'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {parse, within, sourceTemplate} = require('./run.cjs');

const runner = path.join(__dirname, 'run.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const defaults = {catalog: '/catalog.json', 'client-id': 'test-client', harness: '/harness', before: '/before', after: '/after', a: '/a', variant: 'after', transport: 'tls-vision', path: 'direct', scene: 'soak', concurrency: '1', 'duration-ms': '1000', 'interval-ms': '30', direction: 'download', 'half-close': 'tls-and-tcp', expect: 'complete', output: '/new-output', 'pair-id': 'case-1'};
const argsFor = changes => Object.entries({...defaults, ...changes}).flatMap(([k, v]) => ['--' + k, String(v)]);

test('explicit bounded runner options parse without changing identity', () => {
  const o = parse(argsFor());
  assert.equal(o.concurrency, 1);
  assert.equal(o['duration-ms'], 1000);
  assert.equal(o['client-id'], 'test-client');
});
for (const [key, value] of [['concurrency', '0'], ['concurrency', '2'], ['concurrency', '129'], ['duration-ms', '999'], ['duration-ms', '1800001'], ['interval-ms', '9'], ['interval-ms', '501'], ['idle-ms', '-1'], ['read-delay-ms', '1001'], ['variant', 'latest'], ['expect', 'ignore-failure'], ['pair-id', '../escape']]) {
  test(`reject invalid ${key}=${value}`, () => assert.throws(() => parse(argsFor({[key]: value}))));
}
test('duplicate, unknown and missing arguments are refused', () => {
  assert.throws(() => parse([...argsFor(), '--scene', 'idle']));
  assert.throws(() => parse([...argsFor(), '--ignore', 'true']));
  assert.throws(() => parse(argsFor().slice(2)));
});
test('container options require a bounded owned name and exact child result directory', () => {
  parse(argsFor({container: 'h7-h11-test-1', 'artifact-root': '/artifacts', 'container-result': '/results/run'}));
  for (const options of [ {'artifact-root': '/artifacts'}, {container: 'foreign', 'artifact-root': '/artifacts', 'container-result': '/results/run'}, {container: 'h7-h11-test', 'artifact-root': '/artifacts', 'container-result': '/results'}, {container: 'h7-h11-test', 'artifact-root': '/artifacts', 'container-result': '/results/../escape'}]) assert.throws(() => parse(argsFor(options)));
});
test('path confinement excludes root itself, siblings and normalized escapes', () => {
  assert.equal(within('/owned', '/owned/a/config'), 'a/config');
  for (const p of ['/owned', '/owned/..', '/owned-other/a', '/owned/a/../../outside']) assert.throws(() => within('/owned', p));
});

function fixture(t, body = "console.log('testing: warning: no tests to run');") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h11-run-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const put = (name, value, mode = 0o600) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, value, {mode});
    return file;
  };
  const harness = put('harness', '#!' + process.execPath + '\n' + body + '\n', 0o700);
  const sources = Array.from({length: 7}, (_, i) => {
    const file = put('fixture-' + i + '.go', 'package fixture\n// ' + i + '\n');
    return {virtual_path: path.join(root, 'source', 'fixture-' + i + '.go'), path: file, sha256: sha(fs.readFileSync(file))};
  });
  const sourceManifest = put('source-manifest.json', JSON.stringify({schema_version: 11, source_root: root, files: sources}));
  const build = {schema_version: 11, exit_code: 0, error: '', signal: null, harness_sha256: sha(fs.readFileSync(harness)), source_manifest: sourceManifest, source_manifest_sha256: sha(fs.readFileSync(sourceManifest)), sources};
  const buildPath = harness + '.build.json';
  fs.writeFileSync(buildPath, JSON.stringify(build));
  const client = put('client', 'not executed by the fake harness');
  const catalog = put('catalog.json', JSON.stringify({schema_version: 1, clients: [{id: 'test-client', family: 'xray', version: 'test', binary: client, sha256: sha(fs.readFileSync(client)), source: {kind: 'unit-test'}}]}));
  const before = put('before', 'before'), after = put('after', 'after');
  const output = path.join(root, 'output');
  return {root, put, harness, build, buildPath, sources, sourceManifest, output, options: {catalog, harness, before, after, a: before, output}};
}

test('frozen successful build binds parameter digest, harness and prepared files', t => {
  const f = fixture(t), first = sourceTemplate({scene: 'soak'}, f.harness);
  assert.equal(first.sources.length, 7);
  assert.equal(sourceTemplate({scene: 'soak'}, f.harness).sha256, first.sha256);
  assert.notEqual(sourceTemplate({scene: 'idle'}, f.harness).sha256, first.sha256);
});
for (const [name, mutate] of [
  ['failed build', f => { f.build.exit_code = 1; }],
  ['signaled build', f => { f.build.signal = 'SIGTERM'; }],
  ['build error', f => { f.build.error = 'spawn failed'; }],
  ['wrong schema', f => { f.build.schema_version = 9; }],
  ['different executable', f => { fs.appendFileSync(f.harness, '// changed'); }],
  ['changed source manifest', f => { fs.appendFileSync(f.sourceManifest, ' '); }],
  ['changed prepared source', f => { fs.appendFileSync(f.sources[0].path, '// changed'); }],
  ['incomplete fixture', f => { f.build.sources.pop(); }],
]) test('reject ' + name, t => {
  const f = fixture(t);
  mutate(f);
  fs.writeFileSync(f.buildPath, JSON.stringify(f.build));
  assert.throws(() => sourceTemplate({}, f.harness));
});

function invoke(f, extraEnv = {}) {
  const env = {...process.env, ...extraEnv};
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...argsFor(f.options)], {encoding: 'utf8', timeout: 10000, env});
}
test('exit zero with zero selected tests is not a pass', t => {
  const f = fixture(t), p = invoke(f);
  assert.ifError(p.error);
  assert.equal(p.status, 1, p.stderr);
  const r = JSON.parse(fs.readFileSync(path.join(f.output, 'runner-result.json')));
  assert.equal(r.harness_exit_code, 0);
  assert.match(r.verification_error, /exactly one run directory/);
  assert.equal(fs.existsSync(path.join(f.output, 'verified.json')), false);
});
test('planted result and exit zero cannot substitute for completed target test', t => {
  const f = fixture(t, `const fs=require('node:fs'),path=require('node:path');
const dir=path.join(process.env.H11_RESULT_DIR,'r-fake');fs.mkdirSync(dir);
const config=path.join(dir,'config.json');fs.writeFileSync(config,'{}');
fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({run_id:'r-fake',configs:[{role:'b0',path:config}]}));
console.log('PASS');`);
  const p = invoke(f);
  assert.ifError(p.error);
  assert.equal(p.status, 1, p.stderr);
  assert.match(JSON.parse(fs.readFileSync(path.join(f.output, 'runner-result.json'))).verification_error, /target test did not complete/);
});
test('existing evidence is untouched and prevents execution', t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  fs.writeFileSync(path.join(f.output, 'sentinel'), 'preserve');
  const p = invoke(f);
  assert.ifError(p.error);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /refuse to replace previous evidence/);
  assert.deepEqual(fs.readdirSync(f.output), ['sentinel']);
});
test('inherited idle mode cannot silently change the requested scenario', t => {
  const f = fixture(t, `require('node:fs').writeFileSync(require('node:path').join(process.env.H11_RESULT_DIR,'idle-mode.txt'),process.env.H11_IDLE_MODE);`);
  const p = invoke(f, {H11_IDLE_MODE: 'halfclosed'});
  assert.ifError(p.error);
  assert.equal(fs.readFileSync(path.join(f.output, 'idle-mode.txt'), 'utf8'), 'resume');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json'))).idle_mode, 'resume');
});
test('owned deadline fails closed and terminates a stalled harness', t => {
  const f = fixture(t, `require('node:fs').writeFileSync(require('node:path').join(process.env.H11_RESULT_DIR,'pid.txt'),String(process.pid));setInterval(()=>{},1000);`);
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  // Accelerate only the runner's watchdog; the actual owned-group kill and
  // post-run failure path remain unchanged. No multi-minute CI sleep is needed.
  const code = `const set=global.setTimeout;global.setTimeout=(fn,ms,...a)=>set(fn,ms===191000?250:ms,...a);const r=require(${JSON.stringify(runner)});r.run(r.parse(process.argv.slice(1))).then(c=>process.exitCode=c);`;
  const p = spawnSync(process.execPath, ['-e', code, '--', ...argsFor(f.options)], {encoding: 'utf8', timeout: 10000, env});
  assert.ifError(p.error);
  assert.equal(p.status, 1, p.stderr);
  const r = JSON.parse(fs.readFileSync(path.join(f.output, 'runner-result.json')));
  assert.equal(r.interrupted, 'owned runner deadline');
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(alive(Number(fs.readFileSync(path.join(f.output, 'pid.txt'), 'utf8'))), false);
});

async function eventually(check, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(label);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    // A killed orphan can await init reaping briefly; it cannot execute work.
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'));
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}
test('SIGTERM rejects the run and terminates the owned harness process group', {timeout: 15000}, async t => {
  const f = fixture(t, `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(path.join(process.env.H11_RESULT_DIR,'pids.json'),JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`);
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, ...argsFor(f.options)], {stdio: 'ignore', env});
  let ended = false, spawnedError;
  const closed = new Promise(resolve => { child.once('error', e => { spawnedError = e; }); child.once('close', (code, signal) => { ended = true; resolve({code, signal}); }); });
  let owned = [];
  t.after(() => {
    if (!ended) child.kill('SIGKILL');
    for (const pid of owned) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  await eventually(() => fs.existsSync(path.join(f.output, 'pids.json')) || spawnedError, 'harness did not start');
  assert.ifError(spawnedError);
  owned = JSON.parse(fs.readFileSync(path.join(f.output, 'pids.json')));
  assert(owned.every(alive));
  child.kill('SIGTERM');
  await eventually(() => ended, 'runner did not finish after SIGTERM');
  assert.deepEqual(await closed, {code: 1, signal: null});
  await eventually(() => owned.every(pid => !alive(pid)), 'owned descendants remain alive');
  const r = JSON.parse(fs.readFileSync(path.join(f.output, 'runner-result.json')));
  assert.equal(r.interrupted, 'SIGTERM');
  assert.equal(r.signal, 'SIGKILL');
  assert.match(r.verification_error, /SIGTERM/);
});
test('suite SIGTERM stops the active local runner and does not launch remaining cases', {timeout: 15000}, async t => {
  const f = fixture(t, `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.H11_RESULT_DIR,'pid.txt'),String(process.pid));setInterval(()=>{},1000);`);
  for (const directory of ['h11/clients', 'h9', 'h10/runtime-verified']) fs.mkdirSync(path.join(f.root, directory), {recursive: true});
  fs.copyFileSync(f.options.catalog, path.join(f.root, 'h11/clients/catalog.json'));
  fs.copyFileSync(f.options.before, path.join(f.root, 'h9/xray-lab-v6d'));
  fs.copyFileSync(f.options.after, path.join(f.root, 'h10/runtime-verified/xray'));
  const suite = f.put('suite.cjs', fs.readFileSync(path.join(__dirname, 'suite.cjs')));
  fs.symlinkSync(runner, path.join(f.root, 'run.cjs'));
  const output = path.join(f.root, 'suite-output');
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [suite, '--root', f.root, '--harness', f.harness, '--output', output, '--matrix', 'smoke', '--parallel', '1'], {stdio: 'ignore', env});
  let ended = false, spawnedError, owned;
  const closed = new Promise(resolve => { child.once('error', e => { spawnedError = e; }); child.once('close', (code, signal) => { ended = true; resolve({code, signal}); }); });
  t.after(() => { if (!ended) child.kill('SIGKILL'); if (owned && alive(owned)) process.kill(owned, 'SIGKILL'); });
  let pidPath;
  await eventually(() => {
    if (spawnedError) return true;
    if (!fs.existsSync(output)) return false;
    for (const e of fs.readdirSync(output, {withFileTypes: true})) if (e.isDirectory()) {
      const candidate = path.join(output, e.name, 'pid.txt');
      if (fs.existsSync(candidate)) { pidPath = candidate; return true; }
    }
    return false;
  }, 'suite did not start first harness');
  assert.ifError(spawnedError);
  owned = Number(fs.readFileSync(pidPath, 'utf8'));
  child.kill('SIGTERM');
  await eventually(() => ended, 'suite did not terminate');
  assert.deepEqual(await closed, {code: 1, signal: null});
  await eventually(() => !alive(owned), 'suite left active harness alive');
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json')));
  assert.equal(summary.stopped, true);
  assert.equal(summary.completed, 1);
  assert.equal(summary.planned, 4);
  assert.equal(summary.runner_failures, 1);
});
