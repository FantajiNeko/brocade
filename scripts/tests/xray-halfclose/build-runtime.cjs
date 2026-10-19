#!/usr/bin/env node
'use strict';
// Build the isolated prototype with the exact main-tree timer and splice fix.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const [sourceArg,mainArg,outputArg,...flags] = process.argv.slice(2);
if (!outputArg || flags.some(flag => flag !== '--race')) {
  throw new Error('usage: build-runtime.cjs ISOLATED_V6_SOURCE MAIN_XRAY_SOURCE NEW_OUTPUT_DIRECTORY [--race]');
}
const source = fs.realpathSync(sourceArg), main = fs.realpathSync(mainArg), output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error('refuse to overwrite frozen build');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const helpers = ['proxy/splice_accounting_linux.go','proxy/splice_accounting_other.go'];
for (const file of helpers) {
  if (sha(path.join(source,file)) !== sha(path.join(main,file))) {
    throw new Error('prototype splice helper differs from main tree: '+file);
  }
}
fs.mkdirSync(output,{recursive:true});
const replace = {}, inputs = {};
for (const file of ['common/signal/timer.go','proxy/proxy.go']) {
  const frozen = path.join(output,'source',file);
  fs.mkdirSync(path.dirname(frozen),{recursive:true});
  fs.copyFileSync(path.join(main,file),frozen);
  replace[path.join(source,file)] = frozen;
  inputs[file] = sha(frozen);
}
for (const file of helpers) inputs[file] = sha(path.join(source,file));
const overlay = path.join(output,'overlay.json');
fs.writeFileSync(overlay,JSON.stringify({Replace:replace},null,2)+'\n');
const args = ['build','-buildvcs=false',...flags,'-overlay',overlay,'-o',path.join(output,'xray'),'./main'];
const built = spawnSync('go',args,{cwd:source,env:{...process.env,CGO_ENABLED:'1',GOOS:'linux',GOARCH:'amd64',GOAMD64:'v1'},encoding:'utf8',timeout:600000});
fs.writeFileSync(path.join(output,'build.log'),(built.stdout||'')+(built.stderr||''));
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({source,inputs,args,exit_code:built.status,signal:built.signal,error:built.error?.message||null,binary_sha256:built.status===0&&!built.error?sha(path.join(output,'xray')):null},null,2)+'\n');
if (built.error || built.status!==0) throw new Error('runtime build failed: '+(built.error||built.signal||built.status));
console.log(fs.readFileSync(path.join(output,'manifest.json'),'utf8'));
