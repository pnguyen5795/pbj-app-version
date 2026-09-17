import { createReadStream } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat,mkdir,rename,rm } from 'node:fs/promises';
import path from 'node:path';
const execute=promisify(execFile);
export async function hashFile(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export async function inspectMedia(file:string){
 const {stdout}=await execute('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{maxBuffer:2*1024*1024,timeout:120000});
 const probe=JSON.parse(stdout);const video=probe.streams.find((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic);const audio=probe.streams.find((s:any)=>s.codec_type==='audio');
 const isImage=!!video&&!audio&&(/^(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|heif|avif)/.test(probe.format.format_name??'')||/^(heic|heix|mif1|avif)/.test(probe.format.tags?.major_brand??''));
 const track=video??audio;if(!track)throw new Error('No readable media track');
 const kind=isImage?'image':video?'video':'audio';
 const duration=isImage?1:Number(track.duration??probe.format.duration),start=isImage?0:Number(track.start_time??0);
 if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(start))throw new Error('Invalid media timing');
 return {duration:Math.round(duration*60000),mediaStart:Math.round(start*60000),hasAudio:!!audio,kind,probe};
}
export async function analysisMedia(original:string,cache:string,sha:string){
 const destination=path.join(cache,sha+'.analysis-v3.mp4');await mkdir(cache,{recursive:true});
 const before=await inspectMedia(original);const seconds=before.duration/60000;
 const start=before.mediaStart/60000,video=before.probe.streams.find((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic),audio=before.probe.streams.find((s:any)=>s.codec_type==='audio');
 if(!video)throw new Error('Video analysis requires a video track');
 if(seconds>7200)throw new Error('Source exceeds the current analysis model duration limit; original remains available for manual editing');
 const padded=Math.max(4,seconds);
 async function verify(file:string){
  const after=await inspectMedia(file);
  if(after.kind!=='video'||Math.abs(after.mediaStart)>600||Math.abs(after.duration-padded*60000)>6000||(before.hasAudio&&!after.hasAudio))throw new Error('Analysis derivative lost audio or timing');
  if((await stat(file)).size>2_000_000_000)throw new Error('Prepared analysis exceeds provider size limit');
 }
 let cached=false;try{await stat(destination);cached=true;}catch(error:any){if(error.code!=='ENOENT')throw error;}
 if(cached){
  try{await verify(destination);return destination;}catch{
   // This is a rebuildable derivative, not a provider receipt or baseline.
   // Preserve the damaged bytes for recovery; repair locally before submission.
   await rename(destination,destination+'.invalid-'+randomUUID());
  }
 }
 const temporary=path.join(cache,sha+'.'+randomUUID()+'.mp4');
 try{
  await execute('ffmpeg',['-v','error',...mediaWindowInput(original,start),'-map',`0:${video.index}`,...(audio?['-map',`0:${audio.index}`]:[]),'-vf',`trim=start=${start}:end=${start+seconds},setpts=PTS-${start}/TB,`+"scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=w='ceil(max(360,max(iw,ih/2.4))/2)*2':h='ceil(max(360,max(ih,iw/2.4))/2)*2':x=(ow-iw)/2:y=(oh-ih)/2"+(seconds<4?`,tpad=stop_mode=clone:stop_duration=${4-seconds}`:''),...(audio?['-af',audioWindowFilter(start,seconds,padded)]:[]),'-t',String(padded),'-c:v','libx264','-crf','23','-maxrate','2M','-bufsize','4M','-c:a','aac','-b:a','128k','-movflags','+faststart',temporary],{timeout:2*60*60*1000,maxBuffer:1024*1024});
  await verify(temporary);
  await rename(temporary,destination);return destination;
 }catch(error){await rm(temporary,{force:true});throw error;}
}
// Seek efficiently in original timestamps, then give video and audio the same
// origin. Resetting each stream to its own STARTPTS would shift delayed audio.
export function mediaWindowInput(file:string,start:number){return ['-copyts','-seek_timestamp','1','-ss',String(start),'-i',file];}
export function audioWindowFilter(start:number,duration:number,padded=duration){return `atrim=start=${start}:end=${start+duration},asetpts=PTS-${start}/TB,aresample=async=1:first_pts=0,apad=whole_dur=${padded}`;}
export async function thumbnail(file:string,cache:string,sha:string,ticks:number){
 await mkdir(cache,{recursive:true});const target=path.join(cache,sha+'-aligned-v2-'+ticks+'.jpg');
 try{await stat(target);return target;}catch(error:any){if(error.code!=='ENOENT')throw error;}
 const temporary=target+'.'+randomUUID()+'.jpg';
 try{const media=await inspectMedia(file),video=media.probe.streams.find((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic);if(!video)throw new Error('Thumbnail requires a video or image track');await execute('ffmpeg',['-v','error',...mediaWindowInput(file,(media.mediaStart+ticks)/60000),'-map',`0:${video.index}`,'-frames:v','1','-vf','scale=320:320:force_original_aspect_ratio=decrease','-q:v','3',temporary],{timeout:120000,maxBuffer:1024*1024});await rename(temporary,target);return target;}
 catch(error){await rm(temporary,{force:true});throw error;}
}
