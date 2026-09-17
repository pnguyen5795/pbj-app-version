import {readFile,writeFile,unlink} from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'dotenv';
import {readPersonalConfiguration} from '../src/v2/personalService.ts';
const file=process.argv[2];
if(!file)throw new Error('Personal service configuration path required');
const config=await readPersonalConfiguration(file);
const lock=path.join(path.dirname(file),'service.pid');
async function acquire(){await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});}
try{await acquire();}catch(error:any){
 if(error.code!=='EEXIST')throw error;
 const pid=Number(await readFile(lock,'utf8'));
 if(!Number.isSafeInteger(pid)||pid<2)throw new Error('Service lock needs recovery');
 let alive=true;try{process.kill(pid,0);}catch(e:any){if(e.code==='ESRCH')alive=false;else throw e;}
 if(alive)throw new Error('PB&J Mac service is already running');
 await unlink(lock);await acquire();
}
process.on('exit',()=>{try{unlinkSync(lock);}catch{}});
if(config.aiProcessingEnabled){
  const keys=parse(await readFile(config.providerEnvironment));
  for(const key of ['OPENAI_API_KEY','TWELVE_LABS_API_KEY','OPENAI_MODEL']) {
    if(keys[key])process.env[key]=keys[key];
  }
  if(!process.env.OPENAI_API_KEY||!process.env.TWELVE_LABS_API_KEY)throw new Error('Provider keys missing; service has not started');
  console.log('AI processing enabled. Saved queued requests will resume; new provider requests use paid APIs.');
}else{
  // Local project operations stay available without loading provider credentials
  // or running any queued AI work. This persists across launcher restarts.
  for(const key of ['OPENAI_API_KEY','TWELVE_LABS_API_KEY','OPENAI_MODEL'])delete process.env[key];
  console.log('AI processing paused. Project access, approvals and manual editing remain available.');
}
process.env.PBJ_LOCAL_DEVELOPMENT='1';
process.env.PBJ_DATA_ROOT=config.dataRoot;
process.env.PBJ_PERSONAL_CONFIG=file;
process.env.PBJ_PROCESS=config.aiProcessingEnabled?'all':'api';
await import('../src/v2/runtime.ts');
