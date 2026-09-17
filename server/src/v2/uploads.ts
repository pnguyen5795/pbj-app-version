import {randomUUID,createHash} from 'node:crypto';
import {mkdir,open,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import type {Database} from './database.ts';
import {transaction} from './database.ts';
import type {ObjectStore} from './storage.ts';
import {hashFile,inspectMedia} from './media.ts';

type UploadStatus={id:string;assetID?:string;receivedBytes:number;status:string};
// The personal Mac service has one process for its staging directory. Serialize
// writes/recovery for an upload without holding the database while hashing or
// publishing a large original. Shared staging across API processes needs a
// durable per-upload lease before that deployment mode can be supported.
const mutations=new WeakMap<Database,Map<string,Promise<unknown>>>();
const completions=new WeakMap<Database,Map<string,Promise<UploadStatus>>>();
function tasks<T>(store:WeakMap<Database,Map<string,Promise<T>>>,db:Database){
 let entries=store.get(db);if(!entries){entries=new Map();store.set(db,entries);}return entries;
}
async function serialize<T>(db:Database,owner:string,id:string,body:()=>Promise<T>):Promise<T>{
 const entries=tasks(mutations,db),key=JSON.stringify([owner,id]);
 const pending=(entries.get(key)??Promise.resolve()).catch(()=>{}).then(body);
 entries.set(key,pending);
 try{return await pending;}finally{if(entries.get(key)===pending)entries.delete(key);}
}

export async function reserveUpload(db:Database,owner:string,input:{sha256:string;fileName:string;byteCount:number},root?:string){
 const asset=(await db.query<any>(`SELECT a.id,u.id AS upload_id,coalesce((a.metadata->>'originalByteCount')::bigint,u.byte_count) AS byte_count
  FROM pbj_assets a LEFT JOIN pbj_uploads u ON u.owner_id=a.owner_id AND u.sha256=a.original_sha256
  WHERE a.owner_id=$1 AND a.original_sha256=$2`,[owner,input.sha256])).rows[0];
 if(asset){
  if(asset.byte_count!==null&&asset.byte_count!==undefined&&Number(asset.byte_count)!==input.byteCount)throw new Error('Upload byte count conflict');
  // A crash after the asset commit can leave staging behind. The phone resumes
  // with reserve rather than complete, so this path must retry cleanup too.
  if(root&&asset.upload_id)await serialize(db,owner,asset.upload_id,()=>cleanupStaging(path.join(root,asset.upload_id)));
  return {id:asset.id,assetID:asset.id,receivedBytes:input.byteCount,status:'complete'};
 }
 await db.query(`INSERT INTO pbj_uploads(id,owner_id,sha256,file_name,byte_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,sha256) DO NOTHING`,[randomUUID(),owner,input.sha256,path.basename(input.fileName),input.byteCount]);
 const row=(await db.query<any>('SELECT * FROM pbj_uploads WHERE owner_id=$1 AND sha256=$2',[owner,input.sha256])).rows[0];
 if(Number(row.byte_count)!==input.byteCount)throw new Error('Upload byte count conflict');
 return uploadStatus(row);
}
export function uploadStatus(row:any):UploadStatus{return {id:row.id,assetID:row.asset_id,receivedBytes:Number(row.received_bytes),status:row.status};}
export async function appendChunk(db:Database,owner:string,id:string,offset:number,bytes:Buffer,root:string){
 return serialize(db,owner,id,async()=>{
  const result=await transaction(db,async tx=>{
   const row=(await tx.query<any>('SELECT * FROM pbj_uploads WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,id])).rows[0];if(!row)throw new Error('Upload not found');
   if(row.status!=='receiving'||Number(row.received_bytes)!==offset)throw new Error('Upload offset changed; refresh upload status before continuing');
   if(offset+bytes.length>Number(row.byte_count)||!bytes.length)throw new Error('Chunk exceeds upload bounds');
   await mkdir(root,{recursive:true});const file=path.join(root,row.id);let handle;
   try{handle=await open(file,'r+');}catch(error:any){
    if(error.code!=='ENOENT')throw error;
    if(offset!==0){
     await tx.query('UPDATE pbj_uploads SET received_bytes=0 WHERE owner_id=$1 AND id=$2',[owner,id]);
     return {offsetReset:true as const};
    }
    handle=await open(file,'wx+');
   }
   try{
    if((await handle.stat()).size<offset){
     await handle.truncate(0);await handle.sync();
     await tx.query('UPDATE pbj_uploads SET received_bytes=0 WHERE owner_id=$1 AND id=$2',[owner,id]);
     return {offsetReset:true as const};
    }
    // A crash can leave uncommitted trailing bytes. Keep only the acknowledged
    // prefix, write the retry completely, then commit its offset after fsync.
    await handle.truncate(offset);
    let written=0;while(written<bytes.length){const n=await handle.write(bytes,written,bytes.length-written,offset+written);if(!n.bytesWritten)throw new Error('Upload write stalled');written+=n.bytesWritten;}
    await handle.sync();
   }finally{await handle.close();}
   await tx.query('UPDATE pbj_uploads SET received_bytes=$3 WHERE owner_id=$1 AND id=$2',[owner,id,offset+bytes.length]);
   return {id,receivedBytes:offset+bytes.length,status:'receiving'};
  });
  // Throw after committing the recovery offset; throwing inside would roll it back.
  if('offsetReset' in result)throw new Error('Upload offset reset to 0 because saved bytes were missing; retry the original');
  return result;
 });
}

async function resetFailedBytes(db:Database,owner:string,row:any,file:string){
 await transaction(db,async tx=>{
  const current=(await tx.query<any>('SELECT * FROM pbj_uploads WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,row.id])).rows[0];
  if(!current||current.status!=='receiving'||Number(current.received_bytes)!==Number(row.received_bytes))throw new Error('Upload offset changed during recovery; refresh status');
  let handle;
  try{handle=await open(file,'r+');}catch(error:any){if(error.code!=='ENOENT')throw error;}
  if(handle)try{await handle.truncate(0);await handle.sync();}finally{await handle.close();}
  await tx.query('UPDATE pbj_uploads SET received_bytes=0 WHERE owner_id=$1 AND id=$2',[owner,row.id]);
 });
}
async function cleanupStaging(file:string){
 try{await rm(file,{force:true});}catch(error){
  // The original is already committed. A cleanup failure must not tell the
  // phone to upload it again; another completion attempt can retry cleanup.
  console.warn('Original saved; upload staging cleanup needs retry:',String(error));
 }
}
async function finalize(db:Database,owner:string,id:string,root:string,storage:ObjectStore):Promise<UploadStatus>{
 const row=(await db.query<any>('SELECT * FROM pbj_uploads WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];if(!row)throw new Error('Upload not found');
 const file=path.join(root,id);
 if(row.status==='complete'){await cleanupStaging(file);return uploadStatus(row);}
 if(row.status!=='receiving'||Number(row.received_bytes)!==Number(row.byte_count))throw new Error('Upload incomplete');
 let invalid=false;
 try{invalid=(await stat(file)).size!==Number(row.byte_count)||await hashFile(file)!==row.sha256;}
 catch(error:any){if(error.code!=='ENOENT')throw error;invalid=true;}
 if(invalid){
  await resetFailedBytes(db,owner,row,file);
  throw new Error('Original file checksum failed; upload offset reset to 0. Retry the original; no analysis was submitted');
 }
 const media=await inspectMedia(file),key=createHash('sha256').update(owner).digest('hex')+'/'+row.sha256+'.original';
 await storage.put(key,file);
 const result=await transaction(db,async tx=>{
  const current=(await tx.query<any>('SELECT * FROM pbj_uploads WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,id])).rows[0];if(!current)throw new Error('Upload not found');
  if(current.status==='complete')return uploadStatus(current);
  if(current.status!=='receiving'||Number(current.received_bytes)!==Number(current.byte_count))throw new Error('Upload offset changed during completion; refresh status');
  await tx.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,media_start_ticks,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,original_sha256) DO NOTHING`,[randomUUID(),owner,row.sha256,row.file_name,key,media.duration,media.mediaStart,JSON.stringify({originalByteCount:Number(row.byte_count),originalAudio:media.hasAudio,kind:media.kind,probe:media.probe})]);
  const asset=(await tx.query<any>('SELECT id FROM pbj_assets WHERE owner_id=$1 AND original_sha256=$2',[owner,row.sha256])).rows[0];
  await tx.query(`UPDATE pbj_uploads SET status='complete',asset_id=$3 WHERE owner_id=$1 AND id=$2`,[owner,id,asset.id]);
  return {id,assetID:asset.id,receivedBytes:Number(row.byte_count),status:'complete'};
 });
 await cleanupStaging(file);
 return result;
}
export async function finishUpload(db:Database,owner:string,id:string,root:string,storage:ObjectStore):Promise<UploadStatus>{
 const entries=tasks(completions,db),key=JSON.stringify([owner,id]);const existing=entries.get(key);if(existing)return existing;
 const pending=serialize(db,owner,id,()=>finalize(db,owner,id,root,storage));entries.set(key,pending);
 try{return await pending;}finally{if(entries.get(key)===pending)entries.delete(key);}
}
