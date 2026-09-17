import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
export interface Fingerprint {second:number;bits:number[];contrast:number;}
export interface VisualMatch {finalStart:number;finalEnd:number;rawAssetID:string;rawStart:number;rawEnd:number;confidence:'moderate';method:string;}
const method='one-second-difference-hash-sequences-v1';
function fingerprint(bytes:Buffer,second:number):Fingerprint {
 const bits=Array<number>(8).fill(0);let index=0,sum=0,squares=0;
 for(const value of bytes){sum+=value;squares+=value*value;}
 for(let y=0;y<16;y++)for(let x=0;x<15;x++,index++)if(bytes[y*16+x]>bytes[y*16+x+1])bits[index>>>5]|=1<<(index&31);
 return {second,bits,contrast:Math.sqrt(Math.max(0,squares/256-(sum/256)**2))};
}
function popcount(n:number){n-=n>>>1&0x55555555;n=(n&0x33333333)+(n>>>2&0x33333333);return (((n+(n>>>4))&0x0f0f0f0f)*0x01010101)>>>24;}
function distance(a:Fingerprint,b:Fingerprint){return a.bits.reduce((sum,word,i)=>sum+popcount(word^b.bits[i]),0)/240;}
export function matchSequences(final:Fingerprint[],raw:{assetID:string;frames:Fingerprint[]}[]):VisualMatch[]{
 const hits:{final:number;raw:number;assetID:string}[]=[];
 for(const frame of final){
  if(frame.contrast<12)continue;
  let best=Infinity,candidate:{final:number;raw:number;assetID:string}|undefined;
  for(const source of raw)for(const original of source.frames){if(original.contrast<12)continue;const score=distance(frame,original);if(score<best){best=score;candidate={final:frame.second,raw:original.second,assetID:source.assetID};}}
  if(!candidate||best>.10)continue;
  let alternative=Infinity;
  for(const source of raw)for(const original of source.frames){if(source.assetID===candidate.assetID&&Math.abs(original.second-candidate.raw)<=2)continue;alternative=Math.min(alternative,distance(frame,original));}
  if(alternative-best<.025)continue;hits.push(candidate);
 }
 const matches:VisualMatch[]=[];let run:typeof hits=[];
 const emit=()=>{if(run.length>=3){const first=run[0],last=run.at(-1)!;matches.push({finalStart:first.final,finalEnd:last.final,rawAssetID:first.assetID,rawStart:first.raw,rawEnd:last.raw,confidence:'moderate',method});}run=[];};
 for(const hit of hits){const prior=run.at(-1);if(prior&&(hit.assetID!==prior.assetID||hit.final-prior.final!==1||Math.abs((hit.raw-prior.raw)-1)>.1))emit();run.push(hit);}emit();return matches;
}
async function frames(file:string,crop:boolean):Promise<Fingerprint[]> {
 const filter="setpts=PTS-STARTPTS,fps=1:start_time=0,"+(crop?"crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',":"")+'scale=16:16,format=gray';
 const child=spawn('ffmpeg',['-v','error','-i',file,'-an','-vf',filter,'-f','rawvideo','pipe:1'],{stdio:['ignore','pipe','pipe']});
 const completion=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Visual matching decode failed')));});completion.catch(()=>{});
 child.stderr.resume();const timeout=setTimeout(()=>child.kill(),2*60*60*1000);const result:Fingerprint[]=[];let pending=Buffer.alloc(0);
 try{for await(const chunk of child.stdout){pending=Buffer.concat([pending,chunk]);while(pending.length>=256){result.push(fingerprint(pending.subarray(0,256),result.length));pending=pending.subarray(256);}}await completion;if(pending.length)throw new Error('Incomplete visual matching frame');return result;}finally{clearTimeout(timeout);}
}
async function cached(file:string,sha:string,cache:string,crop:boolean){
 await mkdir(cache,{recursive:true});const name=path.join(cache,sha+'.'+method+(crop?'.crop':'')+'.json');
 try{return JSON.parse(await readFile(name,'utf8')) as Fingerprint[];}catch(error:any){if(error.code!=='ENOENT')throw error;}
 const result=await frames(file,crop),temporary=name+'.'+randomUUID();try{await writeFile(temporary,JSON.stringify(result));await rename(temporary,name);}catch(error){await rm(temporary,{force:true});throw error;}return result;
}
export async function teachingCorrespondence(group:any,assets:any[],resolve:(asset:any)=>Promise<string>,cache:string){
 if(!group.raw_asset_ids.length)return {method,matches:[],uncertainties:['Finished-only reference: rejected raw material cannot be inferred.']};
 const finalAsset=assets.find(a=>a.id===group.final_asset_id);const final=await cached(await resolve(finalAsset),finalAsset.original_sha256,cache,false);
 const raw=[];for(const asset of assets.filter(a=>group.raw_asset_ids.includes(a.id))){const file=await resolve(asset);raw.push({assetID:asset.id,frames:await cached(file,asset.original_sha256,cache,false)},{assetID:asset.id,frames:await cached(file,asset.original_sha256,cache,true)});}
 return {method,matches:matchSequences(final,raw),uncertainties:['Matches locate sustained visual correspondence to roughly one second; they are not exact trim boundaries. Unmatched footage may be cropped, transformed, sped up, too short, or visually ambiguous. Absence of a match does not prove rejection.']};
}
