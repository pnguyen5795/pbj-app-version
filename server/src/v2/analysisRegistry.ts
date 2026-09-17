import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { BASELINE_PROMPT, providerEvidenceSchema, normalizeAnalysisEvidence, validateEvidence } from './contracts.ts';

export interface AnalysisRecord {
  id: string; owner_id: string; asset_id: string; status: string; idempotency_key: string;
  provider_asset_id: string | null; provider_task_id: string | null;
  intent: Record<string, unknown>; full_response: unknown; evidence: unknown;
}
export interface AnalysisProvider {
  checkConfiguration?():void;
  prepareUpload?(path:string,correlationID:string):Promise<void|{resumable:boolean}>;
  resumeUpload?(path:string,correlationID:string,state:Record<string,unknown>,checkpoint:(state:Record<string,unknown>)=>Promise<void>):Promise<string|undefined>;
  upload(path: string, correlationID: string): Promise<string>;
  assetStatus(id: string): Promise<string>;
  create(assetID: string, key: string, correlationID: string, intent: Record<string,unknown>): Promise<string>;
  retrieve(taskID: string): Promise<{ status: string; result?: { data: string; finish_reason: string }; [key:string]:unknown }>;
  findTask(correlationID: string): Promise<string | null>;
}

export class AnalysisRegistry {
  private db: Database;
  private provider: AnalysisProvider;
  private legacyHashes: Set<string>;
  constructor(db: Database, provider: AnalysisProvider, legacyHashes=new Set<string>()) { this.db=db; this.provider=provider; this.legacyHashes=legacyHashes; }

  async reserve(owner: string, assetID: string): Promise<AnalysisRecord> {
    if(this.legacyHashes.size){
      const existing=await this.db.query<AnalysisRecord>('SELECT * FROM pbj_analysis WHERE owner_id=$1 AND asset_id=$2',[owner,assetID]);
      if(existing.rows[0])return this.validateRecord(existing.rows[0]);
      const asset=(await this.db.query<any>('SELECT original_sha256 FROM pbj_assets WHERE owner_id=$1 AND id=$2',[owner,assetID])).rows[0];
      if(asset&&this.legacyHashes.has(asset.original_sha256))throw new Error('Saved legacy analysis needs recovery before reuse; no new provider request was submitted');
    }
    // FK ownership and unique(owner,asset) make concurrent requests join the
    // same logical operation. A damaged/missing registry is an error, not new.
    await this.db.query(`INSERT INTO pbj_analysis(id,owner_id,asset_id,status,idempotency_key,intent)
      VALUES($1,$2,$3,'reserved',$4,$5) ON CONFLICT(owner_id,asset_id) DO NOTHING`,
    [randomUUID(), owner, assetID, randomUUID(), JSON.stringify({ model_name:'pegasus1.5',
      prompt: BASELINE_PROMPT, response_format:{type:'json_schema',json_schema:providerEvidenceSchema},
      max_tokens:32768, temperature:0.2, schema_version:1, audio_preserved:true,
      idempotency_retention:'not documented in reviewed endpoint; uncertain POST is not automatically replayed' })]);
    const result = await this.db.query<AnalysisRecord>('SELECT * FROM pbj_analysis WHERE owner_id=$1 AND asset_id=$2',[owner,assetID]);
    if (!result.rows[0]) throw new Error('Analysis registry unavailable');
    return this.validateRecord(result.rows[0]);
  }

  async get(owner: string, id: string): Promise<AnalysisRecord> {
    const result = await this.db.query<AnalysisRecord>('SELECT * FROM pbj_analysis WHERE owner_id=$1 AND id=$2',[owner,id]);
    if (!result.rows[0]) throw new Error('Analysis not found');
    return this.validateRecord(result.rows[0]);
  }

  private async validateRecord(record: AnalysisRecord): Promise<AnalysisRecord> {
    if (record.status === 'complete') {
      const asset=(await this.db.query<{duration_ticks:number|string}>('SELECT duration_ticks FROM pbj_assets WHERE owner_id=$1 AND id=$2',[record.owner_id,record.asset_id])).rows[0];
      try {
        const duration=Number(asset?.duration_ticks)/60000;
        if(!record.full_response||!Number.isFinite(duration)||duration<=0)throw new Error('Missing saved analysis');
        // Cached JSON is untrusted too. Check structure, source bounds and
        // scene references before any planner/teaching request can use it.
        validateEvidence(record.evidence,duration);
      } catch { throw new Error('Damaged completed record; saved analysis needs recovery'); }
    }
    return record;
  }

  private async transition(owner: string, id: string, from: string, to: string): Promise<boolean> {
    return (await this.db.query(`UPDATE pbj_analysis SET status=$4,updated_at=now()
      WHERE owner_id=$1 AND id=$2 AND status=$3 RETURNING id`,[owner,id,from,to])).rows.length === 1;
  }

  private async resumeUpload(owner:string,id:string,localMedia:string):Promise<AnalysisRecord>{
    if(!this.provider.resumeUpload)throw new Error('Multipart provider configuration unavailable; saved upload requires recovery');
    const token=randomUUID();
    // This short-lived ownership marker fences concurrent workers and survives
    // process restarts. No database transaction stays open during HTTP work.
    const claimed=(await this.db.query<AnalysisRecord>(`UPDATE pbj_analysis SET
      intent=jsonb_set(intent,'{multipartLease}',jsonb_build_object('token',$3::text,'expiresAt',now()+interval '15 minutes')),updated_at=now()
      WHERE owner_id=$1 AND id=$2 AND status='uploading' AND intent ? 'multipart'
      AND (intent->'multipartLease' IS NULL OR (intent->'multipartLease'->>'expiresAt')::timestamptz<now()) RETURNING *`,[owner,id,token])).rows[0];
    if(!claimed)return this.get(owner,id);
    try{
      const assetID=await this.provider.resumeUpload(localMedia,id,claimed.intent.multipart as Record<string,unknown>,async state=>{
        const saved=await this.db.query(`UPDATE pbj_analysis SET
          intent=jsonb_set(jsonb_set(intent,'{multipart}',$4::jsonb),'{multipartLease}',jsonb_build_object('token',$3::text,'expiresAt',now()+interval '15 minutes')),
          updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='uploading' AND intent->'multipartLease'->>'token'=$3
          AND (intent->'multipartLease'->>'expiresAt')::timestamptz>now() RETURNING id`,[owner,id,token,JSON.stringify(state)]);
        if(!saved.rows.length)throw new Error('Multipart upload ownership changed; resume saved progress');
      });
      if(assetID){
        const saved=await this.db.query(`UPDATE pbj_analysis SET provider_asset_id=$4,status='uploaded',last_error=NULL,updated_at=now()
          WHERE owner_id=$1 AND id=$2 AND status='uploading' AND intent->'multipartLease'->>'token'=$3 RETURNING id`,[owner,id,token,assetID]);
        if(!saved.rows.length)throw new Error('Multipart completion ownership changed; resume saved progress');
      }
    }finally{
      await this.db.query(`UPDATE pbj_analysis SET intent=intent-'multipartLease' WHERE owner_id=$1 AND id=$2 AND intent->'multipartLease'->>'token'=$3`,[owner,id,token]);
    }
    return this.get(owner,id);
  }

  /** One durable step per worker iteration. No sleeping or unbounded polling. */
  async advance(owner: string, id: string, localMedia: string, durationSeconds: number): Promise<AnalysisRecord> {
    let record = await this.get(owner,id);
    if (['complete','failed','needs_review'].includes(record.status)) return record;
    this.provider.checkConfiguration?.();
    if (record.status === 'reserved') {
      const preparation=await this.provider.prepareUpload?.(localMedia,record.id);
      if(preparation?.resumable){
        if(!this.provider.resumeUpload)throw new Error('Resumable upload configuration unavailable');
        const claimed=await this.db.query(`UPDATE pbj_analysis SET status='uploading',intent=jsonb_set(intent,'{multipart}','{"version":1}'::jsonb),updated_at=now()
          WHERE owner_id=$1 AND id=$2 AND status='reserved' RETURNING id`,[owner,id]);
        return claimed.rows.length?this.resumeUpload(owner,id,localMedia):this.get(owner,id);
      }
      if (!await this.transition(owner,id,'reserved','uploading')) return this.get(owner,id);
      // No paid analysis here. Even an uncertain upload stays unresolved so
      // the operator can recover the reusable asset rather than duplicate it.
      try {
        const providerAsset = await this.provider.upload(localMedia,record.id);
        await this.db.query(`UPDATE pbj_analysis SET provider_asset_id=$3,status='uploaded',updated_at=now()
          WHERE owner_id=$1 AND id=$2`,[owner,id,providerAsset]);
      } catch {
        await this.db.query(`UPDATE pbj_analysis SET status='unresolved',last_error='Upload acceptance or persistence uncertain; reconcile provider asset',updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id]);
        throw new Error('Upload unresolved; automatic resubmission disabled');
      }
      return this.get(owner,id);
    }
    if(record.status==='uploading'&&record.intent.multipart)return this.resumeUpload(owner,id,localMedia);
    if (record.status === 'uploaded') {
      if (!record.provider_asset_id) throw new Error('Damaged upload record');
      const status = await this.provider.assetStatus(record.provider_asset_id);
      if (status === 'failed') {
        await this.transition(owner,id,'uploaded','failed');
        return this.get(owner,id);
      }
      if (status !== 'ready') return record;
      if (!await this.transition(owner,id,'uploaded','submitting')) return this.get(owner,id);
      try {
        const taskID = await this.provider.create(record.provider_asset_id,record.idempotency_key,record.id,record.intent);
        await this.db.query(`UPDATE pbj_analysis SET provider_task_id=$3,status='pending',updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id,taskID]);
      } catch {
        // The provider may have accepted the POST even if we could not save
        // the result. The same correlation/key remains permanently recorded.
        await this.db.query(`UPDATE pbj_analysis SET status='unresolved',last_error='Task acceptance or persistence uncertain; reconcile, never create a new key',updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id]);
      }
      return this.get(owner,id);
    }
    if (['submitting','unresolved'].includes(record.status) && record.provider_asset_id && !record.provider_task_id) {
      const taskID = await this.provider.findTask(record.id);
      if (!taskID) return record; // absence from a list is not proof of nonacceptance
      await this.db.query(`UPDATE pbj_analysis SET provider_task_id=$3,status='pending',updated_at=now() WHERE owner_id=$1 AND id=$2 AND provider_task_id IS NULL`,[owner,id,taskID]);
      record = await this.get(owner,id);
    }
    if (record.status === 'pending' && record.provider_task_id) {
      const response = await this.provider.retrieve(record.provider_task_id);
      // Preserve the complete response BEFORE normalization/completion. A
      // storage failure only repeats this free GET, never the paid POST.
      await this.db.query('UPDATE pbj_analysis SET full_response=$3,updated_at=now() WHERE owner_id=$1 AND id=$2',[owner,id,JSON.stringify(response)]);
      if (response.status === 'failed') {
        await this.transition(owner,id,'pending','failed');
      } else if (response.status === 'ready') {
        try {
          if (response.result?.finish_reason !== 'stop') throw new Error('Incomplete provider output');
          const evidence = normalizeAnalysisEvidence(JSON.parse(response.result.data),durationSeconds,Number(record.intent.analysisDurationSeconds??durationSeconds));
          await this.db.query(`UPDATE pbj_analysis SET evidence=$3,status='complete',last_error=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id,JSON.stringify(evidence)]);
        } catch {
          await this.db.query(`UPDATE pbj_analysis SET status='needs_review',last_error='Saved provider output needs local validation/repair; do not reanalyze',updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id]);
        }
      }
    }
    return this.get(owner,id);
  }
}
