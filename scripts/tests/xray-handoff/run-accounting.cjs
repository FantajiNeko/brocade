#!/usr/bin/env node
'use strict';
// Local isolated fixtures only; every PostgreSQL instance is testcontainers-owned.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const [outputArg, runtimeArg, clientArg, legacyArg, managerArg, agentArg] = process.argv.slice(2);
if (!agentArg) throw new Error('usage: run-accounting.cjs NEW_OUTPUT XRAY CLIENT LEGACY MANAGER_TEST AGENT_TEST');
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error('refuse to overwrite accounting evidence');
const inputs = Object.fromEntries(Object.entries({runtime:runtimeArg, client:clientArg, legacy:legacyArg, manager:managerArg, agent:agentArg}).map(([key,value])=>[key,fs.realpathSync(value)]));
const timeoutMs=Number(process.env.H9_ACCOUNTING_CASE_TIMEOUT_MS || 900000);
if(!Number.isSafeInteger(timeoutMs) || timeoutMs<50 || timeoutMs>900000) throw new Error('case timeout must be 50..900000 ms');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const children=new Set();
let interrupted=null;
function killOwnedGroup(child) {
  if(!child.pid) return;
  try { process.kill(-child.pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') console.error(error); }
}
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
  interrupted=signal;
  for(const child of children) killOwnedGroup(child);
});
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'inputs.json'),JSON.stringify({paths:inputs,sha256:Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,sha(v)]))},null,2)+'\n');
async function run(mode, heldCover = false) {
  if(interrupted) return false;
  const name = heldCover ? 'held-cover' : mode;
  const directory = path.join(output,name);
  fs.mkdirSync(directory);
  const args = heldCover
    ? ['lab_multigen::v5::held_cover_finishes_after_public_pause_before_rust_retirement','--exact','--ignored','--nocapture']
    : ['lab_multigen::v5::','--ignored','--nocapture','--test-threads=1',
      '--skip','lab_multigen::v5::worker','--skip','lab_multigen::v5::whole_config_smoke',
      '--skip','lab_multigen::v5::held_cover_finishes_after_public_pause_before_rust_retirement'];
  if (!heldCover && mode !== 'plain') args.push('--skip','lab_multigen::v5::legacy_drain_contract_is_rejected_without_signaling','--skip','lab_multigen::v5::unreviewed_udp_remains_usable_and_retirement_fails_closed');
  const env = {...process.env, BROCADE_RUN_PG_TESTS:'1', BROCADE_TEST_XRAY:inputs.runtime,
    BROCADE_TEST_CLIENT_XRAY:inputs.client, BROCADE_TEST_LEGACY_XRAY:inputs.legacy,
    LAB_MANAGER_HELPER:inputs.manager, LAB_REQUIRE_FENCING:'1', LAB_V6_SECURITY:mode, LAB_RESULT_DIR:directory};
  const log = fs.openSync(path.join(output,name+'.log'),'wx');
  const start = new Date().toISOString();
  const child = spawn(inputs.agent,args,{env,detached:true,stdio:['ignore',log,log]});
  children.add(child);
  fs.closeSync(log);
  let timedOut=false;
  const deadline=setTimeout(()=>{
    timedOut=true;
    killOwnedGroup(child);
  },timeoutMs);
  const result = await new Promise(resolve=>{
    child.once('error',error=>resolve({error:String(error)}));
    child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  clearTimeout(deadline);
  children.delete(child);
  const record = {name,start,end:new Date().toISOString(),args,timeout_ms:timeoutMs,timed_out:timedOut,interrupted,...result};
  fs.writeFileSync(path.join(output,name+'-exit.json'),JSON.stringify(record,null,2)+'\n');
  console.log(JSON.stringify(record));
  return !interrupted && !timedOut && result.code === 0 && !result.signal && !result.error;
}
(async()=>{
  const results = await Promise.all(['plain','tls','reality'].map(mode=>run(mode)));
  results.push(await run('reality',true));
  for (const [key,file] of Object.entries(inputs)) {
    const frozen = JSON.parse(fs.readFileSync(path.join(output,'inputs.json'))).sha256[key];
    if (sha(file)!==frozen) throw new Error('input changed during run: '+key);
  }
  if (!results.every(Boolean)) { process.exitCode=1; return; }
  const verified=require('./verify-accounting.cjs').verifyDirectory(output);
  fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(verified,null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
