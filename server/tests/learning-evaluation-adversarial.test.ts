import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {evaluateLearningComparison,type SavedLearningRun} from '../src/v2/learningEvaluation.ts';
import {evaluateLearningFiles} from '../scripts/evaluate-learning.ts';

function sample(){
 const off:SavedLearningRun={model:'saved-model',plannerVersion:'planner-v1',input:{brief:'A chronological flight story',
  eligibleSources:[{id:'raw',fileName:'raw.mov',sha256:'a'.repeat(64),duration:600000,mediaStart:0,hasAudio:false}],
  analysis:[],memory:[],required:[]},result:{timeline:{schemaVersion:1,id:'off',parentID:null,width:1080,height:1920,fps:30,
   clips:[{id:'shot',sourceID:'raw',sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fit'}]},
   summary:'Flight story',discrepancies:[],decisions:[{clipID:'shot',evidenceIDs:[],memoryIDs:[],reason:'Set up the flight'}]}};
 const on=structuredClone(off);on.input.memory=[{id:'lesson',version:1,kind:'personal_lesson',context:'Flight story',
  statement:'Keep enough setup for the landing payoff.',strength:'weak',attribution:'Your exported correction',project_scope:null,
  provenance:{memoryID:'lesson',eventID:'learn-event'},root_evidence_ids:['independent-feedback']}];
 (on.result as any).timeline.id='on';(on.result as any).decisions[0].memoryIDs=['lesson'];
 return {caseID:'adversarial-flight',memoryOff:off,memoryOn:on};
}
const emptyEvidence={schemaVersion:1 as const,summary:'Flight footage',scenes:[],observations:[],uncertainties:[]};

test('duplicate analysis and cross-catalog identifiers cannot claim unambiguous source citations',()=>{
 for(const collision of ['analysis','scene'] as const){
  const pair=sample();
  for(const run of [pair.memoryOff,pair.memoryOn]){
   run.input.eligibleSources.push({...run.input.eligibleSources[0],id:'other',sha256:'b'.repeat(64)});
   run.input.analysis=[
    {id:'shared',version:1,sourceID:'other',evidence:collision==='analysis'?emptyEvidence:{...emptyEvidence,
     scenes:[{id:'scene',start:0,end:1,visual:'Another flight',audio:'',speech:'',confidence:'weak'}]}},
    {id:collision==='analysis'?'shared':'shared:scene',version:1,sourceID:'raw',evidence:emptyEvidence}];
   (run.result as any).decisions[0].evidenceIDs=[collision==='analysis'?'shared':'shared:scene'];
  }
  assert.throws(()=>evaluateLearningComparison(pair),/Duplicate evidence identifier/);
 }
});

test('source identities must identify actual originals even when both supplied inputs match',()=>{
 const pair=sample();for(const run of [pair.memoryOff,pair.memoryOn])run.input.eligibleSources[0].sha256='';
 assert.throws(()=>evaluateLearningComparison(pair),/original SHA-256/);
 const aliases=sample();for(const run of [aliases.memoryOff,aliases.memoryOn])run.input.eligibleSources.push({...run.input.eligibleSources[0],id:'alias'});
 assert.throws(()=>evaluateLearningComparison(aliases),/Duplicate original/);
});

test('saved result identity must match the supplied baseline instead of being silently rewritten',()=>{
 const pair=sample();
 for(const run of [pair.memoryOff,pair.memoryOn]){
  run.input.baseTimeline={...(structuredClone(run.result) as any).timeline,id:'baseline'};
  (run.result as any).timeline.parentID='different-baseline';
 }
 assert.throws(()=>evaluateLearningComparison(pair),/baseline identity/);
 for(const run of [pair.memoryOff,pair.memoryOn])(run.result as any).timeline.parentID='baseline';
 assert.equal(evaluateLearningComparison(pair).mechanism.matchedNonMemoryInputs,true);
 for(const run of [pair.memoryOff,pair.memoryOn])run.input.baseTimeline!.clips[0].sourceDuration=700000;
 assert.throws(()=>evaluateLearningComparison(pair),/Source bounds/);
});

test('held-out evidence hidden in provenance or event pointers is still leakage',()=>{
 const pair=sample();pair.memoryOn.input.memory[0].provenance={contributions:[{provenance:{evidence:[{id:'held-out-correction'}]}}]};
 assert.throws(()=>evaluateLearningComparison({...pair,heldOutEvidenceIDs:['held-out-correction']}),/leaked/);
 pair.memoryOn.input.memory[0].provenance={memoryID:'lesson',eventID:'held-out-correction'};
 assert.throws(()=>evaluateLearningComparison({...pair,heldOutEvidenceIDs:['held-out-correction']}),/leaked/);
});

test('project-scoped memory requires the matching comparison project and unique memory IDs',()=>{
 const pair=sample();pair.memoryOn.input.memory[0].project_scope='project-one';
 assert.throws(()=>evaluateLearningComparison(pair),/project scope/);
 assert.throws(()=>evaluateLearningComparison({...pair,projectID:'project-two'}),/project scope/);
 assert.equal(evaluateLearningComparison({...pair,projectID:'project-one'}).mechanism.memoryApplicabilityChecked,true);
 pair.memoryOn.input.memory[0].project_scope=null;
 pair.memoryOn.input.memory.push({...pair.memoryOn.input.memory[0],statement:'Conflicting text under the same ID'});
 assert.throws(()=>evaluateLearningComparison(pair),/Duplicate memory identifier/);
});

test('a reused provider receipt is not two independent runs and identical timelines do not imply learning',()=>{
 const pair=sample();
 for(const run of [pair.memoryOff,pair.memoryOn])(run.result as any).response={id:'same-provider-response',model:'saved-model'};
 assert.throws(()=>evaluateLearningComparison(pair),/same provider response/);
 delete (pair.memoryOff.result as any).response;delete (pair.memoryOn.result as any).response;
 const result=evaluateLearningComparison({...pair,human:{reviewer:'Tester',preferred:'memoryOn'}});
 assert.equal(result.mechanism.timelineContentChanged,false);
 assert.equal(result.mechanism.providerRunIdentity,'not-provided');
 assert.equal(result.mechanism.savedStateOnly,true);
 assert.equal(result.creativeQuality.status,'human-reported');
 assert.match(result.mechanism.interpretation,/independent runs/);
});

test('comparison CLI preserves project context and cannot bypass hidden held-out provenance',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pbj-eval-adversarial-'));
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Network is forbidden');};
 try{
  const pair=sample();pair.memoryOn.input.memory[0].project_scope='project-one';
  for(const [name,run] of [['off',pair.memoryOff],['on',pair.memoryOn]] as const){
   await writeFile(path.join(directory,name+'-input.json'),JSON.stringify(run.input));
   await writeFile(path.join(directory,name+'-result.json'),JSON.stringify(run.result));
  }
  const entry=(name:string)=>({model:'saved-model',plannerVersion:'planner-v1',inputPath:name+'-input.json',resultPath:name+'-result.json'});
  const manifest={schemaVersion:1,caseID:pair.caseID,projectID:'project-one',memoryOff:entry('off'),memoryOn:entry('on')};
  const file=path.join(directory,'comparison.json');await writeFile(file,JSON.stringify(manifest));
  assert.equal((await evaluateLearningFiles(file)).mechanism.memoryApplicabilityChecked,true);
  pair.memoryOn.input.memory[0].provenance={eventID:'hidden-held-out'};
  await writeFile(path.join(directory,'on-input.json'),JSON.stringify(pair.memoryOn.input));
  await writeFile(file,JSON.stringify({...manifest,heldOutEvidenceIDs:['hidden-held-out']}));
  await assert.rejects(evaluateLearningFiles(file),/leaked/);
 }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
