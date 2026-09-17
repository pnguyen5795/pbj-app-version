import { PGlite } from '@electric-sql/pglite';
import { openAsBlob,createReadStream } from 'node:fs';
import { readFile,writeFile,rename,stat } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { obtainSpeechTiming } from '../src/v2/speechTiming.ts';
import type { Database } from '../src/v2/database.ts';
const [directory,assetID,audioPath,receiptPath]=process.argv.slice(2);
if(!directory||!assetID||!audioPath||!receiptPath)throw new Error('Provide existing registry directory, registered asset ID, derived audio and durable response receipt path');
await stat(path.join(directory,'registry','PG_VERSION'));
const sha=createHash('sha256');for await(const bytes of createReadStream(audioPath))sha.update(bytes);
const audioSHA256=sha.digest('hex');
const db=new PGlite(path.join(directory,'registry'));
try{
  await db.exec(await readFile(new URL('../migrations/002_speech_timing.sql',import.meta.url),'utf8'));
  const result=await obtainSpeechTiming(db as Database,'local-spike',assetID,{provider:'OpenAI',model:'whisper-1',audioSHA256,audioPath,sourceOffsetSeconds:0,receiptPath},async()=>{
    if(!process.env.OPENAI_API_KEY)throw new Error('OpenAI configuration missing');
    if((await stat(audioPath)).size>24*1024*1024)throw new Error('Transcription sample exceeds direct audio limit');
    const form=new FormData();form.append('file',await openAsBlob(audioPath,{type:'audio/wav'}),path.basename(audioPath));
    form.append('model','whisper-1');form.append('response_format','verbose_json');
    form.append('timestamp_granularities[]','word');form.append('timestamp_granularities[]','segment');
    const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form,signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw new Error(`Audio transcription HTTP ${response.status}`);
    const body=await response.json();
    const temporary=receiptPath+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,JSON.stringify(body,null,2),{flag:'wx'});await rename(temporary,receiptPath);
    return body;
  });
  console.log(JSON.stringify(result,null,2));
}finally{await db.close();}
