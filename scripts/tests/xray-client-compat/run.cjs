#!/usr/bin/env node
'use strict';

// Own only this invocation's process group and fresh evidence directory. Docker
// invocations additionally require run-netlab.sh's ownership-checked cleanup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');

const allowed = ['catalog', 'client-id', 'harness', 'before', 'after', 'a', 'variant',
  'transport', 'path', 'scene', 'concurrency', 'duration-ms', 'interval-ms',
  'direction', 'half-close', 'expect', 'output', 'pair-id', 'container',
  'artifact-root', 'container-result', 'idle-ms', 'idle-mode', 'read-delay-ms'];
const required = ['catalog', 'client-id', 'harness', 'before', 'after', 'a', 'variant',
  'transport', 'path', 'scene', 'concurrency', 'duration-ms', 'interval-ms',
  'direction', 'half-close', 'expect', 'output', 'pair-id'];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashValue = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function parse(args) {
  const o = {};
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith('--') || !allowed.includes(key.slice(2)) || !args.length || o[key.slice(2)] !== undefined) throw new Error('unknown/duplicate/incomplete option: ' + key);
    o[key.slice(2)] = args.shift();
  }
  for (const k of required) if (!o[k]) throw new Error('required --' + k);
  o['idle-mode'] ??= 'resume';
  for (const [k, choices] of Object.entries({variant: ['before', 'after', 'upgrade'], transport: ['tls-vision', 'reality-vision'], path: ['direct', 'via-A'], scene: ['lifecycle', 'halfclose', 'idle', 'slow', 'soak'], direction: ['upload', 'download'], 'half-close': ['tls-only', 'tls-and-tcp'], 'idle-mode': ['resume', 'halfclosed'], expect: ['complete', 'known-client-timeout']})) {
    if (!choices.includes(o[k])) throw new Error('unsupported --' + k);
  }
  for (const [k, min, max] of [['concurrency', 1, 128], ['duration-ms', 1000, 1800000], ['interval-ms', 10, 500], ['idle-ms', 1200, 5000], ['read-delay-ms', 0, 1000]]) {
    if (o[k] === undefined) continue;
    if (!/^\d+$/.test(o[k]) || !Number.isSafeInteger(Number(o[k])) || Number(o[k]) < min || Number(o[k]) > max) throw new Error('invalid --' + k);
    o[k] = Number(o[k]);
  }
  if (![1, 32, 128].includes(o.concurrency)) throw new Error('unsupported concurrency');
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(o['pair-id'])) throw new Error('invalid pair ID');
  if (o.container) {
    if (!/^h7-h11-[a-z0-9-]{1,33}$/.test(o.container) || !o['artifact-root'] || !/^\/results\/[a-zA-Z0-9_-]+$/.test(o['container-result'] || '')) throw new Error('invalid isolated container options');
  } else if (o['artifact-root'] || o['container-result']) throw new Error('container required');
  return o;
}

function within(root, file) {
  const relative = path.relative(root, file);
  if (relative === '' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('path must be strictly inside controlled root: ' + file);
  return relative;
}

function sourceTemplate(params, harness) {
  const build = JSON.parse(fs.readFileSync(harness + '.build.json', 'utf8'));
  if (build.schema_version !== 11 || build.exit_code !== 0 || build.error || build.signal || digest(harness) !== build.harness_sha256) throw new Error('harness does not match successful frozen build');
  if (digest(build.source_manifest) !== build.source_manifest_sha256) throw new Error('prepared manifest changed');
  const sources = build.sources.map(entry => {
    if (digest(entry.path) !== entry.sha256) throw new Error('prepared fixture source changed');
    return {name: path.basename(entry.virtual_path), sha256: entry.sha256};
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (sources.length < 7) throw new Error('fixture source incomplete');
  return {sources, sha256: hashValue({sources, params})};
}

function assertContainer(o, output) {
  const p = spawnSync('docker', ['inspect', o.container], {encoding: 'utf8', timeout: 10000});
  if (p.error || p.status !== 0) throw new Error('cannot inspect isolated container');
  const [c] = JSON.parse(p.stdout);
  if (c.Config?.Labels?.['brocade.h7.netlab'] !== '1' || c.HostConfig?.NetworkMode !== 'none' || c.State?.Running !== true) throw new Error('refusing non-owned/non-isolated container');
  const artifact = c.Mounts.filter(m => m.Destination === '/artifacts'), results = c.Mounts.filter(m => m.Destination === '/results');
  if (artifact.length !== 1 || results.length !== 1 || artifact[0].Type !== 'bind' || results[0].Type !== 'bind' || artifact[0].RW || !results[0].RW) throw new Error('expected isolated bind mounts');
  if (fs.realpathSync(artifact[0].Source) !== fs.realpathSync(o['artifact-root']) || path.join(fs.realpathSync(results[0].Source), path.basename(o['container-result'])) !== output) throw new Error('container mounts differ from independently hashed paths');
  return c.Id;
}

async function run(o) {
  for (const k of ['catalog', 'harness', 'before', 'after', 'a']) o[k] = fs.realpathSync(o[k]);
  const catalog = JSON.parse(fs.readFileSync(o.catalog, 'utf8'));
  const matches = catalog.clients.filter(c => c.id === o['client-id']);
  if (matches.length !== 1) throw new Error('client not uniquely present in catalog');
  const client = matches[0];
  const clientBin = fs.realpathSync(client.binary);
  if (digest(clientBin) !== client.sha256) throw new Error('client differs from frozen catalog');
  const output = path.resolve(o.output);
  if (fs.existsSync(output)) throw new Error('refuse to replace previous evidence');
  if (!o.container && Buffer.byteLength(output + '/r-4294967295/b0/ctl.sock') >= 108) throw new Error('result path is too long for the AF_UNIX control socket; choose a shorter output directory');
  const params = {transport: o.transport, path: o.path, scene: o.scene, concurrency: o.concurrency, duration_ms: o['duration-ms'], frame_interval_ms: o['interval-ms'], direction: o.direction, half_close_transport: o['half-close'], idle_ms: o['idle-ms'] ?? 3000, idle_mode: o['idle-mode'], read_delay_ms: o['read-delay-ms'] ?? 100};
  const template = sourceTemplate(params, o.harness);
  const binaries = {harness: o.harness, before: o.before, after: o.after, A: o.a, client: clientBin};
  const hashes = Object.fromEntries(Object.entries(binaries).map(([key, file]) => [key, digest(file)]));
  if (hashes.before === hashes.after) throw new Error('before and after must be distinct frozen builds');
  const old = o.variant === 'after' ? o.after : o.before;
  const next = o.variant === 'before' ? o.before : o.after;
  const manifest = {schema_version: 11, pair_id: o['pair-id'], server_variant: o.variant, ...params,
    client: {...client, source: JSON.stringify(client.source)},
    binary_sha256: {b0: digest(old), b1: digest(next), b2: digest(next), A: hashes.A, client: hashes.client},
    server_before_sha256: hashes.before, server_after_sha256: hashes.after, harness_sha256: hashes.harness,
    config_template_sha256: template.sha256, template_sources: template.sources,
    catalog_sha256: digest(o.catalog), expect: o.expect, configs: [],
    network: o.container ? {kind: 'isolated-container-netns', container: o.container} : {kind: 'local-loopback'},
    runner_started_at: new Date().toISOString(), runner_sha256: digest(__filename), binaries};
  const mapped = file => o.container ? '/artifacts/' + within(fs.realpathSync(o['artifact-root']), file) : file;
  let containerId;
  if (o.container) { containerId = assertContainer(o, output); for (const file of Object.values(binaries)) mapped(file); }
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  const save = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  save('manifest.json', manifest);
  const env = {XRAY_H9_RUN: '1', H11_RUN: '1', H11_CLIENT_KIND: client.family, H11_CLIENT_BIN: mapped(clientBin), H11_A_BIN: mapped(o.a), H11_OLD_BIN: mapped(old), H11_NEW_BIN: mapped(next), H11_TRANSPORT: o.transport, H11_PATH: o.path, H11_SCENE: o.scene, H11_CONCURRENCY: String(o.concurrency), H11_DURATION_MS: String(o['duration-ms']), H11_FRAME_INTERVAL_MS: String(o['interval-ms']), H11_RESULT_DIR: o.container ? o['container-result'] : output, H11_DIRECTION: o.direction, H11_HALF_CLOSE: o['half-close'], H11_IDLE_MS: String(params.idle_ms), H11_IDLE_MODE: params.idle_mode, H11_READ_DELAY_MS: String(params.read_delay_ms), H7_NETNS: o.container ? '1' : '', H9_NEGATIVE: '', H9_BOUNDARY: ''};
  const testName = 'TestH11ClientCompatibility';
  const timeoutSeconds = Math.ceil(o['duration-ms'] / 1000) + 180;
  const testArgs = ['-test.run', '^' + testName + '$', '-test.v', '-test.count=1', '-test.timeout=' + timeoutSeconds + 's'];
  const cmd = o.container ? 'docker' : o.harness;
  const argv = o.container ? ['exec', ...Object.entries(env).flatMap(([k, v]) => ['--env', k + '=' + v]), o.container, 'ip', 'netns', 'exec', 'h7-client', mapped(o.harness), ...testArgs] : testArgs;
  const fd = fs.openSync(path.join(output, 'test.log'), 'wx', 0o600);
  const child = spawn(cmd, argv, {detached: true, stdio: ['ignore', fd, fd], env: {...process.env, ...env}});
  let interrupted = '', spawnError = '';
  let stopResources = () => {};
  if (child.pid && !o.container) {
    try { stopResources = require('./resources.cjs').monitor(child.pid, output, timeoutSeconds + 12); }
    catch (error) { save('resources-unavailable.json', {error: error.message}); }
  }
  const stop = reason => {
    interrupted = reason;
    if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') spawnError = error.message; }
  };
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const timer = setTimeout(() => stop('owned runner deadline'), (timeoutSeconds + 10) * 1000);
  const exit = await new Promise(resolve => {
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(timer); stopResources(); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); fs.closeSync(fd);
  if (o.container && !spawnError) {
    try {
      if (assertContainer(o, output) !== containerId) throw new Error('container identity changed');
      const ownership = spawnSync('docker', ['exec', o.container, 'chown', '-R', process.getuid() + ':' + process.getgid(), o['container-result']], {encoding: 'utf8', timeout: 15000});
      if (ownership.error || ownership.status !== 0) throw new Error('could not restore ownership of exact owned result directory');
    } catch (error) { spawnError = error.message; }
  }
  fs.writeFileSync(path.join(output, 'exit-code.txt'), String(exit.code ?? -1) + '\n');
  let verification, verificationError = '', resultPath;
  try {
    if (spawnError || interrupted || exit.signal) throw new Error(spawnError || interrupted || 'harness signal: ' + exit.signal);
    const dirs = fs.readdirSync(output, {withFileTypes: true}).filter(e => e.isDirectory() && e.name.startsWith('r-'));
    if (dirs.length !== 1) throw new Error('exactly one run directory required');
    resultPath = path.join(output, dirs[0].name, 'result.json');
    const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (raw.run_id !== dirs[0].name) throw new Error('raw run identity mismatch');
    for (const [key, file] of Object.entries(binaries)) if (digest(file) !== hashes[key]) throw new Error('binary changed during run: ' + key);
    if (sourceTemplate(params, o.harness).sha256 !== template.sha256) throw new Error('fixture source changed during run');
    if (!Array.isArray(raw.configs) || !raw.configs.length) throw new Error('missing actual configuration files');
    manifest.configs = raw.configs.map(c => {
      const actual = o.container ? path.join(output, within(o['container-result'], c.path)) : c.path;
      within(output, fs.realpathSync(actual));
      return {role: c.role, path: c.path, sha256: digest(actual)};
    });
    manifest.runner_ended_at = new Date().toISOString();
    save('manifest.json', manifest);
    const logs = fs.readFileSync(path.join(output, 'test.log'), 'utf8');
    if (!logs.includes('=== RUN   ' + testName) || !new RegExp('--- (PASS|FAIL): ' + testName + '\\b').test(logs)) throw new Error('target test did not complete');
    verification = require('./verify.cjs').verify(raw, manifest, {exitCode: exit.code});
    save('verified.json', verification);
  } catch (error) { verificationError = error.stack || error.message; }
  const result = {output, result_path: resultPath, harness_exit_code: exit.code, signal: exit.signal, interrupted, spawn_error: spawnError, verification_error: verificationError, verification};
  save('runner-result.json', result);
  process.stdout.write(JSON.stringify(result) + '\n');
  return verificationError ? 1 : 0;
}

if (require.main === module) run(parse(process.argv.slice(2))).then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = {parse, within, sourceTemplate, run};
