import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,type Database} from '../src/v2/database.ts';
import {NotificationBridge,type NotificationEvent,type PushSender} from '../src/v2/notifications.ts';
import {APNsSender,configuredAPNs} from '../src/v2/apns.ts';
import {createAPI} from '../src/v2/api.ts';
import {createProject,requestRevision} from '../src/v2/projects.ts';

const token='a'.repeat(64);
const registration={token,environment:'sandbox' as const,enabled:true};
class Sender implements PushSender {
 environment='sandbox' as const;sent:NotificationEvent[]=[];result={status:200};
 async send(_token:string,event:NotificationEvent){this.sent.push(event);return this.result;}
}
async function fixture(run:(context:{db:PGlite;deviceID:string;projectID:string;jobID:string;revisionID:string})=>Promise<void>){
 const db=new PGlite();try{
  await migrate(db as Database);
  const deviceID=randomUUID(),projectID=randomUUID(),jobID=randomUUID(),revisionID=randomUUID();
  await db.query(`INSERT INTO pbj_projects(id,owner_id,title,brief,current_revision_id) VALUES($1,'owner','Private footage title','Secret brief',$2)`,[projectID,revisionID]);
  await db.query(`INSERT INTO pbj_jobs(id,owner_id,kind,dedupe_key,payload,status,resumed_at,result) VALUES($1,'owner','plan',$1,$2,'running',now(),$3)`,[jobID,JSON.stringify({projectID}),JSON.stringify({accepted:true,revisionID})]);
  await run({db,deviceID,projectID,jobID,revisionID});
 }finally{await db.close();}
}

test('free-account mode records one committed terminal event without any push credentials or network',()=>fixture(async({db,deviceID,projectID,jobID})=>{
 assert.equal(await configuredAPNs({PBJ_APNS_ENABLED:'0',PBJ_APNS_PRIVATE_KEY_FILE:'/must-not-read'}),undefined);
 const bridge=new NotificationBridge(db as Database);await bridge.register('owner',deviceID,{...registration,token:null});
 assert.deepEqual(await bridge.watch('owner',deviceID,{projectID}),{jobID});await bridge.tick();
 assert.equal((await bridge.feed('owner',deviceID)).events.length,0,'A result saved before job commit is not completion');
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);
 await Promise.all(Array.from({length:5},()=>bridge.tick()));
 const first=await bridge.feed('owner',deviceID);assert.equal(first.events.length,1);
 assert.equal(first.events[0].ownerID,'owner');assert.equal(first.events[0].projectID,projectID);assert.equal(first.events[0].jobID,jobID);
 assert.equal((await bridge.feed('owner',deviceID)).events[0].id,first.events[0].id);assert.doesNotMatch(JSON.stringify(first),/Private footage|Secret brief/);
 assert.equal((await db.query<any>('SELECT delivery_status,attempts FROM pbj_notifications')).rows[0].delivery_status,'local_only');
 assert.equal((await bridge.feed('owner',deviceID,first.cursor)).events.length,0);
 await bridge.acknowledge('owner',deviceID,first.events[0].id);assert.equal((await bridge.feed('owner',deviceID)).events.length,0);
}));

test('push delivery is leased, replay-safe and only targets the watching installation',()=>fixture(async({db,deviceID,jobID})=>{
 const sender=new Sender(),bridge=new NotificationBridge(db as Database,sender),other=randomUUID();
 await bridge.register('owner',deviceID,registration);await bridge.register('owner',other,{...registration,token:'b'.repeat(64)});
 await bridge.watch('owner',deviceID,{jobID});await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);
 await Promise.all(Array.from({length:8},()=>bridge.tick()));await bridge.tick();assert.equal(sender.sent.length,1);
 assert.equal((await bridge.feed('owner',other)).events.length,0);
 assert.equal((await db.query<any>('SELECT delivery_status FROM pbj_notifications')).rows[0].delivery_status,'sent');
}));

test('resumed attention is suppressed and only a new terminal outcome can notify again',()=>fixture(async({db,deviceID,jobID})=>{
 const sender=new Sender(),bridge=new NotificationBridge(db as Database,sender);await bridge.register('owner',deviceID,registration);await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='attention' WHERE id=$1`,[jobID]);await bridge.collect();
 await db.query(`UPDATE pbj_jobs SET status='running',resumed_at=now() WHERE id=$1`,[jobID]);await bridge.tick();
 assert.equal(sender.sent.length,0);assert.equal((await bridge.feed('owner',deviceID)).events.length,0);
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);await bridge.tick();
 assert.equal(sender.sent.length,1);assert.equal(sender.sent[0].status,'complete');
}));

test('a resume committed during event collection cannot leak a stale attention alert into catch-up',()=>fixture(async({db,deviceID,jobID})=>{
 const bridge=new NotificationBridge(db as Database);await bridge.register('owner',deviceID,{...registration,token:null});await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='attention' WHERE id=$1`,[jobID]);
 let interrupt=true;const interleaved:Database={async query<T>(sql:string,values?:unknown[]){
  const result=await db.query<T>(sql,values);
  if(interrupt&&sql.includes('SELECT j.*,w.device_id')){interrupt=false;await db.query(`UPDATE pbj_jobs SET status='queued',attempts=0,available_at=now(),resumed_at=now(),last_error=NULL WHERE id=$1 AND status='attention'`,[jobID]);}
  return result;
 }};
 assert.equal((await new NotificationBridge(interleaved).feed('owner',deviceID)).events.length,0);
 assert.equal((await db.query<any>('SELECT status FROM pbj_jobs WHERE id=$1',[jobID])).rows[0].status,'queued');
}));

test('newer requests, rejected heads and archived projects suppress stale alerts',()=>fixture(async({db,deviceID,projectID,jobID})=>{
 const bridge=new NotificationBridge(db as Database);await bridge.register('owner',deviceID,registration);await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='complete',result=jsonb_set(result,'{accepted}','false') WHERE id=$1`,[jobID]);
 assert.equal((await bridge.feed('owner',deviceID)).events.length,0);
 await db.query(`UPDATE pbj_jobs SET result=jsonb_set(result,'{accepted}','true') WHERE id=$1`,[jobID]);
 await db.query('UPDATE pbj_projects SET archived=true WHERE id=$1',[projectID]);assert.equal((await bridge.feed('owner',deviceID)).events.length,0);
 await db.query('UPDATE pbj_projects SET archived=false WHERE id=$1',[projectID]);
 const newer=randomUUID();await db.query(`INSERT INTO pbj_jobs(id,owner_id,kind,dedupe_key,payload) VALUES($1,'owner','plan',$1,$2)`,[newer,JSON.stringify({projectID})]);
 assert.equal((await bridge.feed('owner',deviceID)).events.length,0);assert.deepEqual(await bridge.watch('owner',deviceID,{projectID}),{jobID:newer});
}));

test('analysis subjobs cannot be watched and teaching reports only the parent outcome',()=>fixture(async({db,deviceID})=>{
 const bridge=new NotificationBridge(db as Database);await bridge.register('owner',deviceID,registration);
 const analysis=randomUUID();await db.query(`INSERT INTO pbj_jobs(id,owner_id,kind,dedupe_key,payload,status) VALUES($1,'owner','analysis',$1,'{}','complete')`,[analysis]);
 await assert.rejects(()=>bridge.watch('owner',deviceID,{jobID:analysis}),/not found/);
 const groupID=randomUUID(),assetID=randomUUID(),jobID=randomUUID();
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES($1,'owner',$2,'private.mp4','test',300000)`,[assetID,'b'.repeat(64)]);
 await db.query(`INSERT INTO pbj_teaching_groups(id,owner_id,attribution,notes,final_asset_id) VALUES($1,'owner','Private creator','Private notes',$2)`,[groupID,assetID]);
 await db.query(`INSERT INTO pbj_jobs(id,owner_id,kind,dedupe_key,payload,status) VALUES($1,'owner','teach',$1,$2,'complete')`,[jobID,JSON.stringify({groupID})]);
 await bridge.watch('owner',deviceID,{jobID});const events=(await bridge.feed('owner',deviceID)).events;
 assert.equal(events.length,1);assert.equal(events[0].groupID,groupID);assert.equal(events[0].kind,'teach');assert.doesNotMatch(JSON.stringify(events),/Private creator|Private notes/);
}));

test('device registration, token conflicts, feed, watches, acknowledgements and revocation remain account-scoped',()=>fixture(async({db,deviceID,jobID})=>{
 const bridge=new NotificationBridge(db as Database);await bridge.register('owner',deviceID,registration);
 await assert.rejects(()=>bridge.register('other',deviceID,registration),/another account/);
 await assert.rejects(()=>bridge.register('other',randomUUID(),registration),/token conflict/);
 const other=randomUUID();await bridge.register('other',other,{...registration,token:'b'.repeat(64)});
 await assert.rejects(()=>bridge.watch('other',other,{jobID}),/not found/);await assert.rejects(()=>bridge.feed('other',deviceID),/not found/);
 await bridge.watch('owner',deviceID,{jobID});await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);
 const event=(await bridge.feed('owner',deviceID)).events[0];await bridge.acknowledge('other',other,event.id);
 assert.equal((await bridge.feed('owner',deviceID)).events.length,1);
 await bridge.unregister('other',deviceID);assert.equal((await bridge.feed('owner',deviceID)).events.length,1);
 await bridge.unregister('owner',deviceID);await assert.rejects(()=>bridge.feed('owner',deviceID),/not found/);
 assert.equal((await db.query('SELECT id FROM pbj_notifications')).rows.length,0);
}));

test('APNs uses ES256, generic alerts, matching environment and the same collapse identity after uncertain acknowledgement',()=>fixture(async({db,deviceID,jobID})=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const headers:any[]=[],bodies:any[]=[];
 const sender=new APNsSender({teamID:'ABCDEFGHIJ',keyID:'1234567890',bundleID:'com.pbj.test',environment:'sandbox',privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()},async(origin,head,body)=>{
  assert.equal(origin,'https://api.sandbox.push.apple.com');headers.push(head);bodies.push(JSON.parse(body));if(headers.length===1)throw new Error('Lost accepted response');return {status:200};
 });
 const bridge=new NotificationBridge(db as Database,sender);await bridge.register('owner',deviceID,registration);await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);await bridge.tick();
 await db.query(`UPDATE pbj_notifications SET available_at=now()`);await bridge.tick();await bridge.tick();assert.equal(headers.length,2);
 assert.equal(headers[0]['apns-id'],headers[1]['apns-id']);assert.equal(headers[0]['apns-collapse-id'],headers[1]['apns-collapse-id']);
 assert.equal(headers[0]['apns-push-type'],'alert');assert.equal(headers[0]['apns-topic'],'com.pbj.test');assert.equal(headers[0][':path'],'/3/device/'+token);
 assert.equal(bodies[0].pbj.ownerID,'owner');assert.equal(bodies[0].pbj.jobID,jobID);assert.equal(bodies[0].aps.alert.title,'Your cut is ready');
 const jwt=String(headers[0].authorization).slice(7).split('.');assert.equal(JSON.parse(Buffer.from(jwt[0],'base64url').toString()).alg,'ES256');
 assert.ok(verify('sha256',Buffer.from(jwt.slice(0,2).join('.')),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(jwt[2],'base64url')));
 assert.equal(headers[0].authorization,headers[1].authorization,'Reuse APNs token instead of minting one per notification');
}));

test('APNs transient retries are bounded, 5XX waits fifteen minutes and invalid tokens are revoked',()=>fixture(async({db,deviceID,jobID})=>{
 const sender=new Sender(),bridge=new NotificationBridge(db as Database,sender);sender.result={status:503};await bridge.register('owner',deviceID,registration);await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);await bridge.tick();
 const delayed=(await db.query<any>('SELECT available_at FROM pbj_notifications')).rows[0];assert.ok(new Date(delayed.available_at).getTime()-Date.now()>890000);
 for(let i=0;i<6;i++){await db.query('UPDATE pbj_notifications SET available_at=now()');await bridge.tick();}
 assert.equal(sender.sent.length,5);assert.equal((await db.query<any>('SELECT delivery_status FROM pbj_notifications')).rows[0].delivery_status,'failed');
 sender.result={status:410};await db.query(`UPDATE pbj_notifications SET delivery_status='pending',attempts=0,available_at=now()`);await bridge.tick();
 assert.equal((await db.query<any>('SELECT token FROM pbj_notification_devices WHERE id=$1',[deviceID])).rows[0].token,null);
}));

test('enabling APNs later does not send old local-only receipts',()=>fixture(async({db,deviceID,jobID})=>{
 const local=new NotificationBridge(db as Database);await local.register('owner',deviceID,{...registration,token:null});await local.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);await local.tick();
 const sender=new Sender(),remote=new NotificationBridge(db as Database,sender);await remote.register('owner',deviceID,registration);await remote.tick();
 assert.equal(sender.sent.length,0);assert.equal((await remote.feed('owner',deviceID)).events.length,1);
}));

test('an interrupted final delivery attempt stops at its retry limit and preserves catch-up',()=>fixture(async({db,deviceID,jobID})=>{
 const sender=new Sender(),bridge=new NotificationBridge(db as Database,sender);await bridge.register('owner',deviceID,registration);await bridge.watch('owner',deviceID,{jobID});
 await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);await bridge.collect();
 await db.query(`UPDATE pbj_notifications SET delivery_status='sending',attempts=5,lease_token='old',lease_until=now()-interval '1 minute'`);
 await bridge.tick();assert.equal(sender.sent.length,0);assert.equal((await bridge.feed('owner',deviceID)).events.length,1);
 assert.equal((await db.query<any>('SELECT delivery_status FROM pbj_notifications')).rows[0].delivery_status,'failed');
}));

test('notification HTTP routes enforce authentication and match the native contract',()=>fixture(async({db,deviceID,projectID,jobID})=>{
 const app=createAPI({db:db as Database,storage:{} as any,uploadRoot:'unused',resolveMedia:async()=>{throw new Error('No media');},authenticate:async req=>{if(req.headers['x-owner']!=='owner')throw new Error('Not signed in');return 'owner';}});
 const server=await new Promise<any>(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
 try{
  const base='http://127.0.0.1:'+server.address().port+'/v2';const call=(route:string,method='GET',body?:unknown)=>fetch(base+route,{method,headers:{'x-owner':'owner','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await fetch(base+'/notifications?deviceID='+deviceID)).status,401);
  // Swift's synthesized Encodable omits a nil token in the free-account build.
  assert.deepEqual(await (await call('/notification-devices/'+deviceID,'PUT',{environment:'sandbox',enabled:true})).json(),{remoteEnabled:false});
  assert.deepEqual(await (await call('/notification-devices/'+deviceID+'/watch','POST',{projectID})).json(),{jobID});
  assert.equal((await call('/notification-devices/'+deviceID+'/watch','POST',{projectID,jobID})).status,400);
  await db.query(`UPDATE pbj_jobs SET status='complete' WHERE id=$1`,[jobID]);
  const feed=await (await call('/notifications?deviceID='+deviceID)).json();assert.equal(feed.events[0].ownerID,'owner');assert.equal(typeof feed.cursor,'string');
  assert.equal((await call('/notifications/'+feed.events[0].id+'/ack','POST',{deviceID})).status,200);
  const assetID=randomUUID(),groupID=randomUUID();await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES($1,'owner',$2,'test.mp4','test',300000)`,[assetID,'d'.repeat(64)]);
  const teaching={id:groupID,finalAssetID:assetID,attribution:'Test reference',notificationDeviceID:deviceID};
  const work=await (await call('/teaching','POST',teaching)).json();assert.equal(typeof work.id,'string');
  assert.equal((await (await call('/teaching','POST',teaching)).json()).id,work.id);
  assert.equal((await db.query('SELECT job_id FROM pbj_notification_watches WHERE job_id=$1',[work.id])).rows.length,1);
  const badGroup=randomUUID();assert.equal((await call('/teaching','POST',{...teaching,id:badGroup,notificationDeviceID:randomUUID()})).status,404);
  assert.equal((await db.query('SELECT id FROM pbj_teaching_groups WHERE id=$1',[badGroup])).rows.length,0);
  assert.equal((await call('/notification-devices/'+deviceID,'DELETE')).status,200);
  assert.equal((await call('/notifications?deviceID='+deviceID)).status,404);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

test('project creation and revision subscriptions commit atomically and survive lost-response replay',()=>fixture(async({db,deviceID,projectID,revisionID})=>{
 const bridge=new NotificationBridge(db as Database);await bridge.register('owner',deviceID,{...registration,token:null});
 const assetID=randomUUID();await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES($1,'owner',$2,'test.mp4','test',300000)`,[assetID,'c'.repeat(64)]);
 const input={id:randomUUID(),title:'New cut',brief:'Short cut',assetIDs:[assetID],durationGoal:null,required:[],notificationDeviceID:deviceID};
 await createProject(db as Database,'owner',input);await createProject(db as Database,'owner',input);
 assert.equal((await db.query(`SELECT * FROM pbj_notification_watches`)).rows.length,1);
 assert.equal((await db.query(`SELECT * FROM pbj_jobs WHERE dedupe_key=$1`,[input.id])).rows.length,1);
 const denied={...input,id:randomUUID(),notificationDeviceID:randomUUID()};await assert.rejects(()=>createProject(db as Database,'owner',denied),/Notification device/);
 assert.equal((await db.query('SELECT id FROM pbj_projects WHERE id=$1',[denied.id])).rows.length,0);
 await db.query(`INSERT INTO pbj_revisions(id,owner_id,project_id,origin,timeline,evidence_versions,summary) VALUES($1,'owner',$2,'initial','{"clips":[]}','{}','test')`,[revisionID,projectID]);
 const requestID=randomUUID();const first=await requestRevision(db as Database,'owner',projectID,requestID,revisionID,'Make it shorter',undefined,deviceID);
 assert.equal((await requestRevision(db as Database,'owner',projectID,requestID,revisionID,'Make it shorter',undefined,deviceID)).id,first.id);
 assert.equal((await db.query('SELECT * FROM pbj_notification_watches WHERE job_id=$1',[first.id])).rows.length,1);
 const badID=randomUUID();await assert.rejects(()=>requestRevision(db as Database,'owner',projectID,badID,revisionID,'Another change',undefined,randomUUID()),/Notification device/);
 assert.equal((await db.query('SELECT * FROM pbj_jobs WHERE dedupe_key=$1',[badID])).rows.length,0);
}));
