import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OpenAIPlanner } from '../src/v2/planner.ts';
import type { PlanningInput } from '../src/v2/planner.ts';
const planner=new OpenAIPlanner('not-used','not-used');
const input:PlanningInput={brief:'Short moment',eligibleSources:[{id:'a',duration:600000,mediaStart:0,hasAudio:true,fileName:'a.mov',sha256:'a'}],analysis:[],memory:[],required:[],durationGoal:{seconds:3,mode:'preferred',toleranceSeconds:0.5},speechTiming:[{id:'speech',version:1,sourceID:'a',evidence:{text:'Hello',words:[{word:'Hello',start:2,end:3}]}}]};
function plan(){return {timeline:{schemaVersion:1,id:'new',parentID:null,width:1080,height:1920,fps:30,clips:[{id:'c',sourceID:'a',sourceIn:60000,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fill'}]},summary:'Short moment',decisions:[{clipID:'c',evidenceIDs:['speech'],memoryIDs:[],reason:'Complete utterance'}],discrepancies:[]};}
test('planner preserves whole timed words and validates audio-required moments',()=>{
 const result=planner.validate({...input,required:[{sourceID:'a',start:120000,end:180000,audioRequired:true}]},plan(),{});
 assert.equal(result.quality.durationSeconds,3);
 const chopped=plan();chopped.timeline.clips[0].sourceIn=150000;
 assert.throws(()=>planner.validate(input,chopped,{}),/interrupts a timed word/);
 const muted=plan();muted.timeline.clips[0].muted=true;
 assert.throws(()=>planner.validate({...input,required:[{sourceID:'a',start:120000,end:180000,audioRequired:true}]},muted,{}),/Required moment/);
});
test('planner requires exactly one source-correct decision per clip',()=>{
 const wrong={...input,speechTiming:[{...input.speechTiming![0],sourceID:'reference'}]};
 assert.throws(()=>planner.validate(wrong,plan(),{}),/wrong-source/);
 const missing=plan();missing.decisions=[];
 assert.throws(()=>planner.validate(input,missing,{}),/Every clip/);
 const duplicate=plan();duplicate.decisions.push(duplicate.decisions[0]);
 assert.throws(()=>planner.validate(input,duplicate,{}),/duplicates/);
});
test('preferred duration is reported honestly while exact duration is enforced',()=>{
 const longer=plan();longer.timeline.clips[0].sourceDuration=360000;
 const result=planner.validate(input,longer,{});
 assert.equal(result.quality.durationWithinGoal,false);
 assert.ok(result.discrepancies.some(d=>d.includes('6.00s')));
 assert.throws(()=>planner.validate({...input,durationGoal:{seconds:3,mode:'exact',toleranceSeconds:0.05}},longer,{}),/Exact/);
});

import { compileEditorialPlan,editorialPlanSchema,planningSecondsInput } from '../src/v2/planner.ts';
function editorial(){return {shots:[{retainedClipID:null as string|null,sourceID:'a',sourceStartSeconds:1,sourceEndSeconds:4,volume:1,muted:false,fit:'fill',evidenceIDs:['speech'],memoryIDs:[],reason:'Complete utterance'}],summary:'Three seconds',discrepancies:[]};}
test('seconds plan compiles source ranges and contiguous placements without model arithmetic',()=>{
 const cut=editorial();cut.shots.push({...cut.shots[0],sourceStartSeconds:4.1,sourceEndSeconds:5.2});
 const result=planner.validateEditorial(input,cut,{});
 assert.deepEqual(result.timeline.clips.map(c=>[c.sourceIn,c.sourceDuration,c.outputStart]),[[60000,180000,0],[246000,66000,180000]]);
 assert.equal(new Set(result.timeline.clips.map(c=>c.id)).size,2);
 const seconds=planningSecondsInput({...input,required:[{sourceID:'a',start:120000,end:180000}]});
 assert.equal(seconds.eligibleSources[0].durationSeconds,10);
 assert.equal(seconds.required[0].startSeconds,2);
 assert.ok(!('duration' in seconds.eligibleSources[0]));
});
test('provider plan contract only permits project video and retained clip IDs',()=>{
 const base=plan().timeline;
 const constrained={...input,eligibleSources:[...input.eligibleSources,{id:'audio',duration:60000,mediaStart:0,hasAudio:true,kind:'audio' as const,fileName:'audio.wav',sha256:'b'}],baseTimeline:base as any};
 const schema:any=z.toJSONSchema(editorialPlanSchema(constrained));
 const shot=schema.properties.shots.items.properties;
 assert.equal(shot.sourceID.const,'a');
 assert.deepEqual(shot.retainedClipID.anyOf.find((entry:any)=>entry.enum)?.enum,['c']);
 assert.deepEqual(shot.evidenceIDs.items.enum,['speech']);
 const invalid=editorial();invalid.shots[0].sourceID='not-a-project-source';
 assert.throws(()=>compileEditorialPlan(invalid,constrained),/sourceID/);
 const invented=editorial();invented.shots[0].evidenceIDs=['invented'];
 assert.throws(()=>compileEditorialPlan(invented,constrained),/evidenceIDs/);
});
test('seconds compiler rejects overflow, reversed, sub-tick and unknown retained ranges',()=>{
 for(const [start,end] of [[9,10.001],[4,3],[1,1.000001],[1,Number.MAX_SAFE_INTEGER]]){
  const cut=editorial();cut.shots[0].sourceStartSeconds=start;cut.shots[0].sourceEndSeconds=end;
  assert.throws(()=>compileEditorialPlan(cut,input),/Invalid editorial/);
 }
 const cut=editorial();cut.shots[0].retainedClipID='missing';
 assert.throws(()=>compileEditorialPlan(cut,input),/expected null/);
});

test('editorial replay expands audible endpoints to whole words and rebuilds placements',()=>{
 const cut=editorial();cut.shots[0].sourceStartSeconds=2.5;cut.shots[0].sourceEndSeconds=5.5;
 cut.shots.push({...editorial().shots[0],sourceStartSeconds:7,sourceEndSeconds:8});
 const timed={...input,speechTiming:[{...input.speechTiming![0],evidence:{text:'Hello there',words:[{word:'Hello',start:2,end:3},{word:'there',start:5,end:6}]}}]};
 const result=planner.validateEditorial(timed,cut,{saved:true});
 assert.deepEqual(result.timeline.clips.map(c=>[c.sourceIn,c.sourceDuration,c.outputStart]),[[120000,240000,0],[420000,60000,240000]]);
 assert.equal(result.quality.durationSeconds,5);
 assert.ok(result.discrepancies.some(d=>d.includes('Speech boundary adjustment')));
 assert.match(result.summary,/5.00 seconds/);
 assert.equal(cut.shots[0].sourceStartSeconds,2.5); // saved provider data remains unchanged
 assert.throws(()=>planner.validateEditorial({...timed,durationGoal:{seconds:4,mode:'exact',toleranceSeconds:.05}},cut,{}),/Exact/);
});
test('word expansion handles overlapping intervals and rejects source overflow',()=>{
 const cut=editorial();cut.shots[0].sourceStartSeconds=2.5;cut.shots[0].sourceEndSeconds=5.5;
 const timed={...input,speechTiming:[{...input.speechTiming![0],evidence:{text:'overlap',words:[{word:'one',start:1,end:2.2},{word:'two',start:2,end:3},{word:'three',start:5,end:6},{word:'four',start:5.9,end:7}]}}]};
 const result=planner.validateEditorial(timed,cut,{});
 assert.equal(result.timeline.clips[0].sourceIn,60000);
 assert.equal(result.timeline.clips[0].sourceDuration,360000);
 const overflow={...input,speechTiming:[{...input.speechTiming![0],evidence:{text:'word',words:[{word:'word',start:5,end:11}]}}]};
 assert.throws(()=>planner.validateEditorial(overflow,cut,{}),/source bounds/);
});
test('muted shots keep their exact editorial ranges',()=>{
 const cut=editorial();cut.shots[0].sourceStartSeconds=2.5;cut.shots[0].muted=true;
 const result=planner.validateEditorial(input,cut,{});
 assert.equal(result.timeline.clips[0].sourceIn,150000);
 assert.equal(result.discrepancies.filter(d=>d.includes('Speech boundary adjustment')).length,0);
});
test('word repair cannot alter a retained clip outside revision scope',()=>{
 const base=plan().timeline;base.clips[0].sourceIn=150000;
 const cut=editorial();cut.shots[0].retainedClipID='c';cut.shots[0].sourceStartSeconds=2.5;cut.shots[0].sourceEndSeconds=5.5;
 const compiled=compileEditorialPlan(cut,{...input,baseTimeline:base as any,scopeClipIDs:['other']});
 assert.equal(compiled.timeline.clips[0].sourceIn,150000);
 assert.throws(()=>planner.validateEditorial({...input,baseTimeline:base as any,scopeClipIDs:['other']},cut,{}),/interrupts a timed word/);
});
