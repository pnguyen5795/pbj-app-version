import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/v2/database.ts';
import type {Database} from '../src/v2/database.ts';
import {AnalysisRegistry} from '../src/v2/analysisRegistry.ts';
import {ApplicationWorker} from '../src/v2/worker.ts';
import {enqueue} from '../src/v2/jobs.ts';
import {createProject} from '../src/v2/projects.ts';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const evidence={schemaVersion:1,summary:'Flight',scenes:[{id:'s',start:0,end:5,visual:'Plane flies',audio:'Engine',speech:'',confidence:'moderate'}],observations:[],uncertainties:[]};

test('recovery checks existing provider work before timing out; paused queue time is not processing time',async()=>{
 const db=new PGlite();
 try {
  await migrate(db as Database);
  let reads=0,ready=false;
  const provider:any={
   checkConfiguration(){},
   async retrieve(){reads++;return ready?{status:'ready',result:{data:JSON.stringify(evidence),finish_reason:'stop'}}:{status:'processing'};},
   async upload(){throw new Error('Must not upload again');},
   async create(){throw new Error('Must not analyze again');},
  };
  const registry=new AnalysisRegistry(db as Database,provider);
  const worker=new ApplicationWorker({db:db as Database,registry,resolveMedia:async()=>{throw new Error('Must not load media again');},cache:'/unused',openAIKey:'',openAIModel:''});
  for(const [index,resumed,completed] of [[0,false,false],[1,true,true],[2,true,false]] as const){
   const asset='asset-'+index;
   await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES($1,'owner',$2,'raw.mov','private/raw',300000)`,[asset,String(index).repeat(64)]);
   const record=await registry.reserve('owner',asset);
   await db.query(`UPDATE pbj_analysis SET status='pending',provider_asset_id='saved-asset',provider_task_id='saved-task' WHERE id=$1`,[record.id]);
   const job=await enqueue(db as Database,'owner','analysis',asset,{assetID:asset});
   await db.query(`UPDATE pbj_jobs SET created_at=now()-interval '2 days',resumed_at=CASE WHEN $2 THEN now()-interval '7 hours' ELSE NULL END WHERE id=$1`,[job.id,resumed]);
   ready=completed;
   await worker.tick();
   const saved=(await db.query<any>('SELECT status,last_error,resumed_at FROM pbj_jobs WHERE id=$1',[job.id])).rows[0];
   assert.equal(reads,index+1,'Always retrieve the saved task before declaring it stalled');
   assert.equal(saved.status,index===0?'queued':index===1?'complete':'attention');
   if(index===0){
    assert.ok(saved.resumed_at,'Start recovery window when first processed');
    // Keep this intentionally unfinished fixture out of subsequent claims.
    await db.query(`UPDATE pbj_jobs SET available_at=now()+interval '1 day' WHERE id=$1`,[job.id]);
   }
   if(index===2)assert.match(saved.last_error,/six-hour/);
  }
 } finally {await db.close();}
});

test('malformed cached evidence blocks planning and teaching before recording any provider submission',async()=>{
 const db=new PGlite();
 try{
  await migrate(db as Database);
  await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata) VALUES('asset','owner',$1,'raw.mov','private/raw',300000,'{"originalAudio":false}')`,['a'.repeat(64)]);
  const registry=new AnalysisRegistry(db as Database,{} as any);
  const analysis=await registry.reserve('owner','asset');
  await db.query(`UPDATE pbj_analysis SET status='complete',full_response='{}',evidence='{}' WHERE id=$1`,[analysis.id]);
  await createProject(db as Database,'owner',{id:'project',title:'Flight',brief:'Flight',assetIDs:['asset'],durationGoal:null,required:[]});
  await db.query(`INSERT INTO pbj_teaching_groups(id,owner_id,attribution,notes,final_asset_id,raw_asset_ids) VALUES('group','owner','Me','','asset','[]')`);
  await enqueue(db as Database,'owner','teach','group',{groupID:'group'});
  const worker=new ApplicationWorker({db:db as Database,registry,resolveMedia:async()=>{throw new Error('No media preparation expected');},cache:'/unused',openAIKey:'',openAIModel:''});
  await worker.tick();await worker.tick();
  const jobs=(await db.query<any>(`SELECT kind,status,last_error FROM pbj_jobs ORDER BY kind`)).rows;
  assert.equal(jobs.length,2);
  for(const job of jobs){assert.equal(job.status,'attention');assert.match(job.last_error,/Damaged completed record/);}
  assert.equal((await db.query('SELECT * FROM pbj_provider_calls')).rows.length,0,'No provider intent may be frozen from invalid evidence');
 }finally{await db.close();}
});

test('the worker continues saved multipart parts and recovers completion even if its local cache disappears',async()=>{
 const db=new PGlite(),cache=await mkdtemp(path.join(os.tmpdir(),'pbj-worker-upload-'));
 try{
  await migrate(db as Database);
  await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata)
   VALUES('asset','owner',$1,'raw.mov','private/raw',300000,$2)`,['a'.repeat(64),JSON.stringify({analysisDerivative:{fileName:'saved-v2.mp4'}})]);
  const prepared=path.join(cache,'saved-v2.mp4');await writeFile(prepared,'exact older derivative bytes');
  let resumed=0,created=0;
  const provider:any={async resumeUpload(file:string,id:string,state:any,checkpoint:any){
   resumed++;assert.equal(file,prepared,'Resume the recorded bytes, not a new preparation format');
   if(resumed===1){assert.equal(await readFile(file,'utf8'),'exact older derivative bytes');await checkpoint({...state,phase:'active',completedParts:1});return;}
   assert.equal(state.completedParts,1);return 'saved-uploaded-asset'; // Remote completion is already known: no local file read.
  },async assetStatus(){return 'ready';},async create(){created++;return 'one-task';},async retrieve(){return {status:'ready',result:{data:JSON.stringify(evidence),finish_reason:'stop'}};}};
  const registry=new AnalysisRegistry(db as Database,provider),record=await registry.reserve('owner','asset');
  await db.query(`UPDATE pbj_analysis SET status='uploading',intent=intent||'{"multipart":{"version":1,"phase":"active"}}'::jsonb WHERE id=$1`,[record.id]);
  const work=await enqueue(db as Database,'owner','analysis','asset',{assetID:'asset'});
  const worker=new ApplicationWorker({db:db as Database,registry,cache,resolveMedia:async()=>{throw new Error('Must not re-open the original');},openAIKey:'',openAIModel:''});
  await worker.tick();
  let job=(await db.query<any>('SELECT * FROM pbj_jobs WHERE id=$1',[work.id])).rows[0];
  assert.equal(job.status,'queued');assert.equal(job.attempts,0,'A bounded upload step is progress, not a failed retry');
  assert.match(job.stage,/Sending prepared footage/);
  await rm(prepared);
  for(let i=0;i<3;i++){await db.query('UPDATE pbj_jobs SET available_at=now() WHERE id=$1',[work.id]);await worker.tick();}
  job=(await db.query<any>('SELECT * FROM pbj_jobs WHERE id=$1',[work.id])).rows[0];
  assert.equal(job.status,'complete');assert.equal(resumed,2);assert.equal(created,1);
  assert.equal((await registry.get('owner',record.id)).status,'complete');
 }finally{await db.close();await rm(cache,{recursive:true,force:true});}
});
