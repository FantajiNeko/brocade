'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {counterState, settle} = require('./settle-network.cjs');

function snapshot(count = 0, backlog = 0) {
  const roles = {};
  for (const [i, [role, names]] of [['client', ['c0']], ['forward', ['f0', 'f1']], ['access', ['a0', 'a1']], ['origin', ['o0']]].entries()) {
    roles[role] = {netns: `net:[${i + 1}]`, links: names.map((ifname, j) => ({ifname, ifindex: j + 1, stats64: {rx: {bytes: count * 64, packets: count, errors: 0, dropped: 0}, tx: {bytes: count * 64, packets: count, errors: 0, dropped: 0}}})), qdiscs: names.map(dev => ({dev, kind: 'netem', handle: '10:', parent: '1:1', options: {}, bytes: count * 64, packets: count, drops: 0, overlimits: 0, requeues: 0, backlog, qlen: backlog > 0 ? 1 : 0}))};
  }
  return {roles};
}
async function simulate(values, deadline = 10000) {
  let time = 0, i = 0;
  const saved = [];
  const result = await settle({deadline, now: () => time, sleep: async n => { time += n; }, capture: async () => { time += 50; return structuredClone(values[Math.min(i++, values.length - 1)]); }, save: (n, value, status) => saved.push({n, value, status})});
  return {result, saved, time};
}
test('two identical drained snapshots settle and all raw attempts are retained', async () => {
  const x = await simulate([snapshot(), snapshot()]);
  assert.equal(x.result.attempts, 2); assert.equal(x.saved.length, 2); assert(x.time <= 10000);
});
test('changed counters require a fresh consecutive stable pair', async () => {
  const x = await simulate([snapshot(), snapshot(1), snapshot(2), snapshot(2)]);
  assert.equal(x.result.attempts, 4); assert.equal(x.saved.length, 4);
});
test('nonzero queue backlog cannot be treated as settled', async () => {
  const x = await simulate([snapshot(0, 64), snapshot(0, 64), snapshot(), snapshot()]);
  assert.equal(x.result.attempts, 4);
  await assert.rejects(() => simulate([snapshot(0, 64)], 1000), /did not settle/);
});
test('stable but non-atomic mismatched veth counters cannot be accepted', async () => {
  const bad = snapshot(); bad.roles.client.links[0].stats64.tx.packets = 1;
  assert.equal(counterState(bad).conserved, false);
  await assert.rejects(() => simulate([bad], 1000), /did not settle/);
  assert.equal((await simulate([bad, snapshot(), snapshot()])).result.attempts, 3);
});
test('counter fingerprint includes non-byte counters and qdisc state', () => {
  const a = snapshot(), b = snapshot(); b.roles.client.links[0].stats64.rx.dropped = 1;
  assert.notEqual(counterState(a).fingerprint, counterState(b).fingerprint);
  b.roles.client.links[0].stats64.rx.dropped = 0; b.roles.client.qdiscs[0].drops = 1;
  assert.notEqual(counterState(a).fingerprint, counterState(b).fingerprint);
});
test('interface or namespace replacement breaks stability', () => {
  const a = snapshot(), b = snapshot(); b.roles.client.links[0].ifindex = 12;
  assert.notEqual(counterState(a).fingerprint, counterState(b).fingerprint);
  b.roles.client.links[0].ifindex = 1; b.roles.client.netns = 'net:[1234]';
  assert.notEqual(counterState(a).fingerprint, counterState(b).fingerprint);
});
test('strict counter validity rejects missing, negative and unsafe values', () => {
  for (const value of [undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const s = snapshot(); s.roles.client.links[0].stats64.tx.bytes = value;
    assert.throws(() => counterState(s));
  }
});
test('a snapshot completing beyond deadline cannot pass even if stable', async () => {
  await assert.rejects(() => simulate([snapshot()], 300), /did not settle/);
});
test('invalid readback is retained as evidence before rejecting it', async () => {
  const bad = snapshot(); delete bad.roles.client.links[0].stats64.tx.bytes;
  const saved = [];
  await assert.rejects(() => settle({deadline: 10000, now: () => 0, sleep: async () => {}, capture: async () => bad, save: (...args) => saved.push(args)}));
  assert.equal(saved.length, 1); assert.equal(saved[0][0], 1);
  assert.equal(saved[0][1], bad); assert.match(saved[0][2].readback_error, /safe integer/);
});
