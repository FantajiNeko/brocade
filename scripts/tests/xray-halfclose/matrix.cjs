#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2), options = {};
const allowed = ['harness', 'before-server', 'baseline-client', 'after', 'output'];
while (args.length) {
  const key = args.shift().replace(/^--/, '');
  if (!allowed.includes(key) || options[key] || !args.length) throw new Error('invalid option ' + key);
  options[key] = args.shift();
}
for (const key of allowed) if (!options[key]) throw new Error('required --' + key);
const output = path.resolve(options.output);
if (fs.existsSync(output)) throw new Error('refuse to overwrite matrix');
fs.mkdirSync(output, {recursive: true, mode: 0o700});
const cases = [];
function add(name, server, client, paths, transport = 'tls-and-tcp', direction = 'download', knownDirectFailure = false) {
  for (const p of paths) cases.push({name: name + '-' + (p === 'via-A' ? 'via' : 'direct'), server, client, path: p, transport, direction, expect: knownDirectFailure && p === 'direct-REALITY' ? 'client-timeout' : 'complete'});
}
const both = ['direct-REALITY', 'via-A'];
add('before', options['before-server'], options['baseline-client'], both, 'tls-and-tcp', 'download', true);
add('server-only', options.after, options['baseline-client'], both, 'tls-and-tcp', 'download', true);
add('client-only', options['before-server'], options.after, both);
add('fixed-1', options.after, options.after, both);
add('fixed-2', options.after, options.after, ['direct-REALITY']);
add('fixed-3', options.after, options.after, ['direct-REALITY']);
add('tls-before', options['before-server'], options['baseline-client'], both, 'tls-only');
add('tls-fixed', options.after, options.after, both, 'tls-only');
add('upload-fixed', options.after, options.after, both, 'tls-and-tcp', 'upload');
let child, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; child?.kill('SIGTERM'); });
const summary = {cases: [], complete: false};
(async () => {
  try {
    for (const c of cases) {
      if (interrupted) throw new Error('matrix interrupted');
      const directory = path.join(output, c.name);
      const command = [path.join(__dirname, 'run.cjs'), '--harness', options.harness, '--output', directory];
      for (const key of ['server', 'client', 'path', 'direction', 'transport', 'expect']) command.push('--' + key, c[key]);
      const code = await new Promise((resolve, reject) => { child = spawn(process.execPath, command, {stdio: 'inherit'}); child.once('error', reject); child.once('exit', resolve); });
      summary.cases.push({name: c.name, runner_exit_code: code, ...JSON.parse(fs.readFileSync(path.join(directory, 'runner-result.json')))});
      if (code !== 0) throw new Error('unexpected observation in ' + c.name);
    }
    summary.complete = true;
  } catch (error) { summary.error = error.message; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'matrix-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({matrix: output, complete: summary.complete, cases: summary.cases.length, error: summary.error}));
})();
