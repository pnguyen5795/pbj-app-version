import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {TwelveLabsProvider} from '../src/v2/twelveLabs.ts';
import {AnalysisRegistry} from '../src/v2/analysisRegistry.ts';
import {migrate,type Database} from '../src/v2/database.ts';

const byteCount=200_000_001,chunkSize=80_000_000;
class Transport {
 creates=0;putAttempts:number[]=[];reports:number[]=[];urlRequests:number[]=[];scans=0;
 completed=new Set<number>();lostCreate=false;lostPut=0;lostReport=0;failedPut=0;expired=false;processing=false;missingETag=0;expiredURL=0;staleURL=0;correlationID='analysis';
 async fetch(input:any,init:RequestInit={}):Promise<Response>{
  const url=new URL(String(input)),method=init.method??'GET';
  if(url.hostname==='storage.example'){
   const index=Number(url.pathname.slice(1));this.putAttempts.push(index);
   assert.equal(method,'PUT');assert.equal(new Headers(init.headers).get('x-api-key'),null);
   assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
   assert.equal((init.body as Blob).size,Math.min(chunkSize,byteCount-(index-1)*chunkSize));
   if(this.failedPut===index){this.failedPut=0;return new Response('',{status:503});}
   if(this.lostPut===index){this.lostPut=0;throw new Error('Connection lost after accepted PUT');}
   if(this.expiredURL===index){this.expiredURL=0;return new Response('',{status:403});}
   if(this.missingETag===index){this.missingETag=0;return new Response('',{status:200});}
   return new Response('',{status:200,headers:{ETag:'"part-'+index+'"'}});
  }
  assert.equal(url.origin,'https://api.twelvelabs.io');
  assert.equal(new Headers(init.headers).get('x-api-key'),'mock-key');
  const body=init.body?JSON.parse(String(init.body)):undefined;
  if(url.pathname==='/v1.3/assets/multipart-uploads'&&method==='POST'){
   this.creates++;assert.equal(body.total_size,byteCount);assert.equal(body.user_metadata.pbj_analysis_id,this.correlationID);
   if(this.lostCreate)throw new Error('Connection lost after session creation');
   return Response.json({upload_id:'session',asset_id:'remote-asset',chunk_size:chunkSize,total_chunks:3,
    upload_headers:{'x-upload-purpose':'test'},upload_urls:[],expires_at:new Date(Date.now()+86400000).toISOString()});
  }
  if(url.pathname==='/v1.3/assets/multipart-uploads/session/presigned-urls'){
   this.urlRequests.push(body.start);
   const expiry=this.staleURL===body.start?-1000:3600000;this.staleURL=0;
   return Response.json({upload_id:'session',upload_urls:[{chunk_index:body.start,url:'https://storage.example/'+body.start,expires_at:new Date(Date.now()+expiry).toISOString()}]});
  }
  if(url.pathname==='/v1.3/assets/multipart-uploads/session'&&method==='GET')return Response.json({
   upload_id:'session',status:this.expired?'expired':this.completed.size===3?'completed':'active',total_size:byteCount,
   uploaded_chunks:[...this.completed].map(index=>({index,status:'completed'})),chunks_completed:this.completed.size,
   page_info:{page:1,total_page:1}});
  if(url.pathname==='/v1.3/assets/multipart-uploads/session'&&method==='POST'){
   for(const chunk of body.completed_chunks){assert.equal(chunk.proof_type,'etag');this.reports.push(chunk.chunk_index);this.completed.add(chunk.chunk_index);}
   if(this.lostReport&&this.completed.has(this.lostReport)){this.lostReport=0;throw new Error('Finalization response lost');}
   return Response.json({asset_id:'remote-asset',total_completed:this.completed.size});
  }
  if(url.pathname==='/v1.3/assets/remote-asset')return Response.json({_id:'remote-asset',status:this.processing?'processing':'ready'});
  if(url.pathname==='/v1.3/analyze/tasks'&&method==='POST'){this.scans++;return Response.json({task_id:'task'});}
  if(url.pathname==='/v1.3/analyze/tasks/task'&&method==='GET')return Response.json({status:'ready',result:{finish_reason:'stop',data:JSON.stringify({schemaVersion:1,summary:'Flight',scenes:[{id:'s1',start:0,end:5,visual:'Plane',audio:'Engine',speech:'',confidence:'moderate'}],observations:[],uncertainties:[]})}});
  throw new Error('Unexpected mock HTTP request '+method+' '+url.pathname);
 }
}
async function fixture(body:(file:string,transport:Transport)=>Promise<void>){
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-multipart-'));const file=path.join(directory,'derivative.mp4');
 try{const handle=await open(file,'w');await handle.truncate(byteCount);await handle.close();await body(file,new Transport());}
 finally{await rm(directory,{recursive:true,force:true});}
}
const provider=(transport:Transport)=>new TwelveLabsProvider('mock-key',transport.fetch.bind(transport) as typeof fetch);
async function resume(p:TwelveLabsProvider,file:string,state:any,save:(s:any)=>Promise<void>){
 return p.resumeUpload(file,'analysis',state,save);
}

test('home-Mac large derivatives use durable multipart without rented storage',()=>fixture(async(file,t)=>{
 const p=provider(t);assert.deepEqual(await p.prepareUpload(file,'analysis'),{resumable:true});
 let state:any={version:1},result:string|undefined;
 for(let i=0;i<8&&!result;i++)result=await resume(p,file,state,async next=>{state=structuredClone(next);});
 assert.equal(result,'remote-asset');assert.equal(t.creates,1);assert.deepEqual(t.putAttempts,[1,2,3]);assert.equal(t.scans,0);
 assert.equal(state.sha256.length,64);assert.equal(state.size,byteCount);
}));

test('interrupted and lost-ack parts resume the same session with fresh URLs',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};t.failedPut=2;
 await assert.rejects(async()=>{for(let i=0;i<8;i++)await resume(provider(t),file,state,save);});
 assert.equal(t.creates,1);assert.ok(t.completed.has(1));t.lostPut=2;
 await assert.rejects(()=>resume(provider(t),file,state,save));
 let result;for(let i=0;i<8&&!result;i++)result=await resume(provider(t),file,state,save);
 assert.equal(result,'remote-asset');assert.equal(t.creates,1);assert.equal(t.putAttempts.filter(i=>i===1).length,1);
 assert.equal(t.putAttempts.filter(i=>i===2).length,3);assert.equal(t.urlRequests.filter(i=>i===2).length,3);
}));

test('lost finalization acknowledgement reconciles completion without reuploading or new analysis',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};t.lostReport=3;
 await assert.rejects(async()=>{for(let i=0;i<8;i++)await resume(provider(t),file,state,save);});
 assert.equal(t.completed.size,3);const puts=t.putAttempts.length,reports=t.reports.length;
 assert.equal(await resume(provider(t),file,state,save),'remote-asset');
 assert.equal(t.putAttempts.length,puts);assert.equal(t.reports.length,reports);assert.equal(t.creates,1);assert.equal(t.scans,0);
}));

test('uncertain session creation never silently creates another session',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};t.lostCreate=true;
 await assert.rejects(()=>resume(provider(t),file,state,save));
 await assert.rejects(()=>resume(provider(t),file,state,save),/unresolved|recovery/i);
 assert.equal(t.creates,1);assert.equal(t.putAttempts.length,0);assert.equal(t.scans,0);
}));

test('changed derivative bytes fail closed with the original receipt preserved',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};await resume(provider(t),file,state,save);
 const saved=structuredClone(state);const handle=await open(file,'r+');await handle.write(Buffer.from('changed'),0,7,0);await handle.close();
 await assert.rejects(()=>resume(provider(t),file,state,save),/checksum|changed|identity/i);
 assert.deepEqual(state.receipt,saved.receipt);assert.equal(state.sha256,saved.sha256);assert.equal(state.size,saved.size);
 assert.equal(t.creates,1);assert.equal(t.putAttempts.length,0);
}));

test('expired sessions retain their identity without a replacement upload',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};await resume(provider(t),file,state,save);
 t.expired=true;await assert.rejects(()=>resume(provider(t),file,state,save),/expired.*recovery/i);
 assert.equal(t.creates,1);assert.equal(t.putAttempts.length,0);assert.equal(state.receipt.upload_id,'session');
}));

test('expired URLs and missing ETags retry only their part using fresh URLs',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};await resume(provider(t),file,state,save);
 t.staleURL=1;await assert.rejects(()=>resume(provider(t),file,state,save),error=>{
  assert.match(String(error),/URL expired/);assert.doesNotMatch(String(error),/invalid|recovery|unresolved/i);return true;
 });assert.equal(t.putAttempts.length,0);
 t.expiredURL=1;await assert.rejects(()=>resume(provider(t),file,state,save),/HTTP 403/);
 t.missingETag=1;await assert.rejects(()=>resume(provider(t),file,state,save),/receipt missing/);
 let result;for(let i=0;i<8&&!result;i++)result=await resume(provider(t),file,state,save);
 assert.equal(result,'remote-asset');assert.equal(t.creates,1);assert.equal(t.urlRequests.filter(i=>i===1).length,4);
 assert.equal(t.reports.filter(i=>i===1).length,1);
}));

test('a saved pending ETag is reported after restart without reuploading bytes',()=>fixture(async(file,t)=>{
 let state:any={version:1},fail=true;const save=async(next:any)=>{state=structuredClone(next);};await resume(provider(t),file,state,save);
 const transport=t.fetch.bind(t);
 const p=new TwelveLabsProvider('mock-key',async(input,init)=>{
  if(fail&&String(input).endsWith('/multipart-uploads/session')&&init?.method==='POST'){fail=false;throw new Error('Offline before report');}
  return transport(input,init);
 });
 await assert.rejects(()=>resume(p,file,state,save));assert.equal(state.pending.index,1);
 let result;for(let i=0;i<8&&!result;i++)result=await resume(provider(t),file,state,save);
 assert.equal(result,'remote-asset');assert.equal(t.putAttempts.filter(i=>i===1).length,1);assert.equal(t.creates,1);
}));

test('completed remote uploads recover without local media after restart',()=>fixture(async(file,t)=>{
 let state:any={version:1};const save=async(next:any)=>{state=structuredClone(next);};await resume(provider(t),file,state,save);
 await resume(provider(t),file,state,save);assert.equal(t.completed.size,3);await rm(file);
 assert.equal(await resume(provider(t),file,state,save),'remote-asset');assert.equal(t.creates,1);
}));

test('model size limits fail before uploading and small files retain direct upload',()=>fixture(async(file,t)=>{
 const handle=await open(file,'r+');await handle.truncate(2_000_000_001);await handle.close();
 await assert.rejects(()=>provider(t).prepareUpload(file,'analysis'),/size limit|2 GB/);assert.equal(t.creates,0);
 await writeFile(file,'small fixture');let direct=0;
 const p=new TwelveLabsProvider('mock-key',async(input,init)=>{
  assert.equal(String(input),'https://api.twelvelabs.io/v1.3/assets');assert.equal(init?.redirect,'error');
  const form=init?.body as FormData;assert.equal(form.get('method'),'direct');assert.equal((form.get('file') as Blob).size,13);
  direct++;return Response.json({_id:'small-asset'});
 });
 assert.equal(await p.upload(file,'analysis'),'small-asset');assert.equal(direct,1);
}));

async function registryFixture(file:string,t:Transport,run:(db:PGlite,id:string)=>Promise<void>){
 const db=new PGlite();
 try{
  await migrate(db as Database);
  await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES('asset','owner',$1,'test.mp4','local',300000)`,['a'.repeat(64)]);
  const record=await new AnalysisRegistry(db as Database,provider(t)).reserve('owner','asset');t.correlationID=record.id;
  await run(db,record.id);
 }finally{await db.close();}
}

test('durable registry serializes upload resumes and reuses one analysis for the same original',()=>fixture(async(file,t)=>{
 await registryFixture(file,t,async(db,id)=>{
  const advance=()=>new AnalysisRegistry(db as Database,provider(t)).advance('owner',id,file,5);
  await Promise.all(Array.from({length:8},advance));assert.equal(t.creates,1);
  await Promise.all(Array.from({length:8},advance));assert.deepEqual(t.putAttempts,[1,2,3]);
  await advance();assert.equal((await new AnalysisRegistry(db as Database,provider(t)).get('owner',id)).status,'uploaded');
  t.processing=true;await advance();assert.equal(t.scans,0);
  t.processing=false;await Promise.all(Array.from({length:8},advance));assert.equal(t.scans,1);
  await advance();const reused=await new AnalysisRegistry(db as Database,provider(t)).reserve('owner','asset');
  assert.equal(reused.id,id);assert.equal(reused.status,'complete');assert.equal(t.creates,1);assert.equal(t.scans,1);
 });
}));

test('failed completion persistence recovers the saved multipart asset using GET only',()=>fixture(async(file,t)=>{
 await registryFixture(file,t,async(db,id)=>{
  const registry=new AnalysisRegistry(db as Database,provider(t));await registry.advance('owner',id,file,5);await registry.advance('owner',id,file,5);
  let fail=true;const failing:Database={async query<T>(sql:string,values?:unknown[]){
   if(fail&&sql.includes("SET provider_asset_id=$4,status='uploaded'")){fail=false;throw new Error('Disk unavailable');}
   return db.query<T>(sql,values);
  }};
  await assert.rejects(()=>new AnalysisRegistry(failing,provider(t)).advance('owner',id,'missing',5));
  const saved=await registry.get('owner',id);assert.equal(saved.status,'uploading');assert.equal((saved.intent.multipart as any).assetID,'remote-asset');
  assert.equal((await new AnalysisRegistry(db as Database,provider(t)).advance('owner',id,'missing',5)).status,'uploaded');
  assert.equal(t.creates,1);assert.deepEqual(t.putAttempts,[1,2,3]);assert.equal(t.scans,0);
 });
}));

test('lost creation receipt persistence fails closed after database recovery',()=>fixture(async(file,t)=>{
 await registryFixture(file,t,async(db,id)=>{
  let fail=true;const failing:Database={async query<T>(sql:string,values?:unknown[]){
   if(fail&&sql.includes("'{multipart}',$4::jsonb")&&String(values?.[3]).includes('"phase":"created"')){fail=false;throw new Error('Disk unavailable');}
   return db.query<T>(sql,values);
  }};
  await assert.rejects(()=>new AnalysisRegistry(failing,provider(t)).advance('owner',id,file,5));
  await assert.rejects(()=>new AnalysisRegistry(db as Database,provider(t)).advance('owner',id,file,5),/unresolved.*receipt/);
  assert.equal(t.creates,1);assert.equal(t.putAttempts.length,0);assert.equal(t.scans,0);
 });
}));
