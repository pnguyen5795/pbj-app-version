import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {analysisMedia,hashFile,inspectMedia} from '../src/v2/media.ts';

test('a damaged cached analysis derivative is preserved and repaired before any provider submission',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-derivative-'));
 try {
  const original=path.join(directory,'original.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x240:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-c:v','libx264','-c:a','aac',original]);
  const originalHash=await hashFile(original),cached=path.join(directory,originalHash+'.analysis-v3.mp4');
  const damaged=Buffer.from('interrupted cached file');await writeFile(cached,damaged);
  assert.equal(await analysisMedia(original,directory,originalHash),cached);
  const inspected=await inspectMedia(cached);assert.equal(inspected.hasAudio,true);assert.ok(Math.abs(inspected.duration-240000)<6000);
  const preserved=(await readdir(directory)).find(file=>file.startsWith(path.basename(cached)+'.invalid-'));assert.ok(preserved);
  assert.deepEqual(await readFile(path.join(directory,preserved)),damaged);
  assert.equal(await hashFile(original),originalHash);
  const normalizedHash=await hashFile(cached);await analysisMedia(original,directory,originalHash);assert.equal(await hashFile(cached),normalizedHash);
 }finally{await rm(directory,{recursive:true,force:true});}
});
