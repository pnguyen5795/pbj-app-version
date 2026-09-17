import { createReadStream, openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AnalysisProvider } from './analysisRegistry.ts';

type UploadState = Record<string, unknown>;
const apiRoot='https://api.twelvelabs.io/v1.3';

export class TwelveLabsProvider implements AnalysisProvider {
  private apiKey: string;
  private http: typeof fetch;
  private verifiedFiles=new Map<string,{identity:string;sha256:string}>();
  // Keep the optional hosted-storage argument compatible with existing runtime
  // construction. Large files now use the same durable upload on either host.
  constructor(apiKey: string, http: typeof fetch = fetch,_signMedia?:(path:string,id:string)=>Promise<string>) { this.apiKey=apiKey; this.http=http; }
  checkConfiguration(){if(!this.apiKey)throw new Error('TwelveLabs configuration is unavailable');}
  async prepareUpload(path:string,id:string){
    if(!this.apiKey)throw new Error('TwelveLabs configuration is unavailable');
    const size=(await stat(path)).size;
    if(size<=0||size>2_000_000_000)throw new Error('Analysis derivative exceeds analysis model size limit; prepare a nonempty derivative under 2 GB');
    if(size>200_000_000)return {resumable:true};
  }
  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const response = await this.http(apiRoot + path, {
      ...init, headers: { 'x-api-key':this.apiKey, ...init.headers }, signal:AbortSignal.timeout(120_000),
      redirect:'error',
    });
    // Never include request headers, media URLs or raw response bodies in logs.
    if (!response.ok) throw new Error(`TwelveLabs request returned HTTP ${response.status}`);
    return response.json();
  }
  async upload(path: string, correlationID: string): Promise<string> {
    if(await this.prepareUpload(path,correlationID))throw new Error('Large analysis upload requires its durable multipart registry');
    const form = new FormData();
    form.set('method','direct');form.set('file',await openAsBlob(path),correlationID + '.mp4');
    form.set('user_metadata',JSON.stringify({pbj_analysis_id:correlationID}));
    const result = await this.request('/assets',{method:'POST',body:form});
    if (typeof result._id !== 'string') throw new Error('Missing provider asset ID');
    return result._id;
  }

  private async uploadFileIdentity(path:string,id:string){
    const info=await stat(path);
    if(info.size<=0||info.size>2_000_000_000)throw new Error('Analysis derivative exceeds the 2 GB model limit');
    const identity=[path,info.size,info.mtimeMs,info.ctimeMs,info.ino].join(':');
    let verified=this.verifiedFiles.get(id);
    if(verified?.identity!==identity){
      const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
      const after=await stat(path);
      if([path,after.size,after.mtimeMs,after.ctimeMs,after.ino].join(':')!==identity)throw new Error('Analysis derivative changed while its checksum was being checked');
      verified={identity,sha256:hash.digest('hex')};
      if(this.verifiedFiles.size>=32)this.verifiedFiles.delete(this.verifiedFiles.keys().next().value!);
      this.verifiedFiles.set(id,verified);
    }
    return {size:info.size,sha256:verified.sha256};
  }

  /** Resumes one exact byte stream. Checkpoints precede non-idempotent work.
   * The provider deduplicates chunk reports; session creation has no documented
   * idempotency contract, so a lost creation receipt must be recovered manually.
   * See https://docs.twelvelabs.io/api-reference/upload-files/multipart-uploads/create
   */
  async resumeUpload(path:string,id:string,saved:UploadState,checkpoint:(state:UploadState)=>Promise<void>):Promise<string|undefined>{
    this.checkConfiguration();
    let state=structuredClone(saved);
    if(state.version!==1)throw new Error('Multipart upload state requires recovery');
    const persist=async(next:UploadState)=>{await checkpoint(next);state=next;};
    if(state.phase==='creating')throw new Error('Multipart session creation unresolved; recover its original receipt before uploading again');
    if(!state.phase){
      const identity=await this.uploadFileIdentity(path,id);
      await persist({...state,...identity,phase:'creating'});
      const result=await this.request('/assets/multipart-uploads',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({filename:id+'.mp4',type:'video',total_size:identity.size,user_metadata:{pbj_analysis_id:id}})});
      // Save the receipt before interpreting it. URLs are temporary and are
      // refreshed per part, so only durable fields belong in the registry.
      const receipt=result&&typeof result==='object'&&!Array.isArray(result)?Object.fromEntries(Object.entries(result).filter(([key])=>key!=='upload_urls')):result;
      await persist({...state,phase:'created',receipt});
      return;
    }
    if(!Number.isSafeInteger(state.size)||Number(state.size)<=0||Number(state.size)>2_000_000_000||
      typeof state.sha256!=='string'||!/^[a-f0-9]{64}$/.test(state.sha256))throw new Error('Invalid saved upload byte identity; recovery required');
    const size=Number(state.size);
    if(state.phase==='created'){
      const receipt=state.receipt as any;
      if(!receipt||typeof receipt.upload_id!=='string'||!receipt.upload_id||typeof receipt.asset_id!=='string'||!receipt.asset_id||
        !Number.isSafeInteger(receipt.chunk_size)||receipt.chunk_size<=0||!Number.isSafeInteger(receipt.total_chunks)||
        receipt.total_chunks!==Math.ceil(size/receipt.chunk_size)||receipt.total_chunks>10000||
        !Number.isFinite(Date.parse(receipt.expires_at)))throw new Error('Invalid multipart creation receipt; saved upload requires recovery');
      await persist({...state,phase:'active',uploadID:receipt.upload_id,assetID:receipt.asset_id,
        chunkSize:receipt.chunk_size,totalChunks:receipt.total_chunks,expiresAt:receipt.expires_at,uploadHeaders:receipt.upload_headers??{},completedParts:0});
    }
    const {uploadID,assetID,chunkSize,totalChunks}=state;
    if(state.phase!=='active'||typeof uploadID!=='string'||typeof assetID!=='string'||
      !Number.isSafeInteger(chunkSize)||Number(chunkSize)<=0||!Number.isSafeInteger(totalChunks)||Number(totalChunks)>10000||
      Number(totalChunks)!==Math.ceil(size/Number(chunkSize)))throw new Error('Invalid saved multipart upload; recovery required');
    const endpoint='/assets/multipart-uploads/'+encodeURIComponent(uploadID);
    const completed=new Set<number>();let sessionStatus='active';
    for(let page=1;page<=200;page++){
      await persist(state);
      const result=await this.request(endpoint+`?page=${page}&page_limit=50`);
      if(result.upload_id!==uploadID||result.total_size!==size||!Array.isArray(result.uploaded_chunks)||
        !['active','completed','failed','expired'].includes(result.status))throw new Error('Invalid multipart status; saved upload requires recovery');
      sessionStatus=result.status;
      if(sessionStatus==='completed')return assetID;
      if(sessionStatus==='failed'||sessionStatus==='expired')throw new Error('Multipart upload '+sessionStatus+'; saved session requires recovery before a replacement upload');
      for(const part of result.uploaded_chunks){
        if(!Number.isSafeInteger(part.index)||part.index<1||part.index>Number(totalChunks))throw new Error('Invalid multipart chunk receipt; recovery required');
        if(part.status==='completed')completed.add(part.index);
      }
      const pages=result.page_info?.total_page;
      if(!Number.isSafeInteger(pages)||pages<1||pages>200)throw new Error('Invalid multipart status pagination; recovery required');
      if(page>=pages)break;
    }
    const report=async(index:number,etag:string,size:number)=>{
      await this.request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({completed_chunks:[{chunk_index:index,proof:etag,proof_type:'etag',chunk_size:size}]})});
      completed.add(index);await persist({...state,pending:undefined,completedParts:completed.size});
    };
    const pending=state.pending as {index:number;etag:string;size:number}|undefined;
    if(pending){
      if(!Number.isSafeInteger(pending.index)||pending.index<1||pending.index>Number(totalChunks)||typeof pending.etag!=='string'||!pending.etag||
        pending.size!==Math.min(Number(chunkSize),size-(pending.index-1)*Number(chunkSize)))throw new Error('Invalid saved chunk acknowledgement; recovery required');
      if(!completed.has(pending.index))await report(pending.index,pending.etag,pending.size);
      else await persist({...state,pending:undefined,completedParts:completed.size});
    }
    let sent=0;
    for(let index=1;index<=Number(totalChunks)&&sent<4;index++){
      if(completed.has(index))continue;
      // Completed remote sessions and pending reports need no local media.
      // Each remaining part must still belong to the original exact bytes.
      const identity=await this.uploadFileIdentity(path,id);
      if(state.sha256!==identity.sha256||size!==identity.size)
        throw new Error('Analysis derivative checksum changed; restore the original upload bytes or recover the saved session. Its receipt has been retained');
      await persist(state);
      // Request a fresh URL even after a failed PUT: signed URLs are single-use.
      const urls=await this.request(endpoint+'/presigned-urls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:index,count:1})});
      const item=urls.upload_urls?.find((entry:any)=>entry.chunk_index===index);
      if(urls.upload_id!==uploadID||typeof item?.url!=='string'||!Number.isFinite(Date.parse(item.expires_at)))
        throw new Error('Invalid multipart upload URL; saved session requires recovery');
      if(Date.parse(item.expires_at)<=Date.now())throw new Error('Multipart upload URL expired; retry with a fresh URL');
      const url=new URL(item.url);
      if(url.protocol!=='https:'||url.username||url.password)throw new Error('Invalid multipart upload destination');
      const headers=new Headers();
      if(!state.uploadHeaders||typeof state.uploadHeaders!=='object'||Array.isArray(state.uploadHeaders))throw new Error('Invalid multipart upload headers');
      for(const [key,value] of Object.entries(state.uploadHeaders)){
        if(typeof value!=='string'||/^(x-api-key|authorization|cookie|host)$/i.test(key))throw new Error('Invalid multipart upload headers');
        headers.set(key,value);
      }
      const offset=(index-1)*Number(chunkSize),partSize=Math.min(Number(chunkSize),size-offset);
      const response=await this.http(url.href,{method:'PUT',headers,body:(await openAsBlob(path)).slice(offset,offset+partSize),
        credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120_000)});
      if(!response.ok)throw new Error(`Multipart chunk upload returned HTTP ${response.status}`);
      const etag=response.headers.get('etag')?.replace(/^"|"$/g,'');
      if(!etag)throw new Error('Multipart chunk receipt missing; retry with a fresh URL');
      await persist({...state,pending:{index,etag,size:partSize}});
      await report(index,etag,partSize);sent++;
    }
    // Finalization is confirmed through GET on the next iteration. A lost last
    // report response therefore cannot trigger another upload or paid scan.
  }
  async assetStatus(id: string): Promise<string> {
    return (await this.request('/assets/' + encodeURIComponent(id))).status;
  }
  async create(assetID: string, key: string, correlationID: string, intent: Record<string,unknown>): Promise<string> {
    const { model_name,prompt,response_format,max_tokens,temperature } = intent;
    const result = await this.request('/analyze/tasks',{method:'POST',
      headers:{'Content-Type':'application/json','Idempotency-Key':key},
      body:JSON.stringify({video:{type:'asset_id',asset_id:assetID},custom_id:correlationID,
        model_name,prompt,response_format,max_tokens,temperature})});
    if (typeof result.task_id !== 'string') throw new Error('Missing provider task ID');
    return result.task_id;
  }
  async retrieve(taskID: string) { return this.request('/analyze/tasks/' + encodeURIComponent(taskID)); }
  async findTask(correlationID: string): Promise<string | null> {
    const matches: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(`/analyze/tasks?page=${page}&page_limit=50`);
      if (!Array.isArray(result.data)) throw new Error('Invalid provider task registry response');
      for (const task of result.data) if (task.custom_id === correlationID && typeof task.task_id === 'string') matches.push(task.task_id);
      if (matches.length > 1) throw new Error('Multiple correlated tasks require reconciliation');
      if (result.data.length < 50 || (result.page_info?.total_page && page >= result.page_info.total_page)) return matches[0] ?? null;
    }
    throw new Error('Task reconciliation page limit reached; leave unresolved');
  }
}
