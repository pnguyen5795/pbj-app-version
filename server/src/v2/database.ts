import pg from 'pg';
import { readFile } from 'node:fs/promises';

export interface Database {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export function connectDatabase(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; never fall back to an empty registry');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}
export async function migrate(db: Database) {
  const files=['001_native_foundation.sql','002_speech_timing.sql','003_application.sql','004_speech_chunks.sql','005_recovery.sql','006_learning_policy.sql','007_notifications.sql'];
  if(typeof (db as any).exec==='function') {
    for(const file of files)await (db as any).exec(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  }else await transaction(db,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(739401284)');
    for(const file of files)await tx.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  });
}

export async function transaction<T>(db:Database,body:(connection:Database)=>Promise<T>):Promise<T> {
  const adapter=db as any;
  if(typeof adapter.connect==='function') {
    const client=await adapter.connect();
    try {await client.query('BEGIN');const result=await body(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  if(typeof adapter.transaction==='function')return adapter.transaction(body);
  throw new Error('Database does not provide isolated transactions');
}
