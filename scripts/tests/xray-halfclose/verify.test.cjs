'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {verify, digest, FRAME_BYTES} = require('./verify.cjs');
const hash = 'a'.repeat(64);
function sample(expect = 'complete') {
  const manifest = {path: 'direct-REALITY', direction: 'download', transport: 'tls-and-tcp', expect, sha256: {server: hash, client: hash, harness: hash}};
  const failed = expect === 'client-timeout', count = failed ? 33 : 105;
  const frames = Array.from({length: count}, (_, seq) => ({seq, at_us: 110000 + seq * 30000, bytes: FRAME_BYTES, sha256: digest(seq), expected_sha256: digest(seq)}));
  const flow = {id: 'boundary-direct-REALITY', path: 'direct-REALITY', generation: 'b0', mode: 'download', completion: 'server-ended', marker: 'origin-1', started_us: 100000, stop_requested_us: failed ? 0 : 3240000, finished_us: failed ? 0 : 3260000, error: failed ? 'frame 33 header: EOF' : '', up_frames: [], down_frames: frames, verified_up_bytes: 0, verified_down_bytes: failed ? 0 : frames.length * FRAME_BYTES, sent_up_frames: 0, half_close: {client_write_closed_us: 115000, down_frames_at_client_close: 1, origin_read_eof: true, origin_read_eof_us: 120000, ...(failed ? {error_observed_us: 1120000} : {server_read_eof: true, server_read_eof_us: 3250000})}};
  const r = {schema_version: 10, run_id: 'r-123', h10_path: manifest.path, h10_direction: manifest.direction, half_close_transport: manifest.transport, boundary: 'early-download', negative_control: '', timeout_policy_seconds: {conn_idle: 300, uplink_only: 1, downlink_only: 1}, required_active_after_eof_us: 3000000, initial_persistent_flows: 1, frame_interval_ms: 30, requests: [], pause_requests: [], checkpoints: [], errors: [], application_reconnects: 0, new_request_failures: 0, flows: [flow], test_failed: failed, stream_errors: failed ? [flow.id + ': ' + flow.error] : [], binary_sha256: {b0: hash, client: hash}, expected_binary_sha256: {b0: hash, client: hash}, b0_stats: {'vless>>>vision>>>splice_bytes': 12345}, processes: ['b0', 'fixed-A', 'fixed-client'].map((name, index) => ({name, pid: index + 100, binary_sha256: hash, wait: {exit_code: failed ? -1 : 0, signal: failed ? 'killed' : '', error: failed ? 'signal: killed' : '', at_us: failed ? 1150000 : 3300000}, cleanup: {forced: failed}}))};
  r.events = r.processes.map(p => ({name: p.name + '-ready', pid: p.pid, binary_sha256: p.binary_sha256, at_us: 90000}));
  Object.assign(r.events[0], {config_digest: hash, config_sha256: hash, selected_origin: 1, listeners: ['public', 'public', 'cover'].map((role, i) => ({role, socket_inode: i + 10, socket_cookie: i + 20, socket_type: 1, accept_conn: 1, protocol: 6, address: '127.0.0.1:' + (1000 + i)}))});
  if (!failed) {
    r.events.push({name: 'boundary-complete', at_us: 3280000});
    for (const p of r.processes) r.events.push({name: p.name + '-retirement-signaled', pid: p.pid, at_us: 3290000}, {name: p.name + '-exit-observed', pid: p.pid, at_us: 3310000, exit_code: 0, exit_signal: '', wait_error: ''});
  }
  return {r, manifest, code: failed ? 1 : 0};
}
test('accepts clean post-half-close download with actual payload past three seconds', () => { const s = sample(); assert.equal(verify(s.r, s.manifest, s.code).correctness_passed, true); });
test('classifies exact known timeout separately from correctness pass', () => { const s = sample('client-timeout'); assert.equal(verify(s.r, s.manifest, s.code).correctness_passed, false); });
function uploadSample() {
  const s = sample(), f = s.r.flows[0];
  s.manifest.direction = s.r.h10_direction = f.mode = 'upload';
  f.up_frames = f.down_frames; f.down_frames = [];
  f.verified_up_bytes = f.verified_down_bytes; f.verified_down_bytes = 0; f.sent_up_frames = f.up_frames.length;
  f.half_close = {server_read_eof: true, server_read_eof_us: 120000, server_terminal_us: 115000, up_frames_at_server_eof: 1, origin_read_eof: true, origin_read_eof_us: 3250000, client_write_closed_us: 3245000};
  return s;
}
test('accepts sustained upload after early actual server EOF', () => { const s = uploadSample(); assert.equal(verify(s.r, s.manifest, s.code).correctness_passed, true); });
test('rejects upload write-half-close after completion', () => { const s = uploadSample(); s.r.flows[0].half_close.client_write_closed_us = 9999999; assert.throws(() => verify(s.r, s.manifest, s.code)); });
test('rejects upload missing final write-half-close', () => { const s = uploadSample(); delete s.r.flows[0].half_close.client_write_closed_us; assert.throws(() => verify(s.r, s.manifest, s.code)); });
for (const [name, mutate] of [
  ['legacy schema', s => { s.r.schema_version = 9; }],
  ['two paths share cleanup', s => { s.r.flows.push(structuredClone(s.r.flows[0])); }],
  ['wrong path', s => { s.r.h10_path = 'via-A'; }],
  ['wrong binary', s => { s.r.processes[0].binary_sha256 = 'b'.repeat(64); }],
  ['empty frames', s => { s.r.flows[0].down_frames = []; }],
  ['corrupt payload self-approved', s => { s.r.flows[0].down_frames[0].sha256 = s.r.flows[0].down_frames[0].expected_sha256 = 'b'.repeat(64); }],
  ['sequence gap', s => { s.r.flows[0].down_frames[1].seq = 3; }],
  ['short duration', s => { s.r.flows[0].down_frames = s.r.flows[0].down_frames.slice(0, 50); }],
  ['no clean EOF', s => { delete s.r.flows[0].half_close.server_read_eof; }],
  ['TLS-only mislabeled TCP', s => { s.r.half_close_transport = 'tls-only'; }],
  ['timeout raised', s => { s.r.timeout_policy_seconds.downlink_only = 24 * 3600; }],
  ['forced cleanup', s => { s.r.processes[0].cleanup.forced = true; }],
  ['nonzero child exit', s => { s.r.processes[0].wait.exit_code = 3; }],
  ['missing child', s => { s.r.processes.pop(); }],
  ['harness failure', s => { s.code = 1; }],
  ['no splice', s => { s.r.b0_stats = {}; }],
  ['infinite splice counter', s => { s.r.b0_stats['vless>>>vision>>>splice_bytes'] = Infinity; }],
  ['negative final EOF', s => { s.r.flows[0].half_close.server_read_eof_us = -1; }],
  ['duplicate child PID', s => { s.r.processes[1].pid = s.r.processes[0].pid; }],
  ['changed pacing', s => { s.r.frame_interval_ms = 999; }],
  ['stop after completion', s => { s.r.flows[0].stop_requested_us = 9000000; }],
  ['midstream stall', s => { s.r.flows[0].down_frames.slice(30).forEach(f => { f.at_us += 900000; }); }],
  ['missing actual write half close', s => { delete s.r.flows[0].half_close.client_write_closed_us; }],
  ['second EOF before final payload', s => { s.r.flows[0].half_close.server_read_eof_us = 120001; }],
  ['missing ready events', s => { s.r.events = []; }],
  ['ready with wrong PID', s => { s.r.events[0].pid++; }],
  ['duplicate listener identities', s => { s.r.events[0].listeners[1].socket_inode = 10; }],
  ['forged exit event', s => { s.r.events.find(e => e.name === 'b0-exit-observed').exit_code = 3; }],
  ['signal after actual Wait', s => { s.r.events.find(e => e.name === 'b0-retirement-signaled').at_us = 9000000; }],
  ['two frames separated by three seconds', s => { const f = s.r.flows[0]; const lastTime = f.down_frames.at(-1).at_us; f.down_frames = f.down_frames.slice(0, 2); f.down_frames[1].at_us = lastTime; f.verified_down_bytes = FRAME_BYTES * 2; }],
  ['late close falsely labeled early', s => { s.r.flows[0].half_close.origin_read_eof_us = 1500000; s.r.flows[0].half_close.client_write_closed_us = 1490000; }],
  ['non-stream listener', s => { s.r.events[0].listeners[0].socket_type = 2; }],
  ['initial stall after EOF', s => { s.r.flows[0].down_frames.forEach(f => { f.at_us += 250000; }); }],
]) test('rejects ' + name, () => { const s = sample(); mutate(s); assert.throws(() => verify(s.r, s.manifest, s.code)); });
for (const [name, mutate] of [
  ['generic connection error', s => { s.r.flows[0].error = 'connection refused'; }],
  ['harness skipped/zero', s => { s.code = 0; }],
  ['early handshake failure', s => { s.r.flows[0].down_frames = s.r.flows[0].down_frames.slice(0, 2); }],
  ['wrong elapsed time', s => { s.r.flows[0].half_close.error_observed_us = 9000000; }],
  ['stalled before failure', s => { s.r.flows[0].down_frames.forEach(f => { f.at_us = 150000; }); }],
  ['unrelated stream error', s => { s.r.stream_errors.push('other failure'); }],
  ['unexpected process crash', s => { s.r.processes[0].wait.signal = 'segmentation fault'; }],
  ['unsupported via-A expected failure', s => { s.manifest.path = s.r.h10_path = s.r.flows[0].path = 'via-A'; s.r.flows[0].id = 'boundary-via-A'; }],
  ['frames after error', s => { s.r.flows[0].down_frames.forEach(f => { f.at_us += 1100000; }); }],
  ['child exited before failure', s => { s.r.processes[0].wait.at_us = 1010000; }],
  ['deliberately stopped before failure', s => { s.r.flows[0].stop_requested_us = 500000; }],
]) test('does not accept arbitrary failure as known regression: ' + name, () => { const s = sample('client-timeout'); mutate(s); assert.throws(() => verify(s.r, s.manifest, s.code)); });
module.exports = {sample};
