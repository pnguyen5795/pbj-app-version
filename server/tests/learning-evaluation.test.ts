import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {evaluateLearningComparison} from '../src/v2/learningEvaluation.ts';
import {evaluateLearningFiles} from '../scripts/evaluate-learning.ts';
import type {SavedLearningRun} from '../src/v2/learningEvaluation.ts';

function comparison(){
 const memoryOff:SavedLearningRun={model:'saved-model',plannerVersion:'planner-v1',input:{brief:'A short flight moment',
  eligibleSources:[{id:'raw',fileName:'raw.mov',sha256:'a'.repeat(64),duration:600000,mediaStart:0,hasAudio:false}],analysis:[],required:[],memory:[]},
  result:{timeline:{schemaVersion:1,id:'off',parentID:null,width:1080,height:1920,fps:30,clips:[{id:'off-clip',sourceID:'raw',sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fit'}]},
   summary:'Flight moment',discrepancies:[],decisions:[{clipID:'off-clip',evidenceIDs:[],memoryIDs:[],reason:'A brief-led flight moment'}]}};
 const memoryOn=structuredClone(memoryOff);
 memoryOn.input.memory=[{id:'lesson',version:1,kind:'personal_lesson',context:'flight',statement:'Shorter setup in flight edits',strength:'weak',attribution:'Your feedback',project_scope:null,provenance:{},root_evidence_ids:['feedback-from-another-project']}];
 (memoryOn.result as any).timeline.id='on';(memoryOn.result as any).timeline.clips[0].id='on-clip';
 (memoryOn.result as any).decisions[0].clipID='on-clip';(memoryOn.result as any).decisions[0].memoryIDs=['lesson'];
 return {caseID:'flight-held-out-1',memoryOff,memoryOn};
}
test('matched saved runs distinguish citation plumbing from unmeasured creative quality and ignore ID-only changes',()=>{
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Network is forbidden');};
 try{
  const sample=comparison(),report=evaluateLearningComparison(sample);
  assert.equal(report.mechanism.memoryWasCited,true);
  assert.equal(report.mechanism.memoryApplicabilityChecked,true);
  assert.equal(report.mechanism.legacyMemoryWithoutApplicability,1);
  assert.equal(report.mechanism.timelineContentChanged,false);
  assert.equal(report.creativeQuality.status,'not-measured');
  assert.equal((sample.memoryOn.result as any).timeline.id,'on','Never mutate saved result IDs');
  (sample.memoryOn.result as any).decisions[0].memoryIDs=[];
  assert.equal(evaluateLearningComparison(sample).mechanism.memoryWasCited,false,'Providing memory does not prove the planner used it');
 }finally{globalThis.fetch=originalFetch;}
});
test('comparison rejects mismatched inputs, versions, invalid footage, unsupported citations, and held-out leakage',()=>{
 const changed=comparison();changed.memoryOn.input.brief='A different request';assert.throws(()=>evaluateLearningComparison(changed),/Non-memory inputs differ/);
 const model=comparison();model.memoryOn.model='another-model';assert.throws(()=>evaluateLearningComparison(model),/same model/);
 const bounds=comparison();(bounds.memoryOn.result as any).timeline.clips[0].sourceDuration=700000;assert.throws(()=>evaluateLearningComparison(bounds),/Source bounds/);
 const source=comparison();(source.memoryOn.result as any).timeline.clips[0].sourceID='teaching-only';assert.throws(()=>evaluateLearningComparison(source),/ineligible/);
 const citation=comparison();(citation.memoryOn.result as any).decisions[0].memoryIDs=['invented'];assert.throws(()=>evaluateLearningComparison(citation),/unavailable/);
 assert.throws(()=>evaluateLearningComparison({...comparison(),heldOutEvidenceIDs:['feedback-from-another-project']}),/leaked/);
});
test('memory applicability uses the saved brief and footage summaries, while rejecting inactive or unrelated rules',()=>{
 const sample=comparison();
 sample.memoryOn.input.memory[0].learning={facet:'pacing',formats:[],subjects:['golf'],signal:'explicit_feedback',eventID:'feedback',independenceKey:'other-project'};
 assert.throws(()=>evaluateLearningComparison(sample),/does not apply/);
 sample.memoryOn.input.memory[0].learning.subjects=['flight'];
 assert.equal(evaluateLearningComparison(sample).mechanism.legacyMemoryWithoutApplicability,0);
 for(const run of [sample.memoryOff,sample.memoryOn]){
  run.input.brief='Make this shorter';
  run.input.analysis=[{id:'cached-analysis',version:1,sourceID:'raw',evidence:{schemaVersion:1,summary:'A flight approaching the runway',scenes:[],observations:[],uncertainties:[]}}];
  (run.result as any).decisions[0].evidenceIDs=['cached-analysis'];
 }
 assert.equal(evaluateLearningComparison(sample).mechanism.memoryApplicabilityChecked,true,'Cached footage provides applicability context when the brief is generic');
 sample.memoryOn.input.memory[0].enabled=false;
 assert.throws(()=>evaluateLearningComparison(sample),/inactive memory/);
 sample.memoryOn.input.memory[0].enabled=true;
 for(const status of ['superseded','excluded','disabled'] as const){
  sample.memoryOn.input.memory[0].status=status;
  assert.throws(()=>evaluateLearningComparison(sample),/inactive memory/);
 }
 sample.memoryOn.input.memory[0].status='active';
 assert.equal(evaluateLearningComparison(sample).creativeQuality.status,'not-measured');
});
test('human preference and measured correction time stay explicitly reported rather than inferred from valid timelines',()=>{
 const sample=comparison();(sample.memoryOn.result as any).timeline.clips[0].sourceDuration=120000;
 const report=evaluateLearningComparison({...sample,human:{reviewer:'Tester',preferred:'memoryOn',correctionSeconds:{memoryOff:200,memoryOn:120,scope:'story-and-timing'},notes:'Less setup trimming needed.'}});
 assert.equal(report.mechanism.timelineContentChanged,true);
 assert.equal(report.creativeQuality.status,'human-reported');
 if(report.creativeQuality.status==='human-reported'){
  assert.equal(report.creativeQuality.memoryOnSecondsSaved,80);assert.equal(report.creativeQuality.roughCutTimeComparable,true);
 }
 assert.throws(()=>evaluateLearningComparison({...sample,human:{reviewer:'Tester',correctionSeconds:{memoryOff:-1,memoryOn:0,scope:'story-and-timing'}}}));
});
test('file utility reads relative saved artifacts and produces the same offline comparison',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-learning-evaluation-'));
 try{
  const sample=comparison();
  for(const name of ['memoryOff','memoryOn'] as const){await writeFile(path.join(directory,name+'-input.json'),JSON.stringify(sample[name].input));await writeFile(path.join(directory,name+'-result.json'),JSON.stringify(sample[name].result));}
  const run=(name:string)=>({model:'saved-model',plannerVersion:'planner-v1',inputPath:name+'-input.json',resultPath:name+'-result.json'});
  const manifest=path.join(directory,'comparison.json');await writeFile(manifest,JSON.stringify({schemaVersion:1,caseID:sample.caseID,memoryOff:run('memoryOff'),memoryOn:run('memoryOn')}));
  assert.deepEqual(await evaluateLearningFiles(manifest),evaluateLearningComparison(sample));
 }finally{await rm(directory,{recursive:true,force:true});}
});
