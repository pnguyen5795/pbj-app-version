import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Request} from 'express';
import {z} from 'zod';

const configuration = z.object({
  host:z.string().regex(/^[a-zA-Z0-9-]+\.local$/),
  port:z.number().int().min(1024).max(65535),
  token:z.string().regex(/^[a-f0-9]{64}$/),
  certificate:z.string().min(1), privateKey:z.string().min(1),
  providerEnvironment:z.string().min(1), dataRoot:z.string().min(1),
  aiProcessingEnabled:z.boolean().default(true),
});
export async function readPersonalConfiguration(file:string) {
  return configuration.parse(JSON.parse(await readFile(file,'utf8')));
}
export function pairedAuthentication(token:string) {
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid device pairing configuration');
  const expected=Buffer.from(token);
  return async (request:Request) => {
    const supplied=Buffer.from(request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]??'');
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new Error('Pair this iPhone with your Mac to continue');
    return 'local-spike';
  };
}
