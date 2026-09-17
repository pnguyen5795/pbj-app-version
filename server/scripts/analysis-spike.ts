/** One durable step per invocation. A local PostgreSQL engine is used only
 * for this development spike; production API/worker use DATABASE_URL. */
import { PGlite } from '@electric-sql/pglite';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { AnalysisRegistry } from '../src/v2/analysisRegistry.ts';
import { TwelveLabsProvider } from '../src/v2/twelveLabs.ts';
import type { Database } from '../src/v2/database.ts';

const [original, workDirectory] = process.argv.slice(2);
if (!original || !workDirectory || !process.env.TWELVE_LABS_API_KEY) throw new Error('Provide original file, work directory and TWELVE_LABS_API_KEY');
await mkdir(workDirectory,{recursive:true});
async function hash(file:string){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const sha=await hash(original);
// Registry creation is an explicit setup operation. Losing the database must
// never turn a previously submitted hash into an automatic cache miss.
try { await stat(path.join(workDirectory,'registry','PG_VERSION')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.PBJ_INITIALIZE_REGISTRY !== '1') {
    throw new Error('Registry unavailable or uninitialized. Reconcile existing state; explicitly initialize only a confirmed new library.');
  }
}
const inspect=(file:string)=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8'}));
const info=inspect(original);
const duration=Number(info.format.duration);
if(duration<4 || duration>7200)throw new Error('Sample requires validated preprocessing fallback; do not submit');
const derivative=path.join(workDirectory,sha+'.mp4');
try {await stat(derivative);} catch(err) {
  if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;
  execFileSync('ffmpeg',['-v','error','-i',original,'-map','0:v:0','-map','0:a:0?',
    '-vf',"scale=w='if(gte(iw,ih),960,-2)':h='if(gte(iw,ih),-2,960)'",'-c:v','libx264','-crf','20',
    '-c:a','aac','-b:a','160k','-movflags','+faststart',derivative]);
}
const derivativeInfo=inspect(derivative);
const originalAudio=info.streams.some((s:any)=>s.codec_type==='audio');
if(originalAudio&&!derivativeInfo.streams.some((s:any)=>s.codec_type==='audio'))throw new Error('Preprocessing lost source audio');
if(Math.abs(Number(derivativeInfo.format.duration)-duration)>0.1)throw new Error('Derivative duration mismatch');
const db=new PGlite(path.join(workDirectory,'registry'));
try {
  await db.exec(await readFile(new URL('../migrations/001_native_foundation.sql',import.meta.url),'utf8'));
  await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,media_start_ticks,metadata)
    VALUES($1,'local-spike',$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,original_sha256) DO NOTHING`,
    [randomUUID(),sha,path.basename(original),original,Math.round(duration*60000),Math.round(Number(info.format.start_time||0)*60000),JSON.stringify({
      originalAudio,derivative:{sha256:await hash(derivative),path:derivative,mapping:{sourceOffsetSeconds:0,rate:1}},probe:info})]);
  const asset=(await db.query<{id:string}>(`SELECT id FROM pbj_assets WHERE owner_id='local-spike' AND original_sha256=$1`,[sha])).rows[0];
  const registry=new AnalysisRegistry(db as Database,new TwelveLabsProvider(process.env.TWELVE_LABS_API_KEY));
  const reserved=await registry.reserve('local-spike',asset.id);
  const result=await registry.advance('local-spike',reserved.id,derivative,duration);
  console.log(JSON.stringify({analysisID:result.id,status:result.status,reused:reserved.status==='complete',evidence:result.evidence},null,2));
} finally {await db.close();}
