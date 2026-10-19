#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn,spawnSync} = require('node:child_process');
const {verifyResult} = require('./verify.cjs');
const args = process.argv.slice(2), options = {};
while (args.length) { const flag=args.shift(); if(!flag.startsWith('--')||!args.length)throw new Error('expected --key value'); options[flag.slice(2)]=args.shift(); }
if(options.negative&&!['corrupt-payload','unexpected-exit'].includes(options.negative))throw new Error('unknown negative control');
if(options.boundary&&options.boundary!=='early-download')throw new Error('unknown boundary test');
if(options['half-close']&&!['tls-only','tls-and-tcp'].includes(options['half-close']))throw new Error('unknown half-close transport');
for(const key of ['harness','old','new','client','output'])if(!options[key])throw new Error('required --'+key);
for(const key of ['harness','old','new','client'])options[key]=fs.realpathSync(options[key]);
const output=path.resolve(options.output);
if(fs.existsSync(output))throw new Error('refuse to replace previous run');
fs.mkdirSync(output,{recursive:true,mode:0o700});
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest={binary_sha256:{b0:digest(options.old),b1:digest(options.new),b2:digest(options.new),client:digest(options.client)},harness_sha256:digest(options.harness)};
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const log=fs.openSync(path.join(output,'test.log'),'wx',0o600);
const testName=options.boundary?'TestH9EarlyHalfCloseBoundary':'TestH9MixedLifecycle';
const environment={XRAY_H9_RUN:'1',H9_OLD_BIN:options.old,H9_NEW_BIN:options.new,H9_CLIENT_BIN:options.client,H9_RESULT_DIR:output,H9_FRAME_INTERVAL_MS:options.pace||'30',H9_NEGATIVE:options.negative||'',H9_HALF_CLOSE:options['half-close']||'tls-and-tcp'};
let executable=options.harness,command=['-test.run','^'+testName+'$','-test.v','-test.count=1','-test.timeout=360s'];
if(options.container){
  if(!/^h7-h9-[a-z0-9-]+$/.test(options.container)||!options['artifact-root']||!options['container-result'])throw new Error('explicit owned H9 container and mount paths required');
  const identity=spawnSync('docker',['inspect','--format','{{index .Config.Labels "brocade.h7.netlab"}} {{.HostConfig.NetworkMode}}',options.container],{encoding:'utf8'});
  if(identity.status!==0||identity.stdout.trim()!=='1 none')throw new Error('container is not the owned isolated netlab');
  const artifactRoot=fs.realpathSync(options['artifact-root']);
  const mapped=p=>{const relative=path.relative(artifactRoot,p);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('binary is outside artifact mount');return '/artifacts/'+relative;};
  for(const key of ['H9_OLD_BIN','H9_NEW_BIN','H9_CLIENT_BIN'])environment[key]=mapped(environment[key]);
  if(!/^\/results\/[a-zA-Z0-9-]+$/.test(options['container-result']))throw new Error('invalid container result path');
  environment.H9_RESULT_DIR=options['container-result'];environment.H7_NETNS='1';
  command=['exec',options.container,'ip','netns','exec','h7-client','env',...Object.entries(environment).map(([key,value])=>key+'='+value),mapped(options.harness),...command];
  executable='docker';
}
const child=spawn(executable,command,{
  detached:true,stdio:['ignore',log,log],env:{...process.env,...environment}
});
const killOwnedGroup=()=>{try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}};
const deadline=setTimeout(killOwnedGroup,370000);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{killOwnedGroup();process.exitCode=1});
child.on('error',error=>{clearTimeout(deadline);fs.closeSync(log);throw error});
child.on('exit',(code,signal)=>{
  clearTimeout(deadline);fs.closeSync(log);
  if(options.container){const ownership=spawnSync('docker',['exec',options.container,'chown','-R',process.getuid()+':'+process.getgid(),environment.H9_RESULT_DIR],{stdio:'inherit'});if(ownership.status!==0)throw new Error('could not recover ownership of generated test evidence');}
  const directories=fs.readdirSync(output,{withFileTypes:true}).filter(x=>x.isDirectory()&&x.name.startsWith('r-'));
  fs.writeFileSync(path.join(output,'exit-code.txt'),String(code??-1)+'\n');
  for(const directory of directories)fs.writeFileSync(path.join(output,directory.name,'exit-code.txt'),String(code??-1)+'\n');
  let verificationError='',verified;
  if(code===0){try{
    if(directories.length!==1)throw new Error('expected exactly one result directory');
    const record=JSON.parse(fs.readFileSync(path.join(output,directories[0].name,'result.json'),'utf8'));
    const logs=fs.readFileSync(path.join(output,'test.log'),'utf8');
    if(!logs.includes('=== RUN   '+testName)||!logs.includes('--- PASS: '+testName))throw new Error('target test did not run and pass');
    if(record.schema_version!==9||record.test_failed!==false)throw new Error('missing successful schema9 result');
    if(options.negative)throw new Error('negative control unexpectedly passed');
    if(!options.boundary){verified=verifyResult(record,{expectedBinarySha256:manifest.binary_sha256,harnessExitCode:code});fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(verified,null,2)+'\n');}
    else {if(record.boundary!==options.boundary||record.flows.length!==2||record.flows.some(f=>f.error||!f.half_close.origin_read_eof||!f.half_close.server_read_eof||f.finished_us-f.started_us<2500000))throw new Error('boundary did not prove complete payload/EOF beyond 2.5s');}
  }catch(error){verificationError=error.message;}}
  fs.writeFileSync(path.join(output,'runner-result.json'),JSON.stringify({harness_exit_code:code,signal,verification_error:verificationError},null,2)+'\n');
  console.log(JSON.stringify({output,exit_code:code,signal,verification_error:verificationError,results:directories.map(d=>path.join(output,d.name,'result.json'))}));
  process.exitCode=verificationError?1:(code??1);
});
