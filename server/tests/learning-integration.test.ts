import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,type Database} from '../src/v2/database.ts';
import {createProject,saveRevision} from '../src/v2/projects.ts';
import {createAPI} from '../src/v2/api.ts';
import {ApplicationWorker} from '../src/v2/worker.ts';
import {AnalysisRegistry} from '../src/v2/analysisRegistry.ts';
import {retrieveMemory,saveMemory} from '../src/v2/memory.ts';

async function fixture(){
 const db=new PGlite();await migrate(db as Database);
 const sourceID=randomUUID(),projectID=randomUUID();
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata)
  VALUES($1,'owner',$2,'flight.mov','unused',600000,'{"originalAudio":false}')`,[sourceID,'a'.repeat(64)]);
 await createProject(db as Database,'owner',{id:projectID,title:'Flight',brief:'A TikTok flight montage',assetIDs:[sourceID],durationGoal:null,required:[]});
 const timeline={schemaVersion:1 as const,id:randomUUID(),parentID:null,width:1080,height:1920,fps:30,
  clips:[{id:'setup',sourceID,sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fit' as const}]};
 const initial=await saveRevision(db as Database,'owner',projectID,timeline,null,'initial','Cockpit setup',
  {decisions:[{clipID:'setup',reason:'Establish the cockpit',evidenceIDs:['analysis'],memoryIDs:[]}]});
 const revised=await saveRevision(db as Database,'owner',projectID,{...timeline,id:randomUUID(),parentID:initial.id,
  clips:timeline.clips.map(c=>({...c,sourceDuration:120000}))},initial.id,'ai_revision','Shorter setup',{},'Start closer to takeoff; shorten the empty cockpit setup.');
 await db.query(`UPDATE pbj_jobs SET status='complete'`);
 const registry=new AnalysisRegistry(db as Database,{} as any),analysis=await registry.reserve('owner',sourceID);
 const evidence={schemaVersion:1,summary:'Cockpit before takeoff',scenes:[{id:'s',start:0,end:10,visual:'Pilot preparing for takeoff',audio:'engine',speech:'',confidence:'moderate'}],observations:[],uncertainties:[]};
 await db.query(`UPDATE pbj_analysis SET status='complete',full_response='{}',evidence=$2 WHERE id=$1`,[analysis.id,JSON.stringify(evidence)]);
 const worker=new ApplicationWorker({db:db as Database,registry,resolveMedia:async()=>{throw new Error('Media must stay untouched');},cache:'/unused',openAIKey:'',openAIModel:'fixture'});
 const app=createAPI({db:db as Database,storage:{} as any,uploadRoot:'/unused',resolveMedia:async()=>{throw new Error('No media');},authenticate:async()=> 'owner'});
 const server=await new Promise<any>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const post=async(route:string,body:any)=>fetch(`http://127.0.0.1:${server.address().port}/v2/projects/${projectID}/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const close=async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();};
 return {db,sourceID,projectID,initial,revised,worker,post,close};
}
const lesson=(evidenceID:string)=>({statement:'In fast montages, shorten empty setup before the action.',context:'Fast short-form montages',strength:'moderate',reusable:true,
 evidenceIDs:[evidenceID],facet:'pacing',formats:['short_form'],subjects:[],reinforcesIDs:[],supersedesIDs:[]});
async function receipt(db:any,jobID:string,lessons:any[]){
 await db.query(`UPDATE pbj_provider_calls SET status='received',full_response=$2 WHERE id=$1`,[jobID,JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({lessons})}]}]})]);
 await db.query(`UPDATE pbj_jobs SET status='queued',available_at=now() WHERE id=$1`,[jobID]);
}

test('approval and export share one learning event with retained human intent and cached scene context',async()=>{
 const f=await fixture();try{
  const stale=await (await f.post('approve',{id:randomUUID(),revisionID:f.initial.id,baseRevisionID:f.initial.id})).json();
  assert.equal(stale.accepted,false);
  assert.equal((await f.db.query(`SELECT id FROM pbj_jobs WHERE kind='lesson'`)).rows.length,0);
  const request={id:randomUUID(),revisionID:f.revised.id,baseRevisionID:f.revised.id};
  const approved=await (await f.post('approve',request)).json();assert.equal(approved.accepted,true);
  assert.equal((await f.post('approve',request)).status,200);
  const exportJob=await (await f.post('exports',{id:randomUUID(),verification:{revisionID:approved.id,durationSeconds:2,hasAudio:false,decodedVideoSamples:3,sha256:'b'.repeat(64)}})).json();
  assert.equal((await f.db.query(`SELECT id FROM pbj_jobs WHERE kind='lesson'`)).rows.length,1);
  await f.worker.tick(); // Missing configuration freezes input without a network call.
  const input=(await f.db.query<any>('SELECT input FROM pbj_provider_calls WHERE id=$1',[exportJob.id])).rows[0].input;
  assert.equal(input.requests[0].revisionID,f.revised.id);
  assert.equal(input.changedClips[0].scenes[0].visual,'Pilot preparing for takeoff');
  assert.equal(input.changedClips[0].decisions[0].reason,'Establish the cockpit');
  assert.deepEqual(input.evidence.map((e:any)=>e.id),[f.revised.id]);
  await receipt(f.db,exportJob.id,[lesson(f.revised.id)]);await f.worker.tick();
  const memory=await retrieveMemory(f.db as Database,'owner','Fast TikTok golf montage','next-project');
  assert.equal(memory.length,1,'Transfer pacing across subjects when the lesson is format-scoped');
  assert.equal(memory[0].effectiveStrength,'weak','A generated confidence label cannot promote one example');
  assert.equal(memory[0].learning?.signal,'approved_revision');
  assert.ok(memory[0].root_evidence_ids.includes(f.revised.id));
  await f.post('exports',{id:randomUUID(),verification:{revisionID:approved.id,durationSeconds:2,hasAudio:false,decodedVideoSamples:3,sha256:'c'.repeat(64)}});
  assert.equal((await f.db.query('SELECT id FROM pbj_provider_calls')).rows.length,1);
 }finally{await f.close();}
});

test('lesson extraction rejects scene-only citations and replay cannot broaden legacy subject applicability',async()=>{
 const f=await fixture();try{
  await f.post('approve',{id:randomUUID(),revisionID:f.revised.id,baseRevisionID:f.revised.id});
  const job=(await f.db.query<any>(`SELECT id FROM pbj_jobs WHERE kind='lesson'`)).rows[0];
  await f.worker.tick();await receipt(f.db,job.id,[lesson(f.sourceID)]);await f.worker.tick();
  assert.equal((await f.db.query('SELECT id FROM pbj_memory')).rows.length,0);
  assert.match((await f.db.query<any>('SELECT last_error FROM pbj_jobs WHERE id=$1',[job.id])).rows[0].last_error,/human evidence/);
  // A historical receipt predates the new extraction contract.
  await f.db.query(`UPDATE pbj_provider_calls SET input=input-'learningSchemaVersion' WHERE id=$1`,[job.id]);
  // It lacks classification and human citation fields.
  await receipt(f.db,job.id,[{statement:'Keep the cockpit setup short.',context:'flight cockpit',strength:'moderate',reusable:true}]);
  await f.worker.tick();
  assert.equal((await retrieveMemory(f.db as Database,'owner','flight cockpit','future')).length,1);
  assert.equal((await retrieveMemory(f.db as Database,'owner','golf swing','future')).length,0);
 }finally{await f.close();}
});

test('latest revision instruction participates in retrieval and frozen inputs stay fixed on retry',async()=>{
 const f=await fixture();try{
  await saveMemory(f.db as Database,'owner',{id:'sound-lesson',version:1,kind:'personal_lesson',context:'Talking-head sound',statement:'Lower background music beneath speech.',strength:'weak',attribution:'Your feedback',project_scope:null,provenance:{},root_evidence_ids:['independent'],
   learning:{facet:'sound',formats:['talking_head'],subjects:[],signal:'explicit_feedback',eventID:'f',independenceKey:'f',explicitReusable:true}});
  const response=await f.post('revise',{id:randomUUID(),baseRevisionID:f.revised.id,instruction:'Make this a talking head edit and lower the background music.'});
  const job=await response.json();assert.equal(response.status,200);await f.worker.tick();
  const saved=(await f.db.query<any>('SELECT input FROM pbj_provider_calls WHERE id=$1',[job.id])).rows[0].input;
  assert.match(saved.brief,/talking head/);assert.deepEqual(saved.memory.map((m:any)=>m.id),['sound-lesson']);
  await f.db.query(`UPDATE pbj_memory SET enabled=false`);
  await f.db.query(`UPDATE pbj_jobs SET status='queued',available_at=now() WHERE id=$1`,[job.id]);await f.worker.tick();
  assert.deepEqual((await f.db.query<any>('SELECT input FROM pbj_provider_calls WHERE id=$1',[job.id])).rows[0].input,saved);
 }finally{await f.close();}
});

test('project-only feedback stays project-only through approval and model extraction',async()=>{
 const f=await fixture();try{
  const feedbackID=randomUUID();
  await f.db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable) VALUES($1,'owner',$2,$3,'Shorten this setup for this project only.',false)`,[feedbackID,f.projectID,f.revised.id]);
  await f.post('approve',{id:randomUUID(),revisionID:f.revised.id,baseRevisionID:f.revised.id});
  const job=(await f.db.query<any>(`SELECT id FROM pbj_jobs WHERE kind='lesson'`)).rows[0];
  await f.worker.tick();
  const frozen=(await f.db.query<any>('SELECT input FROM pbj_provider_calls WHERE id=$1',[job.id])).rows[0].input;
  assert.equal(frozen.reusableAllowed,false);assert.equal(frozen.contextFeedback[0].id,feedbackID);
  await receipt(f.db,job.id,[lesson(f.revised.id)]);await f.worker.tick();
  assert.equal((await retrieveMemory(f.db as Database,'owner','Fast TikTok flight montage',f.projectID)).length,1);
  assert.equal((await retrieveMemory(f.db as Database,'owner','Fast TikTok flight montage','next-project')).length,0);
  const saved=(await f.db.query<any>('SELECT * FROM pbj_memory')).rows[0];
  assert.equal(saved.project_scope,f.projectID);assert.ok(!saved.root_evidence_ids.includes(feedbackID),'Context is not another independent vote');
 }finally{await f.close();}
});
