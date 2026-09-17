import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from './database.ts';
import type {Timeline} from './contracts.ts';
import {diffTimelines,timelineContentKey} from './memory.ts';
import type {TimelineDifference} from './memory.ts';
import {enqueue} from './jobs.ts';

type Revision={id:string;parent_id:string|null;origin:string;timeline:Timeline;evidence_versions:any;feedback?:string;accepted?:boolean};
type Change={revisionID:string;baseRevisionID:string;differences:TimelineDifference[]};
type ClipContext={clipID:string;baseRevisionID?:string;before?:Timeline['clips'][number];after?:Timeline['clips'][number];decisions:any[]};
export type HumanDecisionEvidence={id:string;kind:'ai_request'|'manual_change';revisionID:string;baseRevisionID:string;
 instruction?:string;differences:TimelineDifference[];sourceIDs:string[]};
export type ContextFeedback={id:string;text:string;reusable:boolean;created_at:string;textTruncated:boolean};
export type LearningOutcome={
 base?:Revision;differences:TimelineDifference[];manualChanges:Change[];
 requests:(Change&{instruction:string})[];changedClips:Record<string,unknown>[];
 eventKey:string;rootEvidenceIDs:string[];evidence:HumanDecisionEvidence[];completeLineage:boolean;
 contextFeedback:ContextFeedback[];reusableAllowed:boolean;
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clipped=(value:unknown,max=600)=>typeof value==='string'?value.slice(0,max):'';
const renderClip=(clip:Timeline['clips'][number])=>{
 const {id,outputStart,...content}=clip;return {...content,speed:clip.speed??1,rotation:clip.rotation??0};
};

/** Preserve shot occurrence identity through every saved edge, including
 * content-equivalent snapshots that are later omitted from the edit history.
 * Unchanged sequences keep positional identity; other fresh IDs inherit only
 * a unique exact match among unmatched shots. An identical shot already
 * present is never mistaken for a new replay. */
function reconcileLineage(rows:Revision[]):Revision[]{
 const reconciled:Revision[]=[],usedIDs=new Set<string>();
 let previous:Revision|undefined,previousIDs=new Map<string,string>();
 for(const row of [...rows].reverse()){
  const currentIDs=new Set(row.timeline.clips.map(c=>c.id)),ids=new Map<string,string>();
  const missingBefore=previous?.timeline.clips.filter(c=>!currentIDs.has(c.id))??[];
  const missingAfter=row.timeline.clips.filter(c=>!previousIDs.has(c.id));
  const unchanged=previous&&timelineContentKey(previous.timeline)===timelineContentKey(row.timeline);
  for(const [index,clip] of row.timeline.clips.entries()){
   // Identical rendered sequences preserve each occurrence's position even
   // when several indistinguishable copies all receive fresh IDs.
   let id=unchanged?previousIDs.get(previous!.timeline.clips[index].id):previousIDs.get(clip.id);
   if(!id){
    const matches=missingBefore.filter(c=>isDeepStrictEqual(renderClip(c),renderClip(clip)));
    const peers=missingAfter.filter(c=>isDeepStrictEqual(renderClip(c),renderClip(clip)));
    if(matches.length===1&&peers.length===1)id=previousIDs.get(matches[0].id);
   }
   // A deleted ID reused for a different occurrence is not continuity.
   id??=usedIDs.has(clip.id)?'occurrence:'+hash([row.id,clip.id]):clip.id;
   usedIDs.add(id);ids.set(clip.id,id);
  }
  reconciled.push({...row,timeline:{...row.timeline,clips:row.timeline.clips.map(c=>({...c,id:ids.get(c.id)!}))},
   evidence_versions:{...row.evidence_versions,decisions:(row.evidence_versions?.decisions??[])
    .map((decision:any)=>({...decision,clipID:ids.get(decision.clipID)??decision.clipID}))}});
  previous=row;previousIDs=ids;
 }
 return reconciled.reverse();
}

function relatedSourceIDs(before:Timeline,after:Timeline,differences:TimelineDifference[]):string[]{
 const sources=new Set<string>();
 for(const difference of differences){
  if(difference.kind==='sounds'||difference.kind==='overlays'){
   for(const track of [...difference.before as any[],...difference.after as any[]])if(track.sourceID)sources.add(track.sourceID);
  }else{
   const ids=difference.kind==='reordered'?[...difference.before as string[],...difference.after as string[]]:[difference.clipID];
   for(const clip of [...before.clips,...after.clips])if(ids.includes(clip.id))sources.add(clip.sourceID);
  }
 }
 return [...sources].sort();
}

/** A later edit must not turn an undone or overwritten choice into evidence. */
function survivingDifferences(before:Timeline,after:Timeline,later:Timeline[]):TimelineDifference[]{
 // Equal final values alone cannot prove retention: a later request may have
 // overwritten this choice and then independently recreated the same setting.
 return diffTimelines(before,after).filter(change=>later.every(final=>{
  const chosen=after.clips.find(c=>c.id===change.clipID);
  const clip=final.clips.find(c=>c.id===change.clipID);
  switch(change.kind){
   case 'added':return !!clip&&!!chosen&&isDeepStrictEqual(renderClip(clip),renderClip(chosen));
   case 'removed':{
    const removed=renderClip(change.before as Timeline['clips'][number]);
    const count=(timeline:Timeline)=>timeline.clips.filter(c=>isDeepStrictEqual(renderClip(c),removed)).length;
    // Retaining an existing twin does not undo this removal. Recreating the
    // removed occurrence with a fresh ID does, so compare occurrence counts.
    return !clip&&count(final)<=count(after);
   }
   case 'reordered':{
    const order=change.after as string[];
    return order.every(id=>final.clips.some(c=>c.id===id))&&isDeepStrictEqual(final.clips.filter(c=>order.includes(c.id)).map(c=>c.id),order);
   }
   case 'sounds':case 'overlays':return isDeepStrictEqual(final[change.kind]??[],change.after);
   default:{
    if(!clip||!chosen||clip.sourceID!==chosen.sourceID)return false;
    if(change.kind==='trimmed')return clip.sourceIn===chosen.sourceIn&&clip.sourceDuration===chosen.sourceDuration;
    if(change.kind==='audio')return clip.volume===chosen.volume&&clip.muted===chosen.muted;
    if(change.kind==='speed')return (clip.speed??1)===(chosen.speed??1);
    if(change.kind==='rotation')return (clip.rotation??0)===(chosen.rotation??0);
    if(change.kind==='fit')return clip.fit===chosen.fit;
    return change.kind==='replaced';
   }
  }
 }));
}

/** Collect evidence only. The caller establishes explicit approval or a verified
 * export; accepted=true is a head-conflict check, never a preference signal.
 * No media reads, provider calls or analysis reservations occur here. */
export async function collectLearningOutcome(db:Database,owner:string,projectID:string,revision:Revision):Promise<LearningOutcome>{
 // One bounded read instead of a round trip for every saved trim. New snapshots
 // follow their selected source; a legacy restore has no provable source edge.
 const rows=reconcileLineage((await db.query<Revision>(`WITH RECURSIVE lineage AS (
  SELECT r.*,0 AS depth,ARRAY[r.id]::text[] AS path FROM pbj_revisions r
    WHERE owner_id=$1 AND project_id=$2 AND id=$3
  UNION ALL SELECT p.*,c.depth+1,c.path||p.id FROM lineage c JOIN pbj_revisions p
    ON p.owner_id=c.owner_id AND p.project_id=c.project_id AND p.id=CASE
      WHEN c.origin IN ('approved','restored') AND c.evidence_versions->'snapshot'->>'sourceRevisionID' IS NOT NULL
        THEN c.evidence_versions->'snapshot'->>'sourceRevisionID'
      WHEN c.origin='restored' THEN NULL ELSE c.parent_id END
    WHERE c.depth<127 AND NOT p.id=ANY(c.path)
 ) SELECT * FROM lineage ORDER BY depth`,[owner,projectID,revision.id])).rows);
 if(!rows.length)throw new Error('Outcome revision not found');
 const lineage:Revision[]=[],selectedLineageIDs:string[]=[];let completeLineage=true;
 for(let i=0;i<rows.length;i++){
  const row=rows[i],parent=rows[i+1];
  selectedLineageIDs.push(row.id);
  if(row.origin==='approved'||row.origin==='restored'){
   if(!parent||timelineContentKey(row.timeline)!==timelineContentKey(parent.timeline)){
    completeLineage=false;break;
   }
   continue;
  }
  // A new snapshot/clip ID or explicit default values do not create an edit.
  if(parent&&timelineContentKey(row.timeline)===timelineContentKey(parent.timeline))continue;
  lineage.push(row);
  if(!parent&&row.parent_id)completeLineage=false;
 }
 const final=lineage[0]?.timeline??rows[0].timeline;
 const requests:LearningOutcome['requests']=[],manualChanges:Change[]=[],roots:string[]=[],evidence:HumanDecisionEvidence[]=[];
 const changePairs:{before:Revision;after:Revision;differences:TimelineDifference[]}[]=[];
 let base:Revision|undefined;
 for(let i=0;i<lineage.length-1;i++){
  const row=lineage[i];let parent=lineage[i+1];
  const later=lineage.slice(0,i+1).map(revision=>revision.timeline);
  if(row.origin==='manual'){
   // Aggregate contiguous manual saves so a trim and its undo cancel out.
   while(parent.origin==='manual'&&i+2<lineage.length){i++;parent=lineage[i+1];}
   if(parent.origin==='manual')continue; // Baseline lies beyond our safe bound.
   const differences=survivingDifferences(parent.timeline,row.timeline,later);
   if(differences.length){
    manualChanges.push({revisionID:row.id,baseRevisionID:parent.id,differences});
    changePairs.push({before:parent,after:row,differences});base??=parent;
    // Keeping an old trim while making a new volume change is not another
    // independent endorsement of that trim. Give each surviving change a root.
    for(const change of differences){
     const id='manual-change:'+hash([projectID,change]);roots.push(id);
     evidence.push({id,kind:'manual_change',revisionID:row.id,baseRevisionID:parent.id,differences:[change],
      sourceIDs:relatedSourceIDs(parent.timeline,row.timeline,[change])});
    }
   }
  }else if(row.origin==='ai_revision'&&row.feedback?.trim()){
   const differences=survivingDifferences(parent.timeline,row.timeline,later);
   if(differences.length){
    requests.push({revisionID:row.id,baseRevisionID:parent.id,instruction:row.feedback,differences});
    changePairs.push({before:parent,after:row,differences});base??=parent;roots.push(row.id);
    evidence.push({id:row.id,kind:'ai_request',revisionID:row.id,baseRevisionID:parent.id,instruction:row.feedback,differences,
     sourceIDs:relatedSourceIDs(parent.timeline,row.timeline,differences)});
   }
  }
 }
 // Keep actual before/after ranges, the original AI decision and overlapping
 // cached scenes. The model receives relevant excerpts, never full history.
 const contexts=changePairs.flatMap(pair=>{
  const ids=new Set(pair.differences.flatMap(change=>change.kind==='reordered'?change.after as string[]:
   ['sounds','overlays'].includes(change.kind)?[]:[change.clipID]));
  return [...ids].map(clipID=>({clipID,baseRevisionID:pair.before.id,
   before:pair.before.timeline.clips.find(c=>c.id===clipID),after:pair.after.timeline.clips.find(c=>c.id===clipID),
   decisions:[...(pair.before.evidence_versions?.decisions??[]),...(pair.after.evidence_versions?.decisions??[])]
    .filter((d:any)=>d.clipID===clipID).slice(0,2).map((d:any)=>({reason:clipped(d.reason),evidenceIDs:d.evidenceIDs??[]}))}));
 }).slice(0,48);
 const changedClips=await enrichClipContexts(db,owner,contexts);
 // Carry feedback forward through the chosen branch as context, not another
 // independent vote. Scope checks cover all selected feedback, not just the
 // excerpt sent to the model. Missing legacy ancestry cannot grant reuse.
 const feedback=(await db.query<{reusable_allowed:boolean;context_feedback:ContextFeedback[]}>(`WITH feedback AS (
  SELECT id,text,reusable,created_at FROM pbj_feedback
  WHERE owner_id=$1 AND project_id=$2 AND revision_id=ANY($3::text[])
 ) SELECT NOT EXISTS(SELECT 1 FROM feedback WHERE NOT reusable) AS reusable_allowed,
  (SELECT coalesce(jsonb_agg(f),'[]'::jsonb) FROM (
   SELECT id,left(text,3000) AS text,reusable,created_at,length(text)>3000 AS "textTruncated"
   FROM feedback ORDER BY created_at DESC,id DESC LIMIT 12
  ) f) AS context_feedback`,[owner,projectID,selectedLineageIDs])).rows[0];
 const differences=manualChanges.flatMap(change=>change.differences);
 // Deduplicate approval and export snapshots of the same concrete outcome.
 // Event roots retain request identity but omit retry/snapshot/export IDs.
 const eventKey='outcome:'+projectID+':'+hash([timelineContentKey(final),[...roots].sort()]);
 return {base,differences,manualChanges,requests,changedClips,eventKey,rootEvidenceIDs:[...new Set(roots)],
  evidence:[...new Map(evidence.map(item=>[item.id,item])).values()],completeLineage,
  contextFeedback:feedback.context_feedback,reusableAllowed:completeLineage&&feedback.reusable_allowed};
}

async function enrichClipContexts(db:Database,owner:string,contexts:ClipContext[]):Promise<Record<string,unknown>[]>{
 const sourceIDs=[...new Set(contexts.flatMap(c=>[c.before?.sourceID,c.after?.sourceID]).filter((id):id is string=>!!id))];
 const analyses=sourceIDs.length?(await db.query<any>(`SELECT id,asset_id,evidence FROM pbj_analysis
  WHERE owner_id=$1 AND asset_id=ANY($2::text[]) AND status='complete'`,[owner,sourceIDs])).rows:[];
 return contexts.map(context=>({...context,scenes:analyses.flatMap(a=>{
  const ranges=[context.before,context.after].filter(c=>c?.sourceID===a.asset_id);
  if(!ranges.length)return [];
  return (Array.isArray(a.evidence?.scenes)?a.evidence.scenes:[])
   .filter((s:any)=>ranges.some(c=>Number(s.start)*60000<c!.sourceIn+c!.sourceDuration&&Number(s.end)*60000>c!.sourceIn))
   .slice(0,3).map((s:any)=>({analysisID:a.id,sourceID:a.asset_id,id:s.id,start:s.start,end:s.end,
    visual:clipped(s.visual),audio:clipped(s.audio),speech:clipped(s.speech),confidence:s.confidence}));
 })}));
}

/** Bounded saved-scene context for a standalone explicit feedback event. */
export async function collectClipContext(db:Database,owner:string,revision:Revision,clipIDs?:string[]){
 const selected=clipIDs?new Set(clipIDs):undefined;
 return enrichClipContexts(db,owner,revision.timeline.clips.filter(c=>!selected||selected.has(c.id)).slice(0,24)
  .map(clip=>({clipID:clip.id,after:clip,decisions:(revision.evidence_versions?.decisions??[])
   .filter((d:any)=>d.clipID===clip.id).slice(0,1).map((d:any)=>({reason:clipped(d.reason),evidenceIDs:d.evidenceIDs??[]}))})));
}

export async function enqueueLearningOutcome(db:Database,owner:string,projectID:string,revision:Revision,trigger:'approval'|'export'){
 const outcome=await collectLearningOutcome(db,owner,projectID,revision);
 if(!outcome.differences.length&&!outcome.requests.length)return undefined;
 const {base,...evidence}=outcome;
 return enqueue(db,owner,'lesson',outcome.eventKey,{projectID,revisionID:revision.id,eventType:trigger,
  outcome:{...evidence,baseRevisionID:base?.id}});
}
