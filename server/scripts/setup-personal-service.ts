/** Creates private service files and public start/stop launchers. Does not start jobs. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile,stat,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomBytes,X509Certificate} from 'node:crypto';
import {readPersonalConfiguration} from '../src/v2/personalService.ts';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(server,'data','personal-service');
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
const configuration=path.join(root,'config.json');
let exists=false;try{await stat(configuration);exists=true;}catch(e:any){if(e.code!=='ENOENT')throw e;}
if(!exists){
 const providerEnvironment=process.env.PBJ_PROVIDER_ENV;
 if(!providerEnvironment)throw new Error('Set PBJ_PROVIDER_ENV to the existing provider .env path');
 await stat(providerEnvironment);
 const host=execFileSync('/usr/sbin/scutil',['--get','LocalHostName'],{encoding:'utf8'}).trim()+'.local';
 if(!/^[a-zA-Z0-9-]+\.local$/.test(host))throw new Error('Unsupported local host name');
 const certificate=path.join(root,'server.crt'),privateKey=path.join(root,'server.key');
 const openssl=path.join(root,'certificate.conf');
 await writeFile(openssl,`[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=${host}\n[extensions]\nsubjectAltName=DNS:${host}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`,{mode:0o600});
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-days','365','-config',openssl,'-keyout',privateKey,'-out',certificate],{stdio:'ignore'});
 await chmod(privateKey,0o600);
 await writeFile(configuration,JSON.stringify({host,port:8788,token:randomBytes(32).toString('hex'),certificate,privateKey,
   providerEnvironment:path.resolve(providerEnvironment),dataRoot:path.join(server,'data','native')},null,2),{mode:0o600});
}
const config=await readPersonalConfiguration(configuration);
const certificate=new X509Certificate(await readFile(config.certificate));
await writeFile(path.join(root,'PBJMacPairing.json'),JSON.stringify({serverURL:`https://${config.host}:${config.port}`,
 token:config.token,certificateDER:certificate.raw.toString('base64')}),{mode:0o600});
const runner=path.join(server,'scripts','personal-service-runner.ts');
// Launchers deliberately contain no credentials. Terminal keeps the service visible.
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const launcherDirectory=path.resolve(server,'..','Mac Service');await mkdir(launcherDirectory,{recursive:true});
const start=`#!/bin/zsh\nset -eu\nexport PATH=${quote(path.dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')}\ncd ${quote(server)}\necho 'PB&J Mac AI Service — leave this window open. Use Stop PBJ to stop safely.'\nexec /usr/bin/caffeinate -i ${quote(process.execPath)} ${quote(runner)} ${quote(configuration)}\n`;
const stop=`#!/bin/zsh\nset -eu\nexec ${quote(process.execPath)} ${quote(path.join(server,'scripts','stop-personal-service.ts'))} ${quote(path.join(root,'service.pid'))}\n`;
await writeFile(path.join(launcherDirectory,'Start PBJ.command'),start,{mode:0o755});
await writeFile(path.join(launcherDirectory,'Stop PBJ.command'),stop,{mode:0o755});
const status=`#!/bin/zsh\nset -eu\nexec ${quote(process.execPath)} ${quote(path.join(server,'scripts','personal-service-status.ts'))} ${quote(configuration)}\n`;
await writeFile(path.join(launcherDirectory,'Check PBJ.command'),status,{mode:0o755});
console.log('Private configuration and iPhone pairing ready. Setup does not start or restart the service.');
console.log('Mac address: https://'+config.host+':'+config.port);
