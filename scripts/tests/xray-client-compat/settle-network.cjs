#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {LINKS} = require('./network.cjs');

const PROBE_SHA256 = '0550f39333992123ace2e277accd8469e32e5f15983ea08741013f0a2232a7ec';
const BUDGET_MS = 10000;
const integer = (n, label) => assert(Number.isSafeInteger(n) && n >= 0, label + ': nonnegative safe integer required');

function counterState(snapshot) {
  assert.deepEqual(Object.keys(snapshot.roles ?? {}).sort(), ['access', 'client', 'forward', 'origin'], 'four namespace snapshots required');
  const roles = {}, namespaces = new Set();
  let drained = true;
  for (const role of Object.keys(snapshot.roles).sort()) {
    const value = snapshot.roles[role];
    assert(/^net:\[\d+\]$/.test(value.netns) && !namespaces.has(value.netns), 'distinct namespace identities required');
    namespaces.add(value.netns);
    assert(Array.isArray(value.links) && value.links.length > 0, 'interface snapshots required');
    const links = {};
    for (const link of [...value.links].sort((a, b) => a.ifname.localeCompare(b.ifname))) {
      assert(typeof link.ifname === 'string' && !links[link.ifname], 'unique interface names required');
      integer(link.ifindex, 'interface index');
      const counters = link.stats64 ?? link.stats;
      assert(counters && typeof counters === 'object', 'all interface counters required');
      const normalized = {};
      for (const direction of ['rx', 'tx']) {
        assert(counters[direction] && typeof counters[direction] === 'object', 'rx/tx counters required');
        for (const key of ['bytes', 'packets', 'errors', 'dropped']) integer(counters[direction][key], key);
        normalized[direction] = Object.fromEntries(Object.entries(counters[direction]).sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => { integer(n, key); return [key, n]; }));
      }
      links[link.ifname] = {ifindex: link.ifindex, counters: normalized};
    }
    assert(Array.isArray(value.qdiscs) && value.qdiscs.length > 0, 'queue snapshots required');
    const queues = value.qdiscs.map(q => {
      assert(links[q.dev], 'qdisc must belong to a sampled interface');
      integer(q.backlog, 'qdisc backlog'); integer(q.qlen, 'qdisc qlen');
      if (q.backlog !== 0 || q.qlen !== 0) drained = false;
      const counters = Object.fromEntries(['bytes', 'packets', 'drops', 'overlimits', 'requeues', 'backlog', 'qlen'].map(key => { integer(q[key], 'qdisc ' + key); return [key, q[key]]; }));
      return {dev: q.dev, kind: q.kind, handle: q.handle, parent: q.parent ?? null, options: q.options, counters};
    }).sort((a, b) => JSON.stringify([a.dev, a.kind, a.handle]).localeCompare(JSON.stringify([b.dev, b.kind, b.handle])));
    roles[role] = {netns: value.netns, links, queues};
  }
  let conserved = true;
  for (const [left, right] of LINKS) {
    const [lr, li] = left.split('/'), [rr, ri] = right.split('/');
    const a = roles[lr].links[li]?.counters, b = roles[rr].links[ri]?.counters;
    assert(a && b, 'all six veth endpoints required');
    for (const key of ['bytes', 'packets']) if (a.tx[key] !== b.rx[key] || b.tx[key] !== a.rx[key]) conserved = false;
  }
  return {fingerprint: JSON.stringify(roles), drained, conserved};
}

// The clock/capture/write interfaces make the bounded polling contract testable
// without Docker, sleeps or mutation of an actual network namespace.
async function settle({capture, save, now, sleep, deadline}) {
  let previous, attempts = 0;
  while (now() < deadline) {
    const snapshot = await capture(deadline - now());
    attempts++;
    let state;
    try { state = counterState(snapshot); }
    catch (error) { save(attempts, snapshot, {readback_error: error.message}); throw error; }
    save(attempts, snapshot, {drained: state.drained, conserved: state.conserved});
    if (now() >= deadline) break;
    if (previous && previous.drained && state.drained && previous.conserved && state.conserved && state.fingerprint === previous.fingerprint) return {snapshot, attempts};
    previous = state;
    await sleep(Math.min(200, Math.max(0, deadline - now())));
  }
  throw new Error('network counters did not settle within the bounded 10-second observation window');
}

async function main(args) {
  assert.equal(args.length, 2, 'usage: settle-network.cjs OWNED_CONTAINER FRESH_ATTEMPTS_DIRECTORY');
  const [name, directoryArg] = args;
  assert(/^h7-h11-[a-z0-9-]{1,33}$/.test(name), 'exact H11 container name required');
  const directory = path.resolve(directoryArg);
  assert(!fs.existsSync(directory), 'fresh attempts directory required');
  fs.mkdirSync(directory, {mode: 0o700});
  const start = process.hrtime.bigint();
  const now = () => Number(process.hrtime.bigint() - start) / 1e6;
  const command = argv => {
    const remaining = Math.floor(BUDGET_MS - now());
    assert(remaining > 0, 'network observation deadline expired');
    const p = spawnSync('docker', argv, {encoding: 'utf8', timeout: remaining, maxBuffer: 16 * 1024 * 1024});
    if (p.error || p.status !== 0 || p.signal) throw new Error('read-only Docker observation failed: ' + (p.error?.message || p.stderr || p.signal));
    return p.stdout;
  };
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  try {
    const containers = JSON.parse(command(['inspect', name]));
    assert.equal(containers.length, 1, 'one exact container required');
    const container = containers[0];
    assert.equal(container.Name, '/' + name, 'container name differs');
    assert(/^[a-f0-9]{64}$/.test(container.Id), 'full immutable container ID required');
    assert.equal(container.Config?.Labels?.['brocade.h7.netlab'], '1', 'refuse foreign container');
    assert.equal(container.HostConfig?.NetworkMode, 'none', 'refuse non-isolated container');
    assert.equal(container.State?.Running, true, 'owned container is not running');
    const probeRoot = fs.realpathSync(path.join(__dirname, '../xray-handoff/netlab'));
    const mounts = container.Mounts.filter(m => m.Destination === '/netlab');
    assert.equal(mounts.length, 1, 'single frozen probe bind mount required');
    assert.equal(mounts[0].Type, 'bind'); assert.equal(mounts[0].RW, false);
    assert.equal(fs.realpathSync(mounts[0].Source), probeRoot, 'unexpected probe source mount');
    const probe = fs.readFileSync(path.join(probeRoot, 'probe.py'));
    assert.equal(crypto.createHash('sha256').update(probe).digest('hex'), PROBE_SHA256, 'frozen probe changed');
    assert.equal(command(['exec', container.Id, 'sha256sum', '/netlab/probe.py']).trim().split(/\s+/)[0], PROBE_SHA256, 'actual container probe differs');
    write('identity.json', {container: name, container_id: container.Id, probe_sha256: PROBE_SHA256, deadline_ms: BUDGET_MS});
    let captures = 0;
    const result = await settle({
      now, deadline: BUDGET_MS, sleep: delay,
      capture: async () => {
        const raw = command(['exec', container.Id, 'python3', '/netlab/probe.py', 'snapshot']);
        fs.writeFileSync(path.join(directory, 'probe-' + String(++captures).padStart(3, '0') + '.stdout.txt'), raw, {mode: 0o600, flag: 'wx'});
        return JSON.parse(raw);
      },
      save: (attempt, snapshot, status) => { write('snapshot-' + String(attempt).padStart(3, '0') + '.json', snapshot); write('observation-' + String(attempt).padStart(3, '0') + '.json', {...status, elapsed_ms: now()}); },
    });
    write('settled.json', {attempts: result.attempts, elapsed_ms: now(), stable_snapshots: 2, qdisc_backlog_and_qlen_zero: true, absolute_veth_wire_conservation: true});
    process.stdout.write(JSON.stringify(result.snapshot, null, 2) + '\n');
  } catch (error) {
    write('failure.json', {error: error.message, elapsed_ms: now()});
    throw error;
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = {counterState, settle, PROBE_SHA256};
