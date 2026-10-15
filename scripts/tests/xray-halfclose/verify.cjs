'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const FRAME_BYTES = 16384;
function digest(seq) {
  const body = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + seq * 17) % 251;
  return crypto.createHash('sha256').update(body).digest('hex');
}
function integer(value, label, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, label);
}
function finiteTree(value) {
  if (typeof value === 'number') assert(Number.isFinite(value), 'nonfinite evidence');
  else if (value && typeof value === 'object') for (const child of Object.values(value)) finiteTree(child);
}
function verify(r, manifest, harnessExit) {
  finiteTree(r);
  assert.equal(r.schema_version, 10, 'H10 schema required');
  assert(/^r-[0-9]+$/.test(r.run_id), 'run identity');
  assert(['via-A', 'direct-REALITY'].includes(manifest.path), 'explicit path');
  assert(['download', 'upload'].includes(manifest.direction), 'explicit direction');
  assert(['tls-only', 'tls-and-tcp'].includes(manifest.transport), 'explicit transport');
  assert(['complete', 'client-timeout'].includes(manifest.expect), 'explicit expected outcome');
  for (const k of ['server', 'client', 'harness']) assert(/^[a-f0-9]{64}$/.test(manifest.sha256[k]), 'independent binary digest');
  assert.equal(r.h10_path, manifest.path, 'wrong path');
  assert.equal(r.h10_direction, manifest.direction, 'wrong direction');
  assert.equal(r.half_close_transport, manifest.transport, 'wrong half-close semantics');
  assert.equal(r.boundary, 'early-download', 'wrong boundary fixture');
  assert.equal(r.negative_control, '', 'unrelated negative control');
  assert.deepEqual(r.timeout_policy_seconds, {conn_idle: 300, uplink_only: 1, downlink_only: 1}, 'timeout policy changed');
  assert.equal(r.required_active_after_eof_us, 3000000, 'required duration changed');
  assert.equal(r.initial_persistent_flows, 1, 'not isolated single path');
  assert.equal(r.frame_interval_ms, 30, 'fixed 30 ms pacing required');
  for (const key of ['requests', 'pause_requests', 'checkpoints', 'errors']) assert.deepEqual(r[key], [], 'unexpected ' + key);
  assert.equal(r.application_reconnects, 0, 'reconnected');
  assert.equal(r.new_request_failures, 0, 'unexpected request errors');
  assert.equal(r.flows.length, 1, 'exactly one isolated flow required');
  const f = r.flows[0], hc = f.half_close;
  assert.equal(f.id, 'boundary-' + manifest.path);
  assert.equal(f.path, manifest.path);
  assert.equal(f.mode, manifest.direction);
  assert.equal(f.generation, 'b0');
  assert.equal(f.marker, 'origin-1');
  assert.equal(f.completion, 'server-ended');
  integer(f.started_us, 'started time', 1);
  const direction = manifest.direction === 'download' ? 'down' : 'up';
  const frames = f[direction + '_frames'];
  assert(Array.isArray(frames) && frames.length > 1, 'multiple frames required');
  assert.deepEqual(f[direction === 'down' ? 'up_frames' : 'down_frames'], [], 'unexpected opposite payload');
  let previous = f.started_us;
  for (const [seq, frame] of frames.entries()) {
    integer(frame.at_us, 'frame timestamp', previous);
    if (seq > 0) assert(frame.at_us - previous <= 200000, 'payload stalled for more than 200 ms');
    previous = frame.at_us;
    assert.equal(frame.seq, seq, 'missing/repeated frame');
    assert.equal(frame.bytes, FRAME_BYTES, 'frame size');
    assert.equal(frame.sha256, digest(seq), 'payload corruption');
    assert.equal(frame.expected_sha256, frame.sha256, 'self-reported payload mismatch');
  }
  const firstEOF = direction === 'down' ? 'origin_read_eof_us' : 'server_read_eof_us';
  assert.equal(hc[direction === 'down' ? 'origin_read_eof' : 'server_read_eof'], true, 'initial actual EOF not observed');
  integer(hc[firstEOF], 'first EOF timestamp', f.started_us);
  assert(frames.filter(frame => frame.at_us < hc[firstEOF]).length <= 5, 'payload shows half-close was not early');
  const firstAfterEOF = frames.find(frame => frame.at_us >= hc[firstEOF]);
  assert(firstAfterEOF && firstAfterEOF.at_us - hc[firstEOF] <= 200000, 'payload stalled immediately after EOF');
  if (direction === 'down') {
    integer(hc.client_write_closed_us, 'actual client write-half-close', f.started_us);
    integer(hc.down_frames_at_client_close, 'payload before initial half-close');
    assert(hc.down_frames_at_client_close <= 5, 'client did not close early');
    assert(Math.abs(hc.client_write_closed_us - hc[firstEOF]) <= 200000, 'client write close not near actual EOF');
  } else {
    integer(hc.server_terminal_us, 'actual server terminal', f.started_us);
    assert(hc.server_terminal_us <= hc[firstEOF], 'server EOF precedes terminal');
    integer(hc.up_frames_at_server_eof, 'payload before server EOF');
    assert(hc.up_frames_at_server_eof <= 5, 'server did not close early');
  }
  const names = new Set(), pids = new Set();
  assert(Array.isArray(r.events), 'events missing');
  const events = new Map();
  for (const event of r.events) {
    assert(typeof event.name === 'string' && !events.has(event.name), 'duplicate event');
    integer(event.at_us, 'event timestamp');
    events.set(event.name, event);
  }
  function event(name) { assert(events.has(name), 'missing event: ' + name); return events.get(name); }
  assert.equal(r.processes.length, 3, 'must observe all three Xray processes');
  for (const p of r.processes) {
    assert(['b0', 'fixed-A', 'fixed-client'].includes(p.name) && !names.has(p.name), 'unknown/duplicate process');
    names.add(p.name);
    integer(p.pid, 'actual PID', 1);
    assert(!pids.has(p.pid), 'duplicate child PID');
    pids.add(p.pid);
    assert.equal(p.binary_sha256, manifest.sha256[p.name === 'b0' ? 'server' : 'client'], 'wrong live process binary');
    integer(p.wait.at_us, 'Wait timestamp', f.started_us);
    const ready = event(p.name + '-ready');
    assert.equal(ready.pid, p.pid, 'ready PID differs from process');
    assert.equal(ready.binary_sha256, p.binary_sha256, 'ready executable differs');
    assert(ready.at_us < f.started_us, 'process not ready before flow');
  }
  const readyB = event('b0-ready');
  for (const key of ['config_digest', 'config_sha256']) assert(/^[a-f0-9]{64}$/.test(readyB[key]), 'ready config digest');
  assert.equal(readyB.selected_origin, 1, 'wrong ready origin');
  assert.equal(readyB.listeners.length, 3, 'listener evidence missing');
  assert.equal(readyB.listeners.filter(l => l.role === 'public').length, 2, 'public listeners missing');
  assert.equal(readyB.listeners.filter(l => l.role === 'cover').length, 1, 'cover listener missing');
  const inodes = new Set(), cookies = new Set();
  for (const listener of readyB.listeners) {
    integer(listener.socket_inode, 'listener inode', 1);
    integer(listener.socket_cookie, 'listener cookie', 1);
    assert.equal(listener.socket_type, 1, 'listener is not a stream socket');
    assert.equal(listener.accept_conn, 1, 'listener does not accept');
    integer(listener.protocol, 'listener protocol', 1);
    assert(!inodes.has(listener.socket_inode) && !cookies.has(listener.socket_cookie), 'duplicate listener identity');
    inodes.add(listener.socket_inode); cookies.add(listener.socket_cookie);
    assert(typeof listener.address === 'string' && listener.address.length > 0, 'listener address');
  }
  for (const key of ['binary_sha256', 'expected_binary_sha256']) {
    assert.equal(r[key].b0, manifest.sha256.server, 'B binary digest');
    assert.equal(r[key].client, manifest.sha256.client, 'client binary digest');
  }
  if (manifest.expect === 'client-timeout') {
    assert.equal(manifest.direction, 'download', 'known regression is download');
    assert.equal(manifest.path, 'direct-REALITY', 'do not assume via-A shares failure');
    assert.equal(manifest.transport, 'tls-and-tcp', 'known regression requires TCP half-close');
    assert.equal(harnessExit, 1, 'known regression must fail harness');
    assert.equal(r.test_failed, true);
    assert.match(f.error, /^frame \d+ header: EOF$/, 'not the known early EOF failure');
    assert.equal(Number(f.error.match(/^frame (\d+)/)[1]), frames.length, 'failure frame does not follow payload');
    assert(frames.length >= 20 && frames.length <= 45, 'not approximately frame 33');
    integer(hc.error_observed_us, 'failure timestamp', hc[firstEOF]);
    const elapsed = hc.error_observed_us - hc[firstEOF];
    assert(elapsed >= 750000 && elapsed <= 1600000, 'not approximately 1 second after EOF');
    assert(hc.error_observed_us >= frames.at(-1).at_us && hc.error_observed_us - frames.at(-1).at_us < 200000, 'not actively downloading before failure');
    assert.equal(f.finished_us, 0, 'failure cannot be naturally complete');
    assert.equal(f.stop_requested_us, 0, 'test requested stop before failure');
    assert.equal(f.sent_up_frames, 0, 'download unexpectedly uploaded');
    assert.equal(f.verified_up_bytes, 0, 'unexpected upload completion summary');
    assert.equal(f.verified_down_bytes, 0, 'failed flow claims completed byte summary');
    assert.notEqual(hc.server_read_eof, true, 'unexpected clean application EOF');
    assert.deepEqual(r.stream_errors, [f.id + ': ' + f.error], 'unrelated stream failure');
    for (const p of r.processes) {
      assert.equal(p.cleanup.forced, true, 'expected failure cleanup');
      assert.equal(p.wait.exit_code, -1, 'unexpected child exit');
      assert.equal(p.wait.signal, 'killed', 'unexpected child signal');
      assert.equal(p.wait.error, 'signal: killed', 'unexpected child Wait error');
      assert(p.wait.at_us > hc.error_observed_us, 'child exited before observed connection failure');
    }
    return {observed_outcome: 'known-client-timeout', correctness_passed: false, frames: frames.length, after_eof_us: elapsed};
  }
  assert.equal(harnessExit, 0, 'harness failed');
  assert.equal(r.test_failed, false);
  assert.equal(f.error, '');
  assert.deepEqual(r.stream_errors, []);
  assert.equal(hc.origin_read_eof, true, 'origin missing clean EOF');
  assert.equal(hc.server_read_eof, true, 'client missing clean EOF');
  integer(f.finished_us, 'finished time', frames.at(-1).at_us);
  integer(f.stop_requested_us, 'explicit stop time', hc[firstEOF] + 3000000);
  assert(f.stop_requested_us <= f.finished_us, 'stop after completion');
  assert(frames.at(-1).at_us - hc[firstEOF] >= 3000000, 'did not carry payload beyond 3 seconds after EOF');
  assert(frames.filter(frame => frame.at_us >= hc[firstEOF]).length >= 90, 'insufficient sustained payload after EOF');
  integer(hc.origin_read_eof_us, 'origin EOF time', f.started_us);
  integer(hc.server_read_eof_us, 'client EOF time', f.started_us);
  assert(hc[direction === 'down' ? 'server_read_eof_us' : 'origin_read_eof_us'] >= hc[firstEOF], 'EOF completion order reversed');
  assert(hc[direction === 'down' ? 'server_read_eof_us' : 'origin_read_eof_us'] >= Math.max(frames.at(-1).at_us, f.stop_requested_us), 'final EOF before payload/stop');
  if (direction === 'up') {
    integer(hc.client_write_closed_us, 'final client write close', f.stop_requested_us);
    assert(hc.client_write_closed_us <= f.finished_us, 'client write close after completion');
  }
  assert(hc.origin_read_eof_us <= f.finished_us && hc.server_read_eof_us <= f.finished_us, 'EOF outside flow lifetime');
  assert.equal(f.verified_up_bytes, f.up_frames.length * FRAME_BYTES, 'upload byte sum');
  assert.equal(f.verified_down_bytes, f.down_frames.length * FRAME_BYTES, 'download byte sum');
  assert.equal(f.sent_up_frames, f.up_frames.length, 'upload sender/receiver mismatch');
  for (const p of r.processes) {
    assert.equal(p.cleanup.forced, false, 'forced cleanup is not success');
    assert.equal(p.wait.exit_code, 0, 'nonzero child exit');
    assert.equal(p.wait.signal, '', 'signaled child exit');
    assert.equal(p.wait.error, '', 'Wait error');
    assert(p.wait.at_us > f.finished_us, 'child exited before flow completed');
    const completed = event('boundary-complete'), signaled = event(p.name + '-retirement-signaled'), exited = event(p.name + '-exit-observed');
    assert(completed.at_us >= f.finished_us, 'boundary completed before flow');
    assert(signaled.at_us >= completed.at_us && p.wait.at_us >= signaled.at_us && exited.at_us >= p.wait.at_us, 'shutdown event order');
    assert.equal(signaled.pid, p.pid, 'signal PID');
    assert.equal(exited.pid, p.pid, 'exit PID');
    assert.equal(exited.exit_code, p.wait.exit_code, 'exit event code');
    assert.equal(exited.exit_signal, p.wait.signal, 'exit event signal');
    assert.equal(exited.wait_error, p.wait.error, 'exit event Wait error');
  }
  assert(r.b0_stats && Object.keys(r.b0_stats).length > 0, 'stats missing');
  for (const value of Object.values(r.b0_stats)) integer(value, 'invalid statistic');
  if (manifest.path === 'direct-REALITY') integer(r.b0_stats['vless>>>vision>>>splice_bytes'], 'REALITY splice was not exercised', 1);
  return {observed_outcome: 'complete', correctness_passed: true, frames: frames.length, verified_bytes: frames.length * FRAME_BYTES, after_eof_us: frames.at(-1).at_us - hc[firstEOF]};
}
module.exports = {verify, digest, FRAME_BYTES};
if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path');
  const args = process.argv.slice(2);
  assert(args.length === 3 && args[0] === '--manifest', 'usage: verify.cjs --manifest MANIFEST RESULT');
  const result = JSON.parse(fs.readFileSync(args[2], 'utf8'));
  const codeText = fs.readFileSync(path.join(path.dirname(args[2]), 'exit-code.txt'), 'utf8').trim();
  assert(/^-?\d+$/.test(codeText), 'harness exit evidence missing');
  console.log(JSON.stringify(verify(result, JSON.parse(fs.readFileSync(args[1], 'utf8')), Number(codeText)), null, 2));
}
