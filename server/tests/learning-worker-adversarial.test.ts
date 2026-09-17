import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,type Database} from '../src/v2/database.ts';
import {createProject,saveRevision} from '../src/v2/projects.ts';
import {ApplicationWorker} from '../src/v2/worker.ts';
import {AnalysisRegistry} from '../src/v2/analysisRegistry.ts';
import {OpenAIPlanner} from '../src/v2/planner.ts';
import {enqueue} from '../src/v2/jobs.ts';

async function fixture(){
 const db=new PGlite();await migrate(db as Database);
 const sourceID=randomUUID(),projectID=randomUUID(),feedbackID=randomUUID();
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata)
 VALUES($1,'owner',$2,'flight.mov','unused',600000,'{"originalAudio":false}')`,[sourceID,'a'.repeat(64)]);
 await createProject(db as Database,'owner',{id:projectID,title:'Flight',brief:'A fast flight montage',assetIDs:[sourceID],durationGoal:null,required:[]});
 const revision=await saveRevision(db as Database,'owner',projectID,{schemaVersion:1,id:randomUUID(),parentID:null,width:1080,height:1920,fps:30,
 clips:[{id:'setup',sourceID,sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fit'}]},null,'initial','Setup');
 await db.query(`UPDATE pbj_jobs SET status='complete'`);
 await db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable) VALUES($1,'owner',$2,$3,'For future fast montages, shorten empty setup shots.',true)`,[feedbackID,projectID,revision.id]);
 const job=await enqueue(db as Database,'owner','lesson','feedback:'+feedbackID,{projectID,revisionID:revision.id});
 const worker=new ApplicationWorker({db:db as Database,registry:new AnalysisRegistry(db as Database,{} as any),resolveMedia:async()=>{throw new Error('No media or provider access allowed');},cache:'/unused',openAIKey:'',openAIModel:'fixture'});
 const lesson={statement:'Shorten empty setup in fast montages.',context:'Fast montages',strength:'moderate',reusable:true,
  evidenceIDs:[feedbackID],facet:'pacing',formats:['montage'],subjects:[],reinforcesIDs:[],supersedesIDs:[]};
 const receipt=async(lessons:any[])=>{
  await worker.tick(); // Freeze source input with no configured AI key.
  const raw={status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({lessons})}]}]};
  await db.query(`UPDATE pbj_provider_calls SET full_response=$2,status='received' WHERE id=$1`,[job.id,JSON.stringify(raw)]);
  await db.query(`UPDATE pbj_jobs SET status='queued',available_at=now() WHERE id=$1`,[job.id]);
 };
 return {db,job,worker,lesson,receipt,sourceID,feedbackID};
}

test('invalid later citations cannot leave the first lesson from a failed job active',async()=>{
 const f=await fixture();try{
  await f.receipt([f.lesson,{...f.lesson,statement:'Another lesson',evidenceIDs:['invented-human-decision']}]);
  await f.worker.tick();
  assert.match((await f.db.query<any>('SELECT last_error FROM pbj_jobs WHERE id=$1',[f.job.id])).rows[0].last_error,/human evidence/);
  assert.equal((await f.db.query('SELECT id FROM pbj_memory')).rows.length,0,'A failed learning bundle must publish no partial preferences');
 }finally{await f.db.close();}
});

test('invalid later relationships roll back all lessons from the same provider response',async()=>{
 const f=await fixture();try{
  await f.receipt([f.lesson,{...f.lesson,statement:'A different preference',supersedesIDs:['not-a-supplied-candidate']}]);
  await f.worker.tick();
  assert.match((await f.db.query<any>('SELECT last_error FROM pbj_jobs WHERE id=$1',[f.job.id])).rows[0].last_error,/relationship/i);
  assert.equal((await f.db.query('SELECT id FROM pbj_memory')).rows.length,0,'Database validation must be atomic across the entire learning bundle');
 }finally{await f.db.close();}
});

test('fresh malformed output cannot use the compatibility path for historical saved responses',async(t)=>{
 const f=await fixture();try{
  let requests=0;
  t.mock.method(OpenAIPlanner.prototype,'json',async function(this:any){
   requests++;const data={lessons:[{statement:'Shorter setup',context:'montage',strength:'moderate',reusable:true}]};
   const response={status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(data)}]}]};
   await this.recordResponse?.(response);return {data,response};
  });
  const worker=new ApplicationWorker({db:f.db as Database,registry:new AnalysisRegistry(f.db as Database,{} as any),resolveMedia:async()=>{throw new Error('No media');},cache:'/unused',openAIKey:'fake-test-key',openAIModel:'fixture'});
  await worker.tick();
  await f.db.query(`UPDATE pbj_jobs SET status='queued',available_at=now() WHERE id=$1`,[f.job.id]);await worker.tick();
  assert.equal(requests,1,'Retry reuses the malformed receipt instead of asking again');
  assert.equal((await f.db.query('SELECT id FROM pbj_memory')).rows.length,0,'New responses must satisfy the complete new schema');
 }finally{await f.db.close();}
});

test('explicit feedback retains the actual user instruction even when a model reverses its paraphrase',async()=>{
 const f=await fixture();try{
  const instruction='For my future edits, keep original audio audible. Do not mute it.';
  await f.db.query('UPDATE pbj_feedback SET text=$2 WHERE id=$1',[f.feedbackID,instruction]);
  await f.receipt([{...f.lesson,statement:'Mute original audio in future edits.',context:'Original audio',facet:'sound',formats:[]}]);
  await f.worker.tick();
  const saved=(await f.db.query<any>('SELECT statement,learning FROM pbj_memory')).rows[0];
  assert.equal(saved.statement,instruction,'An inferred paraphrase must never replace the explicit instruction as the authoritative preference');
  assert.equal(saved.learning.signal,'explicit_feedback');
 }finally{await f.db.close();}
});
