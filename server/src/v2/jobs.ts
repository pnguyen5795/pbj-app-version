import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from './database.ts';

export type Job = {status?:string;last_error?:string|null;id:string;owner_id:string;kind:string;dedupe_key:string;payload:Record<string,unknown>;attempts:number;max_attempts:number;lease_token:string};
export async function enqueue(db:Database,owner:string,kind:string,dedupeKey:string,payload:unknown,validatePayload=false) {
  await db.query(`INSERT INTO pbj_jobs(id,owner_id,kind,dedupe_key,payload) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(owner_id,kind,dedupe_key) DO NOTHING`,[randomUUID(),owner,kind,dedupeKey,JSON.stringify(payload)]);
  const job=(await db.query<Job>('SELECT * FROM pbj_jobs WHERE owner_id=$1 AND kind=$2 AND dedupe_key=$3',[owner,kind,dedupeKey])).rows[0];
  if(validatePayload&&!isDeepStrictEqual(job.payload,JSON.parse(JSON.stringify(payload))))throw new Error('Request ID conflict: this request was already saved with different instructions');
  return job;
}
export async function claim(db:Database,leaseSeconds=180):Promise<Job|undefined> {
  // Expired work can be reclaimed. Its handler must reconcile external side
  // effects; lease expiry itself NEVER authorizes another analysis scan.
  await db.query(`UPDATE pbj_jobs SET status='attention',last_error='Retry limit reached',lease_token=NULL
    WHERE status='running' AND lease_until<now() AND attempts>=max_attempts`);
  return (await db.query<Job>(`WITH candidate AS (
    SELECT id FROM pbj_jobs WHERE attempts<max_attempts AND
    ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now()))
    ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE pbj_jobs SET status='running',attempts=attempts+1,
      lease_until=now()+make_interval(secs=>$1),lease_token=$2
    WHERE id=(SELECT id FROM candidate) RETURNING *`,[leaseSeconds,randomUUID()])).rows[0];
}
export async function finish(db:Database,job:Job) {
  await db.query(`UPDATE pbj_jobs SET status='complete',lease_until=NULL,lease_token=NULL
    WHERE id=$1 AND owner_id=$2 AND lease_token=$3`,[job.id,job.owner_id,job.lease_token]);
}
export async function retry(db:Database,job:Job,message:string,delaySeconds=30) {
  await db.query(`UPDATE pbj_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'attention' ELSE 'queued' END,
    available_at=now()+make_interval(secs=>$4),lease_until=NULL,lease_token=NULL,last_error=$5
    WHERE id=$1 AND owner_id=$2 AND lease_token=$3`,[job.id,job.owner_id,job.lease_token,delaySeconds,message]);
}
