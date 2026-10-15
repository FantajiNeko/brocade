'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');
for (const expectation of ['complete', 'client-timeout']) test('runner rejects a zero-test executable for ' + expectation, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brocade-h10-zero-test-'));
  const output = path.join(directory, 'run');
  const run = spawnSync(process.execPath, [path.join(__dirname, 'run.cjs'), '--harness', '/usr/bin/true', '--server', '/usr/bin/true', '--client', '/usr/bin/true', '--output', output, '--path', 'direct-REALITY', '--direction', 'download', '--transport', 'tls-and-tcp', '--expect', expectation], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  const result = JSON.parse(fs.readFileSync(path.join(output, 'runner-result.json')));
  assert.equal(result.harness_exit_code, 0);
  assert.match(result.verification_error, /exactly one result/);
});
test('runner rejects unknown options instead of silently ignoring them', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'run.cjs'), '--unknown', 'anything'], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown\/duplicate\/incomplete/);
});
