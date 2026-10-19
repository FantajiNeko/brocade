'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {summarize, validateSnapshot} = require('./network.cjs');

function request(rate = 300, loss = 0.1) {
  return {rate_mbps: rate, rtt_ms: 25, loss_percent_per_selected_egress: loss, loss_egresses: ['client/c0', 'origin/o0']};
}
function snapshot(rate = 300, loss = 0.1, progressed = false) {
  const roles = {};
  const definitions = [['client', [['c0', 0.004]]], ['forward', [['f0', 0.004], ['f1', 0.00649997]]], ['access', [['a0', 0.00649997], ['a1', 0.002]]], ['origin', [['o0', 0.002]]]];
  for (const [index, [role, interfaces]] of definitions.entries()) {
    const entry = roles[role] = {netns: 'net:[' + (100 + index) + ']', links: [], qdiscs: [], offloads: {}};
    for (const [iface, delay] of interfaces) {
      const counters = () => ({bytes: progressed ? 16000 : 0, packets: progressed ? 100 : 0, errors: 0, dropped: 2});
      entry.links.push({ifname: iface, ifindex: entry.links.length + 2, operstate: 'UP', mtu: 1500, stats64: {rx: counters(), tx: counters()}});
      entry.offloads[iface] = 'Features for ' + iface + ':\ntcp-segmentation-offload: off\ngeneric-segmentation-offload: off\ngeneric-receive-offload: off\n';
      const selected = iface === 'c0' || iface === 'o0';
      const options = {limit: 8192, delay: {delay, jitter: 0, correlation: 0}, ecn: false, gap: 0};
      if (loss > 0 && selected) options['loss-random'] = {loss: loss / 100, correlation: 0};
      const q = () => ({dev: iface, bytes: progressed ? 16000 : 0, packets: progressed ? 100 : 0, drops: progressed && selected && loss > 0 ? 3 : 0, overlimits: progressed ? 10 : 0, requeues: 0, backlog: 0, qlen: 0});
      entry.qdiscs.push({...q(), kind: 'tbf', handle: '1:', root: true, options: {rate: rate * 1000000 / 8, burst: 32767, lat: 50000}}, {...q(), kind: 'netem', handle: '10:', parent: '1:1', options});
    }
  }
  return {monotonic_ns: progressed ? 2000000000 : 1000000000, kernel: 'test-kernel', profile: {rate_mbps: rate, rtt_ms: 25}, allowed_cpus: [2, 4, 6, 8], cgroup: {'cpuset.cpus.effective': '2,4,6,8', 'memory.max': '2147483648'}, roles};
}
function q(state, role = 'client', iface = 'c0', kind = 'netem') { return state.roles[role].qdiscs.find(v => v.dev === iface && v.kind === kind); }

for (const rate of [100, 300]) for (const loss of [0, 0.1]) test(`strict actual ${rate}Mbps/25ms/${loss}% profile and interval counters`, () => {
  const value = summarize(snapshot(rate, loss), snapshot(rate, loss, true), request(rate, loss));
  assert.equal(value.profile_verified, true);
  assert.equal(value.interface_errors_and_drops_zero, true);
  assert.equal(value.interval_seconds, 1);
  assert.equal(Object.keys(value.endpoints).length, 6);
  assert.equal(value.endpoints['client/c0'].loss_percent, loss);
  assert.equal(value.endpoints['forward/f0'].loss_percent, 0);
  assert.equal(value.configured_loss_observed_on_both_egresses, loss > 0);
  if (loss > 0) {
    assert.equal(value.endpoints['client/c0'].qdisc_counters.tbf.deltas.drops, 3);
    assert.equal(value.endpoints['client/c0'].qdisc_counters.netem.deltas.drops, 3);
    assert.equal(value.endpoints['client/c0'].interface_deltas.tx.dropped, 0);
  }
});
test('configured random loss without sampled drop is explicitly not claimed exercised', () => {
  const after = snapshot(300, 0.1, true);
  for (const role of Object.values(after.roles)) for (const disc of role.qdiscs) disc.drops = 0;
  const value = summarize(snapshot(), after, request());
  assert.equal(value.profile_verified, true);
  assert.equal(value.configured_loss_observed_on_both_egresses, false);
  assert.deepEqual(value.netem_drop_observed_egresses, []);
});
test('fixed-off notation is accepted but duplicate contradictory feature is not', () => {
  const state = snapshot();
  state.roles.client.offloads.c0 = state.roles.client.offloads.c0.replaceAll(': off', ': off [fixed]');
  validateSnapshot(state, request());
  state.roles.client.offloads.c0 += 'generic-receive-offload: on\n';
  assert.throws(() => validateSnapshot(state, request()));
});

const mutations = [
  ['wrong bandwidth', s => { q(s, 'forward', 'f1', 'tbf').options.rate = 100; }],
  ['wrong one-hop delay', s => { q(s, 'access', 'a0').options.delay.delay = 0.004; }],
  ['milliseconds used as seconds', s => { q(s).options.delay.delay = 4; }],
  ['jitter', s => { q(s).options.delay.jitter = 0.001; }],
  ['delay correlation', s => { q(s).options.delay.correlation = 0.5; }],
  ['missing selected loss', s => { delete q(s).options['loss-random']; }],
  ['percent points instead of probability', s => { q(s).options['loss-random'].loss = 0.1; }],
  ['loss on wrong egress', s => { q(s, 'forward', 'f0').options['loss-random'] = {loss: 0.001, correlation: 0}; }],
  ['missing second selected loss', s => { delete q(s, 'origin', 'o0').options['loss-random']; }],
  ['loss correlation', s => { q(s).options['loss-random'].correlation = 0.1; }],
  ['unexpected loss model', s => { q(s).options['loss-state'] = {p13: 0.001}; }],
  ['unexpected duplication', s => { q(s).options.duplicate = {duplicate: 0.001}; }],
  ['ECN', s => { q(s).options.ecn = true; }],
  ['wrong queue limit', s => { q(s).options.limit = 1000; }],
  ['wrong qdisc hierarchy', s => { q(s).parent = 'root'; }],
  ['duplicate qdisc', s => { s.roles.client.qdiscs.push(structuredClone(q(s))); }],
  ['missing qdisc', s => { s.roles.client.qdiscs.pop(); }],
  ['offload on', s => { s.roles.client.offloads.c0 = s.roles.client.offloads.c0.replace('generic-receive-offload: off', 'generic-receive-offload: on'); }],
  ['missing offload', s => { delete s.roles.origin.offloads.o0; }],
  ['shared namespace', s => { s.roles.origin.netns = s.roles.client.netns; }],
  ['missing endpoint', s => { s.roles.access.links.pop(); }],
  ['extra endpoint', s => { s.roles.client.links.push({...s.roles.client.links[0], ifname: 'host0'}); }],
  ['link down', s => { s.roles.client.links[0].operstate = 'DOWN'; }],
  ['wrong MTU', s => { s.roles.client.links[0].mtu = 9000; }],
  ['wrong allowed CPUs', s => { s.allowed_cpus = [0, 1, 2, 3]; }],
  ['wrong memory cap', s => { s.cgroup['memory.max'] = 'max'; }],
  ['missing counter', s => { delete q(s).drops; }],
  ['unsafe counter', s => { q(s).packets = Number.MAX_SAFE_INTEGER + 1; }],
  ['nonfinite delay', s => { q(s).options.delay.delay = NaN; }],
];
for (const [label, mutate] of mutations) for (const phase of ['before', 'after']) test(`reject ${phase}: ${label}`, () => {
  const before = snapshot(), after = snapshot(300, 0.1, true);
  mutate(phase === 'before' ? before : after);
  assert.throws(() => summarize(before, after, request()));
});
for (const [label, mutate] of [
  ['namespace replaced', s => { s.roles.client.netns = 'net:[999]'; }],
  ['interface replaced', s => { s.roles.client.links[0].ifindex = 999; }],
  ['wire bytes not conserved', s => { s.roles.client.links[0].stats64.tx.bytes++; }],
  ['wire packets not conserved', s => { s.roles.origin.links[0].stats64.rx.packets++; }],
  ['interface errors', s => { s.roles.client.links[0].stats64.tx.errors++; }],
  ['interface drops are not random qdisc drops', s => { s.roles.client.links[0].stats64.tx.dropped++; }],
  ['unexpected other-egress qdisc drops', s => { q(s, 'forward', 'f0').drops++; }],
  ['counter reset', s => { s.roles.client.links[0].stats64.tx.dropped = 1; }],
  ['reversed interval', s => { s.monotonic_ns = 1; }],
  ['kernel changed', s => { s.kernel = 'other'; }],
]) test('reject interval: ' + label, () => {
  const after = snapshot(300, 0.1, true); mutate(after);
  assert.throws(() => summarize(snapshot(), after, request()));
});
test('zero-loss request cannot accept unchanged actual loss settings', () => assert.throws(() => summarize(snapshot(), snapshot(300, 0.1, true), request(300, 0))));
test('request cannot select a different loss model, egress or RTT', () => {
  for (const change of [{loss_percent_per_selected_egress: 1}, {loss_egresses: ['forward/f0', 'origin/o0']}, {rtt_ms: 30}, {rate_mbps: 1000}]) assert.throws(() => summarize(snapshot(), snapshot(300, 0.1, true), {...request(), ...change}));
});
