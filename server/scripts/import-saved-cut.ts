// Import a previously generated, validated local experiment without provider calls.
import {PGlite} from '@electric-sql/pglite';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {migrate} from '../src/v2/database.ts';
import type {Database} from '../src/v2/database.ts';
import {createProject,saveRevision} from '../src/v2/projects.ts';
const [directory,planDirectory]=process.argv.slice(2);if(!directory||!planDirectory)throw new Error('Provide existing registry and saved plan directories');
await stat(path.join(directory,'registry','PG_VERSION'));
const result=JSON.parse(await readFile(path.join(planDirectory,'planning-result.json'),'utf8'));
const input=JSON.parse(await readFile(path.join(planDirectory,'planning-input.json'),'utf8'));
const db=new PGlite(path.join(directory,'registry'));
try{
 await migrate(db as Database);
 const project=await createProject(db as Database,'local-spike',{id:result.timeline.id,title:'Flight rough cut',brief:input.brief,assetIDs:input.eligibleSources.map((s:any)=>s.id),durationGoal:input.durationGoal??null,required:input.required});
 if(!project.current_revision_id)await saveRevision(db as Database,'local-spike',project.id,result.timeline,null,'initial',result.summary,result.evidenceVersions);
 await db.query(`UPDATE pbj_jobs SET status='complete',stage='Restored saved AI cut',result=$2 WHERE owner_id='local-spike' AND kind='plan' AND dedupe_key=$1`,[project.id,JSON.stringify({revisionID:result.timeline.id,accepted:true})]);
 const raw=JSON.parse(await readFile(path.join(planDirectory,'provider-response.json'),'utf8'));
 await db.query(`INSERT INTO pbj_provider_calls(id,owner_id,kind,input,status,full_response,usage) VALUES($1,'local-spike','historical_plan',$2,'received',$3,$4) ON CONFLICT DO NOTHING`,[raw.id,JSON.stringify(input),JSON.stringify(raw),JSON.stringify(raw.usage)]);
 console.log(JSON.stringify({projectID:project.id,providerCalls:0}));
}finally{await db.close();}
