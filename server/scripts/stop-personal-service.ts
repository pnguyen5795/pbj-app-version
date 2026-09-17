import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const file=process.argv[2];if(!file)throw new Error('Service PID file required');
try{
 const pid=Number(await readFile(file,'utf8'));
 if(!Number.isSafeInteger(pid)||pid<2)throw new Error('Invalid service PID');
 let command='';try{command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});}catch{console.log('PB&J service is already stopped.');process.exit(0);}
 if(!command.includes('personal-service-runner.ts'))throw new Error('PID belongs to another process; stop was not sent');
 process.kill(pid,'SIGTERM');
 console.log('Stop requested. PB&J will finish its current operation before closing.');
}catch(error:any){if(['ENOENT','ESRCH'].includes(error.code))console.log('PB&J service is already stopped.');else throw error;}
