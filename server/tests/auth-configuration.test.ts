import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyToken} from '@clerk/backend';
import {parseAuthorizedParties} from '../src/v2/api.ts';

test('blank optional Clerk parties allow valid signed tokens while configured parties stay enforced',async()=>{
 // Fixture keys only. Verify through the installed Clerk SDK with no network.
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const now=Math.floor(Date.now()/1000),azp='https://native.example.test';
 const encode=(value:any)=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const body=encode({alg:'RS256',typ:'JWT',kid:'audit-fixture'})+'.'+encode({sub:'user_audit_fixture',azp,iat:now,nbf:now-10,exp:now+60});
 const token=body+'.'+sign('RSA-SHA256',Buffer.from(body),privateKey).toString('base64url');
 const jwtKey=publicKey.export({type:'spki',format:'pem'}).toString();
 await assert.rejects(()=>verifyToken(token,{jwtKey,authorizedParties:['']})); // The old template behavior.
 assert.equal((await verifyToken(token,{jwtKey,authorizedParties:parseAuthorizedParties('')})).sub,'user_audit_fixture');
 assert.equal((await verifyToken(token,{jwtKey,authorizedParties:parseAuthorizedParties(' , '+azp+', ')})).sub,'user_audit_fixture');
 await assert.rejects(()=>verifyToken(token,{jwtKey,authorizedParties:parseAuthorizedParties('https://another.example.test')}));
});
