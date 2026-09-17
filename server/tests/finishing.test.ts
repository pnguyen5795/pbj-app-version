import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/v2/database.ts';
import type {Database} from '../src/v2/database.ts';
import {advanceSpeech} from '../src/v2/captions.ts';
import {validateTimeline} from '../src/v2/contracts.ts';
import {compileEditorialPlan} from '../src/v2/planner.ts';
const video={id:'v',fileName:'v.mov',sha256:'a',duration:600000,mediaStart:0,hasAudio:true};
const clip={id:'c',sourceID:'v',sourceIn:0,sourceDuration:120000,outputStart:0,volume:1,muted:false,fit:'fit' as const,speed:2};
const overlay={id:'o',kind:'text' as const,start:0,end:60000,text:'Hello',x:.5,y:.8,width:.8,rotation:0,opacity:1,fontSize:56,style:'Classic' as const,color:'#FFFFFF'};
test('finishing survives rough-cut recompilation and rejects foreign sources',()=>{
 const timeline={schemaVersion:2 as const,id:'t',width:1080,height:1920,fps:30,clips:[clip],sounds:[{id:'sound',sourceID:'v',sourceIn:0,sourceDuration:120000,outputStart:0,volume:.5}],overlays:[overlay]};
 validateTimeline(timeline,[video]);
 assert.throws(()=>validateTimeline({...timeline,sounds:[{...timeline.sounds[0],sourceID:'foreign'}]},[video]),/sound/);
 assert.throws(()=>validateTimeline({...timeline,overlays:[{...overlay,kind:'video',sourceID:'foreign'}]},[video]),/unavailable/);
 const plan=compileEditorialPlan({shots:[{retainedClipID:'c',sourceID:'v',sourceStartSeconds:0,sourceEndSeconds:2,volume:1,muted:false,fit:'fit',evidenceIDs:[],memoryIDs:[],reason:'keep'}],summary:'keep',discrepancies:[]},{brief:'keep',eligibleSources:[video],analysis:[],memory:[],required:[],baseTimeline:timeline});
 assert.deepEqual(plan.timeline.overlays,timeline.overlays);assert.deepEqual(plan.timeline.sounds,timeline.sounds);assert.equal(plan.timeline.clips[0].speed,2);
});
test('speech chunks reuse saved words and merge overlapping windows without duplicate seam words',async()=>{
 const db=new PGlite();try{await migrate(db as Database);
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata) VALUES('v','alice','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v.mov','a.original',36120000,'{"originalAudio":true}')`);
 let calls=0;
 const submit=async(chunk:any)=>{calls++;return {text:'words',words:chunk.chunk_index===0?[{word:'first',start:1,end:2},{word:'seam',start:300.1,end:300.3}]:chunk.chunk_index===1?[{word:'seam',start:1.1,end:1.3},{word:'middle',start:50,end:51}]:[{word:'last',start:1,end:2}]};};
 assert.equal((await advanceSpeech(db as Database,'alice','v',submit)).complete,false);
 assert.equal((await advanceSpeech(db as Database,'alice','v',submit)).complete,false);
 const result=await advanceSpeech(db as Database,'alice','v',submit);assert.equal(result.complete,true);assert.deepEqual(result.evidence?.words.map((w:any)=>w.word),['first','seam','middle','last']);assert.equal(result.evidence?.words[1].start,300.1);
 await advanceSpeech(db as Database,'alice','v',submit);assert.equal(calls,3);
 await assert.rejects(()=>advanceSpeech(db as Database,'bob','v',submit),/unavailable/);
 }finally{await db.close();}
});
test('an uncertain speech submission never automatically posts again',async()=>{
 const db=new PGlite();try{await migrate(db as Database);await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata) VALUES('v','alice','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v.mov','a.original',600000,'{"originalAudio":true}')`);
 let calls=0;const submit=async()=>{calls++;throw new Error('network interrupted');};
 await assert.rejects(()=>advanceSpeech(db as Database,'alice','v',submit),/network/);await assert.rejects(()=>advanceSpeech(db as Database,'alice','v',submit),/unresolved/);assert.equal(calls,1);
 }finally{await db.close();}
});

test('visual correspondence requires sustained, unambiguous matches within declared sources',async()=>{
 const {matchSequences}=await import('../src/v2/correspondence.ts');
 const frames=Array.from({length:5},(_,i)=>({second:i,bits:Array.from({length:8},(_,j)=>Math.imul((i+1)*(j+37),0x9e3779b1)),contrast:40}));
 const matches=matchSequences(frames,[{assetID:'raw',frames:frames.map(f=>({...f,second:f.second+10}))}]);
 assert.equal(matches.length,1);assert.equal(matches[0].rawStart,10);assert.equal(matches[0].finalStart,0);
 assert.deepEqual(matchSequences(frames,[{assetID:'raw',frames},{assetID:'duplicate-looking',frames}]),[]);
 assert.deepEqual(matchSequences(frames.slice(0,2),[{assetID:'raw',frames}]),[]);
});

test('local speech preparation errors remain resumable before any provider submission',async()=>{
 const db=new PGlite();try{await migrate(db as Database);await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata) VALUES('v','alice','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v.mov','a.original',600000,'{"originalAudio":true}')`);
 let calls=0;const submit=async()=>{calls++;return {text:'hello',words:[{word:'hello',start:1,end:2}]};};
 await assert.rejects(()=>advanceSpeech(db as Database,'alice','v',submit,async()=>{throw new Error('local disk full');}),/disk/);
 assert.equal(calls,0);assert.equal((await advanceSpeech(db as Database,'alice','v',submit)).complete,true);assert.equal(calls,1);
 }finally{await db.close();}
});

test('short analysis padding never becomes source footage or an editorial minimum',async()=>{
 const {normalizeAnalysisEvidence}=await import('../src/v2/contracts.ts');
 const evidence=normalizeAnalysisEvidence({schemaVersion:1,summary:'brief action',scenes:[{id:'real',start:0,end:4,visual:'action',audio:'click',speech:'',confidence:'moderate'},{id:'pad',start:2,end:4,visual:'held frame',audio:'silence',speech:'',confidence:'weak'}],observations:[{statement:'hold',context:'padding',sceneIDs:['pad'],confidence:'weak'}],uncertainties:[]},1,4);
 assert.equal(evidence.scenes.length,1);assert.equal(evidence.scenes[0].end,1);assert.equal(evidence.observations.length,0);
 assert.equal(validateTimeline({schemaVersion:2,id:'short',width:1080,height:1920,fps:30,clips:[{...clip,sourceDuration:600,speed:1}]},[video]).clips[0].sourceDuration,600);
});

test('scoped revisions compare values rather than PostgreSQL JSON property order',async()=>{
 const {OpenAIPlanner}=await import('../src/v2/planner.ts');
 const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,reorder(item)])):value;
 const base=reorder({schemaVersion:2,id:'base',width:1080,height:1920,fps:30,clips:[clip],overlays:[overlay]});
 const input={brief:'Leave this clip as it is',eligibleSources:[video],analysis:[],memory:[],required:[],baseTimeline:base,scopeClipIDs:[]};
 const data={shots:[{retainedClipID:'c',sourceID:'v',sourceStartSeconds:0,sourceEndSeconds:2,volume:1,muted:false,fit:'fit',evidenceIDs:[],memoryIDs:[],reason:'kept'}],summary:'kept',discrepancies:[]};
 assert.doesNotThrow(()=>new OpenAIPlanner('unused','unused').validateEditorial(input,data,{}));
 assert.throws(()=>new OpenAIPlanner('unused','unused').validateEditorial(input,{...data,shots:data.shots.map(s=>({...s,sourceEndSeconds:1}))},{}),/unrelated/);
});
