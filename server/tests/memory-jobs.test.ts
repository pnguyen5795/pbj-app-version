import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/v2/database.ts';
import type { Timeline } from '../src/v2/contracts.ts';
import { diffTimelines,saveMemory,retrieveMemory,lessonID } from '../src/v2/memory.ts';
import { enqueue,claim,finish,retry } from '../src/v2/jobs.ts';

const timeline:Timeline={schemaVersion:1,id:'initial',width:1080,height:1920,fps:30,clips:[
  {id:'c1',sourceID:'s1',sourceIn:0,sourceDuration:180000,outputStart:0,volume:1,muted:false,fit:'fill'},
  {id:'c2',sourceID:'s2',sourceIn:0,sourceDuration:120000,outputStart:180000,volume:1,muted:false,fit:'fill'},
]};
test('trim shifts are not mislabeled as reorder; unchanged export creates no diff',()=>{
  assert.deepEqual(diffTimelines(timeline,timeline),[]);
  const after=structuredClone(timeline);
  after.clips[0].sourceDuration=60000;after.clips[1].outputStart=60000;
  assert.deepEqual(diffTimelines(timeline,after).map(d=>d.kind),['trimmed']);
  after.clips.reverse();
  assert.ok(diffTimelines(timeline,after).some(d=>d.kind==='reordered'));
});
test('lesson retry is idempotent and root exclusion disables derivatives',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await readFile(new URL('../migrations/001_native_foundation.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../migrations/006_learning_policy.sql',import.meta.url),'utf8'));
    const record={id:lessonID('owner','verified-revision'),version:1,kind:'personal_lesson' as const,context:'flight landing',
      statement:'Keep the full landing reaction in flight edits',strength:'moderate' as const,attribution:'Test fixture only',project_scope:null,
      provenance:{revisionID:'verified-revision',feedbackID:'fixture-feedback'},root_evidence_ids:['fixture-feedback','verified-revision']};
    await saveMemory(db as Database,'owner',record);await saveMemory(db as Database,'owner',record);
    assert.equal((await retrieveMemory(db as Database,'owner','flight landing','next-project')).length,1);
    assert.equal((await retrieveMemory(db as Database,'other-owner','flight landing','next-project')).length,0);
    await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','fixture-feedback')`);
    assert.equal((await retrieveMemory(db as Database,'owner','flight landing','next-project')).length,0);
    await db.query(`DELETE FROM pbj_excluded_evidence WHERE owner_id='owner' AND evidence_id='fixture-feedback'`);
    assert.equal((await retrieveMemory(db as Database,'owner','flight landing','next-project')).length,1);
  } finally {await db.close();}
});
test('durable jobs deduplicate and a stale worker cannot complete newer work',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await readFile(new URL('../migrations/001_native_foundation.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../migrations/006_learning_policy.sql',import.meta.url),'utf8'));
    const first=await enqueue(db as Database,'owner','planning','project:revision',{projectID:'p'});
    assert.equal((await enqueue(db as Database,'owner','planning','project:revision',{})).id,first.id);
    const old=await claim(db as Database);assert.ok(old);
    await db.query(`UPDATE pbj_jobs SET lease_until=now()-interval '1 second' WHERE id=$1`,[old.id]);
    const fresh=await claim(db as Database);assert.ok(fresh);
    assert.notEqual(old.lease_token,fresh.lease_token);
    await finish(db as Database,old);
    assert.equal((await db.query<{status:string}>('SELECT status FROM pbj_jobs WHERE id=$1',[old.id])).rows[0].status,'running');
    await retry(db as Database,fresh,'recoverable',0);
    const again=await claim(db as Database);assert.ok(again);
    await finish(db as Database,again);
    assert.equal((await db.query<{status:string}>('SELECT status FROM pbj_jobs WHERE id=$1',[old.id])).rows[0].status,'complete');
  } finally {await db.close();}
});
