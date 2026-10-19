#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {within, sourceTemplate} = require('./run.cjs');
const {verify} = require('./verify.cjs');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function replay(directory, destination) {
  const dir = fs.realpathSync(directory), output = path.resolve(destination);
  if (fs.existsSync(output)) throw new Error('refuse to overwrite replay evidence');
  const manifestPath = path.join(dir, 'manifest.json'), exitPath = path.join(dir, 'exit-code.txt');
  const m = JSON.parse(fs.readFileSync(manifestPath));
  const dirs = fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory() && /^r-\d+$/.test(e.name));
  if (dirs.length !== 1) throw new Error('exactly one actual run required');
  const rawPath = path.join(dir, dirs[0].name, 'result.json'), raw = JSON.parse(fs.readFileSync(rawPath));
  const codeText = fs.readFileSync(exitPath, 'utf8').trim();
  if (!/^-?\d+$/.test(codeText)) throw new Error('invalid independent exit code');
  const exitCode = Number(codeText);
  const result = {schema_version: 11, replayed_at: new Date().toISOString(), directory: dir,
    verifier_sha256: digest(path.join(__dirname, 'verify.cjs')), raw_sha256: digest(rawPath), manifest_sha256: digest(manifestPath), exit_sha256: digest(exitPath), harness_exit_code: exitCode};
  let verificationError = '';
  try {
    const expected = {harness: m.harness_sha256, before: m.server_before_sha256, after: m.server_after_sha256, A: m.binary_sha256.A, client: m.binary_sha256.client};
    for (const [role, hash] of Object.entries(expected)) if (digest(m.binaries[role]) !== hash) throw new Error('binary changed: ' + role);
    const params = Object.fromEntries(['transport', 'path', 'scene', 'concurrency', 'duration_ms', 'frame_interval_ms', 'direction', 'half_close_transport', 'idle_ms', 'idle_mode', 'read_delay_ms'].map(k => [k, m[k]]));
    if (sourceTemplate(params, m.binaries.harness).sha256 !== m.config_template_sha256) throw new Error('compiled fixture binding changed');
    for (const c of m.configs) {
      const actual = m.network.kind === 'isolated-container-netns' ? path.join(dir, within('/results/run', c.path)) : c.path;
      within(dir, fs.realpathSync(actual));
      if (digest(actual) !== c.sha256) throw new Error('actual configuration changed: ' + c.role);
    }
    const logs = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    if (!logs.includes('=== RUN   TestH11ClientCompatibility') || !/--- (PASS|FAIL): TestH11ClientCompatibility\b/.test(logs)) throw new Error('target test did not finish');
    result.verified = verify(raw, m, {exitCode});
  } catch (error) { verificationError = error.stack || error.message; }
  result.verification_error = verificationError;
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return result;
}
if (require.main === module) {
  const [directory, destination] = process.argv.slice(2);
  if (!directory || !destination) throw new Error('usage: replay.cjs CASE_DIR FRESH_OUTPUT_JSON');
  const r = replay(directory, destination);
  console.log(JSON.stringify({directory: r.directory, passed: r.verified?.correctness_passed ?? false, error: r.verification_error}));
  process.exitCode = r.verification_error ? 1 : 0;
}
module.exports = {replay};
