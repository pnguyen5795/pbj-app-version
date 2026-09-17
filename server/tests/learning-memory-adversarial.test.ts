import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate,type Database} from '../src/v2/database.ts';
import * as memory from '../src/v2/memory.ts';
import type {MemoryRecord,LearningMetadata} from '../src/v2/memory.ts';

function lesson(id:string,changes:Partial<MemoryRecord>={},learning:Partial<LearningMetadata>={}):MemoryRecord{
 return {id,version:1,kind:'personal_lesson',context:'Pacing for short-form edits',statement:'Keep the setup short.',
  strength:'weak',attribution:'Test only',project_scope:null,provenance:{},root_evidence_ids:[id],...changes,
  learning:{facet:'pacing',formats:[],subjects:[],signal:'manual_export',eventID:id,independenceKey:id,...learning}};
}
async function fixture(body:(db:Database)=>Promise<void>){
 const db=new PGlite();try{await migrate(db as Database);await body(db as Database);}finally{await db.close();}
}

test('source scene descriptions cannot choose the output format against the user request',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('short',{}, {formats:['TikTok']}));
 const result=await memory.retrieveMemory(db,'owner','Make a slow documentary edit','p',12,
  {sourceContext:'A flight recorded by a TikTok creator, with short-form commentary.'});
 assert.deepEqual(result,[],'Footage evidence describes content; only the current request chooses its intended format');
}));

test('directly negated format and subject mentions do not activate those contextual preferences',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('short',{}, {formats:['TikTok']}));
 await memory.saveMemory(db,'owner',lesson('golf',{statement:'Keep golf setup short.'}, {subjects:['golf']}));
 for(const brief of ['Not TikTok: make a slow documentary.','Avoid TikTok styling; keep a slow pace.','Without a TikTok format, make a slow edit.',
  'Make a TikTok. Requested revision: do not use TikTok; keep a slow pace.']){
  assert.deepEqual((await memory.retrieveMemory(db,'owner',brief,'p')).map(m=>m.id),[],brief);
 }
 assert.deepEqual((await memory.retrieveMemory(db,'owner','No golf this time; make a slow flight edit.','p',12,
  {sourceContext:'A golf club is visible inside the airplane.'})).map(m=>m.id),[]);
 assert.deepEqual((await memory.retrieveMemory(db,'owner','Do not cut off the golf follow-through. Keep the setup short.','p')).map(m=>m.id),['golf'],
  'Negating an editing operation does not negate the subject');
 assert.deepEqual((await memory.retrieveMemory(db,'owner','Not TikTok at first. Requested revision: make a TikTok with a short setup.','p')).map(m=>m.id),['short'],
  'The latest explicit category mention takes precedence over an earlier exclusion');
}));

test('disabled rules remain comparison candidates so equivalent paraphrases preserve the disabled setting',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('disabled'));await memory.setMemoryEnabled(db,'owner','disabled',false);
 assert.deepEqual(await memory.retrieveMemory(db,'owner','A short setup','p'),[]);
 const candidates=await memory.retrieveLearningCandidates(db,'owner','A short setup','p');
 assert.deepEqual(candidates.map(m=>[m.id,m.status]),[['disabled','disabled']]);
 await memory.saveMemory(db,'owner',lesson('paraphrase',{statement:'Use a brief setup.'},{reinforcesIDs:['disabled']}),candidates.map(m=>m.id));
 assert.deepEqual(await memory.retrieveMemory(db,'owner','A short setup','p'),[]);
 assert.equal((await memory.listEffectiveMemory(db,'owner'))[0].status,'disabled');
}));

test('decimal numbers and numeric ranges are not merged into one preference',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('decimal',{statement:'Keep a 0.5-second pause.'}));
 await memory.saveMemory(db,'owner',lesson('range',{statement:'Keep a 0–5 second pause.'}));
 const result=await memory.listEffectiveMemory(db,'owner');
 assert.equal(result.length,2,'Punctuation changes the numeric instruction, not just its typography');
 assert.ok(result.every(m=>m.supportCount===1&&m.strength==='weak'));
}));

test('a failed multi-lesson result rolls back earlier valid lessons and relationship effects',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('old',{}, {signal:'explicit_feedback',explicitReusable:true}));
 const records=[lesson('valid-first',{statement:'Use a long setup.'},
  {signal:'explicit_feedback',explicitReusable:true,supersedesIDs:['old']}),
 lesson('invalid-second',{statement:'Second proposal.'},{reinforcesIDs:['missing-target']})];
 await assert.rejects(()=>memory.saveMemories(db,'owner',records,['old','missing-target']),/missing evidence/);
 assert.deepEqual((await db.query<{id:string}>('SELECT id FROM pbj_memory ORDER BY id')).rows.map(r=>r.id),['old']);
 assert.deepEqual((await memory.retrieveMemory(db,'owner','A short setup','p')).map(m=>m.id),['old']);
 const valid=[lesson('saved-one',{statement:'Keep an audible reaction.'}),lesson('saved-two',{statement:'Retain a short establishing shot.'})];
 await memory.saveMemories(db,'owner',valid);await memory.saveMemories(db,'owner',valid);
 assert.equal((await db.query('SELECT id FROM pbj_memory')).rows.length,3,'A completed bundle stays idempotent on replay');
}));

test('inactive bridging evidence cannot inflate independent support after exclusion',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('a',{root_evidence_ids:['source-a']}));
 await memory.saveMemory(db,'owner',lesson('bridge',{root_evidence_ids:['source-a','source-b']}));
 await memory.saveMemory(db,'owner',lesson('b',{root_evidence_ids:['source-b']}));
 assert.equal((await memory.listEffectiveMemory(db,'owner'))[0].supportCount,1);
 await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','bridge')`);
 assert.equal((await memory.listEffectiveMemory(db,'owner'))[0].supportCount,2,
  'Once the bridge event is excluded, two disjoint owned examples remain');
 await db.query(`INSERT INTO pbj_excluded_evidence(owner_id,evidence_id) VALUES('owner','source-b')`);
 assert.equal((await memory.listEffectiveMemory(db,'owner'))[0].supportCount,1);
 assert.equal((await memory.listEffectiveMemory(db,'owner'))[0].strength,'weak');
}));

test('an older recovered reversal cannot hide a newer explicit preference and exclusion restores chronology',()=>fixture(async db=>{
 await memory.saveMemory(db,'owner',lesson('older',{}, {signal:'explicit_feedback',explicitReusable:true,occurredAt:'2026-01-01T00:00:00Z'}));
 await memory.saveMemory(db,'owner',lesson('newer',{statement:'Keep a long setup.'},
  {signal:'explicit_feedback',explicitReusable:true,occurredAt:'2026-03-01T00:00:00Z',supersedesIDs:['older']}),['older']);
 await memory.saveMemory(db,'owner',lesson('recovered',{},
  {signal:'explicit_feedback',explicitReusable:true,occurredAt:'2026-02-01T00:00:00Z',supersedesIDs:['newer']}),['newer']);
 assert.deepEqual((await memory.retrieveMemory(db,'owner','A short setup','p')).map(m=>m.id),['newer']);
 await memory.setMemoryEnabled(db,'owner','newer',false);
 assert.deepEqual((await memory.retrieveMemory(db,'owner','A short setup','p')).map(m=>m.id),['recovered']);
}));
