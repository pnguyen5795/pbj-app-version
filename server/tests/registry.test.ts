import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { AnalysisRegistry } from '../src/v2/analysisRegistry.ts';
import type { AnalysisProvider } from '../src/v2/analysisRegistry.ts';
import type { Database } from '../src/v2/database.ts';
import { validateTimeline } from '../src/v2/contracts.ts';

const evidence = {schemaVersion:1,summary:'Person speaks',scenes:[{id:'s1',start:0,end:5,visual:'Person opens a door',audio:'Door sound',speech:'Hello',confidence:'moderate'}],observations:[],uncertainties:[]};
class Provider implements AnalysisProvider {
  uploads=0; scans=0; reads=0; acceptedButTimedOut=false; found=true;
  async upload(){this.uploads++;return 'remote-asset';}
  async assetStatus(){return 'ready';}
  async create(){this.scans++;if(this.acceptedButTimedOut)throw new Error('timeout');return 'remote-task';}
  async findTask(){return this.found?'remote-task':null;}
  async retrieve(){this.reads++;return {status:'ready',result:{data:JSON.stringify(evidence),finish_reason:'stop'}};}
}
async function setup() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../migrations/001_native_foundation.sql',import.meta.url),'utf8'));
  await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES('a','owner',$1,'raw.mov','private/a',300000)`,['a'.repeat(64)]);
  const provider = new Provider();
  return {db,provider,registry:new AnalysisRegistry(db as Database,provider)};
}

test('concurrent reservations and submissions use one baseline scan',async()=>{
  const {db,provider,registry}=await setup();
  try {
    const records=await Promise.all(Array.from({length:12},()=>registry.reserve('owner','a')));
    assert.equal(new Set(records.map(r=>r.id)).size,1);
    const id=records[0].id;
    await Promise.all(Array.from({length:12},()=>registry.advance('owner',id,'file',5)));
    for(let i=0;i<4;i++)await registry.advance('owner',id,'file',5);
    assert.equal(provider.uploads,1);assert.equal(provider.scans,1);
    assert.equal((await registry.get('owner',id)).status,'complete');
    const reused=await registry.reserve('owner','a');
    assert.equal(reused.id,id);assert.equal(reused.status,'complete');
    await assert.rejects(()=>registry.get('someone-else',id));
    await assert.rejects(()=>registry.reserve('someone-else','a'));
  } finally {await db.close();}
});

test('uncertain acceptance reconciles existing task, never repeats POST',async()=>{
  const {db,provider,registry}=await setup();
  try {
    const {id,idempotency_key}=await registry.reserve('owner','a');
    await registry.advance('owner',id,'file',5);
    provider.acceptedButTimedOut=true;
    await registry.advance('owner',id,'file',5);
    assert.equal((await registry.get('owner',id)).status,'unresolved');
    provider.found=false;
    for(let i=0;i<3;i++)await registry.advance('owner',id,'file',5);
    assert.equal(provider.scans,1);
    provider.found=true;
    await registry.advance('owner',id,'file',5);
    assert.equal((await registry.get('owner',id)).status,'complete');
    assert.equal((await registry.get('owner',id)).idempotency_key,idempotency_key);
    assert.equal(provider.scans,1);
  } finally {await db.close();}
});

test('failed result persistence recovers with GET only',async()=>{
  const {db,provider,registry}=await setup();
  try {
    const {id}=await registry.reserve('owner','a');
    await registry.advance('owner',id,'file',5);
    await registry.advance('owner',id,'file',5);
    let fail=true;
    const failing:Database={async query<T>(sql:string,values?:unknown[]){
      if(sql.includes('SET full_response')&&fail){fail=false;throw new Error('disk full');}
      return db.query<T>(sql,values);
    }};
    await assert.rejects(()=>new AnalysisRegistry(failing,provider).advance('owner',id,'file',5));
    await new AnalysisRegistry(db as Database,provider).advance('owner',id,'file',5);
    assert.equal(provider.scans,1);assert.equal(provider.reads,2);
    assert.equal((await registry.get('owner',id)).status,'complete');
  } finally {await db.close();}
});

test('registry unavailable is never a new scan',async()=>{
  const provider=new Provider();
  const db:Database={query:async()=>{throw new Error('database unavailable');}};
  await assert.rejects(()=>new AnalysisRegistry(db,provider).reserve('owner','a'));
  assert.equal(provider.scans,0);assert.equal(provider.uploads,0);
});

test('cache reuse rejects damaged completed records without submitting another scan',async()=>{
  const {db,provider,registry}=await setup();
  try {
    const {id}=await registry.reserve('owner','a');
    for(const missing of ['full_response','evidence']){
      await db.query(`UPDATE pbj_analysis SET status='complete',full_response='{}',evidence=$2 WHERE id=$1`,[id,JSON.stringify(evidence)]);
      // JSON null passes the SQL NOT NULL constraint but is not a usable receipt.
      await db.query(`UPDATE pbj_analysis SET ${missing}='null'::jsonb WHERE id=$1`,[id]);
      await assert.rejects(()=>registry.reserve('owner','a'),/Damaged completed record/);
      const legacyRegistry=new AnalysisRegistry(db as Database,provider,new Set(['a'.repeat(64)]));
      await assert.rejects(()=>legacyRegistry.reserve('owner','a'),/Damaged completed record/);
    }
    for(const malformed of [{},{...evidence,scenes:{}},{...evidence,scenes:[{...evidence.scenes[0],speech:7}]},
      {...evidence,scenes:[{...evidence.scenes[0],end:6}]},
      {...evidence,observations:[{statement:'Pacing',context:'Flight',sceneIDs:['missing'],confidence:'weak'}]}]){
      await db.query(`UPDATE pbj_analysis SET full_response='{}',evidence=$2 WHERE id=$1`,[id,JSON.stringify(malformed)]);
      await assert.rejects(()=>registry.reserve('owner','a'),/Damaged completed record/);
      await assert.rejects(()=>registry.get('owner',id),/Damaged completed record/);
    }
    assert.equal(provider.scans,0);assert.equal(provider.uploads,0);
  } finally {await db.close();}
});

test('eligibility, exact essentials, source bounds and unsupported operations',()=>{
  const source={id:'raw',fileName:'raw.mov',sha256:'hash',duration:300000,mediaStart:0,hasAudio:true};
  const timeline={schemaVersion:1,id:'revision',width:1080,height:1920,fps:30,clips:[{id:'clip',sourceID:'raw',sourceIn:0,sourceDuration:1000,outputStart:0,volume:1,muted:false,fit:'fill'}]};
  assert.doesNotThrow(()=>validateTimeline(timeline,[source]));
  assert.throws(()=>validateTimeline(timeline,[]));
  assert.throws(()=>validateTimeline(timeline,[source],[{sourceID:'raw',start:0,end:2000}]));
  assert.throws(()=>validateTimeline({...timeline,clips:[{...timeline.clips[0],speed:8}]},[source]));
  assert.throws(()=>validateTimeline({...timeline,clips:[{...timeline.clips[0],sourceIn:300000}]},[source]));
});
