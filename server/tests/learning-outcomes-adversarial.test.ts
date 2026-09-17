import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,type Database} from '../src/v2/database.ts';
import type {Timeline} from '../src/v2/contracts.ts';
import {createProject,saveRevision,snapshotRevision} from '../src/v2/projects.ts';
import {collectLearningOutcome} from '../src/v2/learningOutcomes.ts';

async function fixture(duplicate=false){
 const db=new PGlite();await migrate(db as Database);
 const sourceID=randomUUID(),projectID=randomUUID();
 await db.query(`INSERT INTO pbj_assets(id,owner_id,original_sha256,original_name,storage_key,duration_ticks,metadata)
  VALUES($1,'owner',$2,'flight.mov','unused',600000,'{"originalAudio":true}')`,[sourceID,'a'.repeat(64)]);
 await createProject(db as Database,'owner',{id:projectID,title:'Flight',brief:'Flight moments',assetIDs:[sourceID],durationGoal:null,required:[]});
 const shot:Timeline['clips'][number]={id:'setup',sourceID,sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fit'};
 const sequence=(clips:Timeline['clips'])=>{let outputStart=0;return clips.map(c=>{const clip={...c,outputStart};outputStart+=c.sourceDuration/(c.speed??1);return clip;});};
 const timeline:Timeline={schemaVersion:1,id:randomUUID(),parentID:null,width:1080,height:1920,fps:30,
  clips:sequence([shot,{...shot,id:'reaction',sourceIn:duplicate?0:240000}])};
 const initial=await saveRevision(db as Database,'owner',projectID,timeline,null,'initial','Two flight moments');
 const save=(base:any,origin:string,clips:Timeline['clips'],feedback='')=>saveRevision(db as Database,'owner',projectID,
  {...base.timeline,id:randomUUID(),parentID:base.id,clips:sequence(clips)},base.id,origin,'Edited flight',{},feedback);
 const collect=(revision:any)=>collectLearningOutcome(db as Database,'owner',projectID,revision);
 const snapshot=(source:any,head:any,origin:'approved'|'restored'='approved')=>snapshotRevision(db as Database,'owner',projectID,source.id,head.id,origin);
 return {db,initial,save,collect,snapshot};
}

test('undoing an added duplicate does not retain the request just because an identical older shot remains',async()=>{
 const f=await fixture();try{
  const added=await f.save(f.initial,'ai_revision',[...f.initial.timeline.clips,{...f.initial.timeline.clips[0],id:'replay'}],'Replay the setup');
  const undone=await f.save(added,'manual',f.initial.timeline.clips);
  assert.ok(!(await f.collect(undone)).requests.some(r=>r.revisionID===added.id),'The requested extra occurrence was removed');
 }finally{await f.db.close();}
});

test('removing one duplicate is a retained removal even though its identical twin is still present',async()=>{
 const f=await fixture(true);try{
  const removed=await f.save(f.initial,'ai_revision',[f.initial.timeline.clips[0]],'Remove the repeat');
  const outcome=await f.collect(removed);
  assert.deepEqual(outcome.requests.map(r=>r.revisionID),[removed.id]);
  assert.deepEqual(outcome.requests[0].differences.map(d=>[d.kind,d.clipID]),[['removed','reaction']]);
 }finally{await f.db.close();}
});

test('retained trim survives an exact shot ID change followed by a later audio correction',async()=>{
 const f=await fixture();try{
  const trimmed=await f.save(f.initial,'ai_revision',f.initial.timeline.clips.map((c:any)=>c.id==='setup'?{...c,sourceDuration:120000}:c),'Shorten the setup');
  const renamed=await f.save(trimmed,'ai_revision',trimmed.timeline.clips.map((c:any)=>c.id==='setup'?{...c,id:'new-setup'}:{...c,volume:.4}),'Lower the reaction audio');
  const final=await f.save(renamed,'manual',renamed.timeline.clips.map((c:any)=>c.id==='new-setup'?{...c,volume:.5}:c));
  const outcome=await f.collect(await f.snapshot(final,final));
  assert.deepEqual(new Set(outcome.requests.map(r=>r.revisionID)),new Set([trimmed.id,renamed.id]));
  assert.deepEqual(outcome.requests.find(r=>r.revisionID===trimmed.id)!.differences.map(d=>d.kind),['trimmed']);
  assert.deepEqual(outcome.differences.map(d=>d.kind),['audio']);
 }finally{await f.db.close();}
});

test('a content-equivalent ID refresh between manual saves does not turn trim and volume into remove/add',async()=>{
 const f=await fixture();try{
  const trimmed=await f.save(f.initial,'manual',f.initial.timeline.clips.map((c:any)=>c.id==='setup'?{...c,sourceDuration:120000}:c));
  const first=await f.collect(trimmed);
  const renamed=await f.save(trimmed,'ai_revision',trimmed.timeline.clips.map((c:any)=>({...c,id:'new-'+c.id})));
  const final=await f.save(renamed,'manual',renamed.timeline.clips.map((c:any)=>c.id==='new-setup'?{...c,volume:.5}:c));
  const outcome=await f.collect(final);
  assert.deepEqual(outcome.differences.map(d=>d.kind).sort(),['audio','trimmed']);
  assert.ok(outcome.rootEvidenceIDs.includes(first.rootEvidenceIDs[0]),'Keeping the same trim retains its original evidence root');
 }finally{await f.db.close();}
});

test('restoring the chosen pre-undo branch retains only its own requests, including after redo',async()=>{
 const f=await fixture();try{
  const shortened=await f.save(f.initial,'ai_revision',f.initial.timeline.clips.map((c:any)=>({...c,sourceDuration:120000})),'Shorter moments');
  const undo=await f.snapshot(f.initial,shortened,'restored');
  assert.deepEqual((await f.collect(undo)).requests,[]);
  const redo=await f.snapshot(shortened,undo,'restored');
  assert.deepEqual((await f.collect(redo)).requests.map(r=>r.revisionID),[shortened.id]);
  const muted=await f.save(redo,'ai_revision',redo.timeline.clips.map((c:any)=>({...c,muted:true})),'Mute both');
  const restored=await f.snapshot(shortened,muted,'restored');
  assert.deepEqual((await f.collect(restored)).requests.map(r=>r.revisionID),[shortened.id]);
 }finally{await f.db.close();}
});

test('an ID-only refresh of identical shots preserves their positions for the next real correction',async()=>{
 const f=await fixture(true);try{
  const renamed=await f.save(f.initial,'ai_revision',f.initial.timeline.clips.map((c:any)=>({...c,id:'new-'+c.id})));
  const changed=await f.save(renamed,'manual',renamed.timeline.clips.map((c:any)=>c.id==='new-reaction'?{...c,volume:.5}:c));
  const outcome=await f.collect(changed);
  assert.deepEqual(outcome.differences.map(d=>[d.kind,d.clipID]),[['audio','reaction']]);
 }finally{await f.db.close();}
});

test('returning to an old trim value credits the latest request, not the overwritten earlier request',async()=>{
 const f=await fixture();try{
  const resize=(revision:any,duration:number)=>revision.timeline.clips.map((c:any)=>c.id==='setup'?{...c,sourceDuration:duration}:c);
  const first=await f.save(f.initial,'ai_revision',resize(f.initial,120000),'Shorten the empty setup');
  const overwritten=await f.save(first,'ai_revision',resize(first,60000),'Make the opening much faster');
  const returned=await f.save(overwritten,'ai_revision',resize(overwritten,120000),'Restore some breathing room');
  assert.deepEqual((await f.collect(returned)).requests.map(r=>r.revisionID),[returned.id]);
 }finally{await f.db.close();}
});
