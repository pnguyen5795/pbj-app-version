import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {evaluateLearningComparison,humanReviewSchema} from '../src/v2/learningEvaluation.ts';
import type {SavedLearningRun} from '../src/v2/learningEvaluation.ts';

const runSchema=z.object({inputPath:z.string().min(1),resultPath:z.string().min(1),model:z.string().min(1),plannerVersion:z.string().min(1)});
const manifestSchema=z.object({schemaVersion:z.literal(1),caseID:z.string().min(1),projectID:z.string().trim().min(1).optional(),memoryOff:runSchema,memoryOn:runSchema,
 heldOutEvidenceIDs:z.array(z.string()).optional(),human:humanReviewSchema.optional()});

export async function evaluateLearningFiles(manifestFile:string){
 const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestFile,'utf8')));
 const directory=path.dirname(path.resolve(manifestFile));
 const load=async(run:z.infer<typeof runSchema>):Promise<SavedLearningRun>=>({model:run.model,plannerVersion:run.plannerVersion,
  input:JSON.parse(await readFile(path.resolve(directory,run.inputPath),'utf8')),
  result:JSON.parse(await readFile(path.resolve(directory,run.resultPath),'utf8'))});
 const [memoryOff,memoryOn]=await Promise.all([load(manifest.memoryOff),load(manifest.memoryOn)]);
 return evaluateLearningComparison({...manifest,memoryOff,memoryOn});
}
if(import.meta.main){
 const [manifest,output]=process.argv.slice(2);
 if(!manifest)throw new Error('Usage: node scripts/evaluate-learning.ts comparison.json [report.json]. Reads saved files only; makes no AI requests.');
 const report=JSON.stringify(await evaluateLearningFiles(manifest),null,2)+'\n';
 if(output)await writeFile(output,report,{flag:'wx'});else process.stdout.write(report);
}
