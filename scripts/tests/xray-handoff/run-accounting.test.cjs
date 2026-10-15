'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync,spawn}=require('node:child_process');

const runner=path.join(__dirname,'run-accounting.cjs');
function environment(extra={}) { const env={...process.env,...extra};delete env.NODE_TEST_CONTEXT;return env; }
function fakeAgent(directory) {
  const file=path.join(directory,'fake-agent');
  fs.writeFileSync(file,`#!${process.execPath}\nconsole.log(process.pid);setInterval(()=>{},1000);\n`,{mode:0o700});
  return file;
}

test('accounting runner rejects an exit-zero executable that runs no fixtures', {skip:process.platform!=='linux'},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'brocade-accounting-runner-'));
  try {
    const output=path.join(directory,'result');
    const run=spawnSync(process.execPath,[runner,output,...Array(5).fill('/usr/bin/true')],{env:environment(),encoding:'utf8',timeout:10000});
    assert.ifError(run.error);
    assert.equal(run.status,1);
    assert.match(run.stderr,/complete exact case set/,JSON.stringify(run));
    assert.equal(fs.existsSync(path.join(output,'verified.json')),false);
  } finally {
    fs.rmSync(directory,{recursive:true});
  }
});

test('accounting timeout records failure and reaps the owned child', {skip:process.platform!=='linux'},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'brocade-accounting-timeout-'));
  try {
    const output=path.join(directory,'result');
    const run=spawnSync(process.execPath,[runner,output,...Array(4).fill('/usr/bin/true'),fakeAgent(directory)],{env:environment({H9_ACCOUNTING_CASE_TIMEOUT_MS:'500'}),encoding:'utf8',timeout:10000});
    assert.ifError(run.error);assert.equal(run.status,1);
    for(const name of ['plain','tls','reality','held-cover']) {
      const result=JSON.parse(fs.readFileSync(path.join(output,name+'-exit.json')));
      assert.equal(result.timed_out,true);assert.equal(result.signal,'SIGKILL');
      const pid=Number(fs.readFileSync(path.join(output,name+'.log'),'utf8').trim());
      assert(Number.isSafeInteger(pid)&&pid>1);
      assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    }
    assert.equal(fs.existsSync(path.join(output,'verified.json')),false);
  } finally { fs.rmSync(directory,{recursive:true}); }
});

test('accounting spawn failure records an error and cannot publish success', {skip:process.platform!=='linux'},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'brocade-accounting-spawn-'));
  try {
    const output=path.join(directory,'result');
    const agent=fakeAgent(directory);fs.chmodSync(agent,0o600);
    const run=spawnSync(process.execPath,[runner,output,...Array(4).fill('/usr/bin/true'),agent],{env:environment(),encoding:'utf8',timeout:10000});
    assert.ifError(run.error);assert.equal(run.status,1);
    for(const name of ['plain','tls','reality','held-cover']) {
      const result=JSON.parse(fs.readFileSync(path.join(output,name+'-exit.json')));
      assert.match(result.error,/EACCES/);assert.notEqual(result.code,0);
    }
    assert.equal(fs.existsSync(path.join(output,'verified.json')),false);
  } finally { fs.rmSync(directory,{recursive:true}); }
});

test('accounting interruption stops detached children and does not launch held-cover', {skip:process.platform!=='linux'},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'brocade-accounting-interrupt-'));
  let child;
  try {
    const output=path.join(directory,'result');
    child=spawn(process.execPath,[runner,output,...Array(4).fill('/usr/bin/true'),fakeAgent(directory)],{env:environment(),stdio:'ignore'});
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    const limit=Date.now()+5000;
    const pids=[];
    for(const name of ['plain','tls','reality']) {
      const file=path.join(output,name+'.log');
      while(!fs.existsSync(file)||!fs.readFileSync(file,'utf8').trim()) {
        assert(Date.now()<limit,'fake agent did not start');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      pids.push(Number(fs.readFileSync(file,'utf8').trim()));
    }
    child.kill('SIGTERM');
    const watchdog=setTimeout(()=>child.kill('SIGKILL'),5000);
    let result;
    try { result=await exited; } finally { clearTimeout(watchdog); }
    assert.deepEqual(result,{code:1,signal:null});
    for(const pid of pids) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    for(const name of ['plain','tls','reality']) assert.equal(JSON.parse(fs.readFileSync(path.join(output,name+'-exit.json'))).interrupted,'SIGTERM');
    assert.equal(fs.existsSync(path.join(output,'held-cover')),false);
    assert.equal(fs.existsSync(path.join(output,'verified.json')),false);
  } finally { if(child && child.exitCode===null) child.kill('SIGTERM');fs.rmSync(directory,{recursive:true}); }
});
