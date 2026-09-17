import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,appendFile,rm,stat,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {migrate,type Database} from '../src/v2/database.ts';
import {reserveUpload,appendChunk,finishUpload} from '../src/v2/uploads.ts';
import {LocalObjectStore,type ObjectStore} from '../src/v2/storage.ts';

class TracedDatabase implements Database {
 readonly raw=new PGlite();transactionDepth=0;failSQL?:RegExp;
 async query<T=Record<string,unknown>>(sql:string,values?:unknown[]){return this.raw.query<T>(sql,values);}
 async transaction<T>(body:(tx:Database)=>Promise<T>):Promise<T>{
  return this.raw.transaction(async tx=>{
   this.transactionDepth++;
   try{return await body({query:async <R=Record<string,unknown>>(sql:string,values?:unknown[])=>{
    if(this.failSQL?.test(sql)){this.failSQL=undefined;throw new Error('Injected database interruption');}
    return tx.query<R>(sql,values);
   }});}finally{this.transactionDepth--;}
  });
 }
}
async function fixture(body:(db:TracedDatabase,root:string)=>Promise<void>){
 const db=new TracedDatabase(),root=await mkdtemp(path.join(os.tmpdir(),'pbj-upload-adversarial-'));
 try{await migrate(db.raw as Database);await body(db,root);}finally{await db.raw.close();await rm(root,{recursive:true,force:true});}
}
async function prepared(db:Database,root:string){
 const bytes=await readFile(new URL('./fixtures/overlay.png',import.meta.url));
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const input={sha256,fileName:'image.png',byteCount:bytes.length};
 const receipt=await reserveUpload(db,'owner',input);
 await appendChunk(db,'owner',receipt.id,0,bytes,root);
 return {bytes,input,receipt};
}

test('lost chunk acknowledgements and file writes preceding a rolled-back offset remain resumable',()=>fixture(async(db,root)=>{
 const input={sha256:'a'.repeat(64),fileName:'clip.mov',byteCount:9};
 const receipt=await reserveUpload(db,'owner',input);
 await appendChunk(db,'owner',receipt.id,0,Buffer.from('abc'),root);
 await assert.rejects(appendChunk(db,'owner',receipt.id,0,Buffer.from('abc'),root),/offset/);
 assert.equal((await reserveUpload(db,'owner',input)).receivedBytes,3);
 db.failSQL=/UPDATE pbj_uploads SET received_bytes/;
 await assert.rejects(appendChunk(db,'owner',receipt.id,3,Buffer.from('def'),root),/database interruption/);
 assert.equal((await reserveUpload(db,'owner',input)).receivedBytes,3);
 assert.equal(await readFile(path.join(root,receipt.id),'utf8'),'abcdef');
 await appendFile(path.join(root,receipt.id),'orphaned-tail');
 await appendChunk(db,'owner',receipt.id,3,Buffer.from('DEF'),root);
 await appendChunk(db,'owner',receipt.id,6,Buffer.from('ghi'),root);
 assert.equal(await readFile(path.join(root,receipt.id),'utf8'),'abcDEFghi');
}));

test('slow original publication does not hold a database transaction and concurrent completion publishes once',()=>fixture(async(db,root)=>{
 const {bytes,receipt}=await prepared(db,root);let puts=0;
 const local=new LocalObjectStore(path.join(root,'objects'));
 const storage:ObjectStore={materialize:key=>local.materialize(key),put:async(key,file)=>{
  assert.equal(db.transactionDepth,0,'Hash/probe/storage must not monopolize the database transaction');
  puts++;await local.put(key,file);
 }};
 const completed=await Promise.all([finishUpload(db,'owner',receipt.id,root,storage),finishUpload(db,'owner',receipt.id,root,storage)]);
 assert.deepEqual(completed[0],completed[1]);assert.equal(puts,1);
 const asset=(await db.query<any>('SELECT * FROM pbj_assets')).rows[0];
 assert.equal((await db.query('SELECT id FROM pbj_assets')).rows.length,1);
 assert.deepEqual(await readFile(await local.materialize(asset.storage_key)),bytes);
}));

test('committed originals release staging bytes and completion retries remain idempotent',()=>fixture(async(db,root)=>{
 const {bytes,input,receipt}=await prepared(db,root),storage=new LocalObjectStore(path.join(root,'objects'));
 const completed=await finishUpload(db,'owner',receipt.id,root,storage);
 await assert.rejects(stat(path.join(root,receipt.id)),{code:'ENOENT'});
 assert.deepEqual(await finishUpload(db,'owner',receipt.id,root,storage),completed);
 const existing=await reserveUpload(db,'owner',input);assert.equal(existing.assetID,completed.assetID);
 // Reconstruct the precise crash window: completion is committed but its
 // original staging bytes have not yet been deleted when the phone resumes.
 await writeFile(path.join(root,receipt.id),bytes);
 assert.equal((await reserveUpload(db,'owner',input,root)).assetID,completed.assetID);
 await assert.rejects(stat(path.join(root,receipt.id)),{code:'ENOENT'});
 await assert.rejects(reserveUpload(db,'owner',{...input,byteCount:bytes.length+1}),/byte count conflict/);
}));

test('storage and post-publication database failures preserve retryable upload bytes',()=>fixture(async(db,root)=>{
 const {bytes,input,receipt}=await prepared(db,root),local=new LocalObjectStore(path.join(root,'objects'));
 const fullDisk:ObjectStore={materialize:key=>local.materialize(key),put:async()=>{throw Object.assign(new Error('No space left on device'),{code:'ENOSPC'});}};
 await assert.rejects(finishUpload(db,'owner',receipt.id,root,fullDisk),/No space/);
 assert.equal((await db.query('SELECT id FROM pbj_assets')).rows.length,0);
 assert.deepEqual(await readFile(path.join(root,receipt.id)),bytes);
 db.failSQL=/INSERT INTO pbj_assets/;
 await assert.rejects(finishUpload(db,'owner',receipt.id,root,local),/database interruption/);
 assert.equal((await reserveUpload(db,'owner',input)).status,'receiving');
 assert.deepEqual(await readFile(path.join(root,receipt.id)),bytes);
 const completed=await finishUpload(db,'owner',receipt.id,root,local);
 assert.equal(completed.status,'complete');assert.equal((await db.query('SELECT id FROM pbj_assets')).rows.length,1);
}));

test('missing or truncated staging bytes reset the committed offset instead of trapping every retry',()=>fixture(async(db,root)=>{
 for(const missing of [true,false]){
  const input={sha256:(missing?'b':'c').repeat(64),fileName:'clip.mov',byteCount:6};
  const receipt=await reserveUpload(db,'owner',input);
  await appendChunk(db,'owner',receipt.id,0,Buffer.from('abc'),root);
  if(missing)await rm(path.join(root,receipt.id));else await writeFile(path.join(root,receipt.id),'a');
  await assert.rejects(appendChunk(db,'owner',receipt.id,3,Buffer.from('def'),root),/offset.*reset/i);
  const resumed=await reserveUpload(db,'owner',input);assert.equal(resumed.id,receipt.id);assert.equal(resumed.receivedBytes,0);
  await appendChunk(db,'owner',receipt.id,0,Buffer.from('abcdef'),root);
  assert.equal(await readFile(path.join(root,receipt.id),'utf8'),'abcdef');
 }
}));

test('a failed checksum resets only that upload and allows verified bytes on the same reservation',()=>fixture(async(db,root)=>{
 const {bytes,input,receipt}=await prepared(db,root),storage=new LocalObjectStore(path.join(root,'objects'));
 const bad=Buffer.from(bytes);bad[bad.length-1]^=1;await writeFile(path.join(root,receipt.id),bad);
 await assert.rejects(finishUpload(db,'owner',receipt.id,root,storage),/checksum/);
 assert.equal((await db.query('SELECT id FROM pbj_assets')).rows.length,0);
 const resumed=await reserveUpload(db,'owner',input);assert.equal(resumed.id,receipt.id);assert.equal(resumed.receivedBytes,0);
 await appendChunk(db,'owner',receipt.id,0,bytes,root);
 assert.equal((await finishUpload(db,'owner',receipt.id,root,storage)).status,'complete');
}));

test('checksum recovery cannot erase a valid writer queued behind the failed completion',()=>fixture(async(db,root)=>{
 const {bytes,receipt}=await prepared(db,root),storage=new LocalObjectStore(path.join(root,'objects'));
 const bad=Buffer.from(bytes);bad[bad.length-1]^=1;await writeFile(path.join(root,receipt.id),bad);
 const result=await Promise.allSettled([
  finishUpload(db,'owner',receipt.id,root,storage),
  appendChunk(db,'owner',receipt.id,0,bytes,root)
 ]);
 assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');
 assert.deepEqual(await readFile(path.join(root,receipt.id)),bytes);
 assert.equal((await finishUpload(db,'owner',receipt.id,root,storage)).status,'complete');
}));

test('local publication leaves no temporary copies and a failed replacement preserves the old object',()=>fixture(async(_db,root)=>{
 const store=new LocalObjectStore(path.join(root,'objects')),source=path.join(root,'source');
 await writeFile(source,Buffer.alloc(2*1024*1024,17));
 const key='aa/'+'d'.repeat(64)+'.original';await store.put(key,source);
 const original=await readFile(await store.materialize(key));
 // Simulate a crash after a temp copy was written but before its atomic rename.
 await writeFile((await store.materialize(key))+'.'+randomUUID()+'.tmp',original);
 await store.put(key,source);
 await assert.rejects(store.put(key,path.join(root,'missing-source')),{code:'ENOENT'});
 assert.deepEqual(await readFile(await store.materialize(key)),original);
 assert.deepEqual(await readdir(path.join(root,'objects','aa')),[path.basename(key)]);
}));

test('synthetic 16 MiB original publishes once, leaves one file, and keeps the database available',async t=>fixture(async(db,root)=>{
 const payloadBytes=16*1024*1024,bytes=Buffer.alloc(payloadBytes+44);
 // Deterministic PCM silence: a real probeable media container, no private footage.
 bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
 bytes.write('data',36);bytes.writeUInt32LE(payloadBytes,40);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const receipt=await reserveUpload(db,'owner',{sha256,fileName:'synthetic.wav',byteCount:bytes.length});
 for(let offset=0;offset<bytes.length;offset+=4*1024*1024)await appendChunk(db,'owner',receipt.id,offset,bytes.subarray(offset,offset+4*1024*1024),root);
 const local=new LocalObjectStore(path.join(root,'objects'));let puts=0,publicationMs=0,readMs=0;
 const storage:ObjectStore={materialize:key=>local.materialize(key),put:async(key,file)=>{
  assert.equal(db.transactionDepth,0);
  const queryStart=performance.now();await db.query('SELECT 1');readMs=performance.now()-queryStart;
  const started=performance.now();puts++;await local.put(key,file);publicationMs=performance.now()-started;
 }};
 const started=performance.now();
 const [first,second]=await Promise.all([finishUpload(db,'owner',receipt.id,root,storage),finishUpload(db,'owner',receipt.id,root,storage)]);
 const completionMs=performance.now()-started;
 assert.equal(first.assetID,second.assetID);assert.equal(puts,1);
 assert.deepEqual(await readdir(root),['objects']);
 const asset=(await db.query<any>('SELECT * FROM pbj_assets WHERE id=$1',[first.assetID])).rows[0];
 const stored=await readFile(await storage.materialize(asset.storage_key));
 assert.equal(createHash('sha256').update(stored).digest('hex'),sha256);
 t.diagnostic(JSON.stringify({originalBytes:bytes.length,stagingBytesAfterCompletion:0,concurrentCompletions:2,storagePublications:puts,
  activeTransactionsDuringPublication:0,publicationMs:Number(publicationMs.toFixed(2)),databaseReadDuringCompletionMs:Number(readMs.toFixed(2)),completionMs:Number(completionMs.toFixed(2))}));
}));
