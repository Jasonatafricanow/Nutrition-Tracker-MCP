import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFamilyAccounts,tokenHash,validateFamilyRegistry} from '../family-accounts.js';
const TA='A'.repeat(42),TB='B'.repeat(42),TC='C'.repeat(42);
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'family-accounts-'));
 const file=path.join(dir,'members.json');
 writeFileSync(file,JSON.stringify({members:[
  {id:'alex',displayName:'Alex',timeZone:'UTC',tokenSha256:tokenHash(TA)},
  {id:'bea',displayName:'Bea',timeZone:'Asia/Shanghai',tokenSha256:tokenHash(TB)},
  {id:'chen',displayName:'Chen',timeZone:'UTC',tokenSha256:tokenHash(TC)}
 ]}));
 const account=createFamilyAccounts({registryPath:file,dir:path.join(dir,'private'),
   engineFactory:(dbPath,opts)=>({path:dbPath,opts,
     buildSnapshot:()=>({date:'2026-10-18',history:[{date:'2026-10-17',scale_weight_kg:74,intake_complete:1}]}),close(){}})});
 return {account,close(){account.close();rmSync(dir,{recursive:true,force:true});}};
}
test('tokens identify a single member; missing and forged secrets are denied',()=>{
 const f=fixture();try{
  assert.equal(f.account.forToken(TA).id,'alex');
  assert.equal(f.account.forToken(TB).id,'bea');
  assert.equal(f.account.forToken('short'),null);
  assert.equal(f.account.forToken('D'.repeat(42)),null);
 }finally{f.close();}
});
test('engines use separate per-user database paths, preserving timezone',()=>{
 const f=fixture();try{
  const a=f.account.engineFor(f.account.forToken(TA)),b=f.account.engineFor(f.account.forToken(TB));
  assert.notEqual(a.path,b.path);assert.equal(b.opts.timeZone,'Asia/Shanghai');
  assert.equal(f.account.engineFor(f.account.forToken(TA)),a);
 }finally{f.close();}
});
test('cross-member records are denied by default, even when member exists',()=>{
 const f=fixture();try{
  const a=f.account.forToken(TA);
  assert.equal(f.account.canRead(a,'bea','overview'),false);
  assert.throws(()=>f.account.getOverview(a,'bea'),/denied/);
  assert.equal(f.account.directory(a).find(x=>x.id==='bea').overviewVisible,false);
 }finally{f.close();}
});
test('owner-directed grant is scope-specific, revocable and not symmetric',()=>{
 const f=fixture();try{
  const a=f.account.forToken(TA),b=f.account.forToken(TB);
  f.account.setSharing(b,'alex','overview',true);
  assert.equal(f.account.getOverview(a,'bea').memberId,'bea');
  assert.equal(f.account.canRead(a,'bea','health_trends'),false);
  assert.equal(f.account.canRead(b,'alex','overview'),false);
  f.account.setSharing(b,'alex','overview',false);
  assert.throws(()=>f.account.getOverview(a,'bea'),/denied/);
 }finally{f.close();}
});
test('grant cannot impersonate data owner',()=>{
 const f=fixture();try{
  const a=f.account.forToken(TA);
  f.account.setSharing(a,'bea','overview',true);
  assert.equal(f.account.canRead(a,'bea','overview'),false);
  assert.equal(f.account.canRead(f.account.forToken(TB),'alex','overview'),true);
 }finally{f.close();}
});
test('invalid registry ids, tokens and timezones fail closed',()=>{
 const a={id:'a',displayName:'A',tokenSha256:tokenHash(TA)};
 const b={id:'b',displayName:'B',tokenSha256:tokenHash(TB)};
 for(const members of [[a,a],[a,{...b,tokenSha256:a.tokenSha256}],[{...a,id:'../bad'}],[{...a,timeZone:'Mars/Zero'}]])
   assert.throws(()=>validateFamilyRegistry({members}));
});