import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {readPersonalConfiguration} from '../src/v2/personalService.ts';
type GetStatus=(endpoint:string,authenticated?:boolean)=>Promise<{status?:number;body:any}>;
export async function checkPersonalService(get:GetStatus,savedAIProcessingEnabled:boolean){
 const account=await get('/v2/account');
 if(account.status!==200||account.body.ownerID!=='local-spike')throw new Error('Mac pairing was rejected');
 const rejected=await get('/v2/account',false);
 if(rejected.status!==401)throw new Error('Unpaired requests were not rejected');
 const service=await get('/v2/service-status');
 if(service.status!==200||typeof service.body.aiProcessingEnabled!=='boolean')throw new Error('Running AI processing status is unavailable');
 const projects=await get('/v2/projects'),jobs=await get('/v2/jobs');
 if(projects.status!==200||jobs.status!==200)throw new Error('Saved project status is unavailable');
 return {connected:true,encrypted:true,paired:true,unpairedRejected:true,
  aiProcessingEnabled:service.body.aiProcessingEnabled,savedAIProcessingEnabled,
  restartNeeded:service.body.aiProcessingEnabled!==savedAIProcessingEnabled,
  projects:projects.body.projects?.length,jobs:jobs.body.jobs?.map((j:any)=>({id:j.id,kind:j.kind,status:j.status,stage:j.stage,lastError:j.lastError??j.last_error}))};
}

async function main(){
 const config=await readPersonalConfiguration(process.argv[2]);
 const ca=await readFile(config.certificate);
 const get:GetStatus=async(endpoint,authenticated=true)=>{
 return new Promise((resolve,reject)=>{
  const request=https.get({hostname:config.host,port:config.port,path:endpoint,ca,
   headers:authenticated?{Authorization:'Bearer '+config.token}:{},timeout:10000},response=>{
    let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);
    response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(text)});}catch(error){reject(error);}});
  });request.on('timeout',()=>request.destroy(new Error('Mac connection timed out')));request.on('error',reject);
 });
 };
 try{console.log(JSON.stringify(await checkPersonalService(get,config.aiProcessingEnabled),null,2));}
 catch(error:any){
  console.error(JSON.stringify({connected:false,aiProcessingEnabled:null,savedAIProcessingEnabled:config.aiProcessingEnabled,error:'Mac service unavailable: '+error.message},null,2));
  process.exitCode=1;
 }
}
if(import.meta.main)await main();
