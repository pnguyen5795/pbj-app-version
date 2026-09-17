import express from 'express';
import path from 'node:path';
import { thumbnail } from './media.ts';
import type { Request,Response,NextFunction } from 'express';
import { verifyToken } from '@clerk/backend';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from './database.ts';
import type { ObjectStore } from './storage.ts';
import { reserveUpload,appendChunk,finishUpload,uploadStatus } from './uploads.ts';
import { assetSource,createProject,ownedProject,projectSources,saveRevision,requestRevision,snapshotRevision } from './projects.ts';
import { timelineSchema,clipOutputDuration } from './contracts.ts';
import { enqueue } from './jobs.ts';
import { transaction } from './database.ts';
import { listEffectiveMemory,setMemoryEnabled } from './memory.ts';
import { enqueueLearningOutcome } from './learningOutcomes.ts';
import { NotificationBridge,watchNotificationJob } from './notifications.ts';
const id=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().trim().min(1).max(12000);
export function parseAuthorizedParties(value:string|undefined){return value?.split(',').map(party=>party.trim()).filter(Boolean);}
export interface APIOptions {db:Database;storage:ObjectStore;uploadRoot:string;resolveMedia:(asset:any)=>Promise<string>;localDevelopment?:boolean;aiProcessingEnabled?:boolean;authenticate?:(request:Request)=>Promise<string>;notifications?:NotificationBridge;}
export function createAPI(options:APIOptions){
 const {db,storage,uploadRoot}=options;const app=express();app.disable('x-powered-by');
 const notifications=options.notifications??new NotificationBridge(db);
 app.get('/health',(_req,res)=>res.json({status:'ok',service:'pbj-native-api'}));
 app.use('/v2',async(req:Request,res:Response,next:NextFunction)=>{
  try{
   let owner:string|undefined;
   if(options.authenticate)owner=await options.authenticate(req);
   else if(options.localDevelopment&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''))owner='local-spike';
   else {const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||!process.env.CLERK_SECRET_KEY)throw new Error('Authentication required');const claims=await verifyToken(token,{secretKey:process.env.CLERK_SECRET_KEY,authorizedParties:parseAuthorizedParties(process.env.CLERK_AUTHORIZED_PARTIES)});owner=claims.sub;}
   if(!owner)throw new Error('Authentication required');res.locals.owner=owner;next();
  }catch{res.status(401).json({error:'Sign in again to continue.'});}
 });
 const route=(method:'get'|'post'|'put'|'patch'|'delete',path:string,handler:(req:Request,res:Response)=>Promise<unknown>,raw=false)=>{
  app[method]('/v2'+path,raw?express.raw({type:'application/octet-stream',limit:'8mb'}):express.json({limit:'2mb'}),async(req,res,next)=>{try{const result=await handler(req,res);if(!res.headersSent)res.json(result??{ok:true});}catch(error){next(error);}});
 };
 route('get','/service-status',async()=>({aiProcessingEnabled:options.aiProcessingEnabled??true,pushNotificationsEnabled:notifications.remoteEnabled}));
 route('put','/notification-devices/:id',async(req,res)=>notifications.register(res.locals.owner,id.parse(req.params.id),z.object({token:z.string().regex(/^(?:[a-fA-F0-9]{2}){16,256}$/).transform(value=>value.toLowerCase()).nullable().default(null),environment:z.enum(['sandbox','production']),enabled:z.boolean()}).parse(req.body)));
 route('delete','/notification-devices/:id',async(req,res)=>notifications.unregister(res.locals.owner,id.parse(req.params.id)));
 route('post','/notification-devices/:id/watch',async(req,res)=>notifications.watch(res.locals.owner,id.parse(req.params.id),z.object({jobID:id.optional(),projectID:id.optional()}).refine(value=>!!value.jobID!==!!value.projectID,'Choose one work item').parse(req.body)));
 route('get','/notifications',async(req,res)=>notifications.feed(res.locals.owner,id.parse(req.query.deviceID),z.string().regex(/^\d{1,18}$/).parse(req.query.after??'0')));
 route('post','/notifications/:id/ack',async(req,res)=>notifications.acknowledge(res.locals.owner,z.object({deviceID:id}).parse(req.body).deviceID,id.parse(req.params.id)));
 route('get','/account',async(_req,res)=>{
  const owner=res.locals.owner;const usage=(await db.query<any>('SELECT kind,usage FROM pbj_provider_calls WHERE owner_id=$1 AND usage IS NOT NULL',[owner])).rows;
  const media=(await db.query<any>('SELECT sum(duration_ticks)/60000.0 as seconds FROM pbj_assets WHERE owner_id=$1',[owner])).rows[0];
  const analyzed=(await db.query<any>(`SELECT count(*) AS n FROM pbj_analysis WHERE owner_id=$1 AND status='complete'`,[owner])).rows[0];
  const spoken=(await db.query<any>(`SELECT coalesce(sum(a.duration_ticks)/60000.0,0) AS seconds FROM pbj_speech_timing s JOIN pbj_assets a ON a.owner_id=s.owner_id AND a.id=s.asset_id WHERE s.owner_id=$1 AND s.status='complete'`,[owner])).rows[0];
  return {ownerID:owner,sourceSeconds:Number(media.seconds??0),analyzedFiles:Number(analyzed.n),speechSeconds:Number(spoken.seconds),providerRequests:usage.length,inputTokens:usage.reduce((n,c)=>n+Number(c.usage.input_tokens??0),0),outputTokens:usage.reduce((n,c)=>n+Number(c.usage.output_tokens??0),0)};
 });
 route('post','/uploads',async(req,res)=>reserveUpload(db,res.locals.owner,z.object({sha256:sha,fileName:z.string().min(1).max(255),byteCount:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).parse(req.body),uploadRoot));
 route('get','/uploads/:id',async(req,res)=>{const row=(await db.query<any>('SELECT * FROM pbj_uploads WHERE owner_id=$1 AND id=$2',[res.locals.owner,id.parse(req.params.id)])).rows[0];if(!row)throw new Error('Upload not found');return uploadStatus(row);});
 route('put','/uploads/:id/chunk',async(req,res)=>{if(!Buffer.isBuffer(req.body))throw new Error('Binary chunk required');return appendChunk(db,res.locals.owner,id.parse(req.params.id),z.coerce.number().int().nonnegative().parse(req.query.offset),req.body,uploadRoot);},true);
 route('post','/uploads/:id/complete',async(req,res)=>finishUpload(db,res.locals.owner,id.parse(req.params.id),uploadRoot,storage));
 route('get','/assets/:id',async(req,res)=>{const asset=(await db.query<any>('SELECT * FROM pbj_assets WHERE owner_id=$1 AND id=$2',[res.locals.owner,id.parse(req.params.id)])).rows[0];if(!asset)throw new Error('Asset not found');return assetSource(asset);});
 route('get','/assets/:id/thumbnail',async(req,res)=>{const asset=(await db.query<any>('SELECT * FROM pbj_assets WHERE owner_id=$1 AND id=$2',[res.locals.owner,id.parse(req.params.id)])).rows[0];if(!asset)throw new Error('Asset not found');const ticks=z.coerce.number().int().nonnegative().max(Math.max(0,Number(asset.duration_ticks)-1)).parse(req.query.ticks??0);const file=await thumbnail(await options.resolveMedia(asset),path.join(uploadRoot,'thumbnails'),asset.original_sha256,ticks);res.setHeader('Cache-Control','private, no-store');await new Promise<void>((resolve,reject)=>res.sendFile(file,error=>error?reject(error):resolve()));});
 route('get','/assets/:id/content',async(req,res)=>{const asset=(await db.query<any>('SELECT * FROM pbj_assets WHERE owner_id=$1 AND id=$2',[res.locals.owner,id.parse(req.params.id)])).rows[0];if(!asset)throw new Error('Asset not found');res.setHeader('Cache-Control','private, no-store');const file=await options.resolveMedia(asset);await new Promise<void>((resolve,reject)=>res.sendFile(file,error=>error?reject(error):resolve()));});
 route('get','/projects',async(_req,res)=>({archivedProjectIDs:(await db.query<any>('SELECT id FROM pbj_projects WHERE owner_id=$1 AND archived',[res.locals.owner])).rows.map(p=>p.id),projects:(await db.query<any>(`SELECT p.*,r.timeline->'clips'->0->>'sourceID' AS cover_asset_id,coalesce((r.timeline->'clips'->0->>'sourceIn')::bigint,0)::float8 AS cover_ticks,(SELECT sum(round((c->>'sourceDuration')::numeric/coalesce((c->>'speed')::numeric,1)))/60000 FROM jsonb_array_elements(coalesce(r.timeline->'clips','[]'::jsonb)) c)::float8 AS duration_seconds FROM pbj_projects p LEFT JOIN pbj_revisions r ON r.owner_id=p.owner_id AND r.id=p.current_revision_id WHERE p.owner_id=$1 AND NOT p.archived ORDER BY p.updated_at DESC`,[res.locals.owner])).rows}));
 route('post','/projects',async(req,res)=>{
  const input=z.object({id,title:z.string().trim().min(1).max(100),brief:text,assetIDs:z.array(id).min(1),notificationDeviceID:id.optional(),durationGoal:z.object({seconds:z.number().positive(),mode:z.enum(['preferred','exact']),toleranceSeconds:z.number().nonnegative()}).nullable().default(null),required:z.array(z.object({sourceID:id,start:z.number().int().nonnegative(),end:z.number().int().positive(),audioRequired:z.boolean().optional()})).default([])}).parse(req.body);
  return createProject(db,res.locals.owner,input);
 });
 route('get','/projects/:id',async(req,res)=>{const project=await ownedProject(db,res.locals.owner,id.parse(req.params.id));return {project,sources:(await projectSources(db,res.locals.owner,project.id)).map(assetSource),revisions:(await db.query<any>('SELECT * FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 ORDER BY created_at',[res.locals.owner,project.id])).rows,jobs:(await db.query<any>(`SELECT id,kind,status,stage,last_error,result,payload FROM pbj_jobs WHERE owner_id=$1 AND payload->>'projectID'=$2 ORDER BY created_at`,[res.locals.owner,project.id])).rows};});
 route('patch','/projects/:id',async(req,res)=>{const input=z.object({title:z.string().trim().min(1).max(100).optional(),archived:z.boolean().optional()}).parse(req.body);await ownedProject(db,res.locals.owner,id.parse(req.params.id));await db.query('UPDATE pbj_projects SET title=coalesce($3,title),archived=coalesce($4,archived),updated_at=now() WHERE owner_id=$1 AND id=$2',[res.locals.owner,req.params.id,input.title??null,input.archived??null]);return {ok:true};});
 route('post','/projects/:id/inputs',async(req,res)=>{const input=z.object({assetIDs:z.array(id).min(1)}).parse(req.body);return transaction(db,async tx=>{await ownedProject(tx,res.locals.owner,id.parse(req.params.id));for(const assetID of input.assetIDs){if(!(await tx.query('SELECT id FROM pbj_assets WHERE owner_id=$1 AND id=$2',[res.locals.owner,assetID])).rows.length)throw new Error('Asset not found');await tx.query('INSERT INTO pbj_project_inputs(owner_id,project_id,asset_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[res.locals.owner,req.params.id,assetID]);}return {ok:true};});});
 route('post','/projects/:id/revisions',async(req,res)=>{const input=z.object({timeline:timelineSchema,baseRevisionID:id.nullable(),summary:z.string().max(12000).default('Manual edit')}).parse(req.body);id.parse(input.timeline.id);return saveRevision(db,res.locals.owner,id.parse(req.params.id),input.timeline,input.baseRevisionID,'manual',input.summary);});
 route('post','/projects/:id/revise',async(req,res)=>{const input=z.object({id,baseRevisionID:id,instruction:text,scopeClipIDs:z.array(z.string()).optional(),notificationDeviceID:id.optional()}).parse(req.body);return requestRevision(db,res.locals.owner,id.parse(req.params.id),input.id,input.baseRevisionID,input.instruction,input.scopeClipIDs,input.notificationDeviceID);});
 for(const origin of ['approve','restore'] as const)route('post','/projects/:id/'+origin,async(req,res)=>{
  const input=z.object({id,revisionID:id,baseRevisionID:id}).parse(req.body);
  const revision=await snapshotRevision(db,res.locals.owner,id.parse(req.params.id),input.revisionID,input.baseRevisionID,origin==='approve'?'approved':'restored',input.id);
  // Head acceptance alone is not endorsement. This route represents the
  // user's explicit approval; a stale rejected approval never starts learning.
  if(origin==='approve'&&revision.accepted)await enqueueLearningOutcome(db,res.locals.owner,req.params.id,revision,'approval');
  return revision;
 });
 route('post','/projects/:id/feedback',async(req,res)=>{
  const input=z.object({id,revisionID:id,text,reusable:z.boolean().default(false)}).parse(req.body);await ownedProject(db,res.locals.owner,id.parse(req.params.id));
  return transaction(db,async tx=>{
   await tx.query('INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[input.id,res.locals.owner,req.params.id,input.revisionID,input.text,input.reusable]);
   const saved=(await tx.query<any>('SELECT * FROM pbj_feedback WHERE id=$1 AND owner_id=$2',[input.id,res.locals.owner])).rows[0];
   if(!saved||saved.project_id!==req.params.id||saved.revision_id!==input.revisionID||saved.text!==input.text||saved.reusable!==input.reusable)throw new Error('Feedback request ID conflict');
   return enqueue(tx,res.locals.owner,'lesson','feedback:'+input.id,{projectID:req.params.id,revisionID:input.revisionID});
  });
 });
 route('post','/projects/:id/exports',async(req,res)=>{
  const input=z.object({id,verification:z.object({revisionID:id,durationSeconds:z.number().positive(),hasAudio:z.boolean(),decodedVideoSamples:z.number().int().min(3),sha256:sha})}).parse(req.body);
  const revision=(await db.query<any>('SELECT * FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[res.locals.owner,id.parse(req.params.id),input.verification.revisionID])).rows[0];if(!revision)throw new Error('Revision not found');
  const duration=revision.timeline.clips.reduce((n:number,c:any)=>n+clipOutputDuration(c),0)/60000;if(Math.abs(duration-input.verification.durationSeconds)>0.1)throw new Error('Export duration does not match revision');
  await db.query(`INSERT INTO pbj_exports(id,owner_id,project_id,revision_id,artifact_sha256,verification,sync_status) VALUES($1,$2,$3,$4,$5,$6,'recorded') ON CONFLICT(owner_id,revision_id) DO NOTHING`,[input.id,res.locals.owner,req.params.id,input.verification.revisionID,input.verification.sha256,JSON.stringify({...input.verification,verificationOrigin:'native-device'})]);
  // A new revision ID or repeat encoding of the same edit is not new evidence.
  const outcome=await enqueueLearningOutcome(db,res.locals.owner,req.params.id,revision,'export');
  // Keep the existing response contract for exports with no human correction.
  // The worker completes this no-op without invoking a provider.
  return outcome??enqueue(db,res.locals.owner,'lesson','export:'+revision.id,{projectID:req.params.id,revisionID:revision.id});
 });
 for(const method of ['get','post'] as const)route(method,'/projects/:id/captions',async(req,res)=>{
  const project=await ownedProject(db,res.locals.owner,id.parse(req.params.id));
  const revision=(await db.query<any>('SELECT timeline FROM pbj_revisions WHERE owner_id=$1 AND project_id=$2 AND id=$3',[res.locals.owner,project.id,project.current_revision_id])).rows[0];if(!revision)throw new Error('Revision not found');
  const audible=[...revision.timeline.clips.filter((c:any)=>!c.muted&&c.volume>0),...(revision.timeline.sounds??[]).filter((s:any)=>s.volume>0),...(revision.timeline.overlays??[]).filter((o:any)=>o.kind==='video'&&(o.volume??0)>0)];
  const sourceIDs=[...new Set<string>(audible.map((c:any)=>c.sourceID))];
  const wordsBySource:Record<string,unknown>={};let complete=true;const issues:string[]=[];
  for(const assetID of sourceIDs){
   const speech=(await db.query<any>(`SELECT evidence FROM pbj_speech_timing WHERE owner_id=$1 AND asset_id=$2 AND status='complete'`,[res.locals.owner,assetID])).rows[0];
   if(speech){wordsBySource[assetID]=speech.evidence.words;continue;}
   complete=false;
   const job=method==='post'?await enqueue(db,res.locals.owner,'speech',assetID,{projectID:project.id,assetID}):(await db.query<any>(`SELECT * FROM pbj_jobs WHERE owner_id=$1 AND kind='speech' AND dedupe_key=$2`,[res.locals.owner,assetID])).rows[0];
   if(job?.status==='attention')issues.push(job.last_error??'Speech timing needs recovery');
  }
  return {complete,wordsBySource,issues};
 });
 route('get','/jobs',async(_req,res)=>({jobs:(await db.query<any>(`SELECT id,kind,status,stage,last_error,result,payload FROM pbj_jobs WHERE owner_id=$1 AND (status<>'complete' OR id IN (SELECT id FROM pbj_jobs WHERE owner_id=$1 AND status='complete' ORDER BY created_at DESC LIMIT 20)) ORDER BY created_at DESC`,[res.locals.owner])).rows}));
 route('post','/jobs/:id/resume',async(req,res)=>{await db.query(`UPDATE pbj_jobs SET status='queued',attempts=0,available_at=now(),resumed_at=now(),last_error=NULL WHERE owner_id=$1 AND id=$2 AND status='attention'`,[res.locals.owner,id.parse(req.params.id)]);return {ok:true};});
 route('post','/teaching',async(req,res)=>{
  const input=z.object({id,finalAssetID:id,rawAssetIDs:z.array(id).default([]),attribution:text,notes:z.string().max(12000).default(''),notificationDeviceID:id.optional()}).parse(req.body);
  return transaction(db,async tx=>{const ids=[input.finalAssetID,...input.rawAssetIDs];const sources=(await tx.query('SELECT id FROM pbj_assets WHERE owner_id=$1 AND id=ANY($2::text[])',[res.locals.owner,ids])).rows;if(sources.length!==new Set(ids).size)throw new Error('Teaching source not found');await tx.query('INSERT INTO pbj_teaching_groups(id,owner_id,attribution,notes,final_asset_id,raw_asset_ids) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[input.id,res.locals.owner,input.attribution,input.notes,input.finalAssetID,JSON.stringify(input.rawAssetIDs)]);const saved=(await tx.query<any>('SELECT * FROM pbj_teaching_groups WHERE owner_id=$1 AND id=$2',[res.locals.owner,input.id])).rows[0];if(!saved||saved.final_asset_id!==input.finalAssetID||saved.attribution!==input.attribution||saved.notes!==input.notes||!isDeepStrictEqual(saved.raw_asset_ids,input.rawAssetIDs))throw new Error('Teaching request ID conflict');const work=await enqueue(tx,res.locals.owner,'teach',input.id,{groupID:input.id});if(input.notificationDeviceID)await watchNotificationJob(tx,res.locals.owner,input.notificationDeviceID,work.id);return work;});
 });
 route('get','/teaching',async(_req,res)=>({groups:(await db.query(`SELECT g.*,EXISTS(SELECT 1 FROM pbj_excluded_evidence e WHERE e.owner_id=g.owner_id AND e.evidence_id=g.id) AS excluded FROM pbj_teaching_groups g WHERE g.owner_id=$1 ORDER BY g.id`,[res.locals.owner])).rows}));
 route('get','/memory',async(_req,res)=>({records:await listEffectiveMemory(db,res.locals.owner)}));
 route('patch','/memory/:id',async(req,res)=>{const input=z.object({enabled:z.boolean()}).parse(req.body);await setMemoryEnabled(db,res.locals.owner,req.params.id,input.enabled);return {ok:true};});
 route('post','/exclusions',async(req,res)=>{const input=z.object({evidenceID:z.string().min(1),excluded:z.boolean()}).parse(req.body);if(input.excluded)await db.query('INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[res.locals.owner,input.evidenceID]);else await db.query('DELETE FROM pbj_excluded_evidence WHERE owner_id=$1 AND evidence_id=$2',[res.locals.owner,input.evidenceID]);return {ok:true};});
 app.use((error:any,_req:Request,res:Response,_next:NextFunction)=>{if(res.headersSent)return;const message=error instanceof z.ZodError?'Check the request fields.':String(error.message??'Request failed');res.status(/not found/i.test(message)?404:/offset|conflict|incomplete/i.test(message)?409:400).json({error:message});});
 return app;
}
