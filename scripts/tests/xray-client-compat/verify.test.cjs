'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {verify, verifyPair, FRAME_BYTES, frameDigest, frameBucketDigest} = require('./verify.cjs');
const hashes = Object.fromEntries(['before', 'after', 'client', 'A', 'harness', 'config', 'template'].map((name, i) => [name, String(i + 1).repeat(64)]));

function evidence(count, first = 110000, interval = 30000) {
  return {count, bytes: count * FRAME_BYTES, first_us: count ? first : 0,
    last_us: count ? first + (count - 1) * interval : 0, max_gap_us: count > 1 ? interval : 0,
    sha256: frameBucketDigest(0, count), expected_sha256: frameBucketDigest(0, count)};
}

function samples(e) {
  return Array.from({length: Math.min(3, e.count)}, (_, seq) => ({seq, bytes: FRAME_BYTES,
    at_us: e.first_us + seq * 30000, sha256: frameDigest(seq), expected_sha256: frameDigest(seq)}));
}

function sample(scene = 'halfclose', failed = false) {
  const manifest = {schema_version: 11, pair_id: 'synthetic-pair', server_variant: 'after',
    client: {family: 'xray', version: 'synthetic-v1', source: 'synthetic fixture, not a real client claim', sha256: hashes.client},
    transport: 'reality-vision', path: 'direct', scene, concurrency: 1, duration_ms: 3000, frame_interval_ms: 30,
    direction: 'download', half_close_transport: 'tls-and-tcp', expect: failed ? 'known-client-timeout' : 'complete',
    idle_mode: 'resume', idle_ms: 3000, read_delay_ms: 100,
    binary_sha256: {b0: hashes.after, b1: hashes.after, b2: hashes.after, A: hashes.A, client: hashes.client},
    server_before_sha256: hashes.before, server_after_sha256: hashes.after, harness_sha256: hashes.harness,
    config_template_sha256: hashes.template,
    configs: ['b0', 'fixed-A', 'fixed-client'].map(role => ({role, path: '/synthetic/' + role + '.json', sha256: hashes.config}))};
  const count = failed ? 33 : 108, duplex = scene !== 'halfclose';
  const f = {id: 'flow-0', path: 'direct', generation: 'b0', marker: 'origin-1', mode: duplex ? 'duplex' : 'download',
    started_us: 100000, stop_requested_us: failed ? 0 : 3330000, finished_us: failed ? 0 : 3360000,
    completion: 'server-ended', error: failed ? 'frame 33 header: EOF' : '',
    evidence: {up: evidence(duplex ? count : 0), down: evidence(count), sent_up: evidence(duplex ? count : 0, 109000), sent_down: evidence(count, 109000)},
    verified_up_bytes: duplex ? count * FRAME_BYTES : 0, verified_down_bytes: failed ? 0 : count * FRAME_BYTES,
    sent_up_frames: duplex ? count : 0,
    half_close: {client_write_closed_us: duplex ? 3335000 : 115000, down_frames_at_client_close: duplex ? count : 1,
      origin_read_eof: true, origin_read_eof_us: duplex ? 3350000 : 120000,
      ...(failed ? {error_observed_us: 1120000} : {server_read_eof: true, server_read_eof_us: 3350000})},
    workers: ['client-reader', 'client-writer', 'origin-reader', 'origin-writer'].map(name => ({name, joined: true, at_us: failed ? 1170000 : 3355000, error: ''}))};
  f.up_frames = samples(f.evidence.up); f.down_frames = samples(f.evidence.down);
  const r = {schema_version: 11, run_id: 'r-synthetic', client_kind: manifest.client.family,
    ...Object.fromEntries(['transport', 'path', 'scene', 'concurrency', 'duration_ms', 'frame_interval_ms', 'direction', 'half_close_transport', 'idle_mode', 'idle_ms', 'read_delay_ms'].map(key => [key, manifest[key]])),
    binary_sha256: {...manifest.binary_sha256}, configs: structuredClone(manifest.configs), application_reconnects: 0,
    new_request_failures: 0, client_timeout_policy: 'unmodified client defaults',
    timeout_policy_seconds: {server_conn_idle: 300, server_uplink_only: 1, server_downlink_only: 1, A_conn_idle: 300, A_uplink_only: 1, A_downlink_only: 1},
    requests: failed ? [] : [{path: 'direct', error: '', marker: 'origin-1', scheduled_us: 1000000, dispatch_us: 1000000,
      local_adapter_connect_us: 1000, end_to_end_inner_tls_us: 2000, http_headers_us: 3000, total_us: 4000}], pause_requests: [],
    test_failed: failed, errors: [], stream_errors: failed ? [f.id + ': ' + f.error] : [], flows: [f],
    progress_begin_us: 100000, progress_end_us: 3400000,
    progress_flow_ids: [f.id], progress_buckets: [100000, 1100000, 2100000, 3100000, 3400000].map(at_us => ({at_us, partial: at_us === 100000 || at_us === 3400000,
      counts: [[duplex ? Math.min(count, Math.max(0, Math.floor((at_us - 110000) / 30000) + 1)) : 0,
        Math.min(count, Math.max(0, Math.floor((at_us - 110000) / 30000) + 1))]]})),
    processes: ['b0', 'fixed-A', 'fixed-client'].map((name, i) => ({name, pid: 100 + i,
      binary_sha256: manifest.binary_sha256[name === 'fixed-A' ? 'A' : name === 'fixed-client' ? 'client' : name],
      cleanup: {forced: failed}, wait: {at_us: failed ? 1200000 : 3500000,
        exit_code: failed ? -1 : 0, signal: failed ? 'killed' : '', error: failed ? 'signal: killed' : ''}}))};
  r.events = r.processes.map(p => ({name: p.name + '-ready', pid: p.pid, binary_sha256: p.binary_sha256, config_sha256: hashes.config, at_us: 90000}));
  Object.assign(r.events[0], {config_digest: hashes.config, listeners: ['public', 'public', 'cover'].map((role, i) => ({role, address: '127.0.0.1:' + (1000 + i), socket_inode: 10 + i, socket_cookie: 20 + i, socket_type: 1, accept_conn: 1, protocol: 6}))});
  if (!failed) {
    r.events.push(...r.processes.map(p => ({name: p.name + '-retirement-signaled', pid: p.pid, at_us: 3450000})));
    r.events.push(...r.processes.map(p => ({name: p.name + '-exit-observed', pid: p.pid, at_us: 3510000, exit_code: 0, exit_signal: '', wait_error: ''})));
  }
  return {r, manifest, options: {exitCode: failed ? 1 : 0}};
}

function check(s) { return verify(s.r, s.manifest, s.options); }
test('clean half-close evidence is accepted without inferring general stability or accounting', () => {
  const result = check(sample());
  assert.equal(result.correctness_passed, true);
  assert.equal(result.accounting_verified, false);
  assert.equal(result.long_soak_passed, false);
});
test('short soak is accepted as a short observation, never a 30-minute soak', () => {
  const result = check(sample('soak'));
  assert.equal(result.correctness_passed, true);
  assert.equal(result.long_soak_passed, false);
});
test('a final partial bucket shorter than one frame interval need not advance', () => {
  const s = sample('soak');
  s.r.progress_end_us = 3105000;
  s.r.progress_buckets.splice(-1, 0, {at_us: 3105000, partial: true, counts: [[100, 100]]});
  assert.equal(check(s).correctness_passed, true);
});
test('known-looking timeout remains correctness=false and needs a paired observation', () => {
  const result = check(sample('halfclose', true));
  assert.equal(result.correctness_passed, false);
  assert.equal(result.observed_outcome, 'client-timeout-signature');
  assert.equal(result.attribution, 'requires-before-after-pair');
});

for (const [name, mutate, scene = 'halfclose'] of [
  ['old schema', s => { s.r.schema_version = 10; }],
  ['manifest schema absent', s => { delete s.manifest.schema_version; }],
  ['unknown client', s => { s.manifest.client.family = s.r.client_kind = 'curl'; }],
  ['wrong actual client family', s => { s.r.client_kind = 'mihomo'; }],
  ['missing client provenance', s => { delete s.manifest.client.source; }],
  ['wrong client executable', s => { s.r.processes[2].binary_sha256 = hashes.before; }],
  ['relay wrongly bound to client', s => { s.r.processes[1].binary_sha256 = hashes.client; }],
  ['before and after are identical', s => { s.manifest.server_before_sha256 = hashes.after; }],
  ['candidate generations were not changed', s => { s.manifest.binary_sha256.b1 = hashes.before; }],
  ['actual config differs', s => { s.r.configs[0].sha256 = hashes.before; }],
  ['ready config differs', s => { s.r.events[0].config_sha256 = hashes.before; }],
  ['missing independent config', s => { s.manifest.configs.pop(); }],
  ['missing relay process', s => { s.r.processes.splice(1, 1); }],
  ['duplicate PID', s => { s.r.processes[1].pid = s.r.processes[0].pid; }],
  ['wrong ready PID', s => { s.r.events[0].pid++; }],
  ['duplicate listener cookie', s => { s.r.events[0].listeners[1].socket_cookie = 20; }],
  ['non-listening socket', s => { s.r.events[0].listeners[0].accept_conn = 0; }],
  ['child forced cleanup', s => { s.r.processes[0].cleanup.forced = true; }],
  ['nonzero Wait status', s => { s.r.processes[0].wait.exit_code = 1; }],
  ['Wait before signal', s => { s.r.processes[0].wait.at_us = 3400000; }],
  ['exit observation changed', s => { s.r.events.find(e => e.name === 'b0-exit-observed').exit_code = 3; }],
  ['empty requests-only test', s => { s.r.flows = []; }],
  ['reconnection', s => { s.r.application_reconnects = 1; }],
  ['wrong origin', s => { s.r.flows[0].marker = 'origin-2'; }],
  ['wrong path', s => { s.r.flows[0].path = 'via-A'; }],
  ['infinite total', s => { s.r.flows[0].evidence.down.bytes = Infinity; }],
  ['unsafe count', s => { s.r.flows[0].evidence.down.count = Number.MAX_SAFE_INTEGER + 1; }],
  ['wrong byte total', s => { s.r.flows[0].evidence.down.bytes--; }],
  ['self-approved corrupt hash', s => { s.r.flows[0].evidence.down.sha256 = s.r.flows[0].evidence.down.expected_sha256 = hashes.before; }],
  ['sender mismatch', s => { s.r.flows[0].evidence.sent_down = evidence(109, 109000); }],
  ['sample sequence gap', s => { s.r.flows[0].down_frames[1].seq = 8; }],
  ['sample payload corruption', s => { s.r.flows[0].down_frames[1].sha256 = hashes.before; }],
  ['unbounded per-frame payload log', s => { s.r.flows[0].down_frames.push(s.r.flows[0].down_frames[2]); }],
  ['impossible maximum gap', s => { s.r.flows[0].evidence.down.max_gap_us = 1; }],
  ['stalled data', s => { s.r.flows[0].evidence.down.max_gap_us = 300000; }],
  ['missing real EOF', s => { s.r.flows[0].half_close.server_read_eof = false; }],
  ['EOF precedes final payload', s => { s.r.flows[0].half_close.server_read_eof_us = 200000; }],
  ['reader never joined', s => { s.r.flows[0].workers[0].joined = false; }],
  ['missing writer join', s => { s.r.flows[0].workers.pop(); }],
  ['worker join after completion', s => { s.r.flows[0].workers[0].at_us = 9999999; }],
  ['worker error hidden', s => { s.r.flows[0].workers[0].error = 'EOF before terminal'; }],
  ['half close was late', s => { s.r.flows[0].half_close.origin_read_eof_us = 1000000; }],
  ['close-notify mislabeled TCP', s => { s.r.half_close_transport = 'tls-only'; }],
  ['changed duration', s => { s.r.duration_ms = 1; }],
  ['too short for boundary', s => { s.manifest.duration_ms = s.r.duration_ms = 1000; }],
  ['missing progression', s => { s.r.progress_buckets = []; }],
  ['stalled stream hidden by progression', s => { s.r.progress_buckets[2].counts[0][1] = s.r.progress_buckets[1].counts[0][1]; }],
  ['progress baseline nonzero', s => { s.r.progress_buckets[0].counts[0][1] = 1; }],
  ['progress final total differs', s => { s.r.progress_buckets.at(-1).counts[0][1]--; }],
  ['progress bucket lost', s => { s.r.progress_buckets.splice(2, 1); }],
  ['interior stall relabeled partial', s => { s.r.progress_buckets[2].partial = true; s.r.progress_buckets[2].counts[0][1] = s.r.progress_buckets[1].counts[0][1]; }],
  ['missing progress flow ID', s => { s.r.progress_flow_ids = []; }],
  ['half-hour claim on short data', s => { s.r.duration_ms = s.manifest.duration_ms = 1800000; }, 'soak'],
  ['serial flows called concurrent', s => { s.r.concurrency = s.manifest.concurrency = 32; }, 'soak'],
  ['soak only covers one direction', s => { s.r.flows[0].mode = 'download'; }, 'soak'],
]) test('rejects ' + name, () => { const s = sample(scene); mutate(s); assert.throws(() => check(s)); });

for (const [name, mutate] of [
  ['third-party client failure', s => { s.manifest.client.family = s.r.client_kind = 'sing-box'; }],
  ['unrelated failure message', s => { s.r.flows[0].error = 'connection refused'; }],
  ['harness exited successfully', s => { s.options.exitCode = 0; }],
  ['wrong timing', s => { s.r.flows[0].half_close.error_observed_us = 5000000; }],
  ['failure preceded payload', s => { s.r.flows[0].half_close.error_observed_us = 1000000; }],
  ['arbitrary child crash', s => { s.r.processes[0].wait.signal = 'segmentation fault'; }],
  ['requested stop', s => { s.r.flows[0].stop_requested_us = 1000000; }],
  ['clean completion', s => { s.r.flows[0].finished_us = 1200000; }],
  ['other path', s => { s.manifest.path = s.r.path = s.r.flows[0].path = 'via-A'; }],
  ['other security', s => { s.manifest.transport = s.r.transport = 'tls-vision'; }],
  ['other close semantics', s => { s.manifest.half_close_transport = s.r.half_close_transport = 'tls-only'; }],
]) test('does not turn arbitrary failure into a known boundary: ' + name, () => { const s = sample('halfclose', true); mutate(s); assert.throws(() => check(s)); });

function pair(failed = false) {
  const a = sample('halfclose', failed), b = sample('halfclose', failed);
  a.manifest.server_variant = 'before';
  for (const role of ['b0', 'b1', 'b2']) a.manifest.binary_sha256[role] = a.r.binary_sha256[role] = hashes.before;
  a.r.processes[0].binary_sha256 = a.r.events[0].binary_sha256 = hashes.before;
  return [check(a), check(b)];
}
test('same client/template before/after pair is accepted', () => { assert.equal(verifyPair(...pair()).correctness_passed, true); });
test('paired timeout signature remains false and is not a root-cause proof', () => {
  const result = verifyPair(...pair(true));
  assert.equal(result.correctness_passed, false);
  assert.equal(result.attribution, 'pre-existing-client-boundary-signature');
  assert.equal(result.root_cause_proven, false);
});
for (const field of ['client', 'A_sha256', 'config_template_sha256', 'transport', 'path', 'scene', 'concurrency', 'duration_ms', 'frame_interval_ms', 'direction', 'half_close_transport']) {
  test('rejects unmatched pair ' + field, () => { const values = pair(); values[1][field] = 'different'; assert.throws(() => verifyPair(...values)); });
}

module.exports = {sample, evidence, samples};

// Captured sing-box 1.14.3 TLS direct smoke (H11 c004). Only local paths and
// endpoint labels were sanitized; payload hashes, counts and timings are real.
const recordedSmoke = {
  "r": {
    "application_reconnects": 0,
    "b0_stats": {
      "reverse>>>bridge>>>control_queue_failures": 0,
      "reverse>>>bridge>>>dispatch_rejected": 0,
      "reverse>>>bridge>>>probe_ack": 0,
      "reverse>>>bridge>>>probe_sent": 0,
      "reverse>>>bridge>>>probe_timeout": 0,
      "reverse>>>bridge>>>rtt_ms_le_100": 0,
      "reverse>>>bridge>>>rtt_ms_le_1000": 0,
      "reverse>>>bridge>>>rtt_ms_le_10000": 0,
      "reverse>>>bridge>>>rtt_ms_le_2000": 0,
      "reverse>>>bridge>>>rtt_ms_le_250": 0,
      "reverse>>>bridge>>>rtt_ms_le_50": 0,
      "reverse>>>bridge>>>rtt_ms_le_500": 0,
      "reverse>>>bridge>>>rtt_ms_le_5000": 0,
      "reverse>>>bridge>>>rtt_ms_le_750": 0,
      "reverse>>>bridge>>>telemetry_dropped": 0,
      "reverse>>>bridge>>>workers>>>CLOSED": 0,
      "reverse>>>bridge>>>workers>>>DEAD": 0,
      "reverse>>>bridge>>>workers>>>DRAINING": 0,
      "reverse>>>bridge>>>workers>>>READY": 0,
      "reverse>>>bridge>>>workers>>>SUSPECT": 0,
      "reverse>>>bridge>>>workers>>>VALIDATING": 0,
      "reverse>>>bridge>>>workers_closed": 0,
      "reverse>>>bridge>>>workers_created": 0,
      "reverse>>>portal>>>control_queue_failures": 0,
      "reverse>>>portal>>>dispatch_rejected": 0,
      "reverse>>>portal>>>probe_ack": 0,
      "reverse>>>portal>>>probe_sent": 0,
      "reverse>>>portal>>>probe_timeout": 0,
      "reverse>>>portal>>>rtt_ms_le_100": 0,
      "reverse>>>portal>>>rtt_ms_le_1000": 0,
      "reverse>>>portal>>>rtt_ms_le_10000": 0,
      "reverse>>>portal>>>rtt_ms_le_2000": 0,
      "reverse>>>portal>>>rtt_ms_le_250": 0,
      "reverse>>>portal>>>rtt_ms_le_50": 0,
      "reverse>>>portal>>>rtt_ms_le_500": 0,
      "reverse>>>portal>>>rtt_ms_le_5000": 0,
      "reverse>>>portal>>>rtt_ms_le_750": 0,
      "reverse>>>portal>>>telemetry_dropped": 0,
      "reverse>>>portal>>>workers>>>CLOSED": 0,
      "reverse>>>portal>>>workers>>>DEAD": 0,
      "reverse>>>portal>>>workers>>>DRAINING": 0,
      "reverse>>>portal>>>workers>>>READY": 0,
      "reverse>>>portal>>>workers>>>SUSPECT": 0,
      "reverse>>>portal>>>workers>>>VALIDATING": 0,
      "reverse>>>portal>>>workers_closed": 0,
      "reverse>>>portal>>>workers_created": 0,
      "user>>>handoff@example.test>>>traffic>>>downlink": 1721481,
      "user>>>handoff@example.test>>>traffic>>>uplink": 1736617,
      "vless>>>vision>>>completed_connections": 4,
      "vless>>>vision>>>completed_direct_connections": 4,
      "vless>>>vision>>>completed_splice_connections": 4,
      "vless>>>vision>>>connections": 4,
      "vless>>>vision>>>direct_bytes": 2324,
      "vless>>>vision>>>direct_connections": 4,
      "vless>>>vision>>>not_spliced>>>ended_before_direct": 0,
      "vless>>>vision>>>not_spliced>>>ended_before_splice": 0,
      "vless>>>vision>>>not_spliced>>>globally_disabled": 0,
      "vless>>>vision>>>not_spliced>>>inbound_ineligible": 0,
      "vless>>>vision>>>not_spliced>>>missing_outbound": 0,
      "vless>>>vision>>>not_spliced>>>outbound_ineligible": 0,
      "vless>>>vision>>>not_spliced>>>outbound_not_raw": 0,
      "vless>>>vision>>>not_spliced>>>outer_tls_not_13": 0,
      "vless>>>vision>>>not_spliced>>>raw_connection_unavailable": 0,
      "vless>>>vision>>>not_spliced>>>unknown": 0,
      "vless>>>vision>>>not_spliced>>>unsupported_command": 0,
      "vless>>>vision>>>not_spliced>>>unsupported_transport": 0,
      "vless>>>vision>>>not_spliced_connections": 0,
      "vless>>>vision>>>splice_bytes": 1714085,
      "vless>>>vision>>>splice_connections": 4
    },
    "binary_sha256": {
      "A": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "b0": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "b1": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "b2": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "client": "768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93"
    },
    "checkpoints": [
      {
        "at_us": 666492,
        "flows": [
          {
            "down_frames": 3,
            "id": "b0-direct-0",
            "up_frames": 3
          }
        ],
        "name": "baseline"
      }
    ],
    "client_kind": "sing-box",
    "client_timeout_policy": "unmodified client defaults",
    "concurrency": 1,
    "configs": [
      {
        "path": "/fixture/b0.json",
        "role": "b0",
        "sha256": "10da1fa4e1d07379b4837091951a4cdfb15681520a41fc9dc056d54b2856d36a"
      },
      {
        "path": "/fixture/fixed-A.json",
        "role": "fixed-A",
        "sha256": "50110ed58801a12274c2fb2c9f73660a78a2453ece4c844faa7339c2a2702d8f"
      },
      {
        "path": "/fixture/fixed-client.json",
        "role": "fixed-client",
        "sha256": "243521ed7af44046e48e738c601f0c55d96a73912d0d3602b7422e9fb6bb3edb"
      }
    ],
    "direction": "download",
    "duration_ms": 3000,
    "errors": [],
    "events": [
      {
        "address": "127.0.0.1:34029",
        "at_us": 156320,
        "marker": "origin-1",
        "name": "origin-1-bound"
      },
      {
        "address": "127.0.0.1:39105",
        "at_us": 156374,
        "marker": "origin-2",
        "name": "origin-2-bound"
      },
      {
        "at_us": 274709,
        "binary_sha256": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
        "config_digest": "b2eb39c02ba98649af3db807ae030265f215c2dbcf4c3534fab5c72be2e27d0b",
        "config_path": "/fixture/b0.json",
        "config_sha256": "10da1fa4e1d07379b4837091951a4cdfb15681520a41fc9dc056d54b2856d36a",
        "listeners": [
          {
            "role": "public",
            "depends_on": "",
            "address": "127.0.0.1:32789",
            "socket_inode": 23745979,
            "socket_cookie": 897162,
            "socket_type": 1,
            "accept_conn": 1,
            "family": 2,
            "protocol": 262,
            "reuse_addr": 1,
            "reuse_port": 1,
            "ipv6_only": 0,
            "nonblocking": true,
            "accepted": 0,
            "active": 0,
            "in_accept": true
          },
          {
            "role": "public",
            "depends_on": "",
            "address": "127.0.0.1:40355",
            "socket_inode": 23745977,
            "socket_cookie": 897161,
            "socket_type": 1,
            "accept_conn": 1,
            "family": 2,
            "protocol": 262,
            "reuse_addr": 1,
            "reuse_port": 1,
            "ipv6_only": 0,
            "nonblocking": true,
            "accepted": 0,
            "active": 0,
            "in_accept": true
          }
        ],
        "name": "b0-ready",
        "pid": 3537441,
        "prepare_us": 89651,
        "selected_origin": 1
      },
      {
        "at_us": 392824,
        "binary_sha256": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
        "config_path": "/fixture/fixed-A.json",
        "config_sha256": "50110ed58801a12274c2fb2c9f73660a78a2453ece4c844faa7339c2a2702d8f",
        "kind": "xray",
        "name": "fixed-A-ready",
        "netns_role": "forward",
        "pid": 3537498
      },
      {
        "at_us": 586077,
        "binary_sha256": "768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93",
        "config_path": "/fixture/fixed-client.json",
        "config_sha256": "243521ed7af44046e48e738c601f0c55d96a73912d0d3602b7422e9fb6bb3edb",
        "kind": "sing-box",
        "name": "fixed-client-ready",
        "netns_role": "client",
        "pid": 3537553
      },
      {
        "at_us": 666489,
        "name": "baseline-begin"
      },
      {
        "at_us": 666492,
        "name": "baseline"
      },
      {
        "at_us": 3823971,
        "name": "measurement-end"
      },
      {
        "at_us": 3823973,
        "name": "b0-retirement-signaled",
        "pid": 3537441
      },
      {
        "at_us": 3825794,
        "exit_code": 0,
        "exit_signal": "",
        "name": "b0-exit-observed",
        "pid": 3537441,
        "wait_error": ""
      },
      {
        "at_us": 3825796,
        "name": "fixed-A-retirement-signaled",
        "pid": 3537498
      },
      {
        "at_us": 3827129,
        "exit_code": 0,
        "exit_signal": "",
        "name": "fixed-A-exit-observed",
        "pid": 3537498,
        "wait_error": ""
      },
      {
        "at_us": 3827131,
        "name": "fixed-client-retirement-signaled",
        "pid": 3537553
      },
      {
        "at_us": 3828025,
        "exit_code": 0,
        "exit_signal": "",
        "name": "fixed-client-exit-observed",
        "pid": 3537553,
        "wait_error": ""
      }
    ],
    "flows": [
      {
        "evidence": {
          "up": {
            "count": 105,
            "bytes": 1720320,
            "first_us": 595137,
            "last_us": 3792533,
            "max_gap_us": 31237,
            "sha256": "fd90979a48d880558f2188e22b879572491d016d8b655a4847a3370aa92d4934",
            "expected_sha256": "fd90979a48d880558f2188e22b879572491d016d8b655a4847a3370aa92d4934"
          },
          "down": {
            "count": 101,
            "bytes": 1654784,
            "first_us": 595053,
            "last_us": 3670725,
            "max_gap_us": 31372,
            "sha256": "effd3cc00bbcb6138233cf3433326ae308b8b86dabef2621c4c5e5e456bc0468",
            "expected_sha256": "effd3cc00bbcb6138233cf3433326ae308b8b86dabef2621c4c5e5e456bc0468"
          },
          "sent_up": {
            "count": 105,
            "bytes": 1720320,
            "first_us": 595045,
            "last_us": 3792285,
            "max_gap_us": 31246,
            "sha256": "fd90979a48d880558f2188e22b879572491d016d8b655a4847a3370aa92d4934",
            "expected_sha256": "fd90979a48d880558f2188e22b879572491d016d8b655a4847a3370aa92d4934"
          },
          "sent_down": {
            "count": 101,
            "bytes": 1654784,
            "first_us": 594998,
            "last_us": 3670570,
            "max_gap_us": 31271,
            "sha256": "effd3cc00bbcb6138233cf3433326ae308b8b86dabef2621c4c5e5e456bc0468",
            "expected_sha256": "effd3cc00bbcb6138233cf3433326ae308b8b86dabef2621c4c5e5e456bc0468"
          }
        },
        "workers": [
          {
            "name": "origin-writer",
            "joined": true,
            "at_us": 3700657,
            "error": ""
          },
          {
            "name": "client-reader",
            "joined": true,
            "at_us": 3700730,
            "error": ""
          },
          {
            "name": "client-writer",
            "joined": true,
            "at_us": 3822917,
            "error": ""
          },
          {
            "name": "origin-reader",
            "joined": true,
            "at_us": 3823059,
            "error": ""
          }
        ],
        "id": "b0-direct-0",
        "path": "direct",
        "generation": "b0",
        "mode": "duplex",
        "marker": "origin-1",
        "started_us": 586083,
        "stop_requested_us": 3699557,
        "finished_us": 3823071,
        "completion": "server-ended",
        "up_frames": [
          {
            "at_us": 595137,
            "seq": 0,
            "bytes": 16384,
            "sha256": "dff765a589fd8d7df3f0f69bbc220454f1ef4ea6c5c642d79879809829c0b2ba",
            "expected_sha256": "dff765a589fd8d7df3f0f69bbc220454f1ef4ea6c5c642d79879809829c0b2ba"
          },
          {
            "at_us": 625788,
            "seq": 1,
            "bytes": 16384,
            "sha256": "ebb1b719a8cfe5681439d2a080bbde1daf5f52ca84ca58cbd47d3e0ad3a551cb",
            "expected_sha256": "ebb1b719a8cfe5681439d2a080bbde1daf5f52ca84ca58cbd47d3e0ad3a551cb"
          },
          {
            "at_us": 656369,
            "seq": 2,
            "bytes": 16384,
            "sha256": "f5c4b3610a577658b72eba0d3c19e6110fe94d927c1b1cc7aa0d07519e0648e5",
            "expected_sha256": "f5c4b3610a577658b72eba0d3c19e6110fe94d927c1b1cc7aa0d07519e0648e5"
          }
        ],
        "down_frames": [
          {
            "at_us": 595053,
            "seq": 0,
            "bytes": 16384,
            "sha256": "dff765a589fd8d7df3f0f69bbc220454f1ef4ea6c5c642d79879809829c0b2ba",
            "expected_sha256": "dff765a589fd8d7df3f0f69bbc220454f1ef4ea6c5c642d79879809829c0b2ba"
          },
          {
            "at_us": 625652,
            "seq": 1,
            "bytes": 16384,
            "sha256": "ebb1b719a8cfe5681439d2a080bbde1daf5f52ca84ca58cbd47d3e0ad3a551cb",
            "expected_sha256": "ebb1b719a8cfe5681439d2a080bbde1daf5f52ca84ca58cbd47d3e0ad3a551cb"
          },
          {
            "at_us": 656331,
            "seq": 2,
            "bytes": 16384,
            "sha256": "f5c4b3610a577658b72eba0d3c19e6110fe94d927c1b1cc7aa0d07519e0648e5",
            "expected_sha256": "f5c4b3610a577658b72eba0d3c19e6110fe94d927c1b1cc7aa0d07519e0648e5"
          }
        ],
        "sent_up_frames": 105,
        "verified_up_bytes": 1720320,
        "verified_down_bytes": 1654784,
        "error": "",
        "half_close": {
          "client_write_closed_us": 3822914,
          "down_frames_at_client_close": 101,
          "down_frames_at_origin_eof": 101,
          "origin_read_eof": true,
          "origin_read_eof_us": 3823055,
          "server_read_eof": true,
          "server_read_eof_us": 3700729,
          "server_terminal_us": 3700717,
          "up_frames_at_server_eof": 101,
          "up_frames_at_server_terminal": 101
        }
      }
    ],
    "frame_interval_ms": 30,
    "half_close_transport": "tls-only",
    "idle_mode": "resume",
    "idle_ms": 3000,
    "new_request_failures": 0,
    "path": "direct",
    "pause_requests": [],
    "processes": [
      {
        "name": "b0",
        "pid": 3537441,
        "binary_sha256": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
        "wait": {
          "exit_code": 0,
          "signal": "",
          "error": "",
          "at_us": 3825783
        },
        "cleanup": {
          "forced": false,
          "reason": ""
        }
      },
      {
        "name": "fixed-A",
        "pid": 3537498,
        "binary_sha256": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
        "wait": {
          "exit_code": 0,
          "signal": "",
          "error": "",
          "at_us": 3827119
        },
        "cleanup": {
          "forced": false,
          "reason": ""
        }
      },
      {
        "name": "fixed-client",
        "pid": 3537553,
        "binary_sha256": "768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93",
        "wait": {
          "exit_code": 0,
          "signal": "",
          "error": "",
          "at_us": 3828019
        },
        "cleanup": {
          "forced": false,
          "reason": ""
        }
      }
    ],
    "progress_begin_us": 666493,
    "progress_buckets": [
      {
        "at_us": 586082,
        "counts": [
          [
            0,
            0
          ]
        ],
        "partial": true
      },
      {
        "at_us": 666494,
        "counts": [
          [
            3,
            3
          ]
        ],
        "partial": true
      },
      {
        "at_us": 1669493,
        "counts": [
          [
            35,
            35
          ]
        ],
        "partial": false
      },
      {
        "at_us": 2668193,
        "counts": [
          [
            68,
            68
          ]
        ],
        "partial": false
      },
      {
        "at_us": 3676749,
        "counts": [
          [
            101,
            101
          ]
        ],
        "partial": false
      },
      {
        "at_us": 3699554,
        "counts": [
          [
            101,
            101
          ]
        ],
        "partial": true
      },
      {
        "at_us": 3823073,
        "counts": [
          [
            105,
            101
          ]
        ],
        "partial": true
      }
    ],
    "progress_end_us": 3699548,
    "progress_flow_ids": [
      "b0-direct-0"
    ],
    "read_delay_ms": 100,
    "requests": [
      {
        "path": "direct",
        "phase": "baseline",
        "scheduled_us": 1669496,
        "dispatch_us": 1669508,
        "local_adapter_connect_us": 1589,
        "end_to_end_inner_tls_us": 2838,
        "http_headers_us": 3053,
        "total_us": 3147,
        "marker": "origin-1",
        "error": ""
      },
      {
        "path": "direct",
        "phase": "baseline",
        "scheduled_us": 2668200,
        "dispatch_us": 2668208,
        "local_adapter_connect_us": 1571,
        "end_to_end_inner_tls_us": 2832,
        "http_headers_us": 3127,
        "total_us": 3367,
        "marker": "origin-1",
        "error": ""
      },
      {
        "path": "direct",
        "phase": "baseline",
        "scheduled_us": 3676751,
        "dispatch_us": 3676752,
        "local_adapter_connect_us": 1449,
        "end_to_end_inner_tls_us": 2358,
        "http_headers_us": 2459,
        "total_us": 2516,
        "marker": "origin-1",
        "error": ""
      }
    ],
    "run_id": "r-3553691984",
    "scene": "soak",
    "schema_version": 11,
    "stream_errors": [],
    "test_failed": false,
    "timeout_policy_seconds": {
      "A_conn_idle": 300,
      "A_downlink_only": 1,
      "A_uplink_only": 1,
      "server_conn_idle": 300,
      "server_downlink_only": 1,
      "server_uplink_only": 1
    },
    "transport": "tls-vision"
  },
  "manifest": {
    "schema_version": 11,
    "pair_id": "sing-box-1.14.3-tls-vision-direct-soak-1-download-tls-only",
    "server_variant": "after",
    "transport": "tls-vision",
    "path": "direct",
    "scene": "soak",
    "concurrency": 1,
    "duration_ms": 3000,
    "frame_interval_ms": 30,
    "direction": "download",
    "half_close_transport": "tls-only",
    "idle_mode": "resume",
    "idle_ms": 3000,
    "read_delay_ms": 100,
    "binary_sha256": {
      "b0": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "b1": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "b2": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "A": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
      "client": "768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93"
    },
    "server_before_sha256": "97b7b27382b0c40be8741b613eea0e5f26a6525db87e1adb5b825fadb6602836",
    "server_after_sha256": "5ceb488962f77aec69446402c9756075e578dcaf362bf90a7135cf5b257fae32",
    "harness_sha256": "b82a9be128a896f6727ca7240068935083f386410c6424c69c318d7eff8bc317",
    "config_template_sha256": "b7234fa43354a9afeab6e523fcfebc981d4b56228b5e2613caac231027edc984",
    "expect": "complete",
    "client": {
      "family": "sing-box",
      "version": "1.14.3",
      "source": "https://github.com/SagerNet/sing-box/releases/tag/v1.14.3",
      "sha256": "768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93"
    },
    "configs": [
      {
        "role": "b0",
        "path": "/fixture/b0.json",
        "sha256": "10da1fa4e1d07379b4837091951a4cdfb15681520a41fc9dc056d54b2856d36a"
      },
      {
        "role": "fixed-A",
        "path": "/fixture/fixed-A.json",
        "sha256": "50110ed58801a12274c2fb2c9f73660a78a2453ece4c844faa7339c2a2702d8f"
      },
      {
        "role": "fixed-client",
        "path": "/fixture/fixed-client.json",
        "sha256": "243521ed7af44046e48e738c601f0c55d96a73912d0d3602b7422e9fb6bb3edb"
      }
    ]
  },
  "options": {
    "exitCode": 0
  }
};

test('real sing-box smoke accepts a 23 ms final partial with no extra frame', () => {
  const value = check(structuredClone(recordedSmoke));
  assert.equal(value.correctness_passed, true);
  assert.equal(value.long_soak_passed, false);
});
for (const [name, mutate] of [
  ['entire-second stall', s => { s.r.progress_buckets[3].counts[0][0] = s.r.progress_buckets[2].counts[0][0]; }],
  ['entire-second stall called partial', s => { s.r.progress_buckets[3].partial = true; s.r.progress_buckets[3].counts[0][0] = s.r.progress_buckets[2].counts[0][0]; }],
  ['wrong receiver digest', s => { s.r.flows[0].evidence.up.sha256 = s.r.flows[0].evidence.up.expected_sha256 = hashes.before; }],
  ['one duplicated frame', s => { s.r.flows[0].evidence.up.count++; s.r.flows[0].evidence.up.bytes += FRAME_BYTES; }],
  ['wrong relay', s => { s.r.processes.find(p => p.name === 'fixed-A').binary_sha256 = hashes.before; }],
  ['early EOF forged', s => { s.r.flows[0].half_close.origin_read_eof_us = 1; }],
  ['missing writer result', s => { s.r.flows[0].workers.pop(); }],
  ['nonzero child exit', s => { s.r.processes[0].wait.exit_code = 2; }],
  ['unmeasured half hour', s => { s.manifest.duration_ms = s.r.duration_ms = 1800000; }],
]) test('real fixture rejects ' + name, () => { const s = structuredClone(recordedSmoke); mutate(s); assert.throws(() => check(s)); });
