import { PGlite } from '@electric-sql/pglite';
import { readFile,writeFile,mkdir,stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { OpenAIPlanner } from '../src/v2/planner.ts';
import { saveMemory,retrieveMemory } from '../src/v2/memory.ts';
import type { Evidence,Source } from '../src/v2/contracts.ts';
import type { PlanningInput } from '../src/v2/planner.ts';
import type { Database } from '../src/v2/database.ts';

const [workDirectory,legacyReferencePath,outputDirectory]=process.argv.slice(2);
if(!workDirectory||!legacyReferencePath||!outputDirectory||!process.env.OPENAI_API_KEY||!process.env.OPENAI_MODEL)throw new Error('Provide work, cached reference, output directories and OpenAI configuration');
await stat(path.join(workDirectory,'registry','PG_VERSION'));
const db=new PGlite(path.join(workDirectory,'registry'));
try {
  const legacyBytes=await readFile(legacyReferencePath,'utf8');
  const legacy=JSON.parse(legacyBytes);
  const referenceVersion=createHash('sha256').update(legacyBytes).digest('hex');
  // Import observations from completed cached evidence without any TwelveLabs
  // call. This legacy schema remains explicitly identified in provenance.
  for(const [kind,values] of Object.entries(legacy.analysis.editing_observations) as [string,string[]][]) {
    for(const [index,statement] of values.entries()) {
      await saveMemory(db as Database,'local-spike',{
        id:`reference-${referenceVersion}-${kind}-${index}`,version:1,kind:'reference',
        context:`flight cockpit landing documentary ${kind}`,statement,strength:'weak',
        attribution:'Supplied finished video; creator unspecified',project_scope:null,
        provenance:{legacySchema:legacy.schema_version,sourceSHA256:legacy.source_sha256,
          responseSHA256:referenceVersion,observationKind:kind,legacyPath:legacyReferencePath},
        root_evidence_ids:[legacy.source_sha256],
      });
    }
  }
  const rows=(await db.query<any>(`SELECT a.*,x.id as analysis_id,x.evidence FROM pbj_assets a JOIN pbj_analysis x ON x.asset_id=a.id AND x.owner_id=a.owner_id
    WHERE a.owner_id='local-spike' AND x.status='complete' ORDER BY a.original_name`)).rows;
  if(!rows.length)throw new Error('Complete at least one baseline sample first');
  const sources:Source[]=rows.map(r=>({id:r.id,fileName:r.original_name,sha256:r.original_sha256,duration:Number(r.duration_ticks),mediaStart:Number(r.media_start_ticks),hasAudio:r.metadata.originalAudio}));
  const brief='Make a short flight documentary moment from this available cockpit and landing footage. Use relevant reference pacing and a complete landing reaction if it exists. Aim around 15 seconds, but protect intelligible speech and explain missing story coverage. Keep original audio.';
  const memory=await retrieveMemory(db as Database,'local-spike',brief,'spike-project');
  const input:PlanningInput={brief,eligibleSources:sources,analysis:rows.map(r=>({id:r.analysis_id,version:1,sourceID:r.id,evidence:r.evidence as Evidence})),memory,required:[]};
  if(process.env.PBJ_PLANNING_SUPPLEMENT){
    const supplement=JSON.parse(await readFile(process.env.PBJ_PLANNING_SUPPLEMENT,'utf8'));
    input.durationGoal=supplement.durationGoal;
    input.required=supplement.required??[];
    input.localObservations=supplement.localObservations??[];
    const speech=(await db.query<any>(`SELECT * FROM pbj_speech_timing WHERE owner_id='local-spike' AND status='complete'`)).rows;
    input.speechTiming=speech.filter(r=>sources.some(s=>s.id===r.asset_id)).map(r=>({id:r.id,version:1,sourceID:r.asset_id,evidence:r.evidence}));
  }
  await mkdir(outputDirectory,{recursive:true});
  if(!process.env.PBJ_REPLAY_RESPONSE){
    try {await stat(path.join(outputDirectory,'provider-response.json'));throw new Error('This run already has a provider response; use a new output directory or explicit local replay');}
    catch(error:any){if(error.code!=='ENOENT')throw error;}
  }
  await writeFile(path.join(outputDirectory,'planning-input.json'),JSON.stringify(input,null,2));
  const planner=new OpenAIPlanner(process.env.OPENAI_API_KEY,process.env.OPENAI_MODEL,async response=>{await writeFile(path.join(outputDirectory,"provider-response.json"),JSON.stringify(response,null,2));});
  let result;
  if(process.env.PBJ_REPLAY_RESPONSE){
    const response=JSON.parse(await readFile(process.env.PBJ_REPLAY_RESPONSE,'utf8'));
    const text=response.output.flatMap((item:any)=>item.content??[]).filter((item:any)=>item.type==='output_text').map((item:any)=>item.text).join('');
    const data=JSON.parse(text);
    result='shots' in data?planner.validateEditorial(input,data,response):planner.validate(input,data,response);
  } else {result=await planner.plan(input);}
  await mkdir(outputDirectory,{recursive:true});
  await writeFile(path.join(outputDirectory,'planning-input.json'),JSON.stringify(input,null,2));
  await writeFile(path.join(outputDirectory,'planning-result.json'),JSON.stringify(result,null,2));
  await writeFile(path.join(outputDirectory,'timeline.json'),JSON.stringify(result.timeline,null,2));
  await writeFile(path.join(outputDirectory,'sources.json'),JSON.stringify(sources,null,2));
  await writeFile(path.join(outputDirectory,'source-paths.json'),JSON.stringify(Object.fromEntries(rows.map(r=>[r.id,r.storage_key])),null,2));
  console.log(JSON.stringify({revision:result.timeline.id,clips:result.timeline.clips.length,memoryRecords:memory.length,summary:result.summary,discrepancies:result.discrepancies,quality:result.quality},null,2));
} finally {await db.close();}
