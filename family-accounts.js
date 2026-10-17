/** Family identity boundary for the remote MCP server. */
import {DatabaseSync} from 'node:sqlite';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync,mkdirSync,realpathSync} from 'node:fs';
import path from 'node:path';

const ID=/^[a-z][a-z0-9_-]{0,39}$/;
const SCOPES=new Set(['overview','health_trends']);
const hex=/^[a-f0-9]{64}$/;
export const tokenHash=token=>createHash('sha256').update(token,'utf8').digest('hex');
const eq=(a,b)=>{const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');return x.length===32&&y.length===32&&timingSafeEqual(x,y);};

export function validateFamilyRegistry(raw) {
  if(!raw||!Array.isArray(raw.members)||raw.members.length<1||raw.members.length>50)
    throw Error('Family registry requires 1-50 members');
  const ids=new Set(), tokens=new Set();
  return raw.members.map(m=>{
    if(!m||typeof m.id!=='string'||!ID.test(m.id))throw Error('Invalid family member id');
    if(typeof m.displayName!=='string'||m.displayName.trim().length<1||m.displayName.length>80)throw Error('Invalid display name');
    if(typeof m.tokenSha256!=='string'||!hex.test(m.tokenSha256))throw Error('Invalid family token hash');
    if(ids.has(m.id)||tokens.has(m.tokenSha256))throw Error('Duplicate family member or token');
    ids.add(m.id);tokens.add(m.tokenSha256);
    const zone=m.timeZone||raw.timeZone||'UTC';
    try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw Error('Invalid member timezone');}
    return {id:m.id,displayName:m.displayName,timeZone:zone,tokenSha256:m.tokenSha256};
  });
}
export function createFamilyAccounts({registryPath,dir,engineFactory,now=()=>new Date()}={}){
  if(!registryPath||!path.isAbsolute(registryPath))throw Error('FAMILY_REGISTRY_PATH must be an absolute path');
  if(!dir||!path.isAbsolute(dir))throw Error('FAMILY_DATA_DIR must be an absolute path');
  if(typeof engineFactory!=='function')throw Error('engineFactory is required');
  const members=validateFamilyRegistry(JSON.parse(readFileSync(registryPath,'utf8')));
  mkdirSync(dir,{recursive:true,mode:0o700});
  const root=realpathSync(dir),byId=new Map(members.map(m=>[m.id,m]));
  const db=new DatabaseSync(path.join(root,'family-consents.db'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sharing_grants (
      owner_id TEXT NOT NULL,grantee_id TEXT NOT NULL,scope TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(owner_id,grantee_id,scope)
    );`);
  const engines=new Map();
  const member=(id)=>{const m=byId.get(id);if(!m)throw Error('Unknown family member');return m;};
  const forToken=(token)=>{
    if(typeof token!=='string'||Buffer.byteLength(token,'utf8')<32||Buffer.byteLength(token,'utf8')>512)return null;
    const digest=tokenHash(token);
    let selected=null;
    for(const m of members)if(eq(digest,m.tokenSha256))selected=m;
    return selected ? {id:selected.id,displayName:selected.displayName,timeZone:selected.timeZone} : null;
  };
  const engineFor=(principal)=>{
    const m=member(principal.id);
    if(!engines.has(m.id))engines.set(m.id,engineFactory(path.join(root,`member-${m.id}.db`),{timeZone:m.timeZone,now}));
    return engines.get(m.id);
  };
  const canRead=(principal,ownerId,scope)=>{
    if(!SCOPES.has(scope))throw Error('Unknown sharing scope');
    member(principal.id);member(ownerId);
    return principal.id===ownerId||!!db.prepare('SELECT 1 AS ok FROM sharing_grants WHERE owner_id=? AND grantee_id=? AND scope=?').get(ownerId,principal.id,scope);
  };
  const setSharing=(principal,granteeId,scope,enabled)=>{
    member(principal.id);member(granteeId);
    if(principal.id===granteeId)throw Error('Cannot grant to self');
    if(!SCOPES.has(scope)||typeof enabled!=='boolean')throw Error('Invalid sharing scope or action');
    if(enabled)db.prepare('INSERT OR IGNORE INTO sharing_grants(owner_id,grantee_id,scope,created_at) VALUES(?,?,?,?)')
      .run(principal.id,granteeId,scope,new Date().toISOString());
    else db.prepare('DELETE FROM sharing_grants WHERE owner_id=? AND grantee_id=? AND scope=?').run(principal.id,granteeId,scope);
    return {ok:true,ownerId:principal.id,granteeId,scope,enabled};
  };
  const directory=(principal)=>members.map(m=>({id:m.id,displayName:m.displayName,self:m.id===principal.id,
    overviewVisible:canRead(principal,m.id,'overview'),healthTrendsVisible:canRead(principal,m.id,'health_trends')}));
  const getOverview=(principal,ownerId)=>{
    member(ownerId);
    if(!canRead(principal,ownerId,'overview'))throw Error('Family overview access denied');
    const snap=engineFor({id:ownerId}).buildSnapshot();
    const history=snap.history.filter(x=>x.scale_weight_kg!=null).slice(-7).map(x=>({date:x.date,scaleWeightKg:x.scale_weight_kg}));
    return {ok:true,memberId:ownerId,asOf:snap.date,reportedDays:snap.history.filter(x=>x.intake_complete).length,
      latestWeightKg:history.length?history.at(-1).scaleWeightKg:null,measuredWeights:history,
      note:'Shared with explicit member permission; observations are not diagnoses'};
  };
  return {forToken,engineFor,member,directory,setSharing,canRead,getOverview,
    close(){for(const e of engines.values())e.close();db.close();}};
}
