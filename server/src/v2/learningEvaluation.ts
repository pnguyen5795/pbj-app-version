import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {sourceSchema,validateEvidence,validateTimeline} from './contracts.ts';
import {OpenAIPlanner} from './planner.ts';
import type {PlanningInput} from './planner.ts';
import {timelineContentKey} from './memory.ts';
import {matchesApplicability,requestContext} from './learningPolicy.ts';
import {normalizeSpeech} from './speechTiming.ts';

export interface SavedLearningRun {
 model:string;
 plannerVersion:string;
 input:PlanningInput;
 result:unknown;
}
export const humanReviewSchema=z.object({
 reviewer:z.string().trim().min(1),
 preferred:z.enum(['memoryOff','memoryOn','tie','undecided']).optional(),
 correctionSeconds:z.object({memoryOff:z.number().nonnegative(),memoryOn:z.number().nonnegative(),
  scope:z.enum(['story-and-timing','includes-finishing'])}).optional(),
 notes:z.string().optional(),
}).refine(review=>review.preferred!==undefined||review.correctionSeconds!==undefined,'Supply a preference or measured correction times');
export type HumanLearningReview=z.infer<typeof humanReviewSchema>;

function inputWithoutMemory(input:PlanningInput){
 if(!input||typeof input.brief!=='string'||!Array.isArray(input.eligibleSources)||!Array.isArray(input.analysis)||!Array.isArray(input.memory)||!Array.isArray(input.required))throw new Error('Saved planning input is incomplete');
 const {memory,...rest}=input;
 const sources=new Map(input.eligibleSources.map(source=>[source.id,sourceSchema.parse(source)]));
 if(sources.size!==input.eligibleSources.length)throw new Error('Duplicate source identifiers');
 const originals=new Set<string>(),catalog=new Set<string>();
 for(const source of sources.values()){
  if(!/^[a-f0-9]{64}$/i.test(source.sha256))throw new Error('Saved source lacks a valid original SHA-256');
  const hash=source.sha256.toLowerCase();
  if(originals.has(hash))throw new Error('Duplicate original identities under different source IDs');
  originals.add(hash);
 }
 const identifier=(id:string)=>{
  if(typeof id!=='string'||!id.trim())throw new Error('Evidence identifier is missing');
  if(catalog.has(id))throw new Error('Duplicate evidence identifier makes source citations ambiguous');
  catalog.add(id);
 };
 for(const analysis of input.analysis){
  const source=sources.get(analysis.sourceID);
  if(!source)throw new Error('Analysis belongs to an ineligible source');
  if(!Number.isSafeInteger(analysis.version)||analysis.version<1)throw new Error('Invalid analysis version');
  const evidence=validateEvidence(analysis.evidence,source.duration/60000);
  identifier(analysis.id);
  for(const scene of evidence.scenes)identifier(analysis.id+':'+scene.id);
  for(const [index] of evidence.observations.entries())identifier(analysis.id+':observation-'+index);
 }
 for(const speech of input.speechTiming??[]){
  const source=sources.get(speech.sourceID);if(!source)throw new Error('Speech timing belongs to an ineligible source');
  normalizeSpeech(speech.evidence,source.duration/60000);identifier(speech.id);
 }
 for(const observation of input.localObservations??[]){
  if(!sources.has(observation.sourceID))throw new Error('Local observation belongs to an ineligible source');
  identifier(observation.id);
 }
 if(input.baseTimeline)validateTimeline(input.baseTimeline,input.eligibleSources);
 return rest;
}

function containsHeldOutReference(value:unknown,heldOut:Set<string>):boolean {
 const pending=[value],visited=new Set<object>();
 while(pending.length){
  const current=pending.pop();
  if(typeof current==='string'&&heldOut.has(current))return true;
  if(current&&typeof current==='object'&&!visited.has(current)){
   visited.add(current);pending.push(...Object.values(current));
  }
 }
 return false;
}

/** Validates saved results only. Never calls plan/json, a provider, or a database. */
export function evaluateLearningComparison(input:{caseID:string;projectID?:string;memoryOff:SavedLearningRun;memoryOn:SavedLearningRun;human?:HumanLearningReview;heldOutEvidenceIDs?:string[]}){
 if(!input.caseID?.trim())throw new Error('A case ID is required');
 const {memoryOff:off,memoryOn:on}=input;
 if(!off.model?.trim()||off.model!==on.model||!off.plannerVersion?.trim()||off.plannerVersion!==on.plannerVersion)throw new Error('Compare the same model and planner version');
 if(!isDeepStrictEqual(inputWithoutMemory(off.input),inputWithoutMemory(on.input)))throw new Error('Non-memory inputs differ; this is not a matched comparison');
 if(off.input.memory.length!==0||on.input.memory.length===0)throw new Error('Memory-off must be empty and memory-on must contain saved memory');
 const heldOut=new Set(input.heldOutEvidenceIDs??[]);
 const sourceContext=on.input.analysis.map(analysis=>analysis.evidence.summary.slice(0,600)).join(' ').slice(0,6000);
 const context=requestContext(on.input.brief,{sourceContext});
 const memoryIDs=new Set<string>();
 for(const memory of on.input.memory){
  if(!memory.id?.trim()||memoryIDs.has(memory.id))throw new Error('Duplicate memory identifier or missing identity');
  memoryIDs.add(memory.id);
  if(memory.enabled===false||(memory.status!==undefined&&memory.status!=='active'))throw new Error('Memory-on contains inactive memory');
  if(memory.project_scope&&memory.project_scope!==input.projectID)throw new Error('Memory project scope does not match a declared comparison project');
  if(!matchesApplicability(memory.learning??undefined,context))throw new Error('Memory does not apply to the current request and footage');
  if(!Array.isArray(memory.root_evidence_ids)||!memory.root_evidence_ids.length||memory.root_evidence_ids.some(id=>typeof id!=='string'||!id.trim()))throw new Error('Memory provenance is missing');
  // Old/full receipts and compact pointer receipts both retain references which
  // may be missing from an incorrectly constructed root list. Screen those too.
  if(containsHeldOutReference([memory.id,memory.root_evidence_ids,memory.provenance,memory.learning?.eventID,memory.supportingMemoryIDs],heldOut))throw new Error('Held-out evidence leaked into memory or its provenance');
 }
 const offReceipt=(off.result as any)?.response?.id,onReceipt=(on.result as any)?.response?.id;
 if(offReceipt&&offReceipt===onReceipt)throw new Error('Both conditions use the same provider response, not independent runs');
 const validator=new OpenAIPlanner('','');
 function check(run:SavedLearningRun){
  const result=run.result as any;
  if(result?.response?.model&&result.response.model!==run.model)throw new Error('Declared model differs from the saved provider result');
  if(result?.timeline?.parentID!==(run.input.baseTimeline?.id??null))throw new Error('Saved result baseline identity does not match the supplied input');
  const validated=validator.validate(run.input,structuredClone(run.result),{});
  const citedMemoryIDs=[...new Set(validated.decisions.flatMap(decision=>decision.memoryIDs))];
  return {timelineValid:true,sourceEligibilityValid:true,citationsValid:true,
   clipCount:validated.timeline.clips.length,durationSeconds:validated.quality.durationSeconds,
   durationWithinGoal:validated.quality.durationWithinGoal,memoryProvided:run.input.memory.length,
   citedMemoryIDs,contentKey:timelineContentKey(validated.timeline)};
 }
 const memoryOff=check(off),memoryOn=check(on);
 const human=input.human===undefined?undefined:humanReviewSchema.parse(input.human);
 return {schemaVersion:1,caseID:input.caseID,...(input.projectID?{projectID:input.projectID}:{}),model:off.model,plannerVersion:off.plannerVersion,
  mechanism:{matchedNonMemoryInputs:true,memoryOff,memoryOn,
   memoryApplicabilityChecked:true,
   legacyMemoryWithoutApplicability:on.input.memory.filter(memory=>!memory.learning).length,
   memoryWasCited:memoryOn.citedMemoryIDs.length>0,
   timelineContentChanged:memoryOff.contentKey!==memoryOn.contentKey,
   providerRunIdentity:offReceipt&&onReceipt?'distinct-receipts' as const:'not-provided' as const,
   savedStateOnly:true,
   heldOutEvidenceScreened:heldOut.size,
   interpretation:'Valid structure, memory applicability, citations, or a changed timeline do not demonstrate a better edit or independent runs. This checks saved snapshots and declared source hashes, not source bytes, current account/project state, or provider receipt authenticity. Held-out screening covers only supplied identifiers and represented provenance. Legacy memory without applicability metadata cannot be checked for topic relevance.'},
  creativeQuality:human?{status:'human-reported' as const,...human,
   ...(human.correctionSeconds?{memoryOnSecondsSaved:human.correctionSeconds.memoryOff-human.correctionSeconds.memoryOn,
    roughCutTimeComparable:human.correctionSeconds.scope==='story-and-timing'}:{})}
   :{status:'not-measured' as const,explanation:'No human preference or correction-time measurements were supplied.'}};
}
