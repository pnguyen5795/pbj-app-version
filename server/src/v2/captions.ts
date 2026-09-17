import {randomUUID} from 'node:crypto';
import {mkdir,stat,rename,rm} from 'node:fs/promises';
import {openAsBlob} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Database} from './database.ts';
import {normalizeSpeech} from './speechTiming.ts';
import {inspectMedia,mediaWindowInput,audioWindowFilter} from './media.ts';
const execute=promisify(execFile);
export interface SpeechChunk {id:string;owner_id:string;asset_id:string;chunk_index:number;core_start:number;core_end:number;window_start:number;window_end:number;status:string;full_response:any;}
export async function advanceSpeech(db:Database,owner:string,assetID:string,submit:(chunk:SpeechChunk)=>Promise<unknown>,prepare?:(chunk:SpeechChunk)=>Promise<void>){
 const asset=(await db.query<any>('SELECT * FROM pbj_assets WHERE owner_id=$1 AND id=$2',[owner,assetID])).rows[0];if(!asset)throw new Error('Speech source unavailable');
 const completed=(await db.query<any>(`SELECT * FROM pbj_speech_timing WHERE owner_id=$1 AND asset_id=$2 AND status='complete'`,[owner,assetID])).rows[0];if(completed)return {complete:true,evidence:completed.evidence};
 const duration=Number(asset.duration_ticks)/60000;
 await db.query(`INSERT INTO pbj_speech_timing(id,owner_id,asset_id,status,intent) VALUES($1,$2,$3,'reserved',$4) ON CONFLICT(owner_id,asset_id) DO NOTHING`,[randomUUID(),owner,assetID,JSON.stringify({model:'whisper-1',method:'overlapping-300-second-chunks-v1',timeOrigin:'video-track-v2',audioPreserved:true})]);
 const parent=(await db.query<any>('SELECT * FROM pbj_speech_timing WHERE owner_id=$1 AND asset_id=$2',[owner,assetID])).rows[0];
 if(parent.full_response){const evidence=normalizeSpeech(parent.full_response,duration);await db.query(`UPDATE pbj_speech_timing SET status='complete',evidence=$2 WHERE id=$1`,[parent.id,JSON.stringify(evidence)]);return {complete:true,evidence};}
 if(parent.intent.method!=='overlapping-300-second-chunks-v1')throw new Error('Earlier speech request unresolved; recover its saved receipt rather than resubmit');
 if(parent.intent.timeOrigin!=='video-track-v2'){
  // Old partial receipts used a different origin. Mixing them with newly
  // aligned audio silently shifts words; preserve them for explicit recovery.
  if(parent.intent.timeOrigin!==undefined)throw new Error('Unknown saved speech timing origin requires recovery');
  const upgraded=await db.query(`UPDATE pbj_speech_timing SET intent=intent || '{"timeOrigin":"video-track-v2"}'::jsonb
   WHERE id=$1 AND status='reserved' AND NOT (intent ? 'timeOrigin') AND NOT EXISTS (SELECT 1 FROM pbj_speech_chunks
    WHERE owner_id=$2 AND asset_id=$3 AND (status<>'reserved' OR full_response IS NOT NULL)) RETURNING id`,[parent.id,owner,assetID]);
  if(!upgraded.rows.length){
   // Another worker may already have adopted the marker and claimed a chunk.
   const current=(await db.query<any>('SELECT intent FROM pbj_speech_timing WHERE id=$1',[parent.id])).rows[0];
   if(current?.intent.timeOrigin!=='video-track-v2')throw new Error('Saved speech timing origin requires recovery before new chunks can be submitted');
  }
 }
 if(asset.metadata.originalAudio){
  for(let index=0;index<Math.ceil(duration/300);index++){const start=index*300,end=Math.min(duration,start+300);await db.query(`INSERT INTO pbj_speech_chunks(id,owner_id,asset_id,chunk_index,core_start,core_end,window_start,window_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,asset_id,chunk_index) DO NOTHING`,[randomUUID(),owner,assetID,index,start,end,Math.max(0,start-1),Math.min(duration,end+1)]);}
 }
 let rows=(await db.query<SpeechChunk>('SELECT * FROM pbj_speech_chunks WHERE owner_id=$1 AND asset_id=$2 ORDER BY chunk_index',[owner,assetID])).rows;
 const pending=rows.find(r=>!r.full_response);
 if(pending){
  if(pending.status!=='reserved')throw new Error('Speech chunk submission unresolved; automatic resubmission disabled');
  await prepare?.(pending);
  const claim=await db.query(`UPDATE pbj_speech_chunks SET status='submitting' WHERE id=$1 AND status='reserved' RETURNING id`,[pending.id]);if(!claim.rows.length)return {complete:false};
  let result:unknown;try{result=await submit(pending);}catch(error){await db.query(`UPDATE pbj_speech_chunks SET status='unresolved',last_error=$2 WHERE id=$1`,[pending.id,String(error)]);throw error;}
  await db.query(`UPDATE pbj_speech_chunks SET status='received',full_response=$2 WHERE id=$1`,[pending.id,JSON.stringify(result)]);
  rows=(await db.query<SpeechChunk>('SELECT * FROM pbj_speech_chunks WHERE owner_id=$1 AND asset_id=$2 ORDER BY chunk_index',[owner,assetID])).rows;
 }
 if(rows.some(r=>!r.full_response))return {complete:false};
 const words=rows.flatMap(chunk=>normalizeSpeech(chunk.full_response,chunk.window_end-chunk.window_start).words.map(w=>({...w,start:w.start+chunk.window_start,end:w.end+chunk.window_start})).filter(w=>{const midpoint=(w.start+w.end)/2;return midpoint>=chunk.core_start&&midpoint<chunk.core_end;})).sort((a,b)=>a.start-b.start);
 const evidence=normalizeSpeech({text:words.map(w=>w.word).join(' '),words},duration);
 await db.query(`UPDATE pbj_speech_timing SET full_response=$2,evidence=$2,status='complete',updated_at=now() WHERE id=$1`,[parent.id,JSON.stringify({...evidence,chunkIDs:rows.map(r=>r.id)})]);
 return {complete:true,evidence};
}
export async function prepareSpeechChunk(original:string,chunk:SpeechChunk,cache:string){
 await mkdir(cache,{recursive:true});const file=path.join(cache,chunk.id+'.aligned-v2.wav'),duration=chunk.window_end-chunk.window_start;
 async function verify(candidate:string){const media=await inspectMedia(candidate);if(media.kind!=='audio'||Math.abs(media.duration-duration*60000)>600)throw new Error('Speech derivative lost timing');}
 let cached=false;try{await stat(file);cached=true;}catch(error:any){if(error.code!=='ENOENT')throw error;}
 if(cached){try{await verify(file);return file;}catch{await rename(file,file+'.invalid-'+randomUUID());}}
 const media=await inspectMedia(original),start=media.mediaStart/60000+chunk.window_start;
 const temporary=file+'.'+randomUUID()+'.wav';
 try{await execute('ffmpeg',['-v','error',...mediaWindowInput(original,start),'-t',String(duration),'-map','0:a:0','-af',audioWindowFilter(start,duration),'-ac','1','-ar','16000','-c:a','pcm_s16le',temporary],{timeout:600000,maxBuffer:1024*1024});await verify(temporary);await rename(temporary,file);}catch(error){await rm(temporary,{force:true});throw error;}
 return file;
}
export async function transcribeChunk(original:string,chunk:SpeechChunk,cache:string,key:string){
 if(!key)throw new Error('OpenAI speech configuration unavailable');
 const file=await prepareSpeechChunk(original,chunk,cache);
 const form=new FormData();form.append('file',await openAsBlob(file,{type:'audio/wav'}),'speech.wav');form.append('model','whisper-1');form.append('response_format','verbose_json');form.append('timestamp_granularities[]','word');
 const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(180000)});
 if(!response.ok)throw new Error('Speech provider HTTP '+response.status);return response.json();
}
