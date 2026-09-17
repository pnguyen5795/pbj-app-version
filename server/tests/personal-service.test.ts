import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pairedAuthentication} from '../src/v2/personalService.ts';
import {createAPI} from '../src/v2/api.ts';
import {AnalysisRegistry} from '../src/v2/analysisRegistry.ts';
import {checkPersonalService} from '../scripts/personal-service-status.ts';

test('paired service rejects missing, malformed and wrong tokens even on loopback',async()=>{
 const token='a'.repeat(64);
 const db={query:async(sql:string)=>({rows:sql.includes('sum(')||sql.includes('count(')?[{seconds:0,n:0}]:[]})} as any;
 const app=createAPI({db,storage:{} as any,resolveMedia:async()=>'',uploadRoot:'unused',
   localDevelopment:true,aiProcessingEnabled:false,authenticate:pairedAuthentication(token)});
 const server=await new Promise<any>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try {
  const url='http://127.0.0.1:'+server.address().port+'/v2/account';
  for(const authorization of ['', 'Bearer short','Bearer '+'b'.repeat(64),'Bearer '+token+'extra']) {
   assert.equal((await fetch(url,{headers:{authorization}})).status,401);
  }
  const response=await fetch(url,{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).ownerID,'local-spike');
  const status=await fetch(url.replace('/account','/service-status'),{headers:{authorization:'Bearer '+token}});
  assert.equal(status.status,200);assert.deepEqual(await status.json(),{aiProcessingEnabled:false,pushNotificationsEnabled:false});
  assert.equal((await fetch(url.replace('/account','/service-status'))).status,401);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 assert.throws(()=>pairedAuthentication(''),/configuration/);
});

test('legacy originals cannot trigger another paid baseline; existing native results remain reusable',async()=>{
 const sha='c'.repeat(64);let existing:any;let writes=0;
 const db={query:async(sql:string)=>{
  if(sql.startsWith('INSERT')){writes++;throw new Error('Unexpected insert');}
  return {rows:sql.includes('pbj_analysis')?(existing?[existing]:[]):[{original_sha256:sha,duration_ticks:300000}]};
 }} as any;
 const registry=new AnalysisRegistry(db,{} as any,new Set([sha]));
 await assert.rejects(()=>registry.reserve('local-spike','asset'),/legacy analysis needs recovery/);
 existing={id:'native-result',owner_id:'local-spike',asset_id:'asset',status:'complete',full_response:{saved:true},evidence:{schemaVersion:1,summary:'Saved evidence',scenes:[],observations:[],uncertainties:[]}};
 assert.equal((await registry.reserve('local-spike','asset')).id,'native-result');
 assert.equal(writes,0);
});

test('service check reports actual running AI mode separately from saved restart configuration',async()=>{
 const get=async(endpoint:string,authenticated=true)=>{
  if(!authenticated)return {status:401,body:{}};
  if(endpoint==='/v2/account')return {status:200,body:{ownerID:'local-spike'}};
  if(endpoint==='/v2/service-status')return {status:200,body:{aiProcessingEnabled:false}};
  return {status:200,body:{projects:[],jobs:[]}};
 };
 const running=await checkPersonalService(get,true);
 assert.equal(running.aiProcessingEnabled,false);
 assert.equal(running.savedAIProcessingEnabled,true);
 assert.equal(running.restartNeeded,true);
 assert.equal((await checkPersonalService(get,false)).restartNeeded,false);
 await assert.rejects(()=>checkPersonalService(async(endpoint,authenticated)=>endpoint==='/v2/service-status'?{status:404,body:{}}:get(endpoint,authenticated),true),/Running AI processing status is unavailable/);
});
