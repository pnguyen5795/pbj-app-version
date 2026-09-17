import {createHash,randomUUID} from 'node:crypto';
import type {Database} from './database.ts';

export type NotificationEvent={id:string;ownerID:string;jobID:string;kind:'plan'|'teach';status:'complete'|'attention';projectID?:string;groupID?:string;revisionID?:string;title:string;body:string;createdAt:string};
export type PushResult={status:number;reason?:string;timestamp?:number};
export interface PushSender {environment:'sandbox'|'production';send(token:string,event:NotificationEvent):Promise<PushResult>;close?():void;}
const eventKey=`j.id || ':' || j.status || ':' || extract(epoch FROM coalesce(j.resumed_at,j.created_at))::text`;
// Parent operations notify once. Their analysis/speech/learning children never
// notify independently, and a newer request or an archived project supersedes
// an old result. Evaluate again before sending and before exposing catch-up.
const currentJob=`j.status IN ('complete','attention') AND (
 (j.kind='plan' AND EXISTS (SELECT 1 FROM pbj_projects p WHERE p.owner_id=j.owner_id AND p.id=j.payload->>'projectID' AND NOT p.archived
  AND (j.status='attention' OR (j.result->>'accepted'='true' AND p.current_revision_id=j.result->>'revisionID')))
  AND NOT EXISTS (SELECT 1 FROM pbj_jobs newer WHERE newer.owner_id=j.owner_id AND newer.kind='plan'
   AND newer.payload->>'projectID'=j.payload->>'projectID' AND (newer.created_at,newer.id)>(j.created_at,j.id)))
 OR (j.kind='teach' AND EXISTS (SELECT 1 FROM pbj_teaching_groups g WHERE g.owner_id=j.owner_id AND g.id=j.payload->>'groupID')
  AND NOT EXISTS (SELECT 1 FROM pbj_excluded_evidence x WHERE x.owner_id=j.owner_id AND x.evidence_id=j.payload->>'groupID')))`;
function stableID(value:string){const h=createHash('sha256').update(value).digest('hex');return [h.slice(0,8),h.slice(8,12),'5'+h.slice(13,16),'a'+h.slice(17,20),h.slice(20,32)].join('-');}

/** Call inside the transaction that enqueues user-visible work. A lost HTTP
 * response must not lose the phone's request to hear about the result. */
export async function watchNotificationJob(db:Database,owner:string,deviceID:string,jobID:string){
 if(!(await db.query(`SELECT j.id FROM pbj_jobs j JOIN pbj_notification_devices d ON d.owner_id=j.owner_id
  WHERE j.owner_id=$1 AND j.id=$2 AND j.kind IN ('plan','teach') AND d.id=$3`,[owner,jobID,deviceID])).rows.length)throw new Error('Notification device or work not found');
 await db.query('INSERT INTO pbj_notification_watches(owner_id,device_id,job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,deviceID,jobID]);
}

export class NotificationBridge {
 private db:Database;private sender?:PushSender;
 constructor(db:Database,sender?:PushSender){this.db=db;this.sender=sender;}
 get remoteEnabled(){return !!this.sender;}
 async register(owner:string,deviceID:string,input:{token:string|null;environment:'sandbox'|'production';enabled:boolean}){
  try{
   const result=await this.db.query(`INSERT INTO pbj_notification_devices(id,owner_id,token,environment,enabled) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,environment=excluded.environment,enabled=excluded.enabled,updated_at=now()
    WHERE pbj_notification_devices.owner_id=excluded.owner_id RETURNING id`,[deviceID,owner,input.token,input.environment,input.enabled]);
   if(!result.rows.length)throw new Error('Notification device belongs to another account');
  }catch(error:any){if(error.code==='23505')throw new Error('Notification token conflict; unregister the previous installation before pairing again');throw error;}
  if(!input.enabled||!input.token)await this.db.query(`UPDATE pbj_notifications SET delivery_status='local_only',lease_token=NULL,lease_until=NULL
   WHERE owner_id=$1 AND device_id=$2 AND delivery_status IN ('pending','sending')`,[owner,deviceID]);
  return {remoteEnabled:this.remoteEnabled&&input.environment===this.sender?.environment&&input.enabled&&!!input.token};
 }
 async unregister(owner:string,deviceID:string){await this.db.query('DELETE FROM pbj_notification_devices WHERE owner_id=$1 AND id=$2',[owner,deviceID]);}
 private async device(owner:string,deviceID:string){
  const row=(await this.db.query<any>('SELECT * FROM pbj_notification_devices WHERE owner_id=$1 AND id=$2',[owner,deviceID])).rows[0];
  if(!row)throw new Error('Notification device not found');return row;
 }
 async watch(owner:string,deviceID:string,input:{jobID?:string;projectID?:string}){
  await this.device(owner,deviceID);
  const job=(await this.db.query<any>(input.projectID?`SELECT * FROM pbj_jobs WHERE owner_id=$1 AND kind='plan' AND payload->>'projectID'=$2 ORDER BY created_at DESC,id DESC LIMIT 1`:
   `SELECT * FROM pbj_jobs WHERE owner_id=$1 AND id=$2 AND kind IN ('plan','teach')`,[owner,input.projectID??input.jobID])).rows[0];
  if(!job)throw new Error('Notification work not found');
  await watchNotificationJob(this.db,owner,deviceID,job.id);
  await this.collect();return {jobID:job.id};
 }
 async collect(){
  await this.db.query(`UPDATE pbj_notifications e SET delivery_status='suppressed',lease_token=NULL,lease_until=NULL
   WHERE delivery_status<>'suppressed' AND NOT EXISTS (SELECT 1 FROM pbj_jobs j WHERE j.owner_id=e.owner_id AND j.id=e.job_id
    AND e.event_key=(${eventKey}) AND ${currentJob})`);
  const rows=(await this.db.query<any>(`SELECT j.*,w.device_id,d.token,d.environment,d.enabled,(${eventKey}) AS event_key
   FROM pbj_notification_watches w JOIN pbj_notification_devices d ON d.owner_id=w.owner_id AND d.id=w.device_id
   JOIN pbj_jobs j ON j.owner_id=w.owner_id AND j.id=w.job_id WHERE ${currentJob}
   AND NOT EXISTS (SELECT 1 FROM pbj_notifications e WHERE e.owner_id=w.owner_id AND e.device_id=w.device_id AND e.event_key=(${eventKey}))
   ORDER BY j.created_at,j.id LIMIT 100`)).rows;
  for(const row of rows){
   const ready=row.status==='complete',project=row.kind==='plan';
   const event:NotificationEvent={id:stableID(JSON.stringify([row.owner_id,row.device_id,row.event_key])),ownerID:row.owner_id,jobID:row.id,kind:row.kind,status:row.status,
    ...(project?{projectID:row.payload.projectID,...(ready?{revisionID:row.result.revisionID}:{})}:{groupID:row.payload.groupID}),
    title:ready?(project?'Your cut is ready':'Learning is complete'):'PB&J needs your attention',
    body:ready?(project?'Tap to review your project.':'Tap to return to your references.'):'Your progress is saved. Tap to continue.',createdAt:new Date().toISOString()};
   const delivery=this.sender&&row.enabled&&row.token&&row.environment===this.sender.environment?'pending':'local_only';
   await this.db.query(`INSERT INTO pbj_notifications(id,owner_id,device_id,job_id,event_key,event,delivery_status) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(owner_id,device_id,event_key) DO NOTHING`,[event.id,row.owner_id,row.device_id,row.id,row.event_key,JSON.stringify(event),delivery]);
  }
 }
 async feed(owner:string,deviceID:string,after='0'){
  await this.device(owner,deviceID);await this.collect();
  const rows=(await this.db.query<any>(`SELECT e.sequence,e.event FROM pbj_notifications e JOIN pbj_jobs j ON j.owner_id=e.owner_id AND j.id=e.job_id
   WHERE e.owner_id=$1 AND e.device_id=$2 AND e.sequence>$3::bigint AND e.delivery_status<>'suppressed' AND e.read_at IS NULL
   AND e.event_key=(${eventKey}) AND ${currentJob} ORDER BY e.sequence LIMIT 100`,[owner,deviceID,after])).rows;
  return {events:rows.map(row=>row.event as NotificationEvent),cursor:rows.length?String(rows.at(-1).sequence):after};
 }
 async acknowledge(owner:string,deviceID:string,eventID:string){
  await this.device(owner,deviceID);
  await this.db.query(`UPDATE pbj_notifications SET read_at=now(),delivery_status=CASE WHEN delivery_status IN ('pending','sending') THEN 'local_only' ELSE delivery_status END,
   lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND device_id=$2 AND id=$3`,[owner,deviceID,eventID]);
 }
 async tick(){
  await this.collect();if(!this.sender)return;
  await this.db.query(`UPDATE pbj_notifications SET delivery_status='failed',lease_token=NULL,lease_until=NULL,last_error='Delivery retry limit reached; receipt remains available in the app'
   WHERE delivery_status='sending' AND lease_until<now() AND attempts>=5`);
  const lease=randomUUID();
  const event=(await this.db.query<any>(`WITH candidate AS (
    SELECT e.id FROM pbj_notifications e JOIN pbj_notification_devices d ON d.owner_id=e.owner_id AND d.id=e.device_id
    WHERE e.read_at IS NULL AND e.attempts<5 AND e.available_at<=now() AND d.enabled AND d.token IS NOT NULL AND d.environment=$2
    AND (e.delivery_status='pending' OR (e.delivery_status='sending' AND e.lease_until<now())) ORDER BY e.sequence FOR UPDATE OF e SKIP LOCKED LIMIT 1)
   UPDATE pbj_notifications SET delivery_status='sending',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '60 seconds'
   WHERE id=(SELECT id FROM candidate) RETURNING *`,[lease,this.sender.environment])).rows[0];
  if(!event)return;
  const device=await this.device(event.owner_id,event.device_id);
  // Recheck after acquiring the delivery lease: a result may have become stale
  // or the user may have revoked permission since collection.
  await this.collect();
  if(!device.enabled||!device.token||device.environment!==this.sender.environment||!(await this.db.query(`SELECT e.id FROM pbj_notifications e
   JOIN pbj_jobs j ON j.owner_id=e.owner_id AND j.id=e.job_id JOIN pbj_notification_devices d ON d.owner_id=e.owner_id AND d.id=e.device_id
   WHERE e.id=$1 AND e.lease_token=$2 AND e.read_at IS NULL AND d.enabled AND d.token=$3 AND d.updated_at=$4
   AND e.event_key=(${eventKey}) AND ${currentJob}`,[event.id,lease,device.token,device.updated_at])).rows.length)return;
  let result:PushResult;
  try{result=await this.sender.send(device.token,event.event);}
  catch{result={status:0,reason:'Connection interrupted; retrying the same notification'};}
  if(result.status===200){
   await this.db.query(`UPDATE pbj_notifications SET delivery_status='sent',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2`,[event.id,lease]);return;
  }
  const invalidToken=result.status===410||(result.status===400&&['BadDeviceToken','DeviceTokenNotForTopic'].includes(result.reason??''));
  if(invalidToken&&(!result.timestamp||new Date(device.updated_at).getTime()<=result.timestamp)){
   await this.db.query(`UPDATE pbj_notification_devices SET token=NULL,enabled=false,updated_at=now() WHERE owner_id=$1 AND id=$2 AND token=$3 AND updated_at=$4`,[event.owner_id,event.device_id,device.token,device.updated_at]);
  }
  const retryable=result.status===0||result.status===429||result.status>=500;
  const delay=result.status>=500?900:Math.min(900,30*2**(event.attempts-1));
  await this.db.query(`UPDATE pbj_notifications SET delivery_status=$3,available_at=now()+make_interval(secs=>$4),lease_token=NULL,lease_until=NULL,last_error=$5
   WHERE id=$1 AND lease_token=$2`,[event.id,lease,retryable&&event.attempts<5?'pending':'failed',delay,
    result.status===0?'Notification delivery response unavailable':`APNs returned HTTP ${result.status}`]);
 }
 close(){this.sender?.close?.();}
}
