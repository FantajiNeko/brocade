'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyCase, verifyDirectory, verifyAckReplay, verifyGuard, verifyHeldCover } = require('./verify-accounting.cjs');
const crash = ['intent', 'fenced', 'cover_draining', 'drained', 'checkpoint_prepared', 'signal', 'finalized', 'committed'];
const io = ['fenced', 'cover_draining', 'drained', 'accounting_prepare', 'checkpoint_prepared', 'signal', 'accounting_finalize', 'finalized', 'committed'];
const cases = ['zero-old', 'nonzero-old', ...crash.map(x => 'crash-' + x), ...io.map(x => 'io-' + x)];
const lateRecovery = ['crash-signal', 'crash-finalized', 'io-accounting_finalize', 'io-finalized', 'io-committed'];
const modes = ['plain', 'tls', 'reality'];
const guards = ['reject-v4-drain-contract', 'unsupported-udp-retire-guard'];
const clone = structuredClone;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function identity(generation) {
  return { generation_id: generation, pid: generation === 'old' ? 101 : 102,
    boot_id: 'synthetic-boot', pid_start_ticks: '12345', drain_config_digest: sha('config-' + generation),
    drain_config_version: 1, drain_scope_version: 1, ready: true, require_fence: true,
    listeners: [{ role: 'public', address: '127.0.0.1:41001', socket_inode: 123,
      socket_cookie: 456, protocol: 6, socket_type: 1, accept_conn: 1, active: 0, in_accept: false }] };
}
function lifecycle(operation, previousFence = false) {
  const old = identity('old');
  return { version: 6, action: 'Retire', phase: 'committed', owner: 'candidate', target: 'old',
    operation_id: operation, epoch: 5, fence_intent: 'current-intent',
    old: { binary: '/synthetic/xray', control: '/synthetic/old.sock', identity: old, retired: true },
    candidate: { binary: '/synthetic/xray', control: '/synthetic/new.sock', identity: identity('new'), retired: false },
    drain_proof: { ...clone(old), active: 0, public_active: 0, cover_active: 0, background_active: 0,
      paused: true, public_quiescent: true, cover_paused: true, retire_ready: true,
      accepting: false, drain_scope_unsupported: false, fence_epoch: previousFence ? 4 : 5,
      fence_intent: previousFence ? 'previous-intent' : 'current-intent', fence_allowed: 'retire' } };
}
// Public synthetic identities exercise the oracle, not the runtime. Optional
// real evidence below is independently accepted before any in-memory mutation.
function valid(name = 'io-fenced', mode = 'plain') {
  const [old, next] = name === 'zero-old' ? [0, 7168] : name === 'nonzero-old' ? [40960, 18432] : [29696, 7168];
  const total = old + next, operation = mode + '-' + name;
  const report = { agent_instance_id: operation + '-instance', sequence: 3, usage_generation_id: 1,
    read_at_unix_secs: 1010, xray_started_at_unix_secs: 1000, xray_epoch: 'old-epoch',
    counters: [{ label: 'synthetic-user', uplink_bytes: old, downlink_bytes: old }] };
  return { status: 'PASS', case: name, security: mode,
    failpoint: name.startsWith('io-') ? 'io:' + name.slice(3) : name.startsWith('crash-') ? name.slice(6) : '',
    coordinator: 'Rust normal Agent module', runtime: 'v6-fenced-whole-configuration-drain',
    postgres_totals: [total, total], old_final_each_direction: old, new_live_each_direction: next,
    application_reconnect_attempts: 0, old_exit_code: 0, new_active_after_retire: 1, node_zero_windows: 0,
    real_console_commit_ack_drop: true, stale_resume_http: 409, same_listener_inode: 123,
    operation_id: operation, lifecycle: lifecycle(operation, lateRecovery.includes(name)),
    ledger: { ownership: 1, started: 1000, epoch: 'old-epoch', prepared: null,
      totals: { 'synthetic-user': [total, total] },
      heads: { 'old-epoch': { 'synthetic-user': [old, old] }, 'new-epoch': { 'synthetic-user': [next, next] } },
      sources: [
        { control: '/synthetic/old.sock', epoch: 'old-epoch', final_operation: operation,
          final_report: report, intent: null, stopped_at: 1010000 },
        { control: '/synthetic/new.sock', epoch: 'new-epoch', final_operation: null,
          final_report: null, intent: null, stopped_at: null },
      ] },
    receipts: [1, 2, 4].map(sequence => ({ node_id: 'synthetic-node', agent_instance_id: report.agent_instance_id,
      sequence, usage_generation_id: 1, duplicate: false, accepted_readings: 1, inserted_samples: 1,
      gap_samples: 0, rejected_counters: 0, skipped_counters: 0 })) };
}
function guard(name) {
  return name === guards[0]
    ? { status: 'PASS', case: name, old_alive: true, durable_state_unchanged: true,
      fresh_requests_continue: true, old_same_tcp_continues: true, candidate_accepted: 0 }
    : { status: 'PASS', case: name, old_alive: true, durable_state_unchanged: true,
      fresh_candidate_tcp: true, retirement_refused: true, udp_echo_before_and_after_switch: true,
      unsupported: true, old_active: 0 };
}
function cover() {
  const l = lifecycle('held-cover');
  return { status: 'PASS', existing_cover_tls_completed_after_pause: true, same_operation_recovery: true,
    old_exit_code: 0, old_user_bytes_each_direction: 2048, candidate_same_tcp_bytes_each_direction: 3072,
    lifecycle: l, draining_status: { ...clone(l.drain_proof), retire_ready: false, cover_active: 1 } };
}
const http = receipt => 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n' + JSON.stringify(receipt);
const mutations = {
  'missing receipts': r => { r.receipts = []; },
  'double billing': r => { r.postgres_totals = [73728, 73728]; },
  'lost bytes': r => { r.postgres_totals[0]--; },
  'self-consistent wrong totals': r => { r.old_final_each_direction++; r.postgres_totals = [36865, 36865]; Object.values(r.ledger.totals)[0][0]++; },
  'negative generation offset by positive generation': r => { r.old_final_each_direction = -1; r.new_live_each_direction = 36865; r.ledger.sources[0].final_report.counters[0].uplink_bytes = -1; },
  'duplicate receipt': r => { r.receipts[2] = r.receipts[0]; },
  'ledger mismatch': r => { Object.values(r.ledger.totals)[0][0]++; },
  'source head mismatch': r => { Object.values(Object.values(r.ledger.heads)[0])[0][0]++; },
  'final journal mismatch': r => { r.ledger.sources[0].final_report.counters[0].uplink_bytes--; },
  'final journal wrong label': r => { r.ledger.sources[0].final_report.counters[0].label = 'wrong-label'; },
  'final report wrong source epoch': r => { r.ledger.sources[0].final_report.xray_epoch = 'wrong-epoch'; },
  'final report wrong operation': r => { r.ledger.sources[0].final_operation = 'wrong-operation'; },
  'live source finalized': r => { r.ledger.sources[1].final_operation = r.operation_id; },
  'source wrong control socket': r => { r.ledger.sources[0].control = '/wrong.sock'; },
  'source missing epoch': r => { delete r.ledger.sources[0].epoch; },
  'source intent not cleared': r => { r.ledger.sources[0].intent = {}; },
  'duplicate source epoch': r => { r.ledger.sources[1].epoch = r.ledger.sources[0].epoch; },
  'unprepared ownership': r => { r.ledger.ownership = 0; },
  'pending checkpoint': r => { r.ledger.prepared = {}; },
  'negative stop time': r => { r.ledger.sources[0].stopped_at = -1; },
  'invalid report sequence': r => { r.ledger.sources[0].final_report.sequence = -1; },
  'report before startup': r => { r.ledger.sources[0].final_report.read_at_unix_secs = 1; },
  'abnormal exit': r => { r.old_exit_code = 9; },
  'uncommitted retirement': r => { r.lifecycle.phase = 'drained'; },
  'connection reconnect': r => { r.application_reconnect_attempts = 1; },
  'missing candidate': r => { r.new_active_after_retire = 0; },
  'zero node window': r => { r.node_zero_windows = 1; },
  'unreplayed ACK': r => { r.real_console_commit_ack_drop = false; },
  'stale operation accepted': r => { r.stale_resume_http = 200; },
  'counter gap': r => { r.receipts[0].gap_samples = 1; },
  'non-finite amount': r => { r.old_final_each_direction = NaN; },
  'non-finite receipt': r => { r.receipts[0].accepted_readings = Infinity; },
  'negative receipt sequence': r => { r.receipts[0].sequence = -1; },
  'unsafe receipt sequence': r => { r.receipts[0].sequence = Number.MAX_SAFE_INTEGER + 1; },
  'fractional receipt sample': r => { r.receipts[0].inserted_samples = 0.5; },
  'missing receipt identity': r => { delete r.receipts[0].node_id; },
  'mixed receipt node': r => { r.receipts[0].node_id = 'wrong-node'; },
  'receipt wrong instance': r => { r.receipts[0].agent_instance_id = 'wrong-instance'; },
  'receipt wrong generation': r => { r.receipts[0].usage_generation_id++; },
  'stored receipt rewritten by retry': r => { r.receipts[0].duplicate = true; },
  'missing root and lifecycle operation': r => { delete r.operation_id; delete r.lifecycle.operation_id; },
  'empty operation': r => { r.operation_id = r.lifecycle.operation_id = ''; },
  'wrong lifecycle operation': r => { r.lifecycle.operation_id = 'another-operation'; },
  'wrong lifecycle version': r => { r.lifecycle.version = 5; },
  'wrong lifecycle owner': r => { r.lifecycle.owner = 'old'; },
  'unretired source': r => { r.lifecycle.old.retired = false; },
  'missing binary identity': r => { delete r.lifecycle.old.binary; },
  'missing config identity': r => { delete r.lifecycle.old.identity.drain_config_digest; },
  'empty config identity': r => { r.lifecycle.old.identity.drain_config_digest = ''; },
  'empty boot identity': r => { r.lifecycle.old.identity.boot_id = ''; },
  'wrong start ticks': r => { r.lifecycle.drain_proof.pid_start_ticks += '1'; },
  'wrong drain PID': r => { r.lifecycle.drain_proof.pid++; },
  'wrong drain config': r => { r.lifecycle.drain_proof.drain_config_digest = sha('wrong-config'); },
  'same old and candidate PID': r => { r.lifecycle.candidate.identity.pid = r.lifecycle.old.identity.pid; },
  'wrong candidate listener inode': r => { r.lifecycle.candidate.identity.listeners[0].socket_inode++; },
  'wrong drain listener cookie': r => { r.lifecycle.drain_proof.listeners[0].socket_cookie++; },
  'missing listener identity': r => { delete r.lifecycle.drain_proof.listeners[0].socket_cookie; },
  'missing public listener': r => { r.lifecycle.drain_proof.listeners = []; },
  'unreviewed listener role': r => { r.lifecycle.drain_proof.listeners.push({ ...r.lifecycle.drain_proof.listeners[0], role: 'udp' }); },
  'not retire ready': r => { r.lifecycle.drain_proof.retire_ready = false; },
  'active public scope': r => { r.lifecycle.drain_proof.public_active = 1; },
  'active cover scope': r => { r.lifecycle.drain_proof.cover_active = 1; },
  'active background scope': r => { r.lifecycle.drain_proof.background_active = 1; },
  'public admission open': r => { r.lifecycle.drain_proof.paused = false; },
  'cover admission open': r => { r.lifecycle.drain_proof.cover_paused = false; },
  'accept still running': r => { r.lifecycle.drain_proof.listeners[0].in_accept = true; },
  'false quiescent summary': r => { r.lifecycle.drain_proof.public_quiescent = false; },
  'omitted summary with active listener': r => { delete r.lifecycle.drain_proof.public_quiescent; r.lifecycle.drain_proof.listeners[0].active = 1; },
  'omitted summary with pending Accept': r => { delete r.lifecycle.drain_proof.public_quiescent; r.lifecycle.drain_proof.listeners[0].in_accept = true; },
  'unsupported drain scope': r => { r.lifecycle.drain_proof.drain_scope_unsupported = true; },
  'missing fence intent': r => { delete r.lifecycle.fence_intent; },
  'same epoch wrong intent': r => { r.lifecycle.drain_proof.fence_intent = 'wrong-intent'; },
  'older proof at live recovery point': r => { r.lifecycle.drain_proof.fence_epoch--; },
  'wrong fence permission': r => { r.lifecycle.drain_proof.fence_allowed = 'resume'; },
};
for (const mode of modes) for (const name of cases) {
  test(`accepts complete ${mode}/${name} accounting fixture`, () => verifyCase(valid(name, mode), name, mode));
}
test('accepts Rust durable projection only with underlying quiescence proven', () => {
  const r = valid(); delete r.lifecycle.drain_proof.public_quiescent; verifyCase(r, r.case, r.security);
});
for (const [name, mutate] of Object.entries(mutations)) {
  test('accounting rejects ' + name, () => {
    const r = valid(); mutate(r); assert.throws(() => verifyCase(r, 'io-fenced', 'plain'));
  });
}
for (const name of lateRecovery) {
  test(name + ' rejects proof two attempts old', () => {
    const r = valid(name); r.lifecycle.drain_proof.fence_epoch--;
    assert.throws(() => verifyCase(r, name, 'plain'));
  });
  test(name + ' rejects reused recovery intent', () => {
    const r = valid(name); r.lifecycle.drain_proof.fence_intent = r.lifecycle.fence_intent;
    assert.throws(() => verifyCase(r, name, 'plain'));
  });
}
test('binds dropped ACK to original PG receipt and duplicate HTTP retry', () => {
  const r = valid(), receipt = r.receipts[0]; verifyAckReplay(r, http(receipt), [{ ...receipt, duplicate: true }]);
});
const ackMutations = {
  'non-200 ACK': e => { e.http = e.http.replace('200 OK', '503 unavailable'); },
  'ACK from different case': e => { e.ack.agent_instance_id = 'other-case'; },
  'ACK changed amount': e => { e.ack.accepted_readings++; },
  'ACK without accepted reading': e => { e.ack.accepted_readings = 0; },
  'duplicate flag in original ACK': e => { e.ack.duplicate = true; },
  'missing HTTP duplicate': e => { e.duplicates = []; },
  'HTTP duplicate for wrong sequence': e => { e.duplicates[0].sequence++; },
  'HTTP duplicate changed count': e => { e.duplicates[0].inserted_samples++; },
  'HTTP duplicate wrong generation': e => { e.duplicates[0].usage_generation_id++; },
  'HTTP retry not marked duplicate': e => { e.duplicates[0].duplicate = false; },
  'nonfinite duplicate count': e => { e.duplicates[0].inserted_samples = Infinity; },
};
function ackEvidence(r) {
  const ack = clone(r.receipts[0]); return { ack, http: http(ack), duplicates: [{ ...ack, duplicate: true }] };
}
function rejectAck(r, original, mutate) {
  const e = clone(original), before = JSON.stringify(e.ack); mutate(e);
  if (JSON.stringify(e.ack) !== before) e.http = http(e.ack);
  assert.throws(() => verifyAckReplay(r, e.http, e.duplicates));
}
for (const [name, mutate] of Object.entries(ackMutations)) {
  test('rejects ' + name, () => { const r = valid(); rejectAck(r, ackEvidence(r), mutate); });
}
for (const name of guards) {
  test('accepts complete guard ' + name, () => verifyGuard(guard(name), name));
  for (const [field, value] of Object.entries(guard(name))) {
    if (field === 'status' || field === 'case') continue;
    test('rejects guard ' + name + ' broken ' + field, () => {
      const r = guard(name); r[field] = typeof value === 'boolean' ? false : 1;
      assert.throws(() => verifyGuard(r, name));
    });
  }
}
test('accepts held cover completion and final idle certificate', () => verifyHeldCover(cover()));
const coverMutations = {
  'TLS did not finish': r => { r.existing_cover_tls_completed_after_pause = false; },
  'different operation recovery': r => { r.same_operation_recovery = false; },
  'wrong old bytes': r => { r.old_user_bytes_each_direction--; },
  'candidate no progress': r => { r.candidate_same_tcp_bytes_each_direction = 0; },
  'abnormal old exit': r => { r.old_exit_code = 1; },
  'no active cover at pause': r => { r.draining_status.cover_active = 0; },
  'draining status already retire ready': r => { r.draining_status.retire_ready = true; },
  'different draining PID': r => { r.draining_status.pid++; },
  'different draining config': r => { r.draining_status.drain_config_digest = sha('wrong'); },
  'cover remains active at exit': r => { r.lifecycle.drain_proof.cover_active = 1; },
  'missing final proof': r => { delete r.lifecycle.drain_proof; },
};
for (const [name, mutate] of Object.entries(coverMutations)) {
  test('rejects held cover ' + name, () => { const r = cover(); mutate(r); assert.throws(() => verifyHeldCover(r)); });
}

// File-level provenance and zero-selected-test rejection. Cleanup is confined
// to the unique test directory created here, never a user evidence directory.
function directoryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h9-accounting-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, data) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const inputs = { paths: {}, sha256: {} };
  for (const key of ['agent', 'client', 'legacy', 'manager', 'runtime']) {
    write('input-' + key, key); inputs.paths[key] = path.join(root, 'input-' + key); inputs.sha256[key] = sha(key);
  }
  write('inputs.json', inputs);
  for (const mode of modes) {
    const retries = [];
    write(mode + '-exit.json', { code: 0, signal: null, timed_out: false });
    for (const name of cases) {
      const r = valid(name, mode), receipt = r.receipts[0];
      write(`${mode}/${name}/result.json`, r); write(`${mode}/${name}/xray`, 'runtime');
      write(`${mode}/${name}/real-console-committed-but-ack-dropped.http`, http(receipt));
      retries.push(JSON.stringify({ ...receipt, duplicate: true }));
    }
    write(mode + '.log', retries.join('\n') + '\n');
  }
  for (const name of guards) write('plain/' + name + '/result.json', guard(name));
  write('held-cover-exit.json', { code: 0, signal: null, timed_out: false });
  write('held-cover/held-cover-rust-recover/result.json', cover());
  return { root, write, inputs };
}
test('accepts complete 60-case directory with executable and ACK bindings', t => {
  const { root } = directoryFixture(t); assert.equal(verifyDirectory(root).total_fixtures, 60);
});
const directoryMutations = {
  'test harness exits nonzero': e => e.write('plain-exit.json', { code: 1, signal: null }),
  'test harness killed by signal': e => e.write('plain-exit.json', { code: 0, signal: 'SIGKILL' }),
  'test harness timed out': e => e.write('plain-exit.json', { code: 0, signal: null, timed_out: true }),
  'held cover harness timed out': e => e.write('held-cover-exit.json', { code: 0, signal: null, timed_out: true }),
  'missing cases despite exit zero': e => fs.renameSync(path.join(e.root, 'plain/io-fenced'), path.join(e.root, 'missing-case')),
  'extra unknown case': e => e.write('plain/unknown/result.json', {}),
  'changed input executable': e => e.write('input-runtime', 'changed-runtime'),
  'changed per-case executable': e => e.write('plain/io-fenced/xray', 'changed-runtime'),
  'missing input hash': e => { delete e.inputs.sha256.runtime; e.write('inputs.json', e.inputs); },
  'missing mode retry log': e => e.write('plain.log', ''),
  'ACK taken from another case': e => e.write('plain/io-fenced/real-console-committed-but-ack-dropped.http', http(valid('zero-old').receipts[0])),
};
for (const [name, mutate] of Object.entries(directoryMutations)) {
  test('directory rejects ' + name, t => { const e = directoryFixture(t); mutate(e); assert.throws(() => verifyDirectory(e.root)); });
}
if (process.env.H9_ACCOUNTING_ROOT) {
  const root = path.resolve(process.env.H9_ACCOUNTING_ROOT);
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  test('accepts all selected real accounting evidence and binary provenance', () => {
    assert.equal(verifyDirectory(root).total_actual_console_pg_cases, 57);
  });
  const real = read('plain/io-fenced/result.json');
  for (const [name, mutate] of Object.entries(mutations)) {
    test('rejects real accounting evidence with ' + name, () => {
      const r = clone(real); mutate(r); assert.throws(() => verifyCase(r, 'io-fenced', 'plain'));
    });
  }
  for (const name of lateRecovery) {
    test('rejects real ' + name + ' proof two attempts old', () => {
      const r = read('plain/' + name + '/result.json'); r.lifecycle.drain_proof.fence_epoch--;
      assert.throws(() => verifyCase(r, name, 'plain'));
    });
  }
  const realHttp = fs.readFileSync(path.join(root, 'plain/io-fenced/real-console-committed-but-ack-dropped.http'), 'utf8');
  const realAck = JSON.parse(realHttp.split('\r\n\r\n')[1]);
  const duplicate = fs.readFileSync(path.join(root, 'plain.log'), 'utf8').split('\n').filter(x => x.startsWith('{'))
    .map(JSON.parse).find(x => x.duplicate === true && x.agent_instance_id === realAck.agent_instance_id && x.sequence === realAck.sequence);
  const e = { ack: realAck, http: realHttp, duplicates: [duplicate] };
  test('accepts actual dropped ACK and mode-log duplicate HTTP response', () => verifyAckReplay(real, e.http, e.duplicates));
  for (const [name, mutate] of Object.entries(ackMutations)) {
    test('rejects real ' + name, () => rejectAck(real, e, mutate));
  }
  for (const name of guards) {
    const r = read('plain/' + name + '/result.json');
    for (const [field, value] of Object.entries(guard(name))) {
      if (field === 'status' || field === 'case') continue;
      test('rejects real guard ' + name + ' broken ' + field, () => {
        const changed = clone(r); changed[field] = typeof value === 'boolean' ? false : 1;
        assert.throws(() => verifyGuard(changed, name));
      });
    }
  }
  const held = read('held-cover/held-cover-rust-recover/result.json');
  for (const [name, mutate] of Object.entries(coverMutations)) {
    test('rejects real held cover ' + name, () => { const r = clone(held); mutate(r); assert.throws(() => verifyHeldCover(r)); });
  }
}
