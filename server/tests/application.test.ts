import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/v2/database.ts';
import type {Database} from '../src/v2/database.ts';
import {createProject,saveRevision,snapshotRevision,assetSource} from '../src/v2/projects.ts';
import {reserveUpload,appendChunk,finishUpload} from '../src/v2/uploads.ts';
import {ApplicationWorker} from '../src/v2/worker.ts';
import {AnalysisRegistry} from '../src/v2/analysisRegistry.ts';
import {createAPI} from '../src/v2/api.ts';
import {LocalObjectStore} from '../src/v2/storage.ts';
import {enqueue} from '../src/v2/jobs.ts';
import {retrieveMemory} from '../src/v2/memory.ts';

async function database(){const db=new PGlite();await migrate(db as Database);return db;}
async function asset(db:any,owner='alice',hash='a'.repeat(64)){
 const id=randomUUID();await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata) VALUES($1,$2,$3,'raw.mov','a.original',600000,'{"originalAudio":true}')`,[id,owner,hash]);return (await db.query('SELECT * FROM pbj_assets WHERE id=$1',[id])).rows[0];
}
function timeline(sourceID:string,duration=180000){return {schemaVersion:1 as const,id:randomUUID(),parentID:null,width:1080,height:1920,fps:30,clips:[{id:randomUUID(),sourceID,sourceIn:0,sourceDuration:duration,outputStart:0,volume:1,muted:false,fit:'fit' as const}]};}
async function project(db:any,sourceID:string){return createProject(db,'alice',{id:randomUUID(),title:'Flight',brief:'A brisk flight moment',assetIDs:[sourceID],durationGoal:{seconds:3,mode:'preferred',toleranceSeconds:0.5},required:[]});}
test('revision transactions preserve newer edits and make approval/restoration real snapshots',async()=>{
 const db=await database();try{
 const source=await asset(db),p=await project(db,source.id);const initial=timeline(source.id);
 await assert.rejects(()=>createProject(db as Database,'alice',{id:p.id,title:'Changed',brief:p.brief,assetIDs:[source.id],durationGoal:p.duration_goal,required:[]}),/conflict/);
 await saveRevision(db,'alice',p.id,initial,null,'initial','first');
 const manual={...initial,id:randomUUID(),parentID:initial.id,clips:initial.clips.map(c=>({...c,sourceDuration:120000}))};
 await saveRevision(db,'alice',p.id,manual,initial.id,'manual','shorter');
 const stale={...initial,id:randomUUID(),parentID:initial.id};const pending=await saveRevision(db,'alice',p.id,stale,initial.id,'ai_revision','late result');assert.equal(pending.accepted,false);
 const staleApproval=await snapshotRevision(db,'alice',p.id,initial.id,initial.id,'approved');assert.equal(staleApproval.accepted,false);
 const staleRestore=await snapshotRevision(db,'alice',p.id,initial.id,initial.id,'restored');assert.equal(staleRestore.accepted,false);
 assert.equal((await db.query<any>('SELECT current_revision_id FROM pbj_projects WHERE id=$1',[p.id])).rows[0].current_revision_id,manual.id);
 const restored=await snapshotRevision(db,'alice',p.id,initial.id,manual.id,'restored');assert.equal(restored.timeline.clips[0].sourceDuration,180000);assert.notEqual(restored.id,initial.id);
 await assert.rejects(()=>saveRevision(db,'bob',p.id,timeline(source.id),null,'manual','attack'),/not found/);
 const other=await asset(db,'bob','b'.repeat(64));await assert.rejects(()=>project(db,other.id),/unavailable/);
 const illegal=timeline(other.id);await assert.rejects(()=>saveRevision(db,'alice',p.id,illegal,restored.id,'manual','attack'),/ineligible/);
 }finally{await db.close();}
});
test('resumable uploads enforce owner, committed offsets, and exact original byte count',async()=>{
 const db=await database(),directory=await mkdtemp(path.join(os.tmpdir(),'pbj-upload-'));try{
 const reservation=await reserveUpload(db,'alice',{sha256:'c'.repeat(64),fileName:'../raw.mov',byteCount:6});
 await appendChunk(db,'alice',reservation.id,0,Buffer.from('abc'),directory);
 await assert.rejects(()=>appendChunk(db,'alice',reservation.id,0,Buffer.from('bad'),directory),/offset/);
 await assert.rejects(()=>appendChunk(db,'bob',reservation.id,3,Buffer.from('def'),directory),/not found/);
 const resumed=await reserveUpload(db,'alice',{sha256:'c'.repeat(64),fileName:'renamed.mov',byteCount:6});assert.equal(resumed.receivedBytes,3);assert.equal(resumed.id,reservation.id);
 await appendChunk(db,'alice',resumed.id,3,Buffer.from('def'),directory);assert.equal(await readFile(path.join(directory,resumed.id),'utf8'),'abcdef');
 await assert.rejects(()=>appendChunk(db,'alice',resumed.id,6,Buffer.from('!'),directory),/bounds/);
 }finally{await db.close();await rm(directory,{recursive:true,force:true});}
});
test('worker replays saved planner evidence, saves a cut, and retrieves an attributed feedback lesson without new provider calls',async()=>{
 const db=await database();try{
 const source=await asset(db),p=await project(db,source.id);let calls=0;
 const provider:any=new Proxy({},{get:()=>async()=>{calls++;throw new Error('No provider call expected');}});
 const registry=new AnalysisRegistry(db as Database,provider);const analysis=await registry.reserve('alice',source.id);
 const evidence={schemaVersion:1,summary:'Pilot flying',scenes:[{id:'s',start:0,end:10,visual:'Pilot flying',audio:'engine',speech:'',confidence:'moderate'}],observations:[],uncertainties:[]};
 await db.query(`UPDATE pbj_analysis SET status='complete',full_response='{}',evidence=$2 WHERE id=$1`,[analysis.id,JSON.stringify(evidence)]);
 const job=(await db.query<any>(`SELECT * FROM pbj_jobs WHERE kind='plan'`)).rows[0];
 const input={brief:p.brief,eligibleSources:[assetSource(source)],analysis:[{id:analysis.id,version:1,sourceID:source.id,evidence}],memory:[],required:[],durationGoal:p.duration_goal};
 const editorial={shots:[{retainedClipID:null,sourceID:source.id,sourceStartSeconds:0,sourceEndSeconds:3,volume:1,muted:false,fit:'fit',evidenceIDs:[analysis.id],memoryIDs:[],reason:'Short flight setup'}],summary:'Three-second flight moment',discrepancies:[]};
 const response=(data:any)=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(data)}]}]});
 await db.query(`INSERT INTO pbj_provider_calls(id,owner_id,kind,input,status,full_response) VALUES($1,'alice','plan',$2,'received',$3)`,[job.id,JSON.stringify(input),JSON.stringify(response(editorial))]);
 const worker=new ApplicationWorker({db:db as Database,registry,resolveMedia:async()=>{throw new Error('No download expected');},cache:'/unused',openAIKey:'',openAIModel:'gpt-5.1'});
 await worker.tick();const cut=(await db.query<any>('SELECT * FROM pbj_revisions WHERE project_id=$1',[p.id])).rows[0];assert.equal(cut.timeline.clips[0].sourceDuration,180000);assert.equal(cut.id,job.id);assert.equal(calls,0);
 assert.deepEqual(cut.evidence_versions.decisions,[{clipID:cut.timeline.clips[0].id,evidenceIDs:[analysis.id],memoryIDs:[],reason:'Short flight setup'}]);
 // Reclaiming completed work with its receipt reuses exactly the same clip/revision IDs.
 await db.query(`UPDATE pbj_jobs SET status='queued' WHERE id=$1`,[job.id]);await worker.tick();assert.equal((await db.query('SELECT * FROM pbj_revisions WHERE project_id=$1',[p.id])).rows.length,1);
 const feedbackID=randomUUID();await db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable) VALUES($1,'alice',$2,$3,'For flight footage, use shorter cockpit setup shots.',true)`,[feedbackID,p.id,cut.id]);
 const lesson=await enqueue(db as Database,'alice','lesson','feedback:'+feedbackID,{projectID:p.id,revisionID:cut.id});
 await db.query(`INSERT INTO pbj_provider_calls(id,owner_id,kind,input,status,full_response) VALUES($1,'alice','lesson','{}','received',$2)`,[lesson.id,JSON.stringify(response({lessons:[{statement:'Use shorter cockpit setup shots for flight clips.',context:'flight cockpit',strength:'moderate',reusable:true}]}))]);
 await worker.tick();const memory=await retrieveMemory(db as Database,'alice','flight cockpit',randomUUID());assert.equal(memory.length,1);assert.ok(memory[0].root_evidence_ids.includes(feedbackID));
 await db.query('INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES($1,$2)',['alice',feedbackID]);assert.equal((await retrieveMemory(db as Database,'alice','flight cockpit',p.id)).length,0);
 assert.equal((await retrieveMemory(db as Database,'bob','flight cockpit',p.id)).length,0);assert.equal(calls,0);
 }finally{await db.close();}
});
test('API isolates owned media/projects and reports authentication failures',async()=>{
 const db=await database(),directory=await mkdtemp(path.join(os.tmpdir(),'pbj-api-'));let server:any;
 try{
 const source=await asset(db),p=await project(db,source.id);
 const app=createAPI({db:db as Database,storage:new LocalObjectStore(directory),uploadRoot:directory,resolveMedia:async()=>{throw new Error('Must not access another owner media');},authenticate:async req=>{const owner=req.headers['x-test-owner'];if(typeof owner!=='string')throw new Error('no auth');return owner;}});
 server=await new Promise<any>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const address='http://127.0.0.1:'+server.address().port+'/v2';
 assert.equal((await fetch(address+'/projects')).status,401);
 const foreign=await fetch(address+'/projects/'+p.id,{headers:{'x-test-owner':'bob'}});assert.equal(foreign.status,404);
 assert.equal((await fetch(address+'/assets/'+source.id+'/content',{headers:{'x-test-owner':'bob'}})).status,404);
 const list=await fetch(address+'/projects',{headers:{'x-test-owner':'alice'}});assert.equal(list.status,200);assert.equal((await list.json()).projects[0].id,p.id);
 await db.query(`INSERT INTO pbj_jobs(id,owner_id,kind,dedupe_key,payload,status) SELECT 'pending-'||n,'alice','teach','pending-'||n,'{}','attention' FROM generate_series(1,110) n`);
 const allJobs=await (await fetch(address+'/jobs',{headers:{'x-test-owner':'alice'}})).json();assert.equal(allJobs.jobs.filter((job:any)=>job.status==='attention').length,110);
 const usage=await fetch(address+'/account',{headers:{'x-test-owner':'alice'}});assert.equal(usage.status,200);assert.equal((await usage.json()).sourceSeconds,10);
 const mine=await fetch(address+'/projects/'+p.id,{headers:{'x-test-owner':'alice'}});assert.equal(mine.status,200);assert.equal((await mine.json()).sources[0].id,source.id);
 }finally{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();await rm(directory,{recursive:true,force:true});}
});

test('image upload completion verifies bytes and reuses the owned original across names',async()=>{
 const db=await database(),directory=await mkdtemp(path.join(os.tmpdir(),'pbj-image-'));try{
 const bytes=await readFile(new URL('./fixtures/overlay.png',import.meta.url)),sha256=createHash('sha256').update(bytes).digest('hex');
 const reservation=await reserveUpload(db as Database,'alice',{sha256,fileName:'overlay.png',byteCount:bytes.length});
 await appendChunk(db as Database,'alice',reservation.id,0,bytes,directory);
 const storage=new LocalObjectStore(path.join(directory,'objects'));
 const complete=await finishUpload(db as Database,'alice',reservation.id,directory,storage);
 assert.equal(complete.status,'complete');
 const asset=(await db.query<any>('SELECT * FROM pbj_assets WHERE id=$1',[complete.assetID])).rows[0];assert.equal(assetSource(asset).kind,'image');assert.equal(assetSource(asset).hasAudio,false);
 assert.deepEqual(await readFile(await storage.materialize(asset.storage_key)),bytes);
 const repeated=await reserveUpload(db as Database,'alice',{sha256,fileName:'renamed.png',byteCount:bytes.length});assert.equal(repeated.assetID,complete.assetID);
 await assert.rejects(()=>finishUpload(db as Database,'bob',reservation.id,directory,storage),/not found/);
 }finally{await db.close();await rm(directory,{recursive:true,force:true});}
});

test('a new spoken source queues word timing before any first-cut planner request',async()=>{
 const db=await database();try{
 const source=await asset(db),p=await project(db,source.id);
 const provider:any=new Proxy({},{get:()=>async()=>{throw new Error('No provider call expected');}});
 const registry=new AnalysisRegistry(db as Database,provider),analysis=await registry.reserve('alice',source.id);
 const evidence={schemaVersion:1,summary:'A pilot speaks',scenes:[{id:'s',start:0,end:10,visual:'Pilot',audio:'speech',speech:'Hello.',confidence:'moderate'}],observations:[],uncertainties:[]};
 await db.query(`UPDATE pbj_analysis SET status='complete',full_response='{}',evidence=$2 WHERE id=$1`,[analysis.id,JSON.stringify(evidence)]);
 const worker=new ApplicationWorker({db:db as Database,registry,resolveMedia:async()=>{throw new Error('No download expected');},cache:'/unused',openAIKey:'',openAIModel:'gpt-5.1'});
 await worker.tick();
 const speech=(await db.query<any>(`SELECT * FROM pbj_jobs WHERE kind='speech'`)).rows[0];assert.equal(speech.payload.assetID,source.id);
 const plan=(await db.query<any>(`SELECT * FROM pbj_jobs WHERE kind='plan'`)).rows[0];assert.equal(plan.status,'queued');assert.equal(plan.stage,'Refining speech boundaries');
 assert.equal((await db.query('SELECT * FROM pbj_provider_calls')).rows.length,0);assert.equal((await db.query('SELECT * FROM pbj_revisions WHERE project_id=$1',[p.id])).rows.length,0);
 }finally{await db.close();}
});

test('an unchanged AI revision export does not manufacture a personal lesson',async()=>{
 const db=await database();try{
  const source=await asset(db),p=await project(db,source.id),initial=timeline(source.id);
  await saveRevision(db,'alice',p.id,initial,null,'initial','first');
  const revised={...initial,id:randomUUID(),parentID:initial.id,clips:initial.clips.map(c=>({...c,sourceDuration:120000}))};
  await saveRevision(db,'alice',p.id,revised,initial.id,'ai_revision','AI shortened it');
  await db.query(`UPDATE pbj_jobs SET status='complete'`);
  await db.query(`INSERT INTO pbj_exports(id,owner_id,project_id,revision_id,artifact_sha256,verification) VALUES($1,'alice',$2,$3,$4,'{}')`,[randomUUID(),p.id,revised.id,'d'.repeat(64)]);
  const job=await enqueue(db as Database,'alice','lesson','export:'+revised.id,{projectID:p.id,revisionID:revised.id});
  const worker=new ApplicationWorker({db:db as Database,registry:new AnalysisRegistry(db as Database,{} as any),resolveMedia:async()=>{throw new Error('No media expected');},cache:'/unused',openAIKey:'',openAIModel:'gpt-5.1'});
  await worker.tick();
  assert.equal((await db.query<any>('SELECT status FROM pbj_jobs WHERE id=$1',[job.id])).rows[0].status,'complete');
  assert.equal((await db.query('SELECT * FROM pbj_provider_calls')).rows.length,0);
  assert.equal((await db.query('SELECT * FROM pbj_memory')).rows.length,0);
 }finally{await db.close();}
});

test('each feedback event freezes only its own independent feedback',async()=>{
 const db=await database();try{
  const source=await asset(db),p=await project(db,source.id),initial=timeline(source.id);
  await saveRevision(db,'alice',p.id,initial,null,'initial','first');await db.query(`UPDATE pbj_jobs SET status='complete'`);
  const ids=[randomUUID(),randomUUID()];
  for(const [index,id] of ids.entries())await db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text) VALUES($1,'alice',$2,$3,$4)`,[id,p.id,initial.id,index===0?'Shorten the setup':'Keep the reaction']);
  const job=await enqueue(db as Database,'alice','lesson','feedback:'+ids[1],{projectID:p.id,revisionID:initial.id});
  const worker=new ApplicationWorker({db:db as Database,registry:new AnalysisRegistry(db as Database,{} as any),resolveMedia:async()=>{throw new Error('No media expected');},cache:'/unused',openAIKey:'',openAIModel:'gpt-5.1'});
  await worker.tick(); // Stops at missing configuration after persisting the exact input.
  const input=(await db.query<any>('SELECT input FROM pbj_provider_calls WHERE id=$1',[job.id])).rows[0].input;
  assert.deepEqual(input.feedback.map((f:any)=>f.id),[ids[1]]);
  assert.ok(!input.roots.includes(ids[0]));
 }finally{await db.close();}
});

test('manual outcome differences use their own AI ancestor, not an older unrelated cut',async()=>{
 const db=await database();try{
  const source=await asset(db),p=await project(db,source.id),initial=timeline(source.id);
  await saveRevision(db,'alice',p.id,initial,null,'initial','first');
  const ai={...initial,id:randomUUID(),parentID:initial.id,clips:initial.clips.map(c=>({...c,sourceDuration:120000}))};
  await saveRevision(db,'alice',p.id,ai,initial.id,'ai_revision','AI revision');
  const manual={...ai,id:randomUUID(),parentID:ai.id,clips:ai.clips.map(c=>({...c,sourceDuration:60000}))};
  await saveRevision(db,'alice',p.id,manual,ai.id,'manual','User trim');await db.query(`UPDATE pbj_jobs SET status='complete'`);
  await db.query(`INSERT INTO pbj_exports(id,owner_id,project_id,revision_id,artifact_sha256,verification) VALUES($1,'alice',$2,$3,$4,'{}')`,[randomUUID(),p.id,manual.id,'e'.repeat(64)]);
  const job=await enqueue(db as Database,'alice','lesson','export:'+manual.id,{projectID:p.id,revisionID:manual.id});
  const worker=new ApplicationWorker({db:db as Database,registry:new AnalysisRegistry(db as Database,{} as any),resolveMedia:async()=>{throw new Error('No media expected');},cache:'/unused',openAIKey:'',openAIModel:'gpt-5.1'});
  await worker.tick();
  const input=(await db.query<any>('SELECT input FROM pbj_provider_calls WHERE id=$1',[job.id])).rows[0].input;
  assert.equal(input.baseRevisionID,ai.id);assert.equal(input.differences[0].before.duration,120000);
 }finally{await db.close();}
});

test('API rejects conflicting mutation IDs and deduplicates exports with identical content',async()=>{
 const db=await database(),directory=await mkdtemp(path.join(os.tmpdir(),'pbj-events-'));let server:any;
 try {
  const source=await asset(db),p=await project(db,source.id),initial=timeline(source.id);
  await saveRevision(db,'alice',p.id,initial,null,'initial','first');
  const manual={...initial,id:randomUUID(),parentID:initial.id,clips:initial.clips.map(c=>({...c,sourceDuration:120000}))};
  await saveRevision(db,'alice',p.id,manual,initial.id,'manual','trim');
  const equivalent={...manual,id:randomUUID(),parentID:manual.id,clips:manual.clips.map(c=>({...c,id:randomUUID(),speed:1,rotation:0 as const}))};
  await saveRevision(db,'alice',p.id,equivalent,manual.id,'manual','same content, new IDs');
  const app=createAPI({db:db as Database,storage:new LocalObjectStore(directory),uploadRoot:directory,resolveMedia:async()=>{throw new Error('No media read expected');},authenticate:async()=> 'alice'});
  server=await new Promise<any>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const address='http://127.0.0.1:'+server.address().port+'/v2';
  const post=(route:string,body:any)=>fetch(address+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/projects/'+p.id+'/revisions',{timeline:{...equivalent,id:'../outside'},baseRevisionID:manual.id})).status,400);
  assert.equal((await post('/projects/'+p.id+'/revisions',{timeline:{...equivalent,id:randomUUID(),parentID:initial.id},baseRevisionID:equivalent.id})).status,409);
  const feedback={id:randomUUID(),revisionID:manual.id,text:'Keep the reaction',reusable:false};
  assert.equal((await post('/projects/'+p.id+'/feedback',feedback)).status,200);
  assert.equal((await post('/projects/'+p.id+'/feedback',feedback)).status,200);
  assert.equal((await post('/projects/'+p.id+'/feedback',{...feedback,text:'Different instruction'})).status,409);
  const teaching={id:randomUUID(),finalAssetID:source.id,rawAssetIDs:[],attribution:'Me',notes:'Pacing only'};
  assert.equal((await post('/teaching',teaching)).status,200);
  assert.equal((await post('/teaching',{...teaching,notes:'Changed notes'})).status,409);
  const revise={id:randomUUID(),baseRevisionID:manual.id,instruction:'Shorten setup'};
  assert.equal((await post('/projects/'+p.id+'/revise',revise)).status,200);
  assert.equal((await post('/projects/'+p.id+'/revise',{...revise,instruction:'Lengthen setup'})).status,409);
  const manifest=(revisionID:string)=>({id:randomUUID(),verification:{revisionID,durationSeconds:2,hasAudio:true,decodedVideoSamples:3,sha256:'f'.repeat(64)}});
  const first=await (await post('/projects/'+p.id+'/exports',manifest(manual.id))).json();
  const second=await (await post('/projects/'+p.id+'/exports',manifest(equivalent.id))).json();
  assert.equal(first.id,second.id);
  assert.equal((await db.query('SELECT * FROM pbj_exports')).rows.length,2);
  assert.equal((await db.query(`SELECT * FROM pbj_jobs WHERE dedupe_key LIKE 'outcome:%'`)).rows.length,1);
  const initialExport=await (await post('/projects/'+p.id+'/exports',{id:randomUUID(),verification:{...manifest(initial.id).verification,durationSeconds:3}})).json();
  const laterAI={...equivalent,id:randomUUID(),parentID:equivalent.id,clips:equivalent.clips.map(c=>({...c,sourceDuration:240000}))};
  await saveRevision(db,'alice',p.id,laterAI,equivalent.id,'ai_revision','Different AI setup');
  const deliberate={...initial,id:randomUUID(),parentID:laterAI.id};
  await saveRevision(db,'alice',p.id,deliberate,laterAI.id,'manual','User shortens the new AI setup');
  const deliberateExport=await (await post('/projects/'+p.id+'/exports',{id:randomUUID(),verification:{...manifest(deliberate.id).verification,durationSeconds:3}})).json();
  assert.notEqual(initialExport.id,deliberateExport.id,'A no-lesson AI export must not suppress a later deliberate correction');
 } finally {if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();await rm(directory,{recursive:true,force:true});}
});
