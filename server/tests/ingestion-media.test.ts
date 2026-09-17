import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {analysisMedia,hashFile,inspectMedia,thumbnail} from '../src/v2/media.ts';
import {prepareSpeechChunk,type SpeechChunk} from '../src/v2/captions.ts';
const run=promisify(execFile);
async function offsetFixture(directory:string){
 const file=path.join(directory,'offset.mov');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=160x120:r=10:d=1','-f','lavfi','-i','color=blue:s=160x120:r=10:d=1',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
  '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0,setpts=PTS+2/TB[v];[2:a][3:a]concat=n=2:v=0:a=1[a]',
  '-map','[v]','-map','[a]','-c:v','libx264','-c:a','aac','-fps_mode','vfr',file]);
 return file;
}
async function samples(file:string,start:number,duration=.25){
 const {stdout}=await run('ffmpeg',['-v','error','-ss',String(start),'-i',file,'-t',String(duration),'-map','0:a:0','-ac','1','-ar','16000','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:1024*1024});
 return Array.from({length:stdout.length/2},(_,i)=>stdout.readInt16LE(i*2));
}
function frequency(values:number[]){return values.slice(1).filter((v,i)=>v>=0&&values[i]<0).length/(values.length/16000);}
const chunk=(id:string):SpeechChunk=>({id,owner_id:'fixture',asset_id:'fixture',chunk_index:0,core_start:0,core_end:2,window_start:0,window_end:2,status:'reserved',full_response:null});

test('analysis starts at the video track origin and preserves picture/audio alignment',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-ingest-offset-'));try{
  const original=await offsetFixture(directory),hash=await hashFile(original);
  assert.equal((await inspectMedia(original)).mediaStart,120000);
  const prepared=await analysisMedia(original,directory,hash);
  assert.equal((await inspectMedia(prepared)).mediaStart,0);
  for(const [second,channel] of [[.5,0],[1.5,2],[3.5,2]]){
   const {stdout}=await run('ffmpeg',['-v','error','-ss',String(second),'-i',prepared,'-frames:v','1','-vf','scale=2:2,format=rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer'});
   assert.ok(stdout[channel]>150&&stdout[channel===0?2:0]<60,`Correct source frame at ${second}s, including end hold`);
  }
  assert.ok(Math.abs(frequency(await samples(prepared,.3))-880)<12,'Audio before the video origin must not be analyzed as source audio');
  const preview=await thumbnail(original,directory,hash,90000);
  const {stdout:previewRGB}=await run('ffmpeg',['-v','error','-i',preview,'-frames:v','1','-vf','scale=2:2,format=rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer'});
  assert.ok(previewRGB[2]>150&&previewRGB[0]<60,'Thumbnails seek relative to video start too');
  assert.equal(await hashFile(original),hash,'Original bytes remain unchanged');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('speech windows use the same video-relative origin as the timeline',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-ingest-speech-'));try{
  const original=await offsetFixture(directory);
  const speech=await prepareSpeechChunk(original,chunk('offset-speech'),directory);
  assert.ok(Math.abs(frequency(await samples(speech,.3))-880)<12,'Source-relative speech must exclude the earlier 440Hz audio');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('late source audio retains its leading silence in analysis and speech derivatives',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-ingest-late-audio-'));try{
  const original=path.join(directory,'late.mov');
  await run('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=160x120:r=10:d=2','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1',
   '-filter_complex','[1:a]asetpts=PTS+1/TB[a]','-map','0:v','-map','[a]','-c:v','libx264','-c:a','aac',original]);
  const prepared=await analysisMedia(original,directory,await hashFile(original));
  const speech=await prepareSpeechChunk(original,chunk('late-speech'),directory);
  for(const file of [prepared,speech]){
   const early=await samples(file,.25),late=await samples(file,1.25);
   assert.ok(early.length>3000&&Math.max(...early.map(Math.abs))<100,'Keep initial silence rather than pulling late audio to zero');
   assert.ok(Math.abs(frequency(late)-880)<12,'The later tone stays at its original relative time');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('later speech windows seek to the correct source time and repair truncated cached audio',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-ingest-window-'));try{
  const original=await offsetFixture(directory),later={...chunk('later'),window_start:1,window_end:2};
  const speech=await prepareSpeechChunk(original,later,directory);
  assert.ok(Math.abs(frequency(await samples(speech,.3))-880)<12);
  assert.equal((await inspectMedia(speech)).duration,60000);
  const firstStat=await stat(speech);assert.equal(await prepareSpeechChunk(original,later,directory),speech);
  assert.equal((await stat(speech)).mtimeMs,firstStat.mtimeMs,'Healthy cache is not encoded again');
  await writeFile(speech,'interrupted wav');
  assert.equal(await prepareSpeechChunk(original,later,directory),speech);
  assert.ok(Math.abs(frequency(await samples(speech,.3))-880)<12);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a source audio track outside the video range produces silence without failing ingestion',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-ingest-outside-audio-'));try{
  const original=path.join(directory,'outside.mov');
  await run('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:s=160x120:r=10:d=2','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1',
   '-filter_complex','[0:v]setpts=PTS+2/TB[v]','-map','[v]','-map','1:a','-c:v','libx264','-c:a','aac','-fps_mode','vfr',original]);
  for(const file of [await analysisMedia(original,directory,await hashFile(original)),await prepareSpeechChunk(original,chunk('outside'),directory)]){
   const values=await samples(file,.3);assert.ok(values.length>3000&&Math.max(...values.map(Math.abs))<100);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
