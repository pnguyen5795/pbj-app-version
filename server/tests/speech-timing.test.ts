import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { obtainSpeechTiming,normalizeSpeech } from '../src/v2/speechTiming.ts';
import type { Database } from '../src/v2/database.ts';
async function setup(){
 const db=new PGlite();
 for(const file of ['001_native_foundation.sql','002_speech_timing.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks) VALUES('a','owner',$1,'raw.mov','a',600000)`,['b'.repeat(64)]);
 return db;
}
const response={text:'Hello there.',words:[{word:'Hello',start:2,end:2.4},{word:'there.',start:2.5,end:3}]};
test('speech timing submits once under concurrency and reuses completed output',async()=>{
 const db=await setup();let submissions=0;
 try{
 const submit=async()=>{submissions++;return response;};
 const results=await Promise.allSettled(Array.from({length:6},()=>obtainSpeechTiming(db as Database,'owner','a',{},submit)));
 assert.ok(results.some(r=>r.status==='fulfilled'));
 assert.equal(submissions,1);
 const reused=await obtainSpeechTiming(db as Database,'owner','a',{},submit);
 assert.equal(reused.reused,true);assert.deepEqual(reused.evidence,response);assert.equal(submissions,1);
 await assert.rejects(()=>obtainSpeechTiming(db as Database,'other','a',{},submit));
 }finally{await db.close();}
});
test('uncertain audio request is not automatically repeated',async()=>{
 const db=await setup();let submissions=0;
 try{
 const submit=async()=>{submissions++;throw new Error('timeout after acceptance');};
 await assert.rejects(()=>obtainSpeechTiming(db as Database,'owner','a',{},submit));
 await assert.rejects(()=>obtainSpeechTiming(db as Database,'owner','a',{},submit));
 assert.equal(submissions,1);
 }finally{await db.close();}
});
test('malformed cached speech never causes another request',async()=>{
 const db=await setup();let submissions=0;
 try{
 const submit=async()=>{submissions++;return {...response,words:[{word:'Hello',start:2,end:20}]};};
 await assert.rejects(()=>obtainSpeechTiming(db as Database,'owner','a',{},submit));
 await assert.rejects(()=>obtainSpeechTiming(db as Database,'owner','a',{},submit));
 assert.equal(submissions,1);
 assert.throws(()=>normalizeSpeech({...response,words:[]},10));
 }finally{await db.close();}
});
