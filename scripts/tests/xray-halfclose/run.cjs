#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {verify} = require('./verify.cjs');
const options = {}, args = process.argv.slice(2);
const allowed = ['harness', 'server', 'client', 'output', 'path', 'direction', 'transport', 'expect'];
while (args.length) {
  const flag = args.shift();
  if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || !args.length || options[flag.slice(2)] !== undefined) throw new Error('unknown/duplicate/incomplete option: ' + flag);
  options[flag.slice(2)] = args.shift();
}
for (const key of allowed) if (!options[key]) throw new Error('required --' + key);
if (!['via-A', 'direct-REALITY'].includes(options.path) || !['upload', 'download'].includes(options.direction) || !['tls-only', 'tls-and-tcp'].includes(options.transport) || !['complete', 'client-timeout'].includes(options.expect)) throw new Error('unsupported scenario');
for (const key of ['harness', 'server', 'client']) options[key] = fs.realpathSync(options[key]);
const output = path.resolve(options.output);
if (fs.existsSync(output)) throw new Error('refuse to replace previous H10 evidence');
fs.mkdirSync(output, {recursive: true, mode: 0o700});
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = {path: options.path, direction: options.direction, transport: options.transport, expect: options.expect, sha256: Object.fromEntries(['harness', 'server', 'client'].map(key => [key, digest(options[key])]))};
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const log = fs.openSync(path.join(output, 'test.log'), 'wx', 0o600);
const testName = 'TestH10EarlyHalfCloseBoundary';
const child = spawn(options.harness, ['-test.run', '^' + testName + '$', '-test.v', '-test.count=1', '-test.timeout=30s'], {
  detached: true, stdio: ['ignore', log, log],
  env: {...process.env, XRAY_H9_RUN: '1', H9_OLD_BIN: options.server, H9_NEW_BIN: options.server, H9_CLIENT_BIN: options.client, H9_RESULT_DIR: output, H9_FRAME_INTERVAL_MS: '30', H9_NEGATIVE: '', H9_HALF_CLOSE: options.transport, H7_NETNS: '', H10_PATH: options.path, H10_DIRECTION: options.direction},
});
let interrupted = false;
function killGroup() { interrupted = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
const deadline = setTimeout(killGroup, 35000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, killGroup);
child.on('error', error => { clearTimeout(deadline); fs.closeSync(log); throw error; });
child.on('exit', (code, signal) => {
  clearTimeout(deadline); fs.closeSync(log);
  fs.writeFileSync(path.join(output, 'exit-code.txt'), String(code ?? -1) + '\n');
  let failure = '', verification;
  try {
    if (interrupted || signal) throw new Error('harness interrupted, not a valid observation');
    const directories = fs.readdirSync(output, {withFileTypes: true}).filter(e => e.isDirectory() && e.name.startsWith('r-'));
    if (directories.length !== 1) throw new Error('exactly one result directory required');
    const directory = path.join(output, directories[0].name);
    fs.writeFileSync(path.join(directory, 'exit-code.txt'), String(code ?? -1) + '\n');
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
    if (record.run_id !== directories[0].name) throw new Error('result identity mismatch');
    const logs = fs.readFileSync(path.join(output, 'test.log'), 'utf8');
    const ending = options.expect === 'complete' ? 'PASS' : 'FAIL';
    if (!logs.includes('=== RUN   ' + testName) || !logs.includes('--- ' + ending + ': ' + testName)) throw new Error('target test did not run with expected outcome');
    for (const key of ['harness', 'server', 'client']) if (digest(options[key]) !== manifest.sha256[key]) throw new Error('binary changed during run: ' + key);
    verification = verify(record, manifest, code);
    fs.writeFileSync(path.join(output, 'verified.json'), JSON.stringify(verification, null, 2) + '\n');
  } catch (error) { failure = error.message; }
  fs.writeFileSync(path.join(output, 'runner-result.json'), JSON.stringify({harness_exit_code: code, signal, verification_error: failure, verification}, null, 2) + '\n');
  console.log(JSON.stringify({output, harness_exit_code: code, verification_error: failure, verification}));
  process.exitCode = failure ? 1 : 0;
});
