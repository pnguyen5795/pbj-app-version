import {createPrivateKey,sign,type KeyObject} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {connect,sensitiveHeaders,type ClientHttp2Session,type OutgoingHttpHeaders} from 'node:http2';
import type {NotificationEvent,PushResult,PushSender} from './notifications.ts';

export type APNsConfiguration={teamID:string;keyID:string;bundleID:string;environment:'sandbox'|'production';privateKey:string};
export function notificationPayload(event:NotificationEvent){
 return {aps:{alert:{title:event.title,body:event.body},sound:'default','thread-id':event.projectID??event.groupID??event.jobID},pbj:event};
}
export class APNsSender implements PushSender {
 environment:'sandbox'|'production';private config:APNsConfiguration;private key:KeyObject;
 private session?:ClientHttp2Session;private jwt='';private issuedAt=0;
 private transport?:(origin:string,headers:OutgoingHttpHeaders,body:string)=>Promise<PushResult>;
 constructor(configuration:APNsConfiguration,transport?:(origin:string,headers:OutgoingHttpHeaders,body:string)=>Promise<PushResult>){
  if(!/^[A-Z0-9]{10}$/.test(configuration.teamID)||!/^[A-Z0-9]{10}$/.test(configuration.keyID)||
   !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(configuration.bundleID)||!['sandbox','production'].includes(configuration.environment))throw new Error('APNs configuration is incomplete');
  this.config=configuration;this.environment=configuration.environment;this.transport=transport;this.key=createPrivateKey(configuration.privateKey);
  if(this.key.asymmetricKeyType!=='ec'||this.key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error('APNs requires its ES256 signing key');
 }
 async send(token:string,event:NotificationEvent):Promise<PushResult>{
  if(!/^(?:[a-f0-9]{2}){16,256}$/.test(token))throw new Error('Invalid notification device token');
  const now=Math.floor(Date.now()/1000);
  // APNs requires reuse for at least 20 minutes and renewal within 60 minutes.
  if(!this.jwt||now-this.issuedAt>=50*60||now<this.issuedAt){
   const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
   const content=encoded({alg:'ES256',kid:this.config.keyID})+'.'+encoded({iss:this.config.teamID,iat:now});
   this.jwt=content+'.'+sign('sha256',Buffer.from(content),{key:this.key,dsaEncoding:'ieee-p1363'}).toString('base64url');this.issuedAt=now;
  }
  const body=JSON.stringify(notificationPayload(event));if(Buffer.byteLength(body)>4096)throw new Error('Notification exceeds APNs payload limit');
  const headers:OutgoingHttpHeaders={':method':'POST',':path':'/3/device/'+token,authorization:'bearer '+this.jwt,
   'apns-topic':this.config.bundleID,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(now+86400),
   'apns-id':event.id,'apns-collapse-id':'pbj-'+event.jobID,[sensitiveHeaders]:['authorization',':path']};
  const origin=this.environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  return this.transport?this.transport(origin,headers,body):this.request(origin,headers,body);
 }
 private async request(origin:string,headers:OutgoingHttpHeaders,body:string):Promise<PushResult>{
  if(!this.session||this.session.closed||this.session.destroyed){
   const session=connect(origin);this.session=session;
   session.on('error',()=>{session.destroy();if(this.session===session)this.session=undefined;});
   session.on('goaway',()=>{session.close();if(this.session===session)this.session=undefined;});
  }
  const session=this.session;
  return new Promise((resolve,reject)=>{
   const request=session.request(headers);let status=0,data='',settled=false;
   const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){reject(error);return;}
    try{const result=data?JSON.parse(data):{};resolve({status,...(typeof result.reason==='string'?{reason:result.reason.slice(0,128)}:{}),...(typeof result.timestamp==='number'?{timestamp:result.timestamp}:{})});}
    catch{reject(new Error('APNs response could not be read'));}
   };
   const timer=setTimeout(()=>request.destroy(new Error('APNs response timeout')),15000);timer.unref();
   request.setEncoding('utf8');request.on('response',response=>{status=Number(response[':status']);});
   request.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>4096)request.destroy(new Error('APNs response exceeds limit'));});
   request.on('error',()=>done(new Error('APNs connection interrupted')));request.on('end',()=>done());
   request.on('close',()=>{if(!settled)done(new Error('APNs connection closed before acknowledgement'));});request.end(body);
  });
 }
 close(){this.session?.close();this.session=undefined;}
}
/** Disabled by default. No credentials are read and no connection is made
 * until a paid team's APNs configuration is explicitly enabled. */
export async function configuredAPNs(environment:NodeJS.ProcessEnv=process.env):Promise<APNsSender|undefined>{
 if(environment.PBJ_APNS_ENABLED!=='1')return;
 const required=(name:string)=>{const value=environment[name];if(!value)throw new Error('APNs configuration is incomplete');return value;};
 const config={teamID:required('PBJ_APNS_TEAM_ID'),keyID:required('PBJ_APNS_KEY_ID'),bundleID:required('PBJ_APNS_BUNDLE_ID'),
  environment:required('PBJ_APNS_ENVIRONMENT') as 'sandbox'|'production',privateKey:await readFile(required('PBJ_APNS_PRIVATE_KEY_FILE'),'utf8')};
 return new APNsSender(config);
}
