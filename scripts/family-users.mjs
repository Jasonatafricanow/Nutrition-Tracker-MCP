import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {tokenHash,validateFamilyRegistry} from '../family-accounts.js';
const [action,file,id,displayName,zone='UTC']=process.argv.slice(2);
if(!['init','add','rotate','disable','list'].includes(action)||!file||!path.isAbsolute(file)){
 console.error('Usage: node scripts/family-users.mjs <init|add|rotate|disable|list> /absolute/path/family-users.json [id] [displayName] [IANA timeZone]');process.exit(2);
}
if(action==='init'){
 if(existsSync(file))throw Error('Registry already exists');
 mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 writeFileSync(file,JSON.stringify({members:[]},null,2)+'\n',{mode:0o600});
 console.log('Created registry; add at least one member before starting server');process.exit(0);
}
if(!existsSync(file))throw Error('Registry missing; first use init');
const cfg=JSON.parse(readFileSync(file,'utf8'));
if(action==='list'){console.log(cfg.members.map(m=>({id:m.id,displayName:m.displayName,timeZone:m.timeZone})));process.exit(0);}
const index=cfg.members.findIndex(m=>m.id===id);
if(action==='add'&&index!==-1)throw Error('Member exists');
if((action==='rotate'||action==='disable')&&index<0)throw Error('Unknown member');
let secret;
if(action==='add'||action==='rotate'){
 secret=randomBytes(36).toString('base64url');
 const entry=action==='rotate'?{...cfg.members[index],tokenSha256:tokenHash(secret)}:{id,displayName,timeZone:zone,tokenSha256:tokenHash(secret)};
 if(index<0)cfg.members.push(entry);else cfg.members[index]=entry;
}else cfg.members.splice(index,1);
if(cfg.members.length)validateFamilyRegistry(cfg);
const tmp=file+'.new';writeFileSync(tmp,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});renameSync(tmp,file);chmodSync(file,0o600);
if(secret)console.log('Save member bearer token securely (shown once):',secret);
console.log('Restart MCP server for registry changes to take effect');