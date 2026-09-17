import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/v2/database.ts';
import type {Database} from '../src/v2/database.ts';
import type {Timeline} from '../src/v2/contracts.ts';
import {createProject,saveRevision,snapshotRevision} from '../src/v2/projects.ts';
import {collectLearningOutcome,enqueueLearningOutcome} from '../src/v2/learningOutcomes.ts';

async function fixture(){
 const db=new PGlite();await migrate(db as Database);
 const sourceID=randomUUID(),projectID=randomUUID();
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata)
  VALUES($1,'owner',$2,'flight.mov','unused',600000,'{"originalAudio":true}')`,[sourceID,'a'.repeat(64)]);
 await createProject(db as Database,'owner',{id:projectID,title:'Flight',brief:'Chronological flight',assetIDs:[sourceID],durationGoal:null,required:[]});
 const timeline:Timeline={schemaVersion:1,id:randomUUID(),parentID:null,width:1080,height:1920,fps:30,
  clips:[{id:'setup',sourceID,sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fit'}]};
 const initial=await saveRevision(db as Database,'owner',projectID,timeline,null,'initial','A long setup',
  {decisions:[{clipID:'setup',reason:'Establish the cockpit before takeoff',evidenceIDs:['analysis'],memoryIDs:[]}]});
 const save=async(base:any,origin:string,update:Partial<Timeline['clips'][number]>,feedback='')=>{
  const timeline={...base.timeline,id:randomUUID(),parentID:base.id,clips:base.timeline.clips.map((c:any)=>({...c,...update}))};
  return saveRevision(db as Database,'owner',projectID,timeline,base.id,origin,'Changed cut',{},feedback);
 };
 const collect=(revision:any)=>collectLearningOutcome(db as Database,'owner',projectID,revision);
 const snapshot=(source:any,head:any,origin:'approved'|'restored'='approved')=>snapshotRevision(db as Database,'owner',projectID,source.id,head.id,origin);
 return {db,sourceID,projectID,initial,save,collect,snapshot};
}

test('explicit approval captures an actual AI correction, then export and repeated snapshots share one event',async()=>{
 const f=await fixture();try{
  const ai=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten the cockpit setup');
  const approval=await f.snapshot(ai,ai),outcome=await f.collect(approval);
  assert.deepEqual(outcome.requests.map(r=>r.instruction),['Shorten the cockpit setup']);
  assert.equal((outcome.requests[0].differences[0].before as any).duration,180000);
  assert.equal((outcome.requests[0].differences[0].after as any).duration,120000);
  assert.equal(approval.evidence_versions.snapshot.sourceRevisionID,ai.id);
  const first=await enqueueLearningOutcome(f.db as Database,'owner',f.projectID,approval,'approval');
  const exported=await enqueueLearningOutcome(f.db as Database,'owner',f.projectID,approval,'export');
  const repeated=await f.snapshot(approval,approval);
  const retried=await enqueueLearningOutcome(f.db as Database,'owner',f.projectID,repeated,'approval');
  assert.equal(first?.id,exported?.id);assert.equal(first?.id,retried?.id);
  assert.equal((first?.payload.outcome as any).baseRevisionID,f.initial.id);
  assert.equal((first?.payload.outcome as any).base,undefined,'Do not freeze a whole revision history in the job');
  assert.equal((await f.collect(repeated)).eventKey,outcome.eventKey);
  await assert.rejects(()=>snapshotRevision(f.db as Database,'owner',f.projectID,approval.id,ai.id,'approved',approval.id),/conflict/);
  await assert.rejects(()=>snapshotRevision(f.db as Database,'owner',f.projectID,ai.id,ai.id,'restored',approval.id),/conflict/);
 }finally{await f.db.close();}
});

test('untouched AI decisions and requests with no surviving change do not become lessons',async()=>{
 const f=await fixture();try{
  assert.equal(await enqueueLearningOutcome(f.db as Database,'owner',f.projectID,await f.snapshot(f.initial,f.initial),'approval'),undefined);
  const ai=await f.save(f.initial,'ai_revision',{sourceDuration:120000});
  assert.equal((await f.collect(ai)).requests.length,0,'AI output alone supplies no user instruction');
  const requested=await f.save(ai,'ai_revision',{sourceDuration:60000},'Shorter again');
  const undone=await f.save(requested,'manual',{sourceDuration:120000});
  assert.equal((await f.collect(undone)).requests.length,0,'The user undid this requested result');
 }finally{await f.db.close();}
});

test('consecutive AI requests retain separate surviving changes and omit superseded fields',async()=>{
 const f=await fixture();try{
  const first=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten the setup');
  const second=await f.save(first,'ai_revision',{volume:.4},'Lower the engine volume');
  const approved=await f.snapshot(second,second);
  assert.deepEqual(new Set((await f.collect(approved)).requests.map(r=>r.revisionID)),new Set([first.id,second.id]));
  const third=await f.save(approved,'ai_revision',{sourceDuration:60000},'Make the setup even shorter');
  const requests=(await f.collect(third)).requests;
  assert.deepEqual(new Set(requests.map(r=>r.revisionID)),new Set([second.id,third.id]));
 }finally{await f.db.close();}
});

test('manual outcomes aggregate saves and use scene and original decision context',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO pbj_analysis(id,owner_id,asset_id,status,idempotency_key,intent,full_response,evidence)
   VALUES('analysis','owner',$1,'complete','analysis','{}','{}',$2)`,[f.sourceID,JSON.stringify({scenes:[
    {id:'cockpit',start:0,end:3,visual:'Pilot prepares controls',audio:'Engine',speech:'Ready',confidence:'moderate'},
    {id:'later',start:7,end:9,visual:'Landing',audio:'Engine',speech:'',confidence:'moderate'}]})]);
  const first=await f.save(f.initial,'manual',{sourceDuration:120000});
  const final=await f.save(first,'manual',{sourceDuration:60000});
  const outcome=await f.collect(await f.snapshot(final,final));
  assert.equal(outcome.base?.id,f.initial.id);assert.equal(outcome.differences.length,1);
  assert.equal((outcome.differences[0].before as any).duration,180000);assert.equal((outcome.differences[0].after as any).duration,60000);
  const context=outcome.changedClips[0] as any;
  assert.equal(context.decisions[0].reason,'Establish the cockpit before takeoff');
  assert.deepEqual(context.scenes.map((s:any)=>s.id),['cockpit']);
  const undone=await f.save(final,'manual',{sourceDuration:180000});
  assert.equal((await f.collect(undone)).differences.length,0);
 }finally{await f.db.close();}
});

test('restoring a branch follows the chosen source, not the abandoned current head',async()=>{
 const f=await fixture();try{
  const kept=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Keep a shorter setup');
  const abandoned=await f.save(kept,'ai_revision',{volume:0},'Mute everything');
  const restored=await f.snapshot(kept,abandoned,'restored');
  const outcome=await f.collect(await f.snapshot(restored,restored));
  assert.deepEqual(outcome.requests.map(r=>r.revisionID),[kept.id]);
  assert.ok(!outcome.rootEvidenceIDs.includes(abandoned.id));
  // accepted=false is conflict metadata. Explicitly choosing a saved branch
  // later is valid, whereas unrelated stale requests never enter this lineage.
  const stale=await f.save(f.initial,'ai_revision',{sourceDuration:60000},'An abandoned concurrent request');
  assert.equal(stale.accepted,false);
  assert.ok(!(await f.collect(restored)).requests.some(r=>r.revisionID===stale.id));
 }finally{await f.db.close();}
});

test('legacy approvals require identical parent content and legacy restores never guess',async()=>{
 const f=await fixture();try{
  const ai=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten setup');
  const legacy={...ai.timeline,id:randomUUID(),parentID:ai.id};
  const approved=await saveRevision(f.db as Database,'owner',f.projectID,legacy,ai.id,'approved','legacy');
  assert.equal((await f.collect(approved)).requests.length,1);
  const restored=await saveRevision(f.db as Database,'owner',f.projectID,{...legacy,id:randomUUID(),parentID:approved.id},approved.id,'restored','unknown selected source');
  const outcome=await f.collect(restored);assert.equal(outcome.requests.length,0);assert.equal(outcome.completeLineage,false);
  const invalid=await saveRevision(f.db as Database,'owner',f.projectID,{...f.initial.timeline,id:randomUUID(),parentID:restored.id},restored.id,'approved','different content');
  assert.equal((await f.collect(invalid)).requests.length,0);
 }finally{await f.db.close();}
});

test('content-equivalent new clip IDs do not inflate an exported manual correction',async()=>{
 const f=await fixture();try{
  const manual=await f.save(f.initial,'manual',{sourceDuration:120000});
  const clone=await saveRevision(f.db as Database,'owner',f.projectID,{...manual.timeline,id:randomUUID(),parentID:manual.id,
   clips:manual.timeline.clips.map((c:any)=>({...c,id:randomUUID(),speed:1,rotation:0}))},manual.id,'manual','same edit');
  const first=await f.collect(manual),second=await f.collect(clone);
  assert.equal(first.eventKey,second.eventKey);assert.deepEqual(first.differences,second.differences);
 }finally{await f.db.close();}
});

test('fresh IDs for unchanged shots and recreated removals do not become false corrections',async()=>{
 const f=await fixture();try{
  const second={...f.initial.timeline.clips[0],id:'reaction',sourceIn:240000,outputStart:180000};
  const base=await saveRevision(f.db as Database,'owner',f.projectID,{...f.initial.timeline,id:randomUUID(),parentID:f.initial.id,
   clips:[f.initial.timeline.clips[0],second]},f.initial.id,'manual','Add reaction');
  const ai=await saveRevision(f.db as Database,'owner',f.projectID,{...base.timeline,id:randomUUID(),parentID:base.id,
   clips:[{...base.timeline.clips[0],sourceDuration:120000},{...second,id:'regenerated',outputStart:120000}]},base.id,'ai_revision','Shorter setup',{},'Shorten the setup');
  const request=(await f.collect(ai)).requests[0];assert.deepEqual(request.differences.map(c=>c.kind),['trimmed']);
  const removed=await saveRevision(f.db as Database,'owner',f.projectID,{...ai.timeline,id:randomUUID(),parentID:ai.id,
   clips:[ai.timeline.clips[0]]},ai.id,'ai_revision','Remove reaction',{},'Remove the reaction');
  const recreated=await saveRevision(f.db as Database,'owner',f.projectID,{...ai.timeline,id:randomUUID(),parentID:removed.id,
   clips:[ai.timeline.clips[0],{...ai.timeline.clips[1],id:'recreated'}]},removed.id,'manual','Bring it back');
  assert.ok(!(await f.collect(recreated)).requests.some(r=>r.revisionID===removed.id));
 }finally{await f.db.close();}
});

test('keeping an old manual correction in a later export retains its independent root',async()=>{
 const f=await fixture();try{
  const trim=await f.save(f.initial,'manual',{sourceDuration:120000});
  const first=await f.collect(await f.snapshot(trim,trim));
  const volume=await f.save(trim,'manual',{volume:.5}),later=await f.collect(volume);
  assert.equal(first.rootEvidenceIDs.length,1);assert.ok(later.rootEvidenceIDs.includes(first.rootEvidenceIDs[0]));
  assert.equal(later.rootEvidenceIDs.length,2);
 }finally{await f.db.close();}
});

test('human evidence catalog maps each independent choice to its exact retained change and sources',async()=>{
 const f=await fixture();try{
  const ai=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten setup');
  const manual=await f.save(ai,'manual',{volume:.5});
  const approval=await f.snapshot(manual,manual),outcome=await f.collect(approval);
  assert.deepEqual(new Set(outcome.evidence.map(e=>e.id)),new Set(outcome.rootEvidenceIDs));
  const request=outcome.evidence.find(e=>e.kind==='ai_request')!;
  assert.equal(request.id,ai.id);assert.equal(request.instruction,'Shorten setup');
  assert.equal(request.baseRevisionID,f.initial.id);assert.deepEqual(request.differences.map(d=>d.kind),['trimmed']);
  assert.deepEqual(request.sourceIDs,[f.sourceID]);
  const edit=outcome.evidence.find(e=>e.kind==='manual_change')!;
  assert.ok(edit.id.startsWith('manual-change:'));assert.equal(edit.instruction,undefined);
  assert.equal(edit.revisionID,manual.id);assert.equal(edit.baseRevisionID,ai.id);
  assert.deepEqual(edit.differences,outcome.differences);assert.deepEqual(edit.sourceIDs,[f.sourceID]);
  const job=await enqueueLearningOutcome(f.db as Database,'owner',f.projectID,approval,'approval');
  assert.deepEqual((job!.payload.outcome as any).evidence,outcome.evidence);
  const undone=await f.save(approval,'manual',{volume:1}),afterUndo=await f.collect(undone);
  assert.ok(!afterUndo.evidence.some(e=>e.id===edit.id));
  const abandoned=await f.save(undone,'ai_revision',{sourceDuration:60000},'An unwanted shorter setup');
  const restored=await f.snapshot(undone,abandoned,'restored'),afterRestore=await f.collect(restored);
  assert.ok(!afterRestore.evidence.some(e=>e.id===abandoned.id));
  assert.deepEqual(afterRestore.evidence.map(e=>e.id),[ai.id]);
 }finally{await f.db.close();}
});

test('project-only feedback before approval stays context-only and constrains reuse beyond the display bound',async()=>{
 const f=await fixture();try{
  const ai=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten setup'),privateID=randomUUID();
  await f.db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable,created_at)
   VALUES($1,'owner',$2,$3,'For this project only: keep the reaction.',false,'2026-01-01')`,[privateID,f.projectID,ai.id]);
  const approval=await f.snapshot(ai,ai),approvedOutcome=await f.collect(approval);
  assert.equal(approvedOutcome.reusableAllowed,false);
  assert.deepEqual(approvedOutcome.contextFeedback.map(f=>f.id),[privateID]);
  assert.ok(!approvedOutcome.rootEvidenceIDs.includes(privateID),'Context must not become another independent feedback event');
  const approvedJob=await enqueueLearningOutcome(f.db as Database,'owner',f.projectID,approval,'approval');
  assert.equal((approvedJob!.payload.outcome as any).reusableAllowed,false);
  assert.equal((approvedJob!.payload.outcome as any).contextFeedback[0].id,privateID);
  // Older project-only feedback must still constrain reuse when the latest
  // twelve visible comments are all reusable and saved on an approval wrapper.
  for(let i=0;i<13;i++)await f.db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable,created_at)
   VALUES($1,'owner',$2,$3,$4,true,'2026-02-01'::timestamptz+make_interval(secs=>$5))`,
   [randomUUID(),f.projectID,approval.id,i===12?'x'.repeat(3500):'Keep the setup concise.',i]);
  const manual=await f.save(approval,'manual',{volume:.5}),exportedOutcome=await f.collect(manual);
  assert.equal(exportedOutcome.reusableAllowed,false);assert.equal(exportedOutcome.contextFeedback.length,12);
  assert.ok(exportedOutcome.contextFeedback.every(f=>f.reusable));
  assert.equal(exportedOutcome.contextFeedback[0].text.length,3000);assert.equal(exportedOutcome.contextFeedback[0].textTruncated,true);
 }finally{await f.db.close();}
});

test('abandoned branch feedback neither teaches nor constrains a restored outcome',async()=>{
 const f=await fixture();try{
  const kept=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten setup');
  const abandoned=await f.save(kept,'ai_revision',{volume:0},'Mute sound'),feedbackID=randomUUID();
  await f.db.query(`INSERT INTO pbj_feedback(id,owner_id,project_id,revision_id,text,reusable)
   VALUES($1,'owner',$2,$3,'This mute is for this project only.',false)`,[feedbackID,f.projectID,abandoned.id]);
  const restored=await f.snapshot(kept,abandoned,'restored'),outcome=await f.collect(await f.snapshot(restored,restored));
  assert.equal(outcome.reusableAllowed,true);assert.deepEqual(outcome.contextFeedback,[]);
  assert.ok(!outcome.rootEvidenceIDs.includes(feedbackID));
  const legacy=await saveRevision(f.db as Database,'owner',f.projectID,{...kept.timeline,id:randomUUID(),parentID:restored.id},restored.id,'restored','Legacy source unknown');
  assert.equal((await f.collect(legacy)).reusableAllowed,false,'Unknown older scope must not grant reuse');
 }finally{await f.db.close();}
});

test('bounded lineage excludes foreign owners and terminates corrupt cycles',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>collectLearningOutcome(f.db as Database,'another-owner',f.projectID,f.initial),/not found/);
  const ai=await f.save(f.initial,'ai_revision',{sourceDuration:120000},'Shorten setup');
  await f.db.query('UPDATE pbj_revisions SET parent_id=$2 WHERE id=$1',[f.initial.id,ai.id]);
  const outcome=await f.collect(ai);assert.equal(outcome.completeLineage,false);
  assert.equal(outcome.requests.length,1,'The directly saved parent comparison is still grounded');
 }finally{await f.db.close();}
});
