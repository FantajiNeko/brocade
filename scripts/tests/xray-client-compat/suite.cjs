#!/usr/bin/env node
'use strict';

// A saved plan is an ordered collection of local invocations, not shell code.
// Every case keeps its own raw evidence even when a prior case fails.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

function casesFor(matrix, clients) {
  const cases = [];
  const add = (client, transport, route, variant, scene, n, direction = 'download', halfClose = 'tls-and-tcp', duration = 3000, interval = 30) => {
    const pair = [client.id, transport, route, scene, n, direction, halfClose].join('-');
    cases.push({id: pair + '-' + variant, client: client.id, transport, path: route, variant, scene, concurrency: n, direction, half_close: halfClose, duration_ms: duration, interval_ms: interval, pair_id: pair, expect: 'complete'});
  };
  for (const client of clients) for (const transport of ['tls-vision', 'reality-vision']) for (const route of ['direct', 'via-A']) {
    if (matrix === 'halfclose') for (const variant of ['before', 'after']) for (const direction of ['upload', 'download']) for (const halfClose of ['tls-only', 'tls-and-tcp']) add(client, transport, route, variant, 'halfclose', 1, direction, halfClose);
    if (matrix === 'lifecycle') add(client, transport, route, 'upgrade', 'lifecycle', 32, 'download', 'tls-only');
    if (matrix === 'stress') for (const variant of ['before', 'after']) add(client, transport, route, variant, 'soak', 128, 'download', 'tls-only', 5000, 100);
    if (matrix === 'edges') for (const variant of ['before', 'after']) for (const scene of ['idle', 'slow']) add(client, transport, route, variant, scene, 32);
    if (matrix === 'soak') add(client, transport, route, 'after', 'soak', 32, 'download', 'tls-only', 1800000, 500);
    if (matrix === 'smoke') add(client, transport, route, 'after', 'soak', 1, 'download', 'tls-only');
    if (matrix === 'network') add(client, transport, route, 'upgrade', 'lifecycle', 32, 'download', 'tls-only', 3000, 100);
  }
  if (!cases.length) throw new Error('empty/unknown matrix');
  return cases;
}

async function main() {
  const opts = {}, args = process.argv.slice(2);
  const allowed = ['root', 'harness', 'output', 'matrix', 'clients', 'parallel', 'loss', 'rate'];
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith('--') || !allowed.includes(arg.slice(2)) || !args.length || opts[arg.slice(2)] !== undefined) throw new Error('bad option: ' + arg);
    opts[arg.slice(2)] = args.shift();
  }
  for (const k of ['root', 'harness', 'output', 'matrix']) if (!opts[k]) throw new Error('missing --' + k);
  const parallel = Number(opts.parallel ?? 2);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('parallel must be 1..8');
  const root = fs.realpathSync(opts.root), harness = fs.realpathSync(opts.harness), output = path.resolve(opts.output);
  if (fs.existsSync(output)) throw new Error('fresh suite output required');
  const catalog = path.join(root, 'h11/clients/catalog.json');
  let clients = JSON.parse(fs.readFileSync(catalog, 'utf8')).clients;
  if (opts.clients) {
    const selected = opts.clients.split(',');
    if (new Set(selected).size !== selected.length || selected.some(id => !clients.some(c => c.id === id))) throw new Error('unknown/duplicate selected client');
    clients = clients.filter(c => selected.includes(c.id));
  }
  const cases = casesFor(opts.matrix, clients);
  const common = ['--catalog', catalog, '--harness', harness, '--before', path.join(root, 'h9/xray-lab-v6d'), '--after', path.join(root, 'h10/runtime-verified/xray'), '--a', path.join(root, 'h10/runtime-verified/xray')];
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
  write('plan.json', {schema_version: 11, options: opts, cases, common});
  const active = new Set(), results = [];
  let stopped = false, index = 0;
  const stop = () => { stopped = true; for (const child of active) child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  async function worker() {
    while (!stopped && index < cases.length) {
      const i = index++, c = cases[i];
      const caseArgs = [...common, '--client-id', c.client, '--variant', c.variant, '--transport', c.transport, '--path', c.path, '--scene', c.scene, '--concurrency', String(c.concurrency), '--duration-ms', String(c.duration_ms), '--interval-ms', String(c.interval_ms), '--direction', c.direction, '--half-close', c.half_close, '--expect', c.expect, '--pair-id', c.pair_id];
      const isNetwork = opts.matrix === 'network';
      const name = 'h7-h11-' + process.pid + '-' + i;
      // The experimental control socket is AF_UNIX (108-byte path limit).
      // Human-readable full identity stays in plan/progress, not the pathname.
      const dir = path.join(output, isNetwork ? name : 'c' + String(i).padStart(3, '0'));
      const command = isNetwork ? 'bash' : process.execPath;
      const argv = isNetwork ? [path.join(__dirname, 'run-netlab.sh'), root, output, name, opts.rate ?? '300', opts.loss ?? '0.1', ...caseArgs] : [path.join(__dirname, 'run.cjs'), ...caseArgs, '--output', dir];
      const fd = fs.openSync(path.join(output, i + '-runner.log'), 'wx', 0o600);
      const started = new Date().toISOString();
      process.stdout.write(JSON.stringify({event: 'started', index: i, id: c.id, at: started}) + '\n');
      const child = spawn(command, argv, {stdio: ['ignore', fd, fd]});
      active.add(child);
      let error = '';
      child.once('error', e => { error = e.message; });
      const ended = await new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
      active.delete(child); fs.closeSync(fd);
      const result = {id: c.id, index: i, output: dir, started_at: started, ended_at: new Date().toISOString(), ...ended, error};
      results.push(result); write('progress.json', {stopped, completed: results.length, planned: cases.length, results});
      process.stdout.write(JSON.stringify({event: 'finished', ...result}) + '\n');
    }
  }
  await Promise.all(Array.from({length: parallel}, worker));
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  const failures = results.filter(r => r.code !== 0 || r.signal || r.error);
  write('summary.json', {stopped, completed: results.length, planned: cases.length, runner_failures: failures.length, results});
  process.exitCode = stopped || results.length !== cases.length || failures.length ? 1 : 0;
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = {casesFor};
