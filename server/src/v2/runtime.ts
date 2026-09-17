import path from 'node:path';
import { stat,mkdir } from 'node:fs/promises';
import { connectDatabase,migrate } from './database.ts';
import type { Database } from './database.ts';
import { LocalObjectStore,S3ObjectStore } from './storage.ts';
import { TwelveLabsProvider } from './twelveLabs.ts';
import { AnalysisRegistry } from './analysisRegistry.ts';
import { ApplicationWorker } from './worker.ts';
import { createAPI } from './api.ts';
import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import {readPersonalConfiguration,pairedAuthentication} from './personalService.ts';
import {NotificationBridge} from './notifications.ts';
import {configuredAPNs} from './apns.ts';
const local=process.env.PBJ_LOCAL_DEVELOPMENT==='1';
if(local&&process.env.NODE_ENV==='production')throw new Error('Local development authentication cannot run in production');
const personal=process.env.PBJ_PERSONAL_CONFIG?await readPersonalConfiguration(process.env.PBJ_PERSONAL_CONFIG):undefined;
if(personal&&!local)throw new Error('Personal pairing requires the local workspace');
const root=path.resolve(process.env.PBJ_DATA_ROOT??'data/native');await mkdir(root,{recursive:true});
let db:Database;
if(local){const {PGlite}=await import('@electric-sql/pglite');await stat(path.join(root,'registry','PG_VERSION'));db=new PGlite(path.join(root,'registry')) as Database;}
else{if(process.env.PBJ_REGISTRY_RECONCILED!=='1')throw new Error('Migrate existing analysis and set PBJ_REGISTRY_RECONCILED=1 before starting the production worker');db=connectDatabase();}
await migrate(db);
const pushSender=await configuredAPNs().catch(()=>{console.error('Push notifications are not configured correctly; project processing remains available');return undefined;});
const notifications=new NotificationBridge(db,pushSender);
const storage=local?new LocalObjectStore(path.join(root,'objects')):new S3ObjectStore(required('S3_BUCKET'),path.join(root,'cache'));
async function resolveMedia(asset:any){if(local&&path.isAbsolute(asset.storage_key)){await stat(asset.storage_key);return asset.storage_key;}return storage.materialize(asset.storage_key);}
const legacyHashes=new Set<string>();
if(personal){
 const legacy=JSON.parse(await readFile(path.join(path.dirname(process.env.PBJ_PERSONAL_CONFIG!),'legacy-index.json'),'utf8'));
 if(!Array.isArray(legacy)||legacy.some(row=>!/^([a-f0-9]{64})$/.test(row.sha256)))throw new Error('Legacy receipt inventory is invalid; service has not started');
 for(const row of legacy)legacyHashes.add(row.sha256);
}
const registry=new AnalysisRegistry(db,new TwelveLabsProvider(process.env.TWELVE_LABS_API_KEY??'',fetch,storage instanceof S3ObjectStore?async(file,id)=>{const key='de/'+id+'.mp4';await storage.put(key,file);return storage.signedRead(key);}:undefined),legacyHashes);
const worker=new ApplicationWorker({db,registry,resolveMedia,cache:path.join(root,'derivatives'),openAIKey:process.env.OPENAI_API_KEY??'',openAIModel:process.env.OPENAI_MODEL??'gpt-5.1'});
const mode=process.env.PBJ_PROCESS??(local?'all':'api');if(!['api','worker','all'].includes(mode))throw new Error('Invalid PBJ_PROCESS');let running=true;
let server:ReturnType<ReturnType<typeof createAPI>['listen']>|undefined;let closing:Promise<void>|undefined;
async function closeDatabase(){notifications.close();const adapter=db as any;if(adapter.close)await adapter.close();else if(adapter.end)await adapter.end();}
function stop(){if(closing)return;running=false;closing=server?new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve())):Promise.resolve();if(mode==='api')void closing.then(closeDatabase).catch(()=>console.error('Shutdown could not finish cleanly'));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
if(mode==='api'||mode==='all'){
 if(!local)required('CLERK_SECRET_KEY');
 const app=createAPI({db,storage,resolveMedia,uploadRoot:path.join(root,'uploads'),localDevelopment:local&&!personal,
   aiProcessingEnabled:personal?mode==='all':true, authenticate:personal?pairedAuthentication(personal.token):undefined,notifications});
 if(personal){
  server=createServer({key:await readFile(personal.privateKey),cert:await readFile(personal.certificate),minVersion:'TLSv1.2'},app)
    .listen(personal.port,'0.0.0.0',()=>console.log('PB&J paired Mac service ready on https://'+personal.host+':'+personal.port));
 }else server=app.listen(Number(process.env.PORT??8787),local?'127.0.0.1':'0.0.0.0',()=>console.log('PB&J API ready'));
}
if(mode==='worker'||mode==='all'){
 let notificationFailureReported=false;
 const notify=async()=>{try{await notifications.tick();notificationFailureReported=false;}catch{if(!notificationFailureReported)console.error('Notification delivery paused; saved project processing continues');notificationFailureReported=true;}};
 while(running){await notify();const worked=await worker.tick();await notify();if(!worked)await new Promise(resolve=>setTimeout(resolve,1000));}
 await closing;await closeDatabase();
}
function required(name:string){const value=process.env[name];if(!value)throw new Error(name+' configuration is required');return value;}
