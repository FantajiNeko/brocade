#!/usr/bin/env node
'use strict';

// Read-only validation of kernel snapshots, separate from payload correctness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LINKS = [['client/c0', 'forward/f0'], ['forward/f1', 'access/a0'], ['access/a1', 'origin/o0']];
const DELAY_SECONDS = {'client/c0': 0.004, 'forward/f0': 0.004, 'forward/f1': 0.0065, 'access/a0': 0.0065, 'access/a1': 0.002, 'origin/o0': 0.002};
const LOSS_EGRESSES = ['client/c0', 'origin/o0'];
const QDISC_COUNTERS = ['bytes', 'packets', 'drops', 'overlimits', 'requeues'];
const LINK_COUNTERS = ['bytes', 'packets', 'errors', 'dropped'];
function object(v, label) { assert(v && typeof v === 'object' && !Array.isArray(v), label + ': object required'); return v; }
function integer(v, label) { assert(Number.isSafeInteger(v) && v >= 0, label + ': nonnegative safe integer required'); return v; }
function finite(v, label) { assert(typeof v === 'number' && Number.isFinite(v), label + ': finite number required'); return v; }
function onlyKeys(v, keys, label) { object(v, label); assert(Object.keys(v).every(k => keys.includes(k)), label + ': unexpected settings'); }
function unique(list, predicate, label) { assert(Array.isArray(list), label + ': array required'); const hits = list.filter(predicate); assert.equal(hits.length, 1, label + ': exact single entry required'); return hits[0]; }
function delta(old, current, label) { integer(old, label); integer(current, label); assert(current >= old, label + ': counter reset/decrease'); return current - old; }

function validateRequest(requested) {
  object(requested, 'requested profile');
  assert([100, 300].includes(requested.rate_mbps), 'only 100/300 Mbps profiles supported');
  assert.equal(requested.rtt_ms, 25, 'only the explicit 25 ms profile is supported');
  assert([0, 0.1].includes(requested.loss_percent_per_selected_egress), 'loss must be 0 or 0.1 percent');
  assert.deepEqual(requested.loss_egresses, LOSS_EGRESSES, 'loss egress identity differs');
  return requested;
}

function validateSnapshot(state, requested) {
  validateRequest(requested);
  integer(state.monotonic_ns, 'snapshot monotonic timestamp');
  assert.equal(state.profile?.rate_mbps, requested.rate_mbps, 'saved profile rate differs');
  assert.equal(state.profile?.rtt_ms, requested.rtt_ms, 'saved profile delay differs');
  assert.deepEqual(state.allowed_cpus, [2, 4, 6, 8], 'actual allowed CPU set differs');
  assert.equal(state.cgroup?.['cpuset.cpus.effective'], '2,4,6,8', 'actual cgroup cpuset differs');
  assert.equal(state.cgroup?.['memory.max'], '2147483648', 'actual memory limit differs');
  assert.deepEqual(Object.keys(object(state.roles, 'roles')).sort(), ['access', 'client', 'forward', 'origin']);
  const namespaces = new Set();
  for (const [role, value] of Object.entries(state.roles)) {
    assert(/^net:\[\d+\]$/.test(value.netns), role + ': network namespace identity required');
    assert(!namespaces.has(value.netns), 'roles must use distinct network namespaces');
    namespaces.add(value.netns);
    const interfaces = Object.keys(DELAY_SECONDS).filter(id => id.startsWith(role + '/')).map(id => id.split('/')[1]);
    assert.deepEqual(value.links.filter(l => l.ifname !== 'lo').map(l => l.ifname).sort(), interfaces.sort(), role + ': unexpected/missing interface');
    assert(value.qdiscs.every(q => q.dev === 'lo' || interfaces.includes(q.dev)), role + ': unexpected qdisc interface');
  }
  const endpoints = {};
  for (const [id, delaySeconds] of Object.entries(DELAY_SECONDS)) {
    const [role, iface] = id.split('/'), value = state.roles[role];
    const link = unique(value.links, l => l.ifname === iface, id + ' link');
    integer(link.ifindex, id + ' ifindex'); assert(link.ifindex > 0);
    assert.equal(link.operstate, 'UP', id + ': link is not up');
    assert.equal(link.mtu, 1500, id + ': MTU differs');
    const stats = object(link.stats64 ?? link.stats, id + ' interface counters');
    for (const direction of ['rx', 'tx']) for (const key of LINK_COUNTERS) integer(stats[direction]?.[key], id + '/' + direction + '/' + key);
    const qdiscs = value.qdiscs.filter(q => q.dev === iface);
    assert.equal(qdiscs.length, 2, id + ': expected only TBF and netem');
    const tbf = unique(qdiscs, q => q.kind === 'tbf', id + ' TBF'), netem = unique(qdiscs, q => q.kind === 'netem', id + ' netem');
    assert.equal(tbf.root, true, id + ': TBF must be root');
    assert.equal(tbf.handle, '1:', id + ': wrong TBF handle');
    assert.equal(netem.handle, '10:', id + ': wrong netem handle');
    assert.equal(netem.parent, '1:1', id + ': netem must be below TBF');
    assert.equal(tbf.options?.rate, requested.rate_mbps * 1000000 / 8, id + ': actual kernel rate differs');
    const options = netem.options;
    onlyKeys(options, ['limit', 'delay', 'loss-random', 'ecn', 'gap'], id + ' netem');
    assert.equal(options.limit, 8192, id + ': queue limit differs');
    onlyKeys(options.delay, ['delay', 'jitter', 'correlation'], id + ' delay');
    // tc JSON uses seconds; tolerate less than one microsecond of kernel rounding.
    assert(Math.abs(finite(options.delay.delay, id + ' delay') - delaySeconds) <= 0.000001, id + ': actual kernel delay differs');
    assert.equal(options.delay.jitter, 0, id + ': unexpected jitter');
    assert.equal(options.delay.correlation, 0, id + ': unexpected delay correlation');
    assert.equal(options.ecn, false, id + ': ECN changes drop semantics');
    assert.equal(options.gap, 0, id + ': unexpected reordering gap');
    // iproute2 tc/q_netem.c prints probabilities, not percentage points:
    // loss 0.1% is {"loss-random":{"loss":0.001,"correlation":0}}.
    const expectedLoss = LOSS_EGRESSES.includes(id) ? requested.loss_percent_per_selected_egress / 100 : 0;
    let actualLoss = 0;
    if (options['loss-random'] !== undefined) {
      onlyKeys(options['loss-random'], ['loss', 'correlation'], id + ' random loss');
      actualLoss = finite(options['loss-random'].loss, id + ' loss probability');
      assert.equal(options['loss-random'].correlation, 0, id + ': unexpected loss correlation');
    }
    assert(Math.abs(actualLoss - expectedLoss) <= 1e-9, id + ': actual kernel loss differs');
    const features = value.offloads?.[iface];
    assert.equal(typeof features, 'string', id + ': offload readback missing');
    for (const feature of ['tcp-segmentation-offload', 'generic-segmentation-offload', 'generic-receive-offload']) {
      const entries = features.split('\n').map(s => s.trim()).filter(s => s.startsWith(feature + ':'));
      assert.equal(entries.length, 1, id + ': duplicate/missing ' + feature);
      assert(new RegExp('^' + feature + ': off(?: \\[fixed\\])?$').test(entries[0]), id + ': offload is not disabled: ' + feature);
    }
    for (const q of [tbf, netem]) for (const key of [...QDISC_COUNTERS, 'backlog', 'qlen']) integer(q[key], id + '/' + q.kind + '/' + key);
    endpoints[id] = {netns: value.netns, ifindex: link.ifindex, stats, tbf, netem, delay_seconds: options.delay.delay, loss_probability: actualLoss};
  }
  return endpoints;
}

function summarize(before, after, requested) {
  const old = validateSnapshot(before, requested), current = validateSnapshot(after, requested);
  assert(after.monotonic_ns > before.monotonic_ns, 'snapshot interval must be positive');
  assert.equal(after.kernel, before.kernel, 'kernel identity changed');
  const endpoints = {};
  for (const id of Object.keys(DELAY_SECONDS)) {
    const a = old[id], b = current[id];
    assert.equal(b.netns, a.netns, id + ': namespace changed');
    assert.equal(b.ifindex, a.ifindex, id + ': interface replaced');
    const interfaces = {}, qdiscs = {};
    for (const direction of ['rx', 'tx']) {
      interfaces[direction] = Object.fromEntries(LINK_COUNTERS.map(key => [key, delta(a.stats[direction][key], b.stats[direction][key], id + '/' + direction + '/' + key)]));
      assert.equal(interfaces[direction].errors, 0, id + ': interface error during measurement');
      assert.equal(interfaces[direction].dropped, 0, id + ': unexpected interface drop (separate from netem drops)');
    }
    for (const kind of ['tbf', 'netem']) {
      qdiscs[kind] = {deltas: Object.fromEntries(QDISC_COUNTERS.map(key => [key, delta(a[kind][key], b[kind][key], id + '/' + kind + '/' + key)])), before_backlog_bytes: a[kind].backlog, after_backlog_bytes: b[kind].backlog, before_qlen: a[kind].qlen, after_qlen: b[kind].qlen};
      if (b.loss_probability === 0) assert.equal(qdiscs[kind].deltas.drops, 0, id + ': unexpected qdisc drops without configured loss');
    }
    endpoints[id] = {rate_mbps: requested.rate_mbps, delay_ms: b.delay_seconds * 1000, loss_percent: b.loss_probability * 100, interface_deltas: interfaces, qdisc_counters: qdiscs};
  }
  for (const [left, right] of LINKS) for (const key of ['bytes', 'packets']) {
    assert.equal(endpoints[left].interface_deltas.tx[key], endpoints[right].interface_deltas.rx[key], left + '/' + right + ': veth wire counter conservation differs');
    assert.equal(endpoints[right].interface_deltas.tx[key], endpoints[left].interface_deltas.rx[key], right + '/' + left + ': veth wire counter conservation differs');
  }
  const observed = LOSS_EGRESSES.filter(id => endpoints[id].qdisc_counters.netem.deltas.drops > 0);
  return {schema_version: 11, profile_verified: true, requested_profile: requested, interval_seconds: (after.monotonic_ns - before.monotonic_ns) / 1e9,
    actual_cpuset: after.allowed_cpus, memory_limit_bytes: Number(after.cgroup['memory.max']), endpoints,
    wire_packet_and_byte_conservation: true, interface_errors_and_drops_zero: true,
    netem_drop_observed_egresses: observed, configured_loss_observed_on_both_egresses: requested.loss_percent_per_selected_egress > 0 && observed.length === 2,
    drop_note: 'TBF and child netem drops are separate overlapping counters, not summed. Netem counters do not distinguish configured random loss from queue overflow. Zero observed random drops is possible in a short interval.',
    scope: 'Actual kernel profile readback before/after, shared host kernel and four-CPU cpuset. Wire bytes include protocol overhead/retransmits and are not payload/accounting totals. No throughput or VM equivalence claim.'};
}

function readEvidence(file) {
  assert(fs.statSync(file).size <= 16 * 1024 * 1024, 'oversized snapshot');
  const bytes = fs.readFileSync(file);
  return {value: JSON.parse(bytes), sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
}
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 3, 'usage: network.cjs LAB_DIRECTORY');
    const directory = fs.realpathSync(process.argv[2]);
    const files = Object.fromEntries(['before.json', 'after.json', 'requested-profile.json'].map(name => [name, readEvidence(path.join(directory, name))]));
    const result = summarize(files['before.json'].value, files['after.json'].value, files['requested-profile.json'].value);
    result.input_sha256 = Object.fromEntries(Object.entries(files).map(([name, evidence]) => [name, evidence.sha256]));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = {summarize, validateSnapshot, validateRequest, LINKS, LOSS_EGRESSES, DELAY_SECONDS};
