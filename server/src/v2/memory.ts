import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { transaction, type Database } from './database.ts';
import { defaultRuleKey,evidenceStrength,learningContextKey,matchesApplicability,normalizeLearning,normalized,requestContext,type LearningMetadata,type MemoryContext,type Strength } from './learningPolicy.ts';
export type { LearningMetadata,MemoryContext } from './learningPolicy.ts';
import type { Timeline } from './contracts.ts';

export type MemoryRecord={id:string;version:number;kind:'reference'|'personal_lesson';context:string;statement:string;
  strength:Strength;attribution:string;project_scope:string|null;provenance:unknown;root_evidence_ids:string[];
  learning?:LearningMetadata|null;enabled?:boolean;rule_key?:string;
  effectiveStrength?:Strength;supportCount?:number;status?:'active'|'superseded'|'excluded'|'disabled';supportingMemoryIDs?:string[]};
type StoredMemory=MemoryRecord & {learning?:(LearningMetadata & {supersedesRuleKeys?:string[]})|null;excluded:boolean;created_at:Date|string};

function independentSupportCount(records:MemoryRecord[]):number {
  // Partially overlapping exports are still the same example. Connect supports
  // through both their declared example and their actual source/decision roots.
  const parent:number[]=[];const seen=new Map<string,number>();
  const root=(i:number):number=>parent[i]===i?i:(parent[i]=root(parent[i]));
  for(const record of records.filter(r=>r.learning)){
    const i=parent.length;parent.push(i);
    for(const key of ['example:'+record.learning!.independenceKey,...record.root_evidence_ids.map(id=>'root:'+id)]){
      const other=seen.get(key);if(other!==undefined)parent[root(i)]=root(other);else seen.set(key,i);
    }
  }
  return new Set(parent.map((_,i)=>root(i))).size;
}
async function effectiveMemory(db:Database,owner:string,projectID?:string):Promise<MemoryRecord[]> {
  // Full receipts, scene context and timeline differences remain in the saved
  // provenance. Retrieval needs only a stable pointer to them, not another copy
  // of every raw editing outcome in each planning/extraction request.
  const rows=(await db.query<StoredMemory>(`SELECT m.id,m.version,m.kind,m.context,m.statement,m.strength,m.attribution,
    m.project_scope,m.root_evidence_ids,m.learning,m.rule_key,m.enabled,m.created_at,
    jsonb_build_object('memoryID',m.id,'eventID',m.learning->>'eventID') AS provenance,
    EXISTS(SELECT 1 FROM pbj_excluded_evidence e
    WHERE e.owner_id=m.owner_id AND (e.evidence_id=m.id OR m.root_evidence_ids ? e.evidence_id)) AS excluded
    FROM pbj_memory m WHERE m.owner_id=$1 AND ($2::text IS NULL OR m.project_scope IS NULL OR m.project_scope=$2)`,[owner,projectID??null])).rows;
  // A recovered old job must not turn an older user decision into newer feedback.
  const insertionTime=(row:StoredMemory)=>new Date(row.created_at).getTime();
  const eventTime=(row:StoredMemory)=>row.learning?.occurredAt?Date.parse(row.learning.occurredAt):insertionTime(row);
  rows.sort((a,b)=>eventTime(a)-eventTime(b)||insertionTime(a)-insertionTime(b)||a.id.localeCompare(b.id));
  const groups=new Map<string,StoredMemory[]>();
  for(const row of rows){const key=row.rule_key??row.id;const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
  const latestExplicit=new Map<string,number>();
  for(const [index,row] of rows.entries())if(row.enabled&&!row.excluded&&row.learning?.signal==='explicit_feedback'&&row.learning.explicitReusable)
    latestExplicit.set(row.rule_key??row.id,index);
  // New explicit feedback replaces an older preference only while its own
  // independent evidence remains enabled and included. Excluding it restores the old rule.
  const superseded=new Set<string>();
  for(const [index,row] of rows.entries())if(row.enabled&&!row.excluded&&row.learning?.signal==='explicit_feedback'&&row.learning.explicitReusable)
    for(const key of row.learning.supersedesRuleKeys??[])if((latestExplicit.get(key)??-1)<index)superseded.add(key);
  const output:MemoryRecord[]=[];
  for(const [key,group] of groups){
    const active=group.filter(r=>r.enabled&&!r.excluded);
    const selected=active.at(-1)??group.at(-1)!;
    const supportCount=independentSupportCount(active);
    const strength=evidenceStrength(selected.kind,active.flatMap(r=>r.learning?[r.learning]:[]),supportCount,active.filter(r=>!r.learning).map(r=>r.strength));
    const status=!active.length?(group.some(r=>r.enabled)?'excluded':'disabled'):superseded.has(key)?'superseded':'active';
    const {excluded:_,created_at:__,...record}=selected;
    output.push({...record,rule_key:key,strength,effectiveStrength:strength,supportCount,status,
      enabled:group.some(r=>r.enabled),supportingMemoryIDs:active.map(r=>r.id),
      root_evidence_ids:[...new Set(active.flatMap(r=>r.root_evidence_ids))],
      provenance:active.length>1?{contributions:active.map(r=>({memoryID:r.id,rootEvidenceIDs:r.root_evidence_ids,provenance:r.provenance}))}:selected.provenance});
  }
  return output;
}
export async function listEffectiveMemory(db:Database,owner:string):Promise<MemoryRecord[]> {
  return (await effectiveMemory(db,owner)).reverse();
}
export async function setMemoryEnabled(db:Database,owner:string,id:string,enabled:boolean):Promise<void> {
  const result=await db.query(`UPDATE pbj_memory SET enabled=$3 WHERE owner_id=$1 AND rule_key=(
    SELECT rule_key FROM pbj_memory WHERE owner_id=$1 AND id=$2) RETURNING id`,[owner,id,enabled]);
  if(!result.rows.length)throw new Error('Memory not found');
}
function selectMemory(records:MemoryRecord[],brief:string,limit:number,context:MemoryContext,includeInactiveCandidates=false):MemoryRecord[] {
  const request=requestContext(brief,context);
  const terms=[...new Set(request.text.match(/[\p{L}\p{N}]{3,}/gu)??[])].filter(t=>!['the','and','this','that','with','want','make','video','videos','edit','edits'].includes(t)).slice(0,80);
  const ranked=records.filter(m=>(m.status==='active'||(includeInactiveCandidates&&(m.status==='superseded'||m.status==='disabled')))&&matchesApplicability(m.learning??undefined,request)).map(m=>{
    const text=normalized(m.context+' '+m.statement);
    const lexical=terms.filter(t=>(' '+text+' ').includes(' '+t+' ')).length;
    const facet=m.learning&&request.facets.has(m.learning.facet)?1:0;
    // Contextual metadata allows reusable editing lessons to cross subjects;
    // legacy unclassified rows retain the conservative text-match behavior.
    const relevant=lexical>0||facet>0||(m.learning?.facet==='general');
    return {m,relevant,score:facet*4+Math.min(lexical,6)};
  }).filter(x=>x.relevant).sort((a,b)=>
    Number(b.m.kind==='personal_lesson')-Number(a.m.kind==='personal_lesson')||b.score-a.score||
    ({strong:3,moderate:2,weak:1}[b.m.strength]-{strong:3,moderate:2,weak:1}[a.m.strength])||a.m.id.localeCompare(b.m.id));
  const result:MemoryRecord[]=[];const referenceRoots=new Set<string>();
  for(const {m} of ranked){
    // Re-uploading the same reference must not occupy the whole shortlist.
    const root=m.learning?.independenceKey??m.root_evidence_ids[0];
    if(m.kind==='reference'&&referenceRoots.has(root))continue;
    if(m.kind==='reference')referenceRoots.add(root);
    result.push(m);if(result.length>=Math.max(1,Math.min(limit,20)))break;
  }
  return result;
}
export async function retrieveMemory(db:Database,owner:string,brief:string,projectID:string,limit=12,context:MemoryContext={}):Promise<MemoryRecord[]> {
  return selectMemory(await effectiveMemory(db,owner,projectID),brief,limit,context);
}
export async function retrieveLearningCandidates(db:Database,owner:string,brief:string,projectID:string,context:MemoryContext={}):Promise<MemoryRecord[]> {
  // Old rules identify explicit reversals; disabled rules let equivalent new
  // wording inherit the user's disabled setting. Neither becomes a planner
  // instruction. Excluded evidence stays out of comparison too.
  return selectMemory(await effectiveMemory(db,owner,projectID),brief,20,context,true);
}

export type TimelineDifference={kind:'added'|'removed'|'replaced'|'trimmed'|'reordered'|'audio'|'speed'|'rotation'|'fit'|'sounds'|'overlays';clipID:string;before?:unknown;after?:unknown};
export function diffTimelines(before:Timeline,after:Timeline):TimelineDifference[] {
  const result:TimelineDifference[]=[];
  const old=new Map(before.clips.map(c=>[c.id,c]));
  const current=new Map(after.clips.map(c=>[c.id,c]));
  for(const clip of before.clips)if(!current.has(clip.id))result.push({kind:'removed',clipID:clip.id,before:clip});
  for(const clip of after.clips){
    const previous=old.get(clip.id);
    if(!previous){result.push({kind:'added',clipID:clip.id,after:clip});continue;}
    if(previous.sourceID!==clip.sourceID)result.push({kind:'replaced',clipID:clip.id,before:previous.sourceID,after:clip.sourceID});
    if(previous.sourceIn!==clip.sourceIn||previous.sourceDuration!==clip.sourceDuration)result.push({kind:'trimmed',clipID:clip.id,before:{sourceIn:previous.sourceIn,duration:previous.sourceDuration},after:{sourceIn:clip.sourceIn,duration:clip.sourceDuration}});
    if((previous.speed??1)!==(clip.speed??1))result.push({kind:'speed',clipID:clip.id,before:previous.speed??1,after:clip.speed??1});
    if((previous.rotation??0)!==(clip.rotation??0))result.push({kind:'rotation',clipID:clip.id,before:previous.rotation??0,after:clip.rotation??0});
    if(previous.fit!==clip.fit)result.push({kind:'fit',clipID:clip.id,before:previous.fit,after:clip.fit});
    if(previous.volume!==clip.volume||previous.muted!==clip.muted)result.push({kind:'audio',clipID:clip.id,before:{volume:previous.volume,muted:previous.muted},after:{volume:clip.volume,muted:clip.muted}});
  }
  // Compare relative order of survivors; adding a leading clip is not a reorder.
  const oldOrder=before.clips.filter(c=>current.has(c.id)).map(c=>c.id);
  const newOrder=after.clips.filter(c=>old.has(c.id)).map(c=>c.id);
  if(oldOrder.join('|')!==newOrder.join('|'))result.push({kind:'reordered',clipID:'sequence',before:oldOrder,after:newOrder});
  for(const kind of ['sounds','overlays'] as const)if(!isDeepStrictEqual(before[kind]??[],after[kind]??[]))result.push({kind,clipID:kind,before:before[kind]??[],after:after[kind]??[]});
  return result;
}

export async function saveMemory(db:Database,owner:string,record:MemoryRecord,allowedCandidateIDs?:string[]) {
  return saveMemories(db,owner,[record],allowedCandidateIDs);
}
/** A provider result is one durable learning outcome. Validate all proposals
 * before committing any of them, including their relationship checks. */
export async function saveMemories(db:Database,owner:string,records:MemoryRecord[],allowedCandidateIDs?:string[]) {
  const proposals=records.map(record=>{
    if(!record.root_evidence_ids.length)throw new Error('Memory must retain independent root provenance');
    const learning=record.learning?normalizeLearning(record.learning):undefined;
    if(learning&&((record.kind==='reference')!==(learning.signal==='reference')))throw new Error('Reference observations and personal lessons must remain separate');
    return {record,learning,contextKey:learningContextKey(record.kind,record.project_scope,learning,record.context)};
  });
  if(!proposals.length)return;
  await transaction(db,async tx=>{
   for(const {record,learning,contextKey} of proposals){
    let ruleKey=defaultRuleKey(contextKey,record.statement);
    const supersedesRuleKeys:string[]=[];
    if(learning){
      const ids=[...new Set([...(learning.reinforcesIDs??[]),...(learning.supersedesIDs??[])])];
      if(allowedCandidateIDs&&ids.some(id=>!allowedCandidateIDs.includes(id)))throw new Error('Learning relationship was not in the supplied candidates');
      if((learning.supersedesIDs?.length??0)>0&&!(learning.signal==='explicit_feedback'&&learning.explicitReusable))throw new Error('Only explicit reusable feedback can replace an existing preference');
      const targets=ids.length?(await tx.query<Pick<MemoryRecord,'id'|'kind'|'project_scope'|'context'|'learning'|'rule_key'>>(
        'SELECT id,kind,project_scope,context,learning,rule_key FROM pbj_memory WHERE owner_id=$1 AND id=ANY($2::text[])',[owner,ids])).rows:[];
      if(targets.length!==ids.length)throw new Error('Learning relationship points to missing evidence');
      for(const target of targets){
        if(learningContextKey(target.kind,target.project_scope,target.learning??undefined,target.context)!==contextKey)throw new Error('Learning relationships must preserve kind and applicability');
      }
      const reinforcementKeys=[...new Set(targets.filter(t=>learning.reinforcesIDs?.includes(t.id)).map(t=>t.rule_key??t.id))];
      if(reinforcementKeys.length>1)throw new Error('One lesson may reinforce only one existing rule');
      if(reinforcementKeys.length)ruleKey=reinforcementKeys[0];
      for(const target of targets.filter(t=>learning.supersedesIDs?.includes(t.id))){
        const key=target.rule_key??target.id;
        if(key===ruleKey)throw new Error('A lesson cannot replace the rule it reinforces');
        supersedesRuleKeys.push(key);
      }
    }
    const strength=learning?evidenceStrength(record.kind,[learning],1,[]):record.strength;
    await tx.query(`INSERT INTO pbj_memory(id,owner_id,version,kind,context,statement,strength,attribution,project_scope,provenance,root_evidence_ids,learning,rule_key,enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        (SELECT coalesce(bool_or(enabled),true) FROM pbj_memory WHERE owner_id=$2 AND rule_key=$13))
      ON CONFLICT DO NOTHING`,
      [record.id,owner,record.version,record.kind,record.context,record.statement,strength,record.attribution,record.project_scope,
        JSON.stringify(record.provenance),JSON.stringify([...new Set(record.root_evidence_ids)]),learning?JSON.stringify({...learning,supersedesRuleKeys}):null,ruleKey]);
   }
  });
}
export function lessonID(owner:string,revisionID:string):string {
  return createHash('sha256').update(JSON.stringify([owner,revisionID,'outcome-v1'])).digest('hex');
}

/** Render content, independent of revision/track IDs or JSONB property order. */
export function timelineContentKey(timeline:Timeline):string {
  const content={width:timeline.width,height:timeline.height,fps:timeline.fps,
    clips:timeline.clips.map(({id,...clip})=>({...clip,speed:clip.speed??1,rotation:clip.rotation??0})),
    sounds:(timeline.sounds??[]).map(({id,...sound})=>({...sound,speed:sound.speed??1})),
    overlays:(timeline.overlays??[]).map(({id,...overlay})=>overlay)};
  const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

export async function manualOutcome(db:Database,owner:string,projectID:string,revision:any){
  if(revision.origin!=='manual')return {base:undefined,differences:[] as TimelineDifference[]};
  const base=(await db.query<any>(`WITH RECURSIVE lineage AS (
    SELECT r.*,0 AS depth FROM pbj_revisions r WHERE owner_id=$1 AND project_id=$2 AND id=$3
    UNION ALL SELECT p.*,c.depth+1 FROM pbj_revisions p JOIN lineage c ON p.id=c.parent_id
      AND p.owner_id=c.owner_id AND p.project_id=c.project_id WHERE c.origin='manual'
   ) SELECT * FROM lineage WHERE origin<>'manual' ORDER BY depth LIMIT 1`,[owner,projectID,revision.id])).rows[0];
  return {base,differences:base&&timelineContentKey(base.timeline)!==timelineContentKey(revision.timeline)?diffTimelines(base.timeline,revision.timeline):[]};
}
