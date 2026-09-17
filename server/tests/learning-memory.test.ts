import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate,type Database } from '../src/v2/database.ts';
import { listEffectiveMemory,retrieveLearningCandidates,retrieveMemory,saveMemory,setMemoryEnabled,type MemoryRecord,type LearningMetadata } from '../src/v2/memory.ts';

function lesson(id:string,overrides:Partial<MemoryRecord>={},learning:Partial<LearningMetadata>={}):MemoryRecord {
  return {id,version:1,kind:'personal_lesson',context:'Preserve the complete action and its payoff',
    statement:'Keep enough of the action after the main moment to show the payoff.',strength:'strong',
    attribution:'Your kept editing choices',project_scope:null,provenance:{eventID:id},root_evidence_ids:[id+'-root'],
    ...overrides,learning:{facet:'setup_payoff',formats:[],subjects:[],signal:'manual_export',
      eventID:id,independenceKey:id,...learning}};
}
async function fixture(body:(db:Database)=>Promise<void>){const db=new PGlite();try{await migrate(db as Database);await body(db as Database);}finally{await db.close();}}

test('a contextual storytelling lesson transfers subjects but golf-specific advice does not leak',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('story'));
  await saveMemory(db,'owner',lesson('golf',{statement:'Preserve the complete golf follow-through.'},{subjects:['golf']}));
  await saveMemory(db,'owner',lesson('short',{statement:'Leave a brief reaction after the action.'},{formats:['TikTok']}));
  const flight=await retrieveMemory(db,'owner','Build a chronological flight story','flight');
  assert.deepEqual(flight.map(m=>m.id),['story']);
  const golf=await retrieveMemory(db,'owner','Make a chronological TikTok story','golf-project',12,{sourceContext:'A golfer completes three golf swings.'});
  assert.deepEqual(new Set(golf.map(m=>m.id)),new Set(['story','golf','short']));
  assert.equal((await retrieveMemory(db,'stranger','golf story','golf-project')).length,0);
}));

test('the latest correction retrieves its editing purpose even when the original recipe had different words',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('dialogue',{context:'Spoken reactions',statement:'Keep the end of the speaker’s sentence.'},{facet:'dialogue'}));
  await saveMemory(db,'owner',lesson('crop',{context:'Vertical compositions',statement:'Keep the subject framed with a little headroom.'},{facet:'framing'}));
  const result=await retrieveMemory(db,'owner','A flight montage. Requested revision: finish the sentence before the next shot','p');
  assert.deepEqual(result.map(m=>m.id),['dialogue']);
}));

test('confidence follows independent outcomes, with retries and repeated exports counted once',()=>fixture(async db=>{
  const first=lesson('one',{}, {independenceKey:'project-one'});
  await saveMemory(db,'owner',first);await saveMemory(db,'owner',first);
  await saveMemory(db,'owner',lesson('same-event-new-id',{}, {eventID:'one',independenceKey:'project-one'}));
  assert.equal((await db.query('SELECT id FROM pbj_memory')).rows.length,1);
  let rows=await listEffectiveMemory(db,'owner');
  assert.equal(rows.length,1);assert.equal(rows[0].effectiveStrength,'weak');assert.equal(rows[0].supportCount,1);
  await saveMemory(db,'owner',lesson('again',{statement:'Leave the end of the action intact.'},{independenceKey:'project-one',reinforcesIDs:['one']}),['one']);
  rows=await listEffectiveMemory(db,'owner');assert.equal(rows.length,1);assert.equal(rows[0].supportCount,1);assert.equal(rows[0].strength,'weak');
  await saveMemory(db,'owner',lesson('independent',{statement:'Keep the resolution of the action.'},{independenceKey:'project-two',reinforcesIDs:['again']}),['again']);
  rows=await listEffectiveMemory(db,'owner');assert.equal(rows[0].supportCount,2);assert.equal(rows[0].strength,'moderate');
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','independent-root')`);
  rows=await retrieveMemory(db,'owner','action story','p');
  assert.equal(rows[0].supportCount,1);assert.equal(rows[0].strength,'weak');assert.ok(!rows[0].root_evidence_ids.includes('independent-root'));
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','one-root'),('owner','again-root')`);
  assert.equal((await retrieveMemory(db,'owner','action story','p')).length,0);
}));

test('explicit reusable feedback is strong, while an approved revision remains tentative',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('approval',{}, {signal:'approved_revision',explicitReusable:true}));
  assert.equal((await listEffectiveMemory(db,'owner'))[0].strength,'weak');
  await saveMemory(db,'owner',lesson('confirmation',{statement:'Keep a visible payoff after the action.'},{signal:'explicit_feedback',explicitReusable:true,reinforcesIDs:['approval']}),['approval']);
  assert.equal((await listEffectiveMemory(db,'owner'))[0].strength,'strong');
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','confirmation-root')`);
  const memory=(await retrieveMemory(db,'owner','action story','p'))[0];
  assert.equal(memory.strength,'weak');assert.deepEqual(memory.root_evidence_ids,['approval-root']);
}));

test('overlapping source sets are one example, including indirect overlap and exclusions',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('a',{root_evidence_ids:['source-a']},{independenceKey:'sources-a'}));
  await saveMemory(db,'owner',lesson('ab',{root_evidence_ids:['source-a','source-b']},{independenceKey:'sources-ab'}));
  await saveMemory(db,'owner',lesson('b',{root_evidence_ids:['source-b']},{independenceKey:'sources-b'}));
  let memory=(await listEffectiveMemory(db,'owner'))[0];
  assert.equal(memory.supportCount,1);assert.equal(memory.strength,'weak');
  await saveMemory(db,'owner',lesson('c',{root_evidence_ids:['source-c']},{independenceKey:'sources-c'}));
  memory=(await listEffectiveMemory(db,'owner'))[0];assert.equal(memory.supportCount,2);assert.equal(memory.strength,'moderate');
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','source-c')`);
  memory=(await listEffectiveMemory(db,'owner'))[0];assert.equal(memory.supportCount,1);assert.equal(memory.strength,'weak');
}));

test('reference reuploads do not inflate confidence or crowd out personal lessons',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('personal'));
  for(let i=0;i<4;i++)await saveMemory(db,'owner',lesson('ref'+i,{kind:'reference',statement:'Reference action detail '+i,strength:'strong'},{signal:'reference',independenceKey:'same-original'}));
  const memories=await retrieveMemory(db,'owner','action story','p');
  assert.equal(memories[0].id,'personal');assert.equal(memories.filter(m=>m.kind==='reference').length,1);
  assert.equal(memories[1].strength,'weak');
  await assert.rejects(saveMemory(db,'owner',lesson('bad',{kind:'reference'},{signal:'manual_export'})),/remain separate/);
  await assert.rejects(saveMemory(db,'owner',lesson('cross-kind',{}, {reinforcesIDs:['ref0']}),['ref0']),/kind and applicability/);
}));

test('explicit conflicting feedback supersedes within its context and exclusions undo its influence',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('old',{statement:'Keep a long pause after the action.'},{signal:'explicit_feedback',explicitReusable:true,subjects:['golf']}));
  await saveMemory(db,'owner',lesson('new',{statement:'Keep only a brief payoff after the action.'},{signal:'explicit_feedback',explicitReusable:true,subjects:['golf'],supersedesIDs:['old']}),['old']);
  let rows=await listEffectiveMemory(db,'owner');assert.equal(rows.find(m=>m.id==='old')?.status,'superseded');
  assert.deepEqual((await retrieveMemory(db,'owner','golf story','p')).map(m=>m.id),['new']);
  assert.deepEqual(new Set((await retrieveLearningCandidates(db,'owner','golf story','p')).map(m=>m.id)),new Set(['old','new']));
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','new-root')`);
  assert.deepEqual((await retrieveMemory(db,'owner','golf story','p')).map(m=>m.id),['old']);
  await assert.rejects(saveMemory(db,'owner',lesson('implicit',{}, {subjects:['golf'],supersedesIDs:['old']}),['old']),/Only explicit reusable feedback/);
  await assert.rejects(saveMemory(db,'owner',lesson('broaden',{}, {signal:'explicit_feedback',explicitReusable:true,supersedesIDs:['old']}),['old']),/kind and applicability/);
  await assert.rejects(saveMemory(db,'owner',lesson('not-supplied',{}, {subjects:['golf'],reinforcesIDs:['old']}),[]),/supplied candidates/);
}));

test('disabling a displayed grouped preference disables all equivalent evidence',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('first'));
  await saveMemory(db,'owner',lesson('second',{statement:'Preserve the payoff.'},{reinforcesIDs:['first']}),['first']);
  const displayed=(await listEffectiveMemory(db,'owner'))[0];
  await setMemoryEnabled(db,'owner',displayed.id,false);
  assert.equal((await retrieveMemory(db,'owner','action story','p')).length,0);
  assert.equal((await listEffectiveMemory(db,'owner'))[0].status,'disabled');
  await saveMemory(db,'owner',lesson('later-equivalent'));
  assert.equal((await retrieveMemory(db,'owner','action story','p')).length,0);
  assert.equal((await listEffectiveMemory(db,'owner'))[0].status,'disabled');
  await setMemoryEnabled(db,'owner','first',true);
  assert.equal((await listEffectiveMemory(db,'owner'))[0].supportCount,3);
  await assert.rejects(setMemoryEnabled(db,'other','first',false),/not found/);
}));

test('a user can explicitly return to an older preference without creating a supersession cycle',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('long',{statement:'Keep a long pause after the action.'},{signal:'explicit_feedback',explicitReusable:true}));
  await saveMemory(db,'owner',lesson('short',{statement:'Keep only a brief pause after the action.'},{signal:'explicit_feedback',explicitReusable:true,supersedesIDs:['long']}),['long']);
  await saveMemory(db,'owner',lesson('long-again',{statement:'Keep a long pause after the action.'},{signal:'explicit_feedback',explicitReusable:true,supersedesIDs:['short']}),['short']);
  assert.deepEqual((await retrieveMemory(db,'owner','action story','p')).map(m=>m.id),['long-again']);
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','long-again-root')`);
  assert.deepEqual((await retrieveMemory(db,'owner','action story','p')).map(m=>m.id),['short']);
}));

test('recovering an older feedback job does not override a newer user decision',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('old-long',{statement:'Keep a long pause after the action.'},
    {signal:'explicit_feedback',explicitReusable:true,occurredAt:'2026-09-01T10:00:00Z'}));
  await saveMemory(db,'owner',lesson('new-short',{statement:'Keep only a brief pause after the action.'},
    {signal:'explicit_feedback',explicitReusable:true,occurredAt:'2026-09-03T10:00:00Z',supersedesIDs:['old-long']}),['old-long']);
  await saveMemory(db,'owner',lesson('delayed-long',{statement:'Keep a long pause after the action.'},
    {signal:'explicit_feedback',explicitReusable:true,occurredAt:'2026-09-02T10:00:00Z',reinforcesIDs:['old-long']}),['old-long']);
  assert.deepEqual((await retrieveMemory(db,'owner','action story','p')).map(m=>m.id),['new-short']);
  await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','new-short-root')`);
  assert.deepEqual((await retrieveMemory(db,'owner','action story','p')).map(m=>m.id),['delayed-long']);
}));

test('project-only lessons stay local, with legacy evidence preserved but not invented as independent endorsements',()=>fixture(async db=>{
  await saveMemory(db,'owner',lesson('scoped',{project_scope:'one'}));
  const legacy=lesson('legacy',{statement:'Keep the full flight landing reaction.',context:'flight landing'});delete legacy.learning;
  await saveMemory(db,'owner',legacy);
  assert.deepEqual((await retrieveLearningCandidates(db,'owner','flight landing story','two')).map(m=>m.id),['legacy']);
  const existing=(await listEffectiveMemory(db,'owner')).find(m=>m.id==='legacy')!;
  assert.equal(existing.strength,'strong');assert.equal(existing.supportCount,0);
  assert.ok((await retrieveMemory(db,'owner','action story','one')).some(m=>m.id==='scoped'));
}));

test('retrieval keeps provenance links without duplicating full scene and timeline receipts',()=>fixture(async db=>{
  const receipt={timelineDifferences:'retained receipt '.repeat(40000),sourceScenes:['scene-one'],originalDecision:'Preserve payoff'};
  await saveMemory(db,'owner',lesson('large-receipt',{provenance:receipt}));
  const result=await retrieveMemory(db,'owner','action story','p');
  assert.ok(JSON.stringify(result).length<3000);
  assert.deepEqual(result[0].provenance,{memoryID:'large-receipt',eventID:'large-receipt'});
  assert.deepEqual(result[0].root_evidence_ids,['large-receipt-root']);
  const saved=(await db.query<{provenance:unknown}>('SELECT provenance FROM pbj_memory WHERE id=$1',['large-receipt'])).rows[0];
  assert.deepEqual(saved.provenance,receipt);
}));
