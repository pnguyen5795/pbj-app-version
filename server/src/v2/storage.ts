import { createReadStream,constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir,copyFile,stat,open,rename,rm,readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { S3Client,GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectStore { put(key:string,file:string):Promise<void>; materialize(key:string):Promise<string>; signedRead?(key:string):Promise<string>; }
export function safeKey(key:string){if(!/^[a-f0-9/-]+\.[a-z0-9]+$/.test(key)||key.includes('..'))throw new Error('Invalid object key');return key;}
const localWrites=new Map<string,Promise<void>>();
export class LocalObjectStore implements ObjectStore {
  private root:string;
  constructor(root:string){this.root=root;}
  async put(key:string,file:string){
    const target=path.join(this.root,safeKey(key)),directory=path.dirname(target);
    const pending=(localWrites.get(target)??Promise.resolve()).catch(()=>{}).then(async()=>{
      await mkdir(directory,{recursive:true});
      // The personal service is the sole writer of this directory. Serialization
      // means matching temp files belong to interrupted earlier publications.
      const prefix=path.basename(target)+'.';
      const abandoned=(await readdir(directory)).filter(name=>name.startsWith(prefix)&&/^[a-f0-9-]{36}\.tmp$/.test(name.slice(prefix.length)));
      await Promise.all(abandoned.map(name=>rm(path.join(directory,name),{force:true})));
      const temporary=target+'.'+randomUUID()+'.tmp';
      try{
        // Reflink on supported disks avoids a second physical copy; other disks
        // safely fall back to copying. Readers see only a fully published file.
        await copyFile(file,temporary,constants.COPYFILE_FICLONE);
        const handle=await open(temporary,'r');try{await handle.sync();}finally{await handle.close();}
        await rename(temporary,target);
        const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
      }catch(error){await rm(temporary,{force:true});throw error;}
    });
    localWrites.set(target,pending);
    try{await pending;}finally{if(localWrites.get(target)===pending)localWrites.delete(target);}
  }
  async materialize(key:string){const target=path.join(this.root,safeKey(key));await stat(target);return target;}
}
export class S3ObjectStore implements ObjectStore {
  private client:S3Client;
  private bucket:string;private cache:string;
  constructor(bucket:string,cache:string){this.bucket=bucket;this.cache=cache;this.client=new S3Client({region:process.env.AWS_REGION??'us-east-1',endpoint:process.env.S3_ENDPOINT,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='1'});}
  async put(key:string,file:string){await new Upload({client:this.client,params:{Bucket:this.bucket,Key:safeKey(key),Body:createReadStream(file)},queueSize:2,partSize:8*1024*1024,leavePartsOnError:false}).done();}
  async signedRead(key:string){return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:safeKey(key)}),{expiresIn:21600});}
  async materialize(key:string){
    const target=path.join(this.cache,safeKey(key));try{await stat(target);return target;}catch(error:any){if(error.code!=='ENOENT')throw error;}
    await mkdir(path.dirname(target),{recursive:true});
    const {Body}=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));if(!Body)throw new Error('Stored original missing');
    const temporary=target+'.'+crypto.randomUUID()+'.tmp';
    try{await pipeline(Body as any,createWriteStream(temporary,{flags:'wx'}));await (await import('node:fs/promises')).rename(temporary,target);}catch(error){await (await import('node:fs/promises')).rm(temporary,{force:true});throw error;}
    return target;
  }
}
