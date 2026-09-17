import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {advanceSpeech} from '../src/v2/captions.ts';
import type {Database} from '../src/v2/database.ts';

const receipt={text:'Hello',words:[{word:'Hello',start:1,end:1.5}]};
async function fixture(run:(db:PGlite)=>Promise<void>){
 const db=new PGlite();try{
  for(const file of ['001_native_foundation.sql','002_speech_timing.sql','004_speech_chunks.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,media_start_ticks,metadata)
   VALUES('asset','owner',$1,'offset.mov','local',36000000,120000,'{"originalAudio":true}')`,['a'.repeat(64)]);
  await run(db);
 }finally{await db.close();}
}
async function legacy(db:PGlite){
 await db.query(`INSERT INTO pbj_speech_timing(id,owner_id,asset_id,status,intent) VALUES('speech','owner','asset','reserved','{"method":"overlapping-300-second-chunks-v1"}')`);
 await db.query(`INSERT INTO pbj_speech_chunks(id,owner_id,asset_id,chunk_index,core_start,core_end,window_start,window_end)
  VALUES('chunk','owner','asset',0,0,300,0,301)`);
}

test('new speech records persist the video-relative origin before submitting chunks',()=>fixture(async db=>{
 let calls=0;const submit=async()=>{
  const parent=(await db.query<any>('SELECT intent FROM pbj_speech_timing')).rows[0];
  assert.equal(parent.intent.timeOrigin,'video-track-v2');calls++;return receipt;
 };
 assert.equal((await advanceSpeech(db as Database,'owner','asset',submit)).complete,false);
 assert.equal((await advanceSpeech(db as Database,'owner','asset',submit)).complete,true);
 assert.equal(calls,2);
}));

test('legacy accepted or uncertain chunks cannot be mixed with newly aligned chunks',()=>fixture(async db=>{
 await legacy(db);let calls=0,preparations=0;
 for(const status of ['received','submitting','unresolved']){
  await db.query('UPDATE pbj_speech_chunks SET status=$1,full_response=$2',[status,status==='received'?JSON.stringify(receipt):null]);
  await assert.rejects(()=>advanceSpeech(db as Database,'owner','asset',async()=>{calls++;return receipt;},async()=>{preparations++;}),/origin.*recovery|recovery.*origin/i);
  const parent=(await db.query<any>('SELECT intent FROM pbj_speech_timing')).rows[0];assert.equal(parent.intent.timeOrigin,undefined);
 }
 assert.equal(calls,0);assert.equal(preparations,0);
}));

test('untouched legacy speech reservations safely adopt the new timing origin',()=>fixture(async db=>{
 await legacy(db);let calls=0;
 const result=await advanceSpeech(db as Database,'owner','asset',async()=>{calls++;return receipt;});
 assert.equal(result.complete,false);assert.equal(calls,1);
 assert.equal((await db.query<any>('SELECT intent FROM pbj_speech_timing')).rows[0].intent.timeOrigin,'video-track-v2');
}));

test('complete and fully saved legacy speech receipts remain reusable without retranscription',()=>fixture(async db=>{
 await legacy(db);await db.query('UPDATE pbj_speech_timing SET full_response=$1',[JSON.stringify(receipt)]);
 let calls=0;const submit=async()=>{calls++;return receipt;};
 const recovered=await advanceSpeech(db as Database,'owner','asset',submit);
 assert.equal(recovered.complete,true);assert.deepEqual(recovered.evidence,receipt);
 assert.deepEqual((await advanceSpeech(db as Database,'owner','asset',submit)).evidence,receipt);assert.equal(calls,0);
 assert.equal((await db.query<any>('SELECT intent FROM pbj_speech_timing')).rows[0].intent.timeOrigin,undefined);
}));
