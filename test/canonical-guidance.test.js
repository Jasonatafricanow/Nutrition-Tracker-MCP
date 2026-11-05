import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {EVERYDAY_READS,EVERYDAY_WRITES} from '../everyday-interface.js';

const file = name => readFileSync(fileURLToPath(new URL('../'+name, import.meta.url)), 'utf8');

test('one canonical everyday contract is linked by active setup and deployment docs', ()=>{
 const guide=file('docs/AGENT_CONTRACT_ZH.md');
 const readme=file('README.md');
 const install=file('docs/INSTALL_AND_AGENT_SETUP_ZH.md');
 const remote=file('docs/REMOTE_MCP_DEPLOYMENT_ZH.md');
 const family=file('docs/HOUSEHOLD_LIGHTWEIGHT_ZH.md');
 const photo=file('docs/PHOTO_ESTIMATION_PROTOCOL.md');
 for(const operation of [...EVERYDAY_READS,...EVERYDAY_WRITES]){
   assert.ok(guide.includes(String.fromCharCode(96)+operation+String.fromCharCode(96)),
             'missing canonical operation '+operation);
 }
 assert.deepEqual(EVERYDAY_READS,['summary','meals','foods']);
 assert.deepEqual(EVERYDAY_WRITES,['meal','correct','health','photo_stage','photo_confirm']);
 assert.ok(readme.includes('docs/AGENT_CONTRACT_ZH.md'));
 for(const [name,content] of [['install',install],['remote',remote],['family',family],['photo',photo]]){
   assert.ok(content.includes('AGENT_CONTRACT_ZH.md'),name+' must link canonical contract');
 }
 assert.ok(photo.includes('operation:"photo_stage"'));
 assert.ok(photo.includes('operation:"photo_confirm"'));
 assert.ok(!install.includes('当前 **MCP 传输为 stdio**，不是 HTTP MCP'));
 assert.ok(!install.includes('需要额外开发受认证的 Streamable HTTP MCP 层'));
 assert.ok(!family.includes('默认 compact'));
 assert.ok(!readme.includes('operation:"recent_correction"'));
});

test('historical tool walkthroughs are explicitly non-normative', ()=>{
 for(const doc of ['docs/AGENT_RUNTIME.md','docs/AGENT_WORKFLOWS.md',
                   'docs/archive/README_pre_v5_5.md']){
   assert.match(file(doc),/HISTORICAL REFERENCE|历史设计记录/,doc);
 }
 const prompt=file('everyday-agent-workflow.js');
 assert.ok(prompt.includes('THREE read intents and FIVE write intents'));
 assert.ok(!prompt.includes('switch the deployment profile'));
});
