import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { transaction } from './database.ts';
import { validateTimeline } from './contracts.ts';
import type { Timeline,Source } from './contracts.ts';
import { enqueue } from './jobs.ts';
import { watchNotificationJob } from './notifications.ts';
export function assetSource(row:any):Source{return {id:row.id,fileName:row.original_name,sha256:row.original_sha256,duration:Number(row.duration_ticks),mediaStart:Number(row.media_start_ticks),hasAudio:!!row.metadata.originalAudio,...(row.metadata.kind?{kind:row.metadata.kind}:{})};}
export async function ownedProject(db:Database,owner:string,id:string){const row=(await db.query<any>('SELECT * FROM pbj_projects WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];if(!row)throw new Error('Project not found');return row;}
export async function projectSources(db:Database,owner:string,id:string){return (await db.query<any>(`SELECT a.* FROM pbj_assets a JOIN pbj_project_inputs i ON i.owner_id=a.owner_id AND i.asset_id=a.id WHERE i.owner_id=$1 AND i.project_id=$2 ORDER BY a.id`,[owner,id])).rows;}
export async function createProject(db:Database,owner:string,input:{id:string;title:string;brief:string;assetIDs:string[];durationGoal:unknown;required:unknown;notificationDeviceID?:string}){
 return transaction(db,async tx=>{
  const existing=(await tx.query<any>('SELECT * FROM pbj_projects WHERE owner_id=$1 AND id=$2',[owner,input.id])).rows[0];
  if(existing){
   const sourceIDs=(await tx.query<any>('SELECT asset_id FROM pbj_project_inputs WHERE owner_id=$1 AND project_id=$2',[owner,input.id])).rows.map(r=>r.asset_id).sort();
   if(existing.title!==input.title||existing.brief!==input.brief||!isDeepStrictEqual(existing.duration_goal,input.durationGoal)||!isDeepStrictEqual(existing.required_moments,input.required)||!isDeepStrictEqual(sourceIDs,[...new Set(input.assetIDs)].sort()))throw new Error('Project request ID conflict: these saved settings differ. Start a new project for the new brief.');
   if(input.notificationDeviceID){const work=(await tx.query<any>(`SELECT id FROM pbj_jobs WHERE owner_id=$1 AND kind='plan' AND dedupe_key=$2`,[owner,input.id])).rows[0];if(!work)throw new Error('Saved project work requires recovery');await watchNotificationJob(tx,owner,input.notificationDeviceID,work.id);}
   return existing;
  }
  const assets=(await tx.query<any>('SELECT id FROM pbj_assets WHERE owner_id=$1 AND id=ANY($2::text[])',[owner,input.assetIDs])).rows;
  if(!assets.length||assets.length!==new Set(input.assetIDs).size)throw new Error('Project contains unavailable footage');
  await tx.query(`INSERT INTO pbj_projects(id,owner_id,title,brief,duration_goal,required_moments,status) VALUES($1,$2,$3,$4,$5,$6,'queued')`,[input.id,owner,input.title,input.brief,JSON.stringify(input.durationGoal),JSON.stringify(input.required)]);
  for(const asset of assets)await tx.query('INSERT INTO pbj_project_inputs(owner_id,project_id,asset_id) VALUES($1,$2,$3)',[owner,input.id,asset.id]);
  const work=await enqueue(tx,owner,'plan',input.id,{projectID:input.id,baseRevisionID:null});
  if(input.notificationDeviceID)await watchNotificationJob(tx,owner,input.notificationDeviceID,work.id);
  return ownedProject(tx,owner,input.id);
 });
}
export async function saveRevision(db:Database,owner:string,projectID:string,timeline:Timeline,baseRevisionID:string|null,origin:string,summary:string,evidenceVersions:unknown={},feedback=''){
 return transaction(db,async tx=>{
  const project=(await tx.query<any>('SELECT * FROM pbj_projects WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,projectID])).rows[0];if(!project)throw new Error('Project not found');
  const exists=(await tx.query<any>('SELECT * FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[owner,projectID,timeline.id])).rows[0];
  if(exists){if(!isDeepStrictEqual(exists.timeline,timeline))throw new Error('Revision ID conflict');return exists;}
  validateTimeline(timeline,(await projectSources(tx,owner,projectID)).map(assetSource),origin==='initial'||origin==='ai_revision'?project.required_moments:[]);
  if((timeline.parentID??null)!==baseRevisionID)throw new Error('Revision parent conflicts with the saved base revision');
  if(baseRevisionID&&!(await tx.query('SELECT id FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[owner,projectID,baseRevisionID])).rows.length)throw new Error('Base revision not found');
  const accepted=project.current_revision_id===baseRevisionID;
  const row=(await tx.query<any>(`INSERT INTO pbj_revisions(id,owner_id,project_id,parent_id,origin,timeline,evidence_versions,summary,feedback,accepted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[timeline.id,owner,projectID,baseRevisionID,origin,JSON.stringify(timeline),JSON.stringify(evidenceVersions),summary,feedback,accepted])).rows[0];
  if(accepted)await tx.query(`UPDATE pbj_projects SET current_revision_id=$3,status=$4,updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,projectID,timeline.id,origin==='approved'?'approved':origin==='manual'?'editing':'review']);
  return row;
 });
}
export async function requestRevision(db:Database,owner:string,projectID:string,id:string,baseRevisionID:string,instruction:string,scopeClipIDs?:string[],notificationDeviceID?:string){
 return transaction(db,async tx=>{
  await ownedProject(tx,owner,projectID);
  const base=(await tx.query<any>('SELECT timeline FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[owner,projectID,baseRevisionID])).rows[0];if(!base)throw new Error('Revision not found');
  if(scopeClipIDs?.some(id=>!base.timeline.clips.some((clip:any)=>clip.id===id)))throw new Error('Selected clip no longer exists');
  const work=await enqueue(tx,owner,'plan',id,{projectID,baseRevisionID,instruction,scopeClipIDs},true);
  if(notificationDeviceID)await watchNotificationJob(tx,owner,notificationDeviceID,work.id);return work;
 });
}
export async function snapshotRevision(db:Database,owner:string,projectID:string,revisionID:string,baseRevisionID:string,origin:'approved'|'restored',id:string=randomUUID()){
 const source=(await db.query<any>('SELECT * FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[owner,projectID,revisionID])).rows[0];if(!source)throw new Error('Revision not found');
 const existing=(await db.query<any>('SELECT origin,evidence_versions FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[owner,projectID,id])).rows[0];
 if(existing&&(existing.origin!==origin||(existing.evidence_versions?.snapshot?.sourceRevisionID&&existing.evidence_versions.snapshot.sourceRevisionID!==revisionID)))throw new Error('Snapshot request ID conflict');
 // parent_id records the head replaced by this operation. It is not necessarily
 // the revision whose content was chosen (especially when restoring a branch).
 const evidence={...source.evidence_versions,snapshot:{sourceRevisionID:source.id}};
 return saveRevision(db,owner,projectID,{...source.timeline,id,parentID:baseRevisionID},baseRevisionID,origin,origin==='approved'?'Approved rough cut':'Restored previous version',evidence);
}
