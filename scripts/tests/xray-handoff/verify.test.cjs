'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { verifyResult, PATHS, CHECKPOINTS, FRAME_BYTES } = require('./verify.cjs');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const FIXED = sha('synthetic fixed runtime');
const CLIENT = sha('synthetic client runtime');
const hashes = { b0: FIXED, b1: FIXED, b2: FIXED, client: CLIENT };
const options = () => ({ expectedBinarySha256: { ...hashes }, harnessExitCode: 0 });
const frameDigests = Array.from({ length: 251 }, (_, seq) =>
  sha(Buffer.from(Array.from({ length: FRAME_BYTES }, (_, i) => (i * 31 + seq * 17) % 251))));

function listener(index, active = false) {
  return { role: 'public', address: `127.0.0.1:${41000 + index}`, socket_inode: 100 + index,
    socket_cookie: 200 + index, protocol: 6, socket_type: 1, accept_conn: 1,
    active: active ? 1 : 0, in_accept: active };
}

function request(path, phase, dispatch, marker) {
  return { path, phase, scheduled_us: dispatch - 1, dispatch_us: dispatch,
    local_adapter_connect_us: 1, end_to_end_inner_tls_us: 2,
    http_headers_us: 3, total_us: 4, marker, error: '' };
}

// Synthetic evidence exercises the checker, not the real network/runtime. Every
// negative below starts with this independently accepted complete H9 document.
function validResult() {
  const configs = { b0: sha('config b0'), b1: sha('config b1'), b2: sha('config b2') };
  const event = (name, at_us, detail = {}) => ({ name, at_us, ...detail });
  const ready = (name, at_us, pid, selected_origin) => event(`${name}-ready`, at_us,
    { pid, selected_origin, binary_sha256: FIXED, config_digest: configs[name], listeners: [listener(1), listener(2)] });
  const certificate = generation => ({ drain_config_version: 1, drain_config_digest: configs[generation],
    active: 0, public_active: 0, cover_active: 0, background_active: 0,
    paused: true, public_quiescent: true, cover_paused: true, retire_ready: true,
    accepting: false, drain_scope_unsupported: false, listeners: [listener(1), listener(2)] });
  const r = {
    schema_version: 9, run_id: 'synthetic-verifier-fixture', mode: 'fixed-to-fixed',
    boundary: '', negative_control: '', half_close_transport: 'tls-and-tcp',
    scope: 'synthetic strict verifier test only', binary_sha256: { ...hashes }, expected_binary_sha256: { ...hashes },
    test_failed: false, errors: [], stream_errors: [], application_reconnects: 0, new_request_failures: 0,
    initial_persistent_flows: 32,
    events: [ready('b0', 1, 101, 1), event('baseline-begin', 100), ready('b1', 250, 102, 1),
      event('same-binary-control-begin', 300), event('same-binary-control-paused', 320),
      event('same-binary-control-committed', 400, { pause_to_resume_us: 80, total_us: 100 }),
      ready('b2', 550, 103, 2), event('routing-update-begin', 600), event('routing-update-paused', 620),
      event('routing-update-committed', 700, { pause_to_resume_us: 80, total_us: 100 }),
      event('retirement-begin', 990), event('before-b0-retire', 1000), event('b0-drain-certified', 1100, { certificate: certificate('b0') }),
      event('b0-retirement-signaled', 1110),
      event('b0-exit-observed', 1120, { pid: 101, exit_code: 0, exit_signal: '', wait_error: '' }),
      event('b1-drain-certified', 1400, { certificate: certificate('b1') }),
      event('b1-retirement-signaled', 1410),
      event('b1-exit-observed', 1420, { pid: 102, exit_code: 0, exit_signal: '', wait_error: '' }),
      event('measurement-end', 1800),
      ...['b2', 'fixed-A', 'fixed-client'].flatMap((name, index) => [
        event(`${name}-retirement-signaled`, 1900 + index),
        event(`${name}-exit-observed`, 1902 + index, { pid: 103 + index, exit_code: 0, exit_signal: '', wait_error: '' }),
      ])].sort((a, b) => a.at_us - b.at_us),
    requests: PATHS.flatMap(path => [request(path, 'baseline', 200, 'origin-1'),
      request(path, 'same-binary-control-post', 450, 'origin-1'),
      request(path, 'routing-update-post', 800, 'origin-2'), request(path, 'retirement', 1600, 'origin-2')]),
    pause_requests: PATHS.flatMap(path => [
      { ...request(path, 'baseline', 350, 'origin-1'), operation: 'same-binary-control' },
      { ...request(path, 'same-binary-control-post', 650, 'origin-2'), operation: 'routing-update' }]),
    processes: ['b0', 'b1', 'b2', 'fixed-A', 'fixed-client'].map((name, index) => ({ name, pid: 101 + index,
      binary_sha256: name.startsWith('fixed-') ? CLIENT : FIXED,
      wait: { exit_code: 0, signal: '', error: '', at_us: index < 2 ? [1115, 1415][index] : 1900 + index },
      cleanup: { forced: false, reason: '' } })),
    flows: [], checkpoints: [],
    b0_stats: { 'vless>>>vision>>>splice_bytes': 16384, counter: 0 },
    b1_stats: { 'vless>>>vision>>>splice_bytes': 16384 },
    b2_stats: { 'vless>>>vision>>>splice_bytes': 16384 },
  };
  const times = {
    b0: [50, 100, 150, 200, 250, 450, 470, 490, 650, 750, 770, 790, 850, 950],
    b1: [420, 450, 500, 650, 750, 770, 850, 950, 1000, 1100, 1200],
    b2: [720, 750, 800, 900, 950, 990, 1050, 1100, 1130, 1150, 1170, 1190, 1250, 1290, 1350, 1400, 1430, 1450, 1470, 1490, 1600, 1700],
  };
  for (const generation of ['b0', 'b1', 'b2']) for (const path of PATHS) {
    for (let index = 0; index < (generation === 'b0' ? 16 : 3); index++) {
      const mode = ['download', 'upload', 'duplex'][index % 3];
      const makeFrames = () => times[generation].map((at_us, seq) => {
        const digest = frameDigests[seq % 251];
        return { at_us, seq, bytes: FRAME_BYTES, sha256: digest, expected_sha256: digest };
      });
      const up_frames = mode === 'download' ? [] : makeFrames();
      const down_frames = mode === 'upload' ? [] : makeFrames();
      const finish = { b0: 980, b1: 1280, b2: 1780 }[generation];
      const stop = { b0: 960, b1: 1250, b2: 1750 }[generation];
      const serverFirst = mode === 'duplex' && index % 2 === 0;
      if (mode === 'duplex') {
        const tailFrames = serverFirst ? up_frames : down_frames;
        for (let tail = 0; tail < 3; tail++) {
          const seq = tailFrames.length;
          tailFrames.push({ at_us: stop + 3 + tail, seq, bytes: FRAME_BYTES, sha256: frameDigests[seq % 251], expected_sha256: frameDigests[seq % 251] });
        }
      }
      r.flows.push({ id: `${generation}-${path}-${index}`, generation, path, mode,
        marker: generation === 'b2' ? 'origin-2' : 'origin-1', error: '',
        completion: serverFirst ? 'server-ended' : 'client-half-close', started_us: { b0: 10, b1: 410, b2: 710 }[generation],
        stop_requested_us: stop, finished_us: finish,
        half_close: { client_write_closed_us: serverFirst ? finish - 1 : stop + 1, server_terminal_us: serverFirst ? stop + 1 : finish - 1,
          origin_read_eof: true, server_read_eof: true,
          origin_read_eof_us: serverFirst ? finish - 1 : stop + 2, server_read_eof_us: serverFirst ? stop + 2 : finish - 1,
          down_frames_at_origin_eof: down_frames.length - (mode === 'duplex' && !serverFirst ? 3 : 0),
          up_frames_at_server_eof: up_frames.length - (serverFirst ? 3 : 0),
          down_frames_at_client_close: down_frames.length - (mode === 'duplex' && !serverFirst ? 3 : 0),
          up_frames_at_server_terminal: up_frames.length - (serverFirst ? 3 : 0) },
        up_frames, down_frames, sent_up_frames: up_frames.length,
        verified_up_bytes: up_frames.length * FRAME_BYTES,
        verified_down_bytes: down_frames.length * FRAME_BYTES });
    }
  }
  r.checkpoints = CHECKPOINTS.map((name, index) => {
    const at_us = [210, 500, 800, 1000, 1200, 1300, 1500][index];
    return { name, at_us, flows: r.flows.filter(flow => flow.started_us < at_us).map(flow => ({ id: flow.id,
      up_frames: flow.up_frames.filter(frame => frame.at_us <= at_us).length,
      down_frames: flow.down_frames.filter(frame => frame.at_us <= at_us).length })) };
  });
  return r;
}

const findEvent = (r, name) => r.events.find(event => event.name === name);
const oldFlow = r => r.flows.find(flow => flow.generation === 'b0' && flow.mode === 'download');
const candidate = r => r.flows.find(flow => flow.generation === 'b2' && flow.mode === 'download');

test('accepts a complete synthetic H9 result with both paths and all transfer modes', () => {
  const summary = verifyResult(validResult(), options());
  assert.equal(summary.correctness_passed, true);
  assert.equal(summary.flows, 44);
  assert.equal(summary.pause_requests, 4);
  assert(summary.verified_bytes > 0);
});

test('accepts explicitly labeled cross-version evidence with independently different baseline digest', () => {
  const r = validResult();
  const opt = options();
  const old = sha('synthetic old runtime');
  r.mode = 'old-to-fixed';
  opt.expectedBinarySha256.b0 = old;
  r.binary_sha256.b0 = old;
  r.expected_binary_sha256.b0 = old;
  findEvent(r, 'b0-ready').binary_sha256 = old;
  r.processes.find(process => process.name === 'b0').binary_sha256 = old;
  for (const event of r.events) event.name = event.name.replace('same-binary-control', 'binary-upgrade');
  for (const request of [...r.requests, ...r.pause_requests]) {
    request.phase = request.phase.replace('same-binary-control', 'binary-upgrade');
    if (request.operation) request.operation = request.operation.replace('same-binary-control', 'binary-upgrade');
  }
  assert.equal(verifyResult(r, opt).mode, 'old-to-fixed');
});

test('accepts a pre-switch dispatched request completed after the route pause', () => {
  for (const marker of ['origin-1', 'origin-2']) {
    const r = validResult(), q = r.requests[1];
    q.http_headers_us = 300; q.total_us = 301; q.marker = marker;
    assert.equal(verifyResult(r, options()).correctness_passed, true);
  }
});

const mutations = [
  ['boundary mistaken for lifecycle', r => { r.boundary = 'idle'; }, /boundary/],
  ['negative control mistaken for positive', r => { r.negative_control = 'broken'; }, /negative_control/],
  ['missing transport claim', r => { delete r.half_close_transport; }, /half_close_transport/],
  ['TLS-only mistaken for TCP half close', r => { r.half_close_transport = 'tls-only'; }, /half_close_transport/],
  ['legacy H8 lacks strict schema', r => { delete r.schema_version; }, /schema_version/],
  ['unknown schema cannot inherit H9 semantics', r => { r.schema_version = 10; }, /schema_version/],
  ['missing run identity', r => { delete r.run_id; }, /run_id/],
  ['test failed', r => { r.test_failed = true; }, /test_failed/],
  ['hidden harness errors', r => { r.errors.push('failure'); }, /errors/],
  ['hidden stream errors', r => { r.stream_errors.push('failure'); }, /stream_errors/],
  ['application reconnect', r => { r.application_reconnects = 1; }, /application_reconnects/],
  ['request failure count', r => { r.new_request_failures = 1; }, /new_request_failures/],
  ['self-approved binary digest', r => { r.binary_sha256.b0 = r.expected_binary_sha256.b0 = sha('unapproved'); }, /binary_sha256.b0/],
  ['same binary mislabeled as upgrade', r => { r.mode = 'old-to-fixed'; }, /distinct binaries/],
  ['empty requests', r => { r.requests = []; }, /requests/],
  ['missing request path', r => { delete r.requests[0].path; }, /path/],
  ['unknown request path', r => { r.requests[0].path = 'other'; }, /path/],
  ['missing request phase', r => { delete r.requests[0].phase; }, /phase/],
  ['empty path/phase cell', r => { r.requests.splice(0, 1); }, /missing via-A\/baseline/],
  ['phase falsely labels old timestamp', r => { r.requests[0].phase = 'retirement'; }, /phase timestamp/],
  ['wrong post-route origin', r => { r.requests[2].marker = 'origin-1'; }, /wrong origin/],
  ['new origin for response completed before pause', r => { r.requests[1].marker = 'origin-2'; }, /wrong origin before/],
  ['unknown origin on truly overlapping request', r => {
    const q = r.requests[1]; q.http_headers_us = 300; q.total_us = 301; q.marker = 'wrong';
  }, /wrong origin during/],
  ['no unambiguous old-window observation', r => {
    for (const q of r.requests.filter(q => q.path === 'via-A' && q.dispatch_us < 620)) {
      q.http_headers_us = 700 - q.dispatch_us; q.total_us = q.http_headers_us + 1;
    }
  }, /missing via-A causally old window/],
  ['request carries error', r => { r.requests[0].error = 'reset'; }, /request error/],
  ['nonfinite request duration', r => { r.requests[0].total_us = Infinity; }, /nonfinite/],
  ['null request duration after JSON serialization', r => { r.requests[0].total_us = null; }, /safe integer/],
  ['negative timing', r => { r.requests[0].total_us = -1; }, /safe integer/],
  ['unsafe counter value', r => { r.b0_stats.counter = Number.MAX_SAFE_INTEGER + 1; }, /safe integer/],
  ['NaN statistic', r => { r.b0_stats.counter = NaN; }, /nonfinite/],
  ['null statistic', r => { r.b0_stats.counter = null; }, /safe integer/],
  ['empty counters', r => { r.b0_stats = {}; }, /empty/],
  ['missing splice evidence', r => { delete r.b0_stats['vless>>>vision>>>splice_bytes']; }, /splice bytes/],
  ['missing in-window probes', r => { r.pause_requests = []; }, /pause_requests/],
  ['probe outside pause window', r => { r.pause_requests[0].dispatch_us = 401; }, /outside pause window/],
  ['duplicate probe hides missing path', r => { r.pause_requests[2] = structuredClone(r.pause_requests[0]); }, /duplicate pause probe/],
  ['wrong pause request origin', r => { r.pause_requests[1].marker = 'origin-1'; }, /wrong origin/],
  ['missing ready event', r => { r.events = r.events.filter(e => e.name !== 'b1-ready'); }, /missing b1-ready/],
  ['duplicate event alias', r => { r.events.push(structuredClone(r.events[0])); }, /duplicate/],
  ['missing listener inode', r => { delete findEvent(r, 'b1-ready').listeners[0].socket_inode; }, /socket_inode/],
  ['changed listener cookie', r => { findEvent(r, 'b1-ready').listeners[0].socket_cookie++; }, /listener identity/],
  ['duplicated listener identity', r => { findEvent(r, 'b0-ready').listeners[1] = structuredClone(findEvent(r, 'b0-ready').listeners[0]); }, /duplicate listener/],
  ['wrong ready binary', r => { findEvent(r, 'b1-ready').binary_sha256 = sha('wrong'); }, /binary_sha256/],
  ['missing ready config hash', r => { delete findEvent(r, 'b1-ready').config_digest; }, /SHA-256/],
  ['route config never changed', r => { findEvent(r, 'b2-ready').config_digest = findEvent(r, 'b1-ready').config_digest; }, /digest did not change/],
  ['wrong selected origin', r => { findEvent(r, 'b2-ready').selected_origin = 1; }, /b2 origin/],
  ['child returned nonzero', r => { r.processes[0].wait.exit_code = 7; }, /child exit code/],
  ['child killed by signal', r => { r.processes[0].wait.signal = 'SIGKILL'; }, /child signal/],
  ['child wait error', r => { r.processes[0].wait.error = 'lost wait'; }, /wait error/],
  ['forced cleanup mislabeled success', r => { r.processes[0].cleanup.forced = true; }, /forced cleanup/],
  ['wrong child PID', r => { r.processes[0].pid += 10; }, /PID mismatch/],
  ['duplicate child PID', r => { r.processes[4].pid = r.processes[0].pid; }, /duplicate PID/],
  ['unapproved relay binary', r => { r.processes.find(p => p.name === 'fixed-A').binary_sha256 = sha('unapproved relay'); }, /fixed-A: process binary/],
  ['missing process wait', r => { delete r.processes[0].wait; }, /child exit code/],
  ['missing client exit evidence', r => { r.processes = r.processes.filter(p => p.name !== 'fixed-client'); }, /exactly three generations/],
  ['exit event refers to wrong child', r => { findEvent(r, 'b0-exit-observed').pid++; }, /exited wrong child/],
  ['exit event nonzero despite good harness', r => { findEvent(r, 'b0-exit-observed').exit_code = 7; }, /exit event code/],
  ['exit event hides wait failure', r => { findEvent(r, 'b0-exit-observed').wait_error = 'unknown'; }, /wait error/],
  ['missing drain certificate', r => { delete findEvent(r, 'b0-drain-certified').certificate; }, /expected object/],
  ['retirement not ready', r => { findEvent(r, 'b0-drain-certified').certificate.retire_ready = false; }, /retire_ready/],
  ['background work remains', r => { findEvent(r, 'b0-drain-certified').certificate.background_active = 1; }, /background_active/],
  ['public work remains', r => { findEvent(r, 'b0-drain-certified').certificate.public_active = 1; }, /public_active/],
  ['cover work remains', r => { findEvent(r, 'b0-drain-certified').certificate.cover_active = 1; }, /cover_active/],
  ['unsupported drain scope', r => { findEvent(r, 'b0-drain-certified').certificate.drain_scope_unsupported = true; }, /unsupported/],
  ['accept still active', r => { findEvent(r, 'b0-drain-certified').certificate.listeners[0].in_accept = true; }, /accept still active/],
  ['drain certificate from wrong config', r => { findEvent(r, 'b0-drain-certified').certificate.drain_config_digest = sha('wrong'); }, /config binding/],
  ['missing flow', r => { r.flows.pop(); }, /expected 32/],
  ['duplicate flow ID', r => { r.flows[1].id = r.flows[0].id; }, /duplicate/],
  ['wrong flow origin', r => { oldFlow(r).marker = 'origin-2'; }, /wrong origin/],
  ['flow completion is unknown', r => { oldFlow(r).completion = 'forced'; }, /completion/],
  ['only first frame, even with matching byte sum', r => {
    const f = oldFlow(r); f.down_frames = f.down_frames.slice(0, 1); f.verified_down_bytes = FRAME_BYTES;
  }, /at least 4/],
  ['old flow never crosses handoffs', r => {
    oldFlow(r).down_frames.forEach((f, i) => { f.at_us = 50 + i; });
  }, /did not span/],
  ['candidate never crosses retirement', r => {
    candidate(r).down_frames.forEach((f, i) => { f.at_us = 720 + i; });
  }, /did not span/],
  ['missing frame sequence', r => { oldFlow(r).down_frames[3].seq++; }, /missing\/duplicate sequence/],
  ['duplicate frame sequence', r => { oldFlow(r).down_frames[3].seq--; }, /missing\/duplicate sequence/],
  ['truncated frame payload', r => { oldFlow(r).down_frames[0].bytes--; }, /frame size/],
  ['wrong byte total', r => { oldFlow(r).verified_down_bytes++; }, /byte sum/],
  ['missing payload digest', r => { delete oldFlow(r).down_frames[0].sha256; }, /SHA-256/],
  ['payload corruption', r => { oldFlow(r).down_frames[0].sha256 = sha('corrupted'); }, /payload digest mismatch/],
  ['self-approved payload corruption', r => {
    oldFlow(r).down_frames[0].sha256 = oldFlow(r).down_frames[0].expected_sha256 = sha('corrupted');
  }, /deterministic sequence/],
  ['upload frames lost at receiver', r => { r.flows.find(f => f.mode === 'upload').sent_up_frames++; }, /sent\/verified/],
  ['flow unfinished at certification', r => { oldFlow(r).finished_us = 1150; }, /certified while/],
  ['missing duplex half-close evidence', r => { delete r.flows.find(f => f.mode === 'duplex').half_close; }, /half_close/],
  ['missing clean EOF at origin', r => { oldFlow(r).half_close.origin_read_eof = false; }, /origin clean EOF/],
  ['missing clean EOF at receiver', r => { delete oldFlow(r).half_close.server_read_eof; }, /server clean EOF/],
  ['missing EOF observation time', r => { delete oldFlow(r).half_close.origin_read_eof_us; }, /origin_read_eof_us/],
  ['EOF after completion', r => { oldFlow(r).half_close.server_read_eof_us = oldFlow(r).finished_us + 1; }, /EOF outside/],
  ['no progress after client half close', r => {
    const f = r.flows.find(f => f.mode === 'duplex' && f.completion === 'client-half-close'); f.half_close.down_frames_at_origin_eof = f.down_frames.length;
  }, /did not advance after half close/],
  ['no progress after server half close', r => {
    const f = r.flows.find(f => f.mode === 'duplex' && f.completion === 'server-ended'); f.half_close.up_frames_at_server_eof = f.up_frames.length;
  }, /did not advance after half close/],
  ['half-close order reversed', r => {
    const f = r.flows.find(f => f.mode === 'duplex'); f.half_close.server_read_eof_us = f.half_close.origin_read_eof_us;
  }, /half close order/],
  ['missing checkpoint', r => { r.checkpoints.pop(); }, /missing after-b1-retire/],
  ['missing flow from checkpoint', r => { r.checkpoints[0].flows.shift(); }, /missing b0/],
  ['checkpoint has impossible count', r => { r.checkpoints[0].flows[0].down_frames = 999; }, /count exceeds/],
  ['checkpoint claims future frames', r => { r.checkpoints[0].flows[0].down_frames = 10; }, /future frame/],
  ['old stream stalls across handoff', r => {
    r.checkpoints[1].flows[0].down_frames = r.checkpoints[0].flows[0].down_frames;
  }, /no checkpoint progress/],
  ['candidate stalls across retirement', r => {
    const before = r.checkpoints.find(c => c.name === 'before-b0-retire');
    const after = r.checkpoints.find(c => c.name === 'after-b0-retire');
    const id = candidate(r).id;
    after.flows.find(f => f.id === id).down_frames = before.flows.find(f => f.id === id).down_frames;
  }, /did not advance/],
];

for (const [name, mutate, message] of mutations) {
  test(`rejects ${name}`, () => {
    const r = validResult();
    mutate(r);
    assert.throws(() => verifyResult(r, options()), message);
  });
}

test('requires independent binary and harness provenance', () => {
  assert.throws(() => verifyResult(validResult(), { expectedBinarySha256: hashes }), /harness exit/);
  assert.throws(() => verifyResult(validResult(), { expectedBinarySha256: hashes, harnessExitCode: 1 }), /harness exit/);
  assert.throws(() => verifyResult(validResult(), { harnessExitCode: 0 }), /independent binary manifest/);
});

// Opt in with a real, completed H9 run. CI always exercises the synthetic
// counterexamples above; this block additionally prevents fixture-only success
// when accepting a new real-process evidence batch.
if (process.env.H9_REAL_RESULT || process.env.H9_REAL_MANIFEST) {
  const filename = process.env.H9_REAL_RESULT;
  const manifest = process.env.H9_REAL_MANIFEST;
  assert(filename && manifest, 'set both H9_REAL_RESULT and H9_REAL_MANIFEST');
  const real = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const realOptions = {
    expectedBinarySha256: JSON.parse(fs.readFileSync(manifest, 'utf8')).binary_sha256,
    harnessExitCode: Number(fs.readFileSync(path.join(path.dirname(filename), 'exit-code.txt'), 'utf8').trim()),
  };
  test('accepts the selected real H9 result and independent manifest', () => {
    assert.equal(verifyResult(real, realOptions).correctness_passed, true);
  });
  const routePause = findEvent(real, 'routing-update-paused').at_us;
  const overlapping = real.requests.findIndex(q => q.marker === 'origin-2' &&
    q.dispatch_us + 3 < routePause && q.dispatch_us + q.http_headers_us >= routePause);
  if (overlapping >= 0) {
    test('rejects a real in-flight new-origin request falsely completed before pause', () => {
      const changed = structuredClone(real), q = changed.requests[overlapping];
      q.local_adapter_connect_us = 1; q.end_to_end_inner_tls_us = 2;
      q.http_headers_us = routePause - q.dispatch_us - 1; q.total_us = q.http_headers_us + 1;
      assert.throws(() => verifyResult(changed, realOptions), /wrong origin before route pause/);
    });
  }
  const realMutations = [
    ['empty request list', r => { r.requests = []; }],
    ['missing request path', r => { delete r.requests[0].path; }],
    ['missing request phase', r => { delete r.requests[0].phase; }],
    ['empty retirement phase for one path', r => { r.requests = r.requests.filter(q => q.path !== 'via-A' || q.phase !== 'retirement'); }],
    ['empty pause probes', r => { r.pause_requests = []; }],
    ['first-frame-only stream', r => {
      const f = oldFlow(r); f.down_frames = f.down_frames.slice(0, 1); f.verified_down_bytes = FRAME_BYTES;
    }],
    ['old stream without handoff coverage', r => { oldFlow(r).down_frames.forEach(f => { f.at_us = oldFlow(r).started_us; }); }],
    ['candidate without retirement coverage', r => { candidate(r).down_frames.forEach(f => { f.at_us = candidate(r).started_us; }); }],
    ['nonfinite stats', r => { r.b0_stats.injected = Infinity; }],
    ['wrong child exit code', r => { r.processes.find(p => p.name === 'b0').wait.exit_code = 7; }],
    ['wrong origin after route commit', r => { r.requests.find(q => q.phase === 'routing-update-post').marker = 'origin-1'; }],
    ['new origin for pre-pause completed response', r => {
      const pause = findEvent(r, 'routing-update-paused').at_us;
      r.requests.find(q => q.dispatch_us + q.http_headers_us < pause).marker = 'origin-2';
    }],
    ['TLS-only mislabeled TCP half close', r => { r.half_close_transport = 'tls-only'; }],
    ['lost sequence', r => { oldFlow(r).down_frames.splice(1, 1); }],
    ['duplicate sequence', r => { oldFlow(r).down_frames[1].seq = 0; }],
    ['byte mismatch', r => { oldFlow(r).verified_down_bytes++; }],
    ['forged matching payload hashes', r => { oldFlow(r).down_frames[0].sha256 = oldFlow(r).down_frames[0].expected_sha256 = sha('wrong'); }],
    ['missing ready', r => { r.events = r.events.filter(e => e.name !== 'b1-ready'); }],
    ['missing listener identity', r => { delete findEvent(r, 'b1-ready').listeners.find(l => l.role === 'public').socket_cookie; }],
    ['wrong binary hash', r => { findEvent(r, 'b1-ready').binary_sha256 = sha('wrong'); }],
    ['bad retirement proof', r => { findEvent(r, 'b0-drain-certified').certificate.background_active = 1; }],
    ['forced cleanup', r => { r.processes.find(p => p.name === 'b0').cleanup.forced = true; }],
    ['missing half-close evidence', r => { delete r.flows.find(f => f.mode === 'duplex').half_close; }],
    ['missing receiver EOF', r => { delete oldFlow(r).half_close.server_read_eof; }],
    ['missing origin EOF', r => { oldFlow(r).half_close.origin_read_eof = false; }],
    ['missing final continuity checkpoint', r => { r.checkpoints = r.checkpoints.filter(c => c.name !== 'after-b1-retire'); }],
  ];
  for (const [name, mutate] of realMutations) {
    test(`rejects real H9 evidence mutated with ${name}`, () => {
      const changed = structuredClone(real);
      mutate(changed);
      assert.throws(() => verifyResult(changed, realOptions), assert.AssertionError);
    });
  }
}

module.exports = { validResult };
