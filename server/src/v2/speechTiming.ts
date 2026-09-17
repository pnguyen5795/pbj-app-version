import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.ts';

const wordSchema=z.object({word:z.string(),start:z.number().nonnegative(),end:z.number().nonnegative()});
export const speechTimingSchema=z.object({text:z.string(),words:z.array(wordSchema)});
export type SpeechTiming=z.infer<typeof speechTimingSchema>;
export function normalizeSpeech(input:unknown,duration:number):SpeechTiming {
  const parsed=speechTimingSchema.parse(input);
  let previous=0;
  for(const word of parsed.words){
    if(word.start<previous||word.end<word.start||word.end>duration+0.05)throw new Error('Speech timing exceeds source bounds or is unordered');
    previous=word.start;
  }
  if(parsed.text.trim()&&!parsed.words.length)throw new Error('Transcript lacks requested word timing');
  return parsed;
}
export async function obtainSpeechTiming(db:Database,owner:string,assetID:string,intent:unknown,submit:()=>Promise<unknown>){
  const asset=(await db.query<any>('SELECT duration_ticks FROM pbj_assets WHERE owner_id=$1 AND id=$2',[owner,assetID])).rows[0];
  if(!asset)throw new Error('Speech source is not available in this account');
  await db.query(`INSERT INTO pbj_speech_timing(id,owner_id,asset_id,status,intent) VALUES($1,$2,$3,'reserved',$4::jsonb) ON CONFLICT(owner_id,asset_id) DO NOTHING`,[randomUUID(),owner,assetID,JSON.stringify(intent)]);
  let row=(await db.query<any>('SELECT * FROM pbj_speech_timing WHERE owner_id=$1 AND asset_id=$2',[owner,assetID])).rows[0];
  const duration=Number(asset.duration_ticks)/60000;
  if(row.full_response){
    const evidence=normalizeSpeech(row.full_response,duration);
    if(row.status!=='complete')await db.query(`UPDATE pbj_speech_timing SET evidence=$2::jsonb,status='complete',updated_at=now() WHERE id=$1`,[row.id,JSON.stringify(evidence)]);
    return {id:row.id,version:1,evidence,reused:true};
  }
  if(row.status!=='reserved')throw new Error('Speech submission unresolved or already in flight; automatic resubmission is disabled');
  const claimed=await db.query(`UPDATE pbj_speech_timing SET status='submitting',updated_at=now() WHERE id=$1 AND status='reserved' RETURNING id`,[row.id]);
  if(!claimed.rows.length)throw new Error('Another process claimed this speech submission');
  let response:unknown;
  try { response=await submit(); }
  catch(error){
    await db.query(`UPDATE pbj_speech_timing SET status='unresolved',last_error=$2,updated_at=now() WHERE id=$1`,[row.id,String(error)]);
    throw error;
  }
  // Store the response before interpreting it; malformed output is not grounds
  // for another paid transcription.
  await db.query(`UPDATE pbj_speech_timing SET full_response=$2::jsonb,status='needs_review',updated_at=now() WHERE id=$1`,[row.id,JSON.stringify(response)]);
  const evidence=normalizeSpeech(response,duration);
  await db.query(`UPDATE pbj_speech_timing SET evidence=$2::jsonb,status='complete',updated_at=now() WHERE id=$1`,[row.id,JSON.stringify(evidence)]);
  return {id:row.id,version:1,evidence,reused:false};
}
