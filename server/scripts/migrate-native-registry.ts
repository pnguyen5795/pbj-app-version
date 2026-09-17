/** Copy an existing native registry into PostgreSQL without new provider calls.
 * Run with API/worker stopped. Default is an inventory-only dry run.
 * --apply requires a destination Clerk owner and private S3 storage configuration.
 */
import {PGlite} from '@electric-sql/pglite';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {connectDatabase,migrate,transaction} from '../src/v2/database.ts';
import type {Database} from '../src/v2/database.ts';
import {S3ObjectStore} from '../src/v2/storage.ts';
import {hashFile} from '../src/v2/media.ts';
const root=path.resolve(process.env.PBJ_SOURCE_DATA_ROOT??'data/native');
await stat(path.join(root,'registry','PG_VERSION'));
const source=new PGlite(path.join(root,'registry'));
const tables=['pbj_assets','pbj_analysis','pbj_projects','pbj_project_inputs','pbj_revisions','pbj_teaching_groups','pbj_memory','pbj_excluded_evidence','pbj_exports','pbj_jobs','pbj_uploads','pbj_provider_calls','pbj_feedback','pbj_speech_timing','pbj_speech_chunks'];
try {
 const owner=process.env.PBJ_SOURCE_OWNER??'local-spike';const rows:Record<string,any[]>={};
 for(const table of tables){const exists=(await source.query<any>('SELECT to_regclass($1) AS name',[table])).rows[0]?.name;rows[table]=exists?(await source.query<any>('SELECT * FROM '+table+' WHERE owner_id=$1',[owner])).rows:[];}
 console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'inventory',counts:Object.fromEntries(tables.map(t=>[t,rows[t].length])),analyses:rows.pbj_analysis.map(a=>({id:a.id,status:a.status,hasFullResponse:!!a.full_response,hasEvidence:!!a.evidence,providerTaskID:a.provider_task_id}))},null,2));
 if(process.argv.includes('--apply')) {
  const destinationOwner=process.env.PBJ_DESTINATION_OWNER,bucket=process.env.S3_BUCKET;
  if(!destinationOwner?.startsWith('user_')||!bucket)throw new Error('Destination Clerk owner and S3_BUCKET required');
  if(rows.pbj_uploads.some(u=>u.status!=='complete'))throw new Error('Finish or explicitly reconcile partial uploads before moving registries');
  if(rows.pbj_analysis.some(a=>a.status==='complete'&&(!a.full_response||!a.evidence)))throw new Error('Damaged saved analysis requires recovery');
  const destination=connectDatabase();
  try {
   await migrate(destination);const storage=new S3ObjectStore(bucket,path.join(root,'migration-cache'));
   // The destination must be empty for this owner: never merge conflicting
   // identities or silently replace a registry that may contain paid history.
   for(const table of tables)if((await destination.query('SELECT 1 FROM '+table+' WHERE owner_id=$1 LIMIT 1',[destinationOwner])).rows.length)throw new Error('Destination owner has existing data; reconcile conflicts before importing');
   for(const asset of rows.pbj_assets){
    const file=path.isAbsolute(asset.storage_key)?asset.storage_key:path.join(root,'objects',asset.storage_key);
    if(await hashFile(file)!==asset.original_sha256)throw new Error('Original checksum mismatch for '+asset.id);
    const key=createHash('sha256').update(destinationOwner).digest('hex')+'/'+asset.original_sha256+'.original';await storage.put(key,file);asset.storage_key=key;
   }
   await transaction(destination,async tx=>{
    for(const table of tables)for(const row of rows[table]){
     row.owner_id=destinationOwner;
     if(table==='pbj_jobs'&&row.status==='running'){row.status='queued';row.lease_until=null;row.lease_token=null;}
     const columns=(await tx.query<any>(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table])).rows;
     const keys=Object.keys(row).filter(k=>columns.some(c=>c.column_name===k));
     const values=keys.map(k=>['json','jsonb'].includes(columns.find(c=>c.column_name===k).data_type)&&row[k]!==null?JSON.stringify(row[k]):row[k]);
     await tx.query('INSERT INTO '+table+' ('+keys.map(k=>'"'+k+'"').join(',')+') VALUES ('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',values);
    }
    for(const table of tables){const count=(await tx.query<any>('SELECT count(*) AS n FROM '+table+' WHERE owner_id=$1',[destinationOwner])).rows[0];if(Number(count.n)!==rows[table].length)throw new Error('Migration count verification failed for '+table);}
   });
   console.log('Native rows and originals copied. Source registry retained. Reconcile any other legacy caches before enabling ingestion.');
  } finally {await destination.end();}
 }
} finally {await source.close();}
