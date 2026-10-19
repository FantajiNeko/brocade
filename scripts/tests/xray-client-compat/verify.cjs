'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FRAME_BYTES = 16384;
const LEGACY_CUSTOM_CLIENT_SHA256 = '38a335e3bba579ef919164b19df7cd7c59a14859b2ef31e17e1f1dc6b49bcae2';
const payloadDigests = Array.from({length: 251}, (_, seq) => {
  const body = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + seq * 17) % 251;
  return crypto.createHash('sha256').update(body).digest('hex');
});
const EMPTY_SHA256 = crypto.createHash('sha256').digest('hex');

function object(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  return value;
}

function array(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert(Array.isArray(value) && value.length >= minimum && value.length <= maximum, `${label}: invalid entry count`);
  return value;
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label}: invalid safe integer`);
  return value;
}

function string(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label}: nonempty string required`);
  return value;
}

function digest(value, label) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label}: SHA-256 required`);
  return value;
}

function finiteTree(value) {
  if (typeof value === 'number') assert(Number.isFinite(value), 'nonfinite evidence');
  else if (value && typeof value === 'object') for (const child of Object.values(value)) finiteTree(child);
}

function frameDigest(seq) {
  integer(seq, 'frame sequence');
  return payloadDigests[seq % payloadDigests.length];
}

// Hash receiver-validated frame records, not just a producer-supplied expected
// hash. The bounded payload cache avoids re-hashing gigabytes during a soak
// replay; sequence numbers remain part of the digest even when payload repeats.
function frameBucketDigest(first, count) {
  integer(first, 'bucket first sequence');
  integer(count, 'bucket frame count', 0, 5000000);
  const hash = crypto.createHash('sha256');
  for (let seq = first; seq < first + count; seq++) hash.update(`${seq}:${FRAME_BYTES}:${frameDigest(seq)}\n`);
  return hash.digest('hex');
}

function named(entries, label, key = 'name') {
  const result = new Map();
  for (const entry of array(entries, label, 1)) {
    object(entry, label);
    const name = string(entry[key], `${label}.${key}`);
    assert(!result.has(name), `${label}: duplicate ${name}`);
    result.set(name, entry);
  }
  return result;
}

function required(map, key, label) {
  assert(map.has(key), `${label}: missing ${key}`);
  return map.get(key);
}

function verifyManifest(manifest) {
  const m = object(manifest, 'manifest');
  finiteTree(m);
  assert.equal(m.schema_version, 11, 'manifest must use schema 11');
  string(m.pair_id, 'manifest.pair_id');
  assert(['before', 'after', 'upgrade'].includes(m.server_variant), 'explicit server variant required');
  assert(['xray', 'sing-box', 'mihomo'].includes(m.client?.family), 'unsupported client family');
  for (const field of ['version', 'source']) string(m.client[field], `client.${field}`);
  digest(m.client.sha256, 'client.sha256');
  assert(['direct', 'via-A'].includes(m.path), 'explicit path required');
  assert(['tls-vision', 'reality-vision'].includes(m.transport), 'explicit transport required');
  assert(['lifecycle', 'halfclose', 'idle', 'slow', 'soak'].includes(m.scene), 'unsupported scene');
  assert([1, 32, 128].includes(m.concurrency), 'unsupported concurrency');
  integer(m.duration_ms, 'duration_ms', 1000, 1800000);
  integer(m.frame_interval_ms, 'frame_interval_ms', 10, 500);
  assert(['download', 'upload'].includes(m.direction), 'explicit direction required');
  assert(['tls-only', 'tls-and-tcp'].includes(m.half_close_transport), 'explicit half-close semantics required');
  assert(['resume', 'halfclosed'].includes(m.idle_mode), 'explicit idle mode required');
  integer(m.idle_ms, 'idle duration', 1200, 10000);
  integer(m.read_delay_ms, 'read delay', 0, 1000);
  assert(['complete', 'known-client-timeout'].includes(m.expect), 'explicit expected outcome required');
  digest(m.config_template_sha256, 'configuration template digest');
  for (const role of ['b0', 'b1', 'b2', 'A', 'client']) digest(m.binary_sha256?.[role], `manifest binary ${role}`);
  assert.equal(m.binary_sha256.client, m.client.sha256, 'client identity differs from executable');
  digest(m.server_before_sha256, 'server-before digest');
  digest(m.server_after_sha256, 'server-after digest');
  assert.notEqual(m.server_before_sha256, m.server_after_sha256, 'before/after did not change executable');
  assert.equal(m.binary_sha256.b0, m.server_variant === 'after' ? m.server_after_sha256 : m.server_before_sha256, 'server variant digest mismatch');
  for (const role of ['b1', 'b2']) assert.equal(m.binary_sha256[role], m.server_variant === 'before' ? m.server_before_sha256 : m.server_after_sha256, 'candidate generation digest mismatch');
  if (m.server_variant === 'upgrade') assert.equal(m.scene, 'lifecycle', 'upgrade requires lifecycle proof');
  digest(m.harness_sha256, 'harness digest');
  return m;
}

function verifyEvidence(evidence, label, flow, limit, allowIdle = false, maximumFrames = 5000000) {
  const e = object(evidence, label);
  integer(e.count, `${label}.count`, 0, maximumFrames);
  integer(e.bytes, `${label}.bytes`);
  assert.equal(e.bytes, e.count * FRAME_BYTES, `${label}: byte total differs from count`);
  digest(e.sha256, `${label}.sha256`);
  assert.equal(e.expected_sha256, e.sha256, `${label}: producer-reported hash mismatch`);
  assert.equal(e.sha256, frameBucketDigest(0, e.count), `${label}: payload/sequence digest mismatch`);
  if (e.count === 0) {
    for (const field of ['first_us', 'last_us', 'max_gap_us']) assert.equal(e[field], 0, `${label}: nonempty timing for empty stream`);
    assert.equal(e.sha256, EMPTY_SHA256);
    return e;
  }
  integer(e.first_us, `${label}.first_us`, flow.started_us);
  integer(e.last_us, `${label}.last_us`, e.first_us);
  integer(e.max_gap_us, `${label}.max_gap_us`);
  if (e.count === 1) assert.equal(e.first_us, e.last_us, `${label}: one frame has two timestamps`);
  if (e.count > 1) {
    assert(e.max_gap_us >= (e.last_us - e.first_us) / (e.count - 1), `${label}: impossible maximum gap`);
    assert(e.max_gap_us <= e.last_us - e.first_us, `${label}: maximum gap exceeds stream`);
  }
  if (!allowIdle) assert(e.max_gap_us <= limit, `${label}: stalled payload`);
  return e;
}

function verifySamples(samples, e, label) {
  array(samples, label);
  assert.equal(samples.length, Math.min(3, e.count), `${label}: only exact first-three-frame samples are permitted`);
  let previous = e.first_us;
  for (const [seq, sample] of samples.entries()) {
    assert.equal(sample.seq, seq, `${label}: missing/repeated sequence`);
    assert.equal(sample.bytes, FRAME_BYTES, `${label}: wrong frame size`);
    integer(sample.at_us, `${label}: sample timestamp`, previous, e.last_us);
    if (seq === 0) assert.equal(sample.at_us, e.first_us, `${label}: first timestamp differs`);
    previous = sample.at_us;
    assert.equal(sample.sha256, frameDigest(seq), `${label}: corrupted sample`);
    assert.equal(sample.expected_sha256, sample.sha256, `${label}: self-reported digest differs`);
  }
}

function verifyProgress(r, flows, m) {
  const ids = array(r.progress_flow_ids, 'progress_flow_ids', flows.size, flows.size);
  assert.equal(new Set(ids).size, ids.length, 'duplicate progress flow ID');
  for (const id of ids) required(flows, id, 'progress flow');
  const buckets = array(r.progress_buckets, 'progress_buckets', 2, Math.ceil(m.duration_ms / 1000) + 180);
  integer(r.progress_begin_us, 'measurement begin', 1);
  integer(r.progress_end_us, 'measurement end', r.progress_begin_us + m.duration_ms * 1000);
  assert(buckets.some(b => Math.abs(b.at_us - r.progress_begin_us) <= 100000), 'missing measurement-begin bucket');
  assert(buckets.some(b => Math.abs(b.at_us - r.progress_end_us) <= 100000), 'missing measurement-end bucket');
  let previous;
  for (const [bucketIndex, b] of buckets.entries()) {
    integer(b.at_us, 'progress timestamp', previous ? previous.at_us + 1 : 1);
    assert(typeof b.partial === 'boolean', 'explicit partial-bucket status required');
    if (b.partial) assert(bucketIndex === 0 || bucketIndex === buckets.length - 1 ||
      Math.abs(b.at_us - r.progress_begin_us) <= 100000 || Math.abs(b.at_us - r.progress_end_us) <= 100000,
    'interior progress bucket cannot be relabeled partial');
    if (previous && previous.at_us >= r.progress_begin_us - 100000 && b.at_us <= r.progress_end_us + 100000) {
      assert(b.at_us - previous.at_us <= 1500000, 'missing progress interval');
    }
    array(b.counts, 'progress counts', ids.length, ids.length);
    for (const [i, id] of ids.entries()) {
      const f = flows.get(id);
      array(b.counts[i], 'progress up/down pair', 2, 2);
      for (const [j, direction] of ['up', 'down'].entries()) {
        const e = f.evidence[direction], value = b.counts[i][j];
        integer(value, 'progress count', 0, e.count);
        if (previous) {
          const prior = previous.counts[i][j];
          assert(value >= prior, 'progress counter decreased');
          // Only intervals wholly inside this direction's active lifetime
          // require progress; first/last partial intervals are still bounded.
          // A final partial bucket can be shorter than a single pacing period.
          // Require progress only when its elapsed time exceeds the observed
          // maximum inter-frame gap; full one-second buckets remain strict.
          const progressGap = m.scene === 'idle' ? Math.max(250000, m.frame_interval_ms * 4000) : e.max_gap_us;
          const enoughTime = !b.partial || b.at_us - previous.at_us > progressGap;
          if (enoughTime && e.count > 0 && previous.at_us >= e.first_us && b.at_us <= e.last_us) {
            assert(value > prior, `${id}/${direction}: inactive stream hidden by aggregate progress`);
          }
        }
        if (b.at_us < e.first_us) assert.equal(value, 0, 'progress before first frame');
        if (e.count > 0 && b.at_us >= e.last_us) assert.equal(value, e.count, 'progress after last frame is incomplete');
      }
    }
    previous = b;
  }
  const first = buckets[0], last = buckets.at(-1);
  for (const [i, id] of ids.entries()) for (const [j, direction] of ['up', 'down'].entries()) {
    const e = flows.get(id).evidence[direction];
    if (e.count > 0) {
      assert(first.at_us <= e.first_us, 'progress observation started after payload');
      assert(last.at_us >= e.last_us, 'progress observation ended before payload');
    }
    assert.equal(first.counts[i][j], 0, 'progress baseline must be zero');
    assert.equal(last.counts[i][j], e.count, 'progress final count differs');
  }
  return last.at_us - first.at_us;
}

function verifyListeners(entries, label) {
  const listeners = array(entries, label, 2, 4), seen = [new Set(), new Set(), new Set()];
  const publicListeners = [];
  for (const l of listeners) {
    assert(['public', 'cover'].includes(l.role), `${label}: unknown listener role`);
    string(l.address, `${label}.address`);
    integer(l.socket_inode, `${label}.socket_inode`, 1);
    integer(l.socket_cookie, `${label}.socket_cookie`, 1);
    integer(l.protocol, `${label}.protocol`, 1);
    assert.equal(l.socket_type, 1, `${label}: non-stream socket`);
    assert.equal(l.accept_conn, 1, `${label}: not listening`);
    for (const [i, value] of [l.address, l.socket_inode, l.socket_cookie].entries()) {
      assert(!seen[i].has(value), `${label}: duplicate identity`);
      seen[i].add(value);
    }
    if (l.role === 'public') publicListeners.push([l.address, l.socket_inode, l.socket_cookie, l.protocol]);
  }
  assert.equal(publicListeners.length, 2, `${label}: missing public listener`);
  return publicListeners.sort((a, b) => a[0].localeCompare(b[0]));
}

function verifyProcesses(r, m, flows, failed) {
  const events = named(r.events, 'events'), processes = named(r.processes, 'processes');
  const names = m.scene === 'lifecycle' ? ['b0', 'b1', 'b2', 'fixed-A', 'fixed-client'] : ['b0', 'fixed-A', 'fixed-client'];
  assert.equal(processes.size, names.length, 'unexpected/missing process');
  let priorTime = -1;
  for (const e of r.events) {
    integer(e.at_us, 'event timestamp', priorTime);
    priorTime = e.at_us;
  }
  const configs = named(r.configs, 'configs', 'role'), expectedConfigs = named(m.configs, 'manifest.configs', 'role');
  assert.equal(configs.size, names.length, 'missing actual process configurations');
  assert.equal(expectedConfigs.size, names.length, 'missing independent configuration evidence');
  const pids = new Set();
  for (const name of names) {
    const p = required(processes, name, 'process'), ready = required(events, name + '-ready', 'event');
    const binaryRole = name === 'fixed-A' ? 'A' : name === 'fixed-client' ? 'client' : name;
    integer(p.pid, 'actual process PID', 1);
    assert(!pids.has(p.pid), 'duplicate actual PID'); pids.add(p.pid);
    assert.equal(p.binary_sha256, m.binary_sha256[binaryRole], `${name}: wrong live executable`);
    assert.equal(ready.pid, p.pid, `${name}: ready PID mismatch`);
    assert.equal(ready.binary_sha256, p.binary_sha256, `${name}: ready executable mismatch`);
    const config = required(configs, name, 'config'), expectedConfig = required(expectedConfigs, name, 'manifest config');
    digest(config.sha256, `${name}: config hash`);
    string(config.path, `${name}: config path`);
    assert.equal(config.path, expectedConfig.path, `${name}: config path differs from independent manifest`);
    assert.equal(config.sha256, expectedConfig.sha256, `${name}: config bytes differ from independent manifest`);
    assert.equal(ready.config_sha256, config.sha256, `${name}: ready config is unbound`);
    if (name.startsWith('b')) {
      digest(ready.config_digest, `${name}: runtime config digest`);
      verifyListeners(ready.listeners, `${name}: listeners`);
    }
    const ownFlows = [...flows.values()].filter(f => !name.startsWith('b') || f.generation === name);
    assert(ownFlows.length > 0, `${name}: process never exercised`);
    assert(ready.at_us < Math.min(...ownFlows.map(f => f.started_us)), `${name}: not ready before its flow`);
    integer(p.wait?.at_us, `${name}: actual Wait timestamp`, ready.at_us + 1);
    if (failed) {
      assert.equal(p.cleanup?.forced, true, `${name}: failure cleanup must be explicit`);
      assert.equal(p.wait.exit_code, -1, `${name}: unexpected failing exit`);
      assert.equal(p.wait.signal, 'killed', `${name}: unexpected failing signal`);
      assert.equal(p.wait.error, 'signal: killed', `${name}: unexpected Wait error`);
      assert(p.wait.at_us > Math.max(...ownFlows.map(f => f.half_close.error_observed_us)), `${name}: child died before observed stream failure`);
    } else {
      assert.equal(p.cleanup?.forced, false, `${name}: forced cleanup is not success`);
      assert.equal(p.wait.exit_code, 0, `${name}: nonzero exit`);
      assert.equal(p.wait.signal, '', `${name}: signaled exit`);
      assert.equal(p.wait.error, '', `${name}: Wait error`);
      const signal = required(events, name + '-retirement-signaled', 'event'), exit = required(events, name + '-exit-observed', 'event');
      assert.equal(signal.pid, p.pid, `${name}: signal PID mismatch`);
      assert.equal(exit.pid, p.pid, `${name}: exit PID mismatch`);
      assert.equal(exit.exit_code, p.wait.exit_code, `${name}: exit code event mismatch`);
      assert.equal(exit.exit_signal, p.wait.signal, `${name}: exit signal event mismatch`);
      assert.equal(exit.wait_error, p.wait.error, `${name}: exit error event mismatch`);
      assert(signal.at_us >= Math.max(...ownFlows.flatMap(f => [f.finished_us, ...f.workers.map(w => w.at_us)])), `${name}: terminated with live stream workers`);
      assert(signal.at_us <= p.wait.at_us && p.wait.at_us <= exit.at_us, `${name}: signal/Wait/exit order`);
    }
  }
  return {events, processes};
}

function verifyWorkers(flow, failed) {
  const workers = named(flow.workers, `${flow.id}.workers`);
  assert.equal(workers.size, 4, 'all four stream workers must be joined');
  for (const [name, direction] of [['client-reader', 'down'], ['client-writer', 'sent_up'], ['origin-reader', 'up'], ['origin-writer', 'sent_down']]) {
    const w = required(workers, name, 'worker');
    assert.equal(w.joined, true, `${name}: worker did not exit`);
    integer(w.at_us, `${name}: join timestamp`, Math.max(flow.started_us, flow.evidence[direction].last_us));
    if (!failed) {
      assert.equal(w.error, '', `${name}: worker error`);
      assert(w.at_us <= flow.finished_us, `${name}: joined after flow claimed completion`);
    } else assert(typeof w.error === 'string', `${name}: missing worker result`);
  }
}

function verifyFlow(flow, m, failed) {
  const f = object(flow, 'flow');
  string(f.id, 'flow.id');
  assert.equal(f.path, m.path, 'flow path mismatch');
  assert(['b0', 'b1', 'b2'].includes(f.generation), 'invalid generation');
  if (m.scene !== 'lifecycle') assert.equal(f.generation, 'b0', 'unexpected generation');
  assert.equal(f.marker, f.generation === 'b2' ? 'origin-2' : 'origin-1', 'flow reached wrong origin');
  assert(['download', 'upload', 'duplex'].includes(f.mode), 'invalid flow mode');
  integer(f.started_us, 'flow start', 1);
  const directions = f.mode === 'duplex' ? ['up', 'down'] : [f.mode === 'upload' ? 'up' : 'down'];
  const limit = Math.max(250000, m.frame_interval_ms * 4000, m.scene === 'slow' ? integer(m.read_delay_ms, 'read_delay_ms', 1, 1000) * 4000 : 0);
  for (const direction of ['up', 'down', 'sent_up', 'sent_down']) {
    const e = verifyEvidence(f.evidence?.[direction], `${f.id}/${direction}`, f, limit, m.scene === 'idle', Math.ceil((m.duration_ms + 120000) / m.frame_interval_ms) + 1000);
    const active = directions.includes(direction.replace('sent_', ''));
    assert(active ? e.count >= 3 : e.count === 0, `${f.id}/${direction}: wrong active direction`);
  }
  for (const direction of ['up', 'down']) {
    const e = f.evidence[direction], sender = f.evidence['sent_' + direction];
    verifySamples(f[direction + '_frames'], e, `${f.id}/${direction} samples`);
    assert(sender.count >= e.count, `${f.id}/${direction}: received unsent frames`);
    if (!failed) {
      assert.equal(e.count, sender.count, `${f.id}/${direction}: sent/received frame count differs`);
      assert.equal(e.sha256, sender.sha256, `${f.id}/${direction}: sent/received payload differs`);
      assert.equal(f[`verified_${direction}_bytes`], e.bytes, `${f.id}/${direction}: byte summary differs`);
    }
  }
  object(f.half_close, 'half-close evidence');
  if (!failed) {
    assert.equal(f.error, '', 'flow error');
    integer(f.stop_requested_us, 'flow stop', f.started_us);
    integer(f.finished_us, 'flow completion', f.stop_requested_us);
    assert(['client-half-close', 'server-ended', 'client-ended'].includes(f.completion), 'missing natural flow completion');
    for (const [side, direction] of [['origin', 'up'], ['server', 'down']]) {
      assert.equal(f.half_close[side + '_read_eof'], true, `${side}: missing actual EOF`);
      integer(f.half_close[side + '_read_eof_us'], `${side}: EOF timestamp`, Math.max(f.started_us, f.evidence[direction].last_us), f.finished_us);
    }
    integer(f.half_close.client_write_closed_us, 'actual client write close', f.started_us, f.finished_us);
    assert.equal(f.sent_up_frames, f.evidence.sent_up.count, 'upload send summary differs');
  }
  verifyWorkers(f, failed);
  return directions;
}

function verifyHalfClose(f, m, failed) {
  assert.equal(m.scene, 'halfclose');
  assert.equal(f.mode, m.direction, 'half-close direction differs');
  const h = f.half_close, direction = m.direction === 'download' ? 'down' : 'up';
  const firstSide = direction === 'down' ? 'origin' : 'server';
  assert.equal(h[firstSide + '_read_eof'], true, 'missing initial actual EOF');
  integer(h[firstSide + '_read_eof_us'], 'initial EOF timestamp', f.started_us);
  const eof = h[firstSide + '_read_eof_us'], e = f.evidence[direction];
  assert(Math.abs(e.first_us - eof) <= 250000, 'half-close was not early');
  if (direction === 'down') {
    integer(h.client_write_closed_us, 'initial client write close', f.started_us);
    assert(Math.abs(h.client_write_closed_us - eof) <= 250000, 'client write close differs from actual EOF');
    integer(h.down_frames_at_client_close, 'frames at initial write close', 0, 5);
  } else {
    integer(h.server_terminal_us, 'initial server terminal', f.started_us, eof);
    integer(h.up_frames_at_server_eof, 'frames at initial EOF', 0, 5);
  }
  if (failed) {
    assert.equal(m.concurrency, 1, 'timeout signature requires one isolated flow');
    assert.equal(m.client.family, 'xray', 'third-party failure must not be classified as old Xray timeout');
    assert.equal(m.path, 'direct', 'unknown path cannot inherit known timeout');
    assert.equal(m.transport, 'reality-vision', 'unknown transport cannot inherit known timeout');
    assert.equal(m.direction, 'download', 'unknown direction cannot inherit known timeout');
    assert.equal(m.half_close_transport, 'tls-and-tcp', 'known timeout requires TCP half-close');
    assert.match(f.error, /^frame \d+ header: EOF$/, 'not the observed timeout signature');
    assert.equal(Number(f.error.match(/^frame (\d+)/)[1]), e.count, 'failure frame differs from verified sequence');
    integer(e.count, 'timeout frame count', 20, 45);
    integer(h.error_observed_us, 'error timestamp', eof + 750000, eof + 1600000);
    assert(h.error_observed_us >= e.last_us && h.error_observed_us - e.last_us <= 200000, 'payload was not active before failure');
    assert.equal(f.finished_us, 0, 'failed stream claims natural completion');
    assert.equal(f.stop_requested_us, 0, 'failure followed requested stop');
    assert.notEqual(h.server_read_eof, true, 'failure claims clean final EOF');
    return h.error_observed_us - eof;
  }
  assert(m.duration_ms >= 3000, 'half-close observation must exceed the one-second boundary');
  assert(e.last_us - eof >= m.duration_ms * 1000, 'insufficient active payload after EOF');
  assert(f.stop_requested_us >= eof + m.duration_ms * 1000, 'test stopped before required active interval');
  const lastSide = direction === 'down' ? 'server' : 'origin';
  assert(h[lastSide + '_read_eof_us'] >= f.stop_requested_us, 'final EOF before requested stop');
  return e.last_us - eof;
}

function verify(result, manifest, options) {
  const m = verifyManifest(manifest), r = object(result, 'result');
  finiteTree(r);
  assert.equal(r.schema_version, 11, 'only schema 11 evidence is accepted');
  string(r.run_id, 'run_id');
  assert.equal(r.client_kind, m.client.family, 'wrong actual client family');
  for (const field of ['transport', 'path', 'scene', 'concurrency', 'duration_ms', 'frame_interval_ms', 'direction', 'half_close_transport', 'idle_mode', 'idle_ms', 'read_delay_ms']) {
    assert.equal(r[field], m[field], `manifest/result ${field} differs`);
  }
  for (const role of ['b0', 'b1', 'b2', 'A', 'client']) assert.equal(r.binary_sha256?.[role], m.binary_sha256[role], `binary ${role} differs`);
  assert.equal(r.application_reconnects, 0, 'application reconnects hide stream breakage');
  assert.equal(r.new_request_failures, 0, 'new requests failed');
  assert.equal(r.client_timeout_policy, 'unmodified client defaults', 'client timeout policy was changed');
  assert.deepEqual(r.timeout_policy_seconds, {server_conn_idle: 300, server_uplink_only: 1, server_downlink_only: 1,
    A_conn_idle: 300, A_uplink_only: 1, A_downlink_only: 1}, 'server/relay policy changed');
  assert.deepEqual(r.errors, [], 'unrelated test errors');
  const failed = m.expect === 'known-client-timeout';
  const idleExpiry = m.scene === 'idle' && m.idle_mode === 'halfclosed';
  if (idleExpiry) assert.equal(m.expect, 'complete', 'expected idle timeout is not a legacy client failure');
  assert.equal(options?.exitCode, failed ? 1 : 0, 'independent harness exit differs');
  assert.equal(r.test_failed, failed, 'test outcome differs');
  const flows = named(r.flows, 'flows', 'id');
  if (m.scene !== 'lifecycle') assert.equal(flows.size, m.concurrency, 'actual flow count differs from concurrency');
  const durations = [];
  const concurrentStarts = [], concurrentEnds = [];
  let bytes = 0;
  for (const f of flows.values()) {
    const directions = verifyFlow(f, m, failed || idleExpiry);
    if (m.scene === 'halfclose') {
      durations.push(verifyHalfClose(f, m, failed));
      if (!failed) {
        concurrentStarts.push(f.half_close[m.direction === 'download' ? 'origin_read_eof_us' : 'server_read_eof_us']);
        concurrentEnds.push(f.evidence[m.direction === 'download' ? 'down' : 'up'].last_us);
      }
    }
    else if (m.scene === 'soak' || m.scene === 'slow') {
      if (m.scene === 'soak' && m.concurrency === 1) assert.equal(f.mode, 'duplex', 'single-flow soak must exercise both directions');
      if (m.scene === 'slow') assert.equal(f.mode, m.direction, 'slow-reader direction mismatch');
      for (const direction of directions) {
        const e = f.evidence[direction];
        assert(e.last_us - e.first_us >= m.duration_ms * 1000, `${f.id}/${direction}: actual payload duration too short`);
        durations.push(e.last_us - e.first_us);
        concurrentStarts.push(e.first_us); concurrentEnds.push(e.last_us);
      }
    }
    bytes += f.evidence.up.bytes + f.evidence.down.bytes;
  }
  assert(Number.isSafeInteger(bytes), 'unsafe byte sum');
  if (concurrentStarts.length) {
    const overlap = Math.min(...concurrentEnds) - Math.max(...concurrentStarts);
    assert(overlap >= m.duration_ms * 1000, 'flows were not concurrently active for required duration');
    durations.push(overlap);
  }
  if (failed || idleExpiry) {
    if (idleExpiry) assert.deepEqual(r.stream_errors, [...flows.values()].map(f => f.id + ': ' + f.error), 'idle stream errors differ from observed failures');
    else {
    assert.equal(m.scene, 'halfclose', 'only the isolated boundary can classify the signature');
    const f = [...flows.values()][0];
    assert.deepEqual(r.stream_errors, [f.id + ': ' + f.error], 'unexpected failure set');
    }
  } else assert.deepEqual(r.stream_errors, [], 'stream errors');
  const {events, processes} = verifyProcesses(r, m, flows, failed);
  if (m.scene !== 'lifecycle') {
    assert.deepEqual(r.pause_requests, [], 'unexpected lifecycle probes');
    for (const q of array(r.requests, 'requests', failed || idleExpiry ? 0 : 1)) {
      verifyRequest(q, m);
      assert.equal(q.marker, 'origin-1', 'new request reached wrong origin');
    }
  }
  if (!failed && !idleExpiry && m.scene !== 'lifecycle') verifyProgress(r, flows, m);
  if (m.scene === 'soak' && m.concurrency > 1) {
    const counts = {download: 0, upload: 0, duplex: 0};
    for (const f of flows.values()) counts[f.mode]++;
    assert.deepEqual(counts, {download: Math.ceil(m.concurrency / 3), upload: Math.floor((m.concurrency + 1) / 3), duplex: Math.floor(m.concurrency / 3)}, 'soak traffic mix differs from declared concurrency');
  }
  // These scenarios are accepted only once their scene-specific proof has
  // passed; a generic duplex stream must not masquerade as an idle or handoff test.
  if (m.scene === 'lifecycle') verifyLifecycle(r, m, flows, events, processes);
  let idleExpiryUS = 0;
  if (m.scene === 'idle') {
    if (idleExpiry) idleExpiryUS = verifyIdleExpiry(r, m, flows, events);
    else durations.push(verifyIdle(r, m, flows, events));
  }
  const backpressure = m.scene === 'slow' && verifySlow(r, m, flows);
  return {
    schema_version: 11, run_id: r.run_id, pair_id: m.pair_id, server_variant: m.server_variant,
    observed_outcome: failed ? 'client-timeout-signature' : idleExpiry ? 'natural-idle-expiry' : 'complete', correctness_passed: !failed,
    attribution: failed ? 'requires-before-after-pair' : 'case-only',
    client: m.client, server_sha256: m.binary_sha256.b0, A_sha256: m.binary_sha256.A,
    server_before_sha256: m.server_before_sha256, server_after_sha256: m.server_after_sha256,
    config_template_sha256: m.config_template_sha256,
    transport: m.transport, path: m.path, scene: m.scene, concurrency: m.concurrency,
    duration_ms: m.duration_ms, frame_interval_ms: m.frame_interval_ms, direction: m.direction,
    half_close_transport: m.half_close_transport,
    idle_mode: m.idle_mode, idle_ms: m.idle_ms, read_delay_ms: m.read_delay_ms,
    active_duration_us: durations.length ? Math.min(...durations) : 0,
    long_soak_passed: !failed && m.scene === 'soak' && m.duration_ms >= 1800000,
    verified_bytes: bytes, flows: flows.size, accounting_verified: false,
    slow_reader_verified: m.scene === 'slow', backpressure_verified: Boolean(backpressure),
    idle_resume_verified: m.scene === 'idle' && !idleExpiry, idle_timeout_verified: idleExpiry, idle_expiry_us: idleExpiryUS,
  };
}

function verifyPair(before, after) {
  for (const value of [before, after]) {
    assert.equal(value.schema_version, 11, 'pair requires verified H11 summaries');
    assert(['complete', 'client-timeout-signature', 'natural-idle-expiry'].includes(value.observed_outcome), 'unverified pair outcome');
  }
  assert.equal(before.server_variant, 'before', 'pair before side');
  assert.equal(after.server_variant, 'after', 'pair after side');
  for (const field of ['pair_id', 'client', 'A_sha256', 'server_before_sha256', 'server_after_sha256', 'config_template_sha256',
    'transport', 'path', 'scene', 'concurrency', 'duration_ms', 'frame_interval_ms', 'direction', 'half_close_transport', 'idle_mode', 'idle_ms', 'read_delay_ms']) {
    assert.deepEqual(before[field], after[field], `paired ${field} differs`);
  }
  assert.notEqual(before.server_sha256, after.server_sha256, 'pair did not change server executable');
  const preexisting = before.observed_outcome === 'client-timeout-signature' && after.observed_outcome === 'client-timeout-signature';
  return {pair_id: before.pair_id, correctness_passed: before.correctness_passed && after.correctness_passed,
    attribution: preexisting ? 'pre-existing-client-boundary-signature' : before.correctness_passed && !after.correctness_passed ? 'candidate-regression' : 'paired-observation',
    root_cause_proven: false, before: before.observed_outcome, after: after.observed_outcome};
}

function verifyRequest(q, m) {
  object(q, 'request');
  assert.equal(q.path, m.path, 'request used the untested path');
  assert.equal(q.error, '', 'request error');
  for (const field of ['scheduled_us', 'dispatch_us', 'local_adapter_connect_us', 'end_to_end_inner_tls_us', 'http_headers_us', 'total_us']) integer(q[field], 'request.' + field);
  assert(q.scheduled_us <= q.dispatch_us, 'request dispatched before schedule');
  assert(q.local_adapter_connect_us <= q.end_to_end_inner_tls_us && q.end_to_end_inner_tls_us <= q.http_headers_us && q.http_headers_us <= q.total_us, 'request timing order');
  integer(q.dispatch_us + q.total_us, 'request completion timestamp');
}

function verifyLifecycle(r, m, flows, events, processes) {
  const event = name => required(events, name, 'lifecycle event');
  const first = m.server_variant === 'upgrade' ? 'binary-upgrade' : 'same-binary-control';
  assert.equal(r.first_operation, first, 'actual operation differs from server variant');
  const operations = [first, 'routing-update'].map(name => {
    const begin = event(name + '-begin'), paused = event(name + '-paused'), committed = event(name + '-committed');
    assert(begin.at_us <= paused.at_us && paused.at_us < committed.at_us, 'control window ordering');
    integer(committed.pause_to_resume_us, 'pause-to-resume duration', 1);
    integer(committed.total_us, 'total operation duration', committed.pause_to_resume_us);
    assert.equal(paused.certificate?.paused, true, 'unproved pause barrier');
    assert.equal(paused.certificate?.accepting, false, 'old generation still accepting');
    for (const listener of array(paused.certificate?.listeners, 'pause listener proof', 2)) {
      if (listener.role === 'public') assert.equal(listener.in_accept, false, 'pause left accept syscall running');
    }
    return {name, begin, paused, committed};
  });
  const baseline = event('baseline-begin').at_us, retirementBegin = event('retirement-begin').at_us, end = event('measurement-end').at_us;
  assert(baseline < operations[0].begin.at_us && operations[0].committed.at_us < operations[1].begin.at_us && operations[1].committed.at_us < retirementBegin && retirementBegin < end, 'lifecycle phases absent/out of order');
  const ready = Object.fromEntries(['b0', 'b1', 'b2'].map(name => [name, event(name + '-ready')]));
  const identities = verifyListeners(ready.b0.listeners, 'original listener identities');
  for (const name of ['b0', 'b1', 'b2']) {
    assert.deepEqual(verifyListeners(ready[name].listeners, name + ' listener identities'), identities, 'public listener identity changed across handoff');
    assert.equal(ready[name].selected_origin, name === 'b2' ? 2 : 1, 'wrong generation route');
  }
  assert.notEqual(ready.b1.config_digest, ready.b2.config_digest, 'routing update did not change config');
  assert(ready.b0.at_us < baseline && ready.b1.at_us <= operations[0].begin.at_us && ready.b2.at_us <= operations[1].begin.at_us, 'generation was not ready before handoff');
  const retirement = {};
  for (const name of ['b0', 'b1']) {
    const certified = event(name + '-drain-certified'), signaled = event(name + '-retirement-signaled'), exited = event(name + '-exit-observed');
    assert(retirementBegin < certified.at_us && certified.at_us <= signaled.at_us && signaled.at_us <= exited.at_us && exited.at_us < end, 'drain/retire sequence');
    assert.equal(certified.pid, processes.get(name).pid, 'drain certified wrong process');
    const proof = object(certified.certificate, 'drain certificate');
    assert.equal(proof.drain_config_version, 1, 'wrong drain protocol');
    assert.equal(proof.drain_config_digest, ready[name].config_digest, 'drain certificate config mismatch');
    for (const field of ['active', 'public_active', 'cover_active', 'background_active']) assert.equal(proof[field], 0, `${field}: not quiescent`);
    for (const field of ['ready', 'paused', 'public_quiescent', 'cover_paused', 'retire_ready']) assert.equal(proof[field], true, `${field}: drain incomplete`);
    for (const field of ['accepting', 'drain_scope_unsupported']) assert.equal(proof[field], false, `${field}: retirement unsafe`);
    assert.deepEqual(verifyListeners(proof.listeners, 'drain listener proof'), identities, 'drain listener identity mismatch');
    for (const listener of proof.listeners) {
      assert.equal(listener.active, 0, 'listener still active at retirement');
      assert.equal(listener.in_accept, false, 'listener still accepting at retirement');
    }
    retirement[name] = {certified, exited};
  }
  assert(retirement.b0.exited.at_us < retirement.b1.certified.at_us, 'retired generations out of order');
  assert.equal(flows.size, m.concurrency + 6, 'lifecycle flow count');
  assert.equal(r.lifecycle_peak_persistent_flows, m.concurrency + 6, 'lifecycle peak concurrency is unreported');
  for (const name of ['b0', 'b1', 'b2']) {
    const cohort = [...flows.values()].filter(f => f.generation === name);
    assert.equal(cohort.length, name === 'b0' ? m.concurrency : 3, 'generation cohort missing');
    if (name !== 'b0' || m.concurrency > 1) for (const mode of ['download', 'upload', 'duplex']) assert(cohort.some(f => f.mode === mode), 'missing generation traffic mode');
    for (const f of cohort) {
      if (name !== 'b0') assert(f.started_us >= operations[name === 'b1' ? 0 : 1].committed.at_us, 'canary started before generation committed');
      if (name !== 'b2') assert(f.finished_us <= retirement[name].certified.at_us, 'retired while own flow still running');
      for (const direction of ['up', 'down']) {
        const e = f.evidence[direction]; if (!e.count) continue;
        const start = name === 'b0' ? operations[0].begin.at_us : name === 'b1' ? operations[1].begin.at_us : retirement.b0.certified.at_us;
        const finish = name === 'b2' ? retirement.b1.exited.at_us : operations[1].committed.at_us;
        assert(e.first_us < start && e.last_us > finish, 'flow did not span required handoff/retirement');
      }
    }
    const stats = object(r[name + '_stats'], name + ' stats');
    assert(Object.keys(stats).length > 0, 'empty runtime statistics');
    for (const value of Object.values(stats)) integer(value, 'runtime statistic');
  }
  const phases = ['baseline', first, first + '-post', 'routing-update', 'routing-update-post', 'retirement'];
  const windows = [baseline, operations[0].begin.at_us, operations[0].committed.at_us, operations[1].begin.at_us, operations[1].committed.at_us, retirementBegin, end];
  const phaseCounts = Object.fromEntries(phases.map(phase => [phase, 0]));
  let oldWindow = 0, newWindow = 0;
  for (const q of array(r.requests, 'lifecycle requests', 1)) {
    verifyRequest(q, m);
    const index = phases.indexOf(q.phase);
    assert(index >= 0 && q.dispatch_us >= windows[index] && q.dispatch_us < windows[index + 1], 'request outside claimed phase');
    // A pre-pause dispatch may arrive after the barrier under real RTT. Only
    // requests whose interval overlaps the barrier may choose either origin.
    if (q.dispatch_us >= operations[1].paused.at_us) { assert.equal(q.marker, 'origin-2', 'new-window request reached old route'); newWindow++; }
    else if (q.dispatch_us + q.http_headers_us < operations[1].paused.at_us) { assert.equal(q.marker, 'origin-1', 'old-window request reached new route'); oldWindow++; }
    else assert(['origin-1', 'origin-2'].includes(q.marker), 'transition request reached unknown route');
    phaseCounts[q.phase]++;
  }
  for (const phase of ['baseline', first + '-post', 'routing-update-post', 'retirement']) assert(phaseCounts[phase] > 0, 'empty required request phase: ' + phase);
  assert(oldWindow > 0 && newWindow > 0, 'missing causally unambiguous old/new request windows');
  const probes = named(r.pause_requests, 'pause requests', 'operation');
  assert.equal(probes.size, 2, 'both control windows require explicit probes');
  for (const op of operations) {
    const q = required(probes, op.name, 'pause request'); verifyRequest(q, m);
    assert(q.dispatch_us >= op.paused.at_us && q.dispatch_us < op.committed.at_us, 'probe did not enter paused window');
    assert.equal(q.marker, op.name === 'routing-update' ? 'origin-2' : 'origin-1', 'pause probe reached wrong route');
  }
  const checkpoints = named(r.checkpoints, 'checkpoints');
  const definitions = [['baseline', ['b0']], ['after-handoff', ['b0', 'b1']], ['after-route', ['b0', 'b1', 'b2']],
    ['before-b0-retire', ['b2']], ['after-b0-exit', ['b2']], ['after-b0-retire', ['b2']],
    ['before-b1-retire', ['b2']], ['after-b1-exit', ['b2']], ['after-b1-retire', ['b2']]];
  let prior = -1;
  const checkpointCounts = new Map();
  for (const [name, generations] of definitions) {
    const c = required(checkpoints, name, 'checkpoint'); integer(c.at_us, 'checkpoint timestamp', prior + 1); prior = c.at_us;
    assert.equal(c.at_us, event(name).at_us, 'checkpoint event timestamp differs');
    const entries = named(c.flows, 'checkpoint flows', 'id');
    const expected = [...flows.values()].filter(f => generations.includes(f.generation));
    assert.equal(entries.size, expected.length, 'missing/extraneous checkpoint flow');
    for (const f of expected) for (const direction of ['up', 'down']) {
      const value = required(entries, f.id, 'checkpoint flow')[direction + '_frames'], e = f.evidence[direction];
      integer(value, 'checkpoint frame count', 0, e.count);
      if (e.count) assert(value > 0 && e.first_us <= c.at_us && c.at_us < e.last_us, 'checkpoint outside active payload lifetime');
    }
    checkpointCounts.set(name, entries);
  }
  assert(checkpoints.get('baseline').at_us >= baseline && checkpoints.get('baseline').at_us < operations[0].begin.at_us, 'baseline checkpoint window');
  assert(checkpoints.get('after-handoff').at_us > operations[0].committed.at_us && checkpoints.get('after-handoff').at_us < operations[1].begin.at_us, 'handoff checkpoint window');
  assert(checkpoints.get('after-route').at_us > operations[1].committed.at_us && checkpoints.get('after-route').at_us < retirementBegin, 'route checkpoint window');
  const advances = [['baseline', 'after-handoff', ['b0']], ['after-handoff', 'after-route', ['b0', 'b1']]];
  for (const name of ['b0', 'b1']) {
    const before = checkpoints.get('before-' + name + '-retire'), exited = checkpoints.get('after-' + name + '-exit'), after = checkpoints.get('after-' + name + '-retire');
    assert(before.at_us < retirement[name].certified.at_us && retirement[name].exited.at_us <= exited.at_us && exited.at_us < after.at_us, 'checkpoint does not bracket real retirement');
    advances.push(['after-' + name + '-exit', 'after-' + name + '-retire', ['b2']]);
  }
  for (const [before, after, generations] of advances) for (const f of flows.values()) {
    if (!generations.includes(f.generation)) continue;
    for (const direction of ['up', 'down']) if (f.evidence[direction].count) {
      assert(checkpointCounts.get(after).get(f.id)[direction + '_frames'] - checkpointCounts.get(before).get(f.id)[direction + '_frames'] >= 3, 'no post-boundary progress');
    }
  }
}
function verifyIdle(r, m, flows, events) {
  assert.equal(m.idle_mode, 'resume', 'halfclosed idle requires a separate natural-timeout schema');
  const checkpoints = named(r.checkpoints, 'idle checkpoints');
  const paused = required(checkpoints, 'idle-pause', 'idle checkpoint'), beforeResume = required(checkpoints, 'idle-before-resume', 'idle checkpoint');
  const begin = required(events, 'idle-window-begin', 'idle event'), resumed = required(events, 'idle-resumed', 'idle event');
  assert(paused.at_us <= begin.at_us && begin.at_us + m.idle_ms * 1000 <= beforeResume.at_us && beforeResume.at_us <= resumed.at_us, 'actual idle interval too short/out of order');
  assert(resumed.at_us <= r.progress_begin_us, 'measurement started before idle recovery');
  const a = named(paused.flows, 'paused flows', 'id'), b = named(beforeResume.flows, 'before-resume flows', 'id');
  assert.equal(a.size, flows.size, 'missing paused flow'); assert.equal(b.size, flows.size, 'missing resumed flow');
  let duration = Number.MAX_SAFE_INTEGER;
  for (const f of flows.values()) {
    assert.equal(f.mode, m.direction, 'idle flow direction differs');
    const left = required(a, f.id, 'idle pause'), right = required(b, f.id, 'idle resume');
    for (const direction of ['up', 'down']) {
      const count = left[direction + '_frames'], e = f.evidence[direction];
      integer(count, 'idle checkpoint frame count', e.count ? 3 : 0, e.count);
      assert.equal(right[direction + '_frames'], count, 'payload moved during declared idle');
      if (!e.count) { assert.equal(count, 0, 'inactive direction count'); continue; }
      assert(e.first_us < paused.at_us && e.last_us > resumed.at_us, 'flow did not span idle');
      assert(e.count >= count + 3, 'flow did not resume payload');
      assert(e.last_us - resumed.at_us >= m.duration_ms * 1000, 'post-idle payload observation too short');
      assert(e.max_gap_us >= m.idle_ms * 1000 - 100000 && e.max_gap_us <= m.idle_ms * 1000 + 1000000, 'payload timings do not show the declared idle window');
      duration = Math.min(duration, e.last_us - resumed.at_us);
    }
  }
  return duration;
}

function verifySlow(r, m, flows) {
  assert(typeof r.slow_reader_only === 'boolean', 'explicit slow-reader/backpressure scope required');
  const backpressure = !r.slow_reader_only;
  if (backpressure) assert.equal(r.slow_backpressure_requested, true, 'backpressure was not actually requested');
  integer(m.read_delay_ms, 'slow-reader delay', 20, 200);
  assert(m.duration_ms <= 10000, 'slow-reader fixture exceeds bounded duration');
  const direction = m.direction === 'download' ? 'down' : 'up';
  for (const f of flows.values()) {
    const e = f.evidence[direction], sent = f.evidence['sent_' + direction];
    assert(e.last_us - e.first_us >= (e.count - 1) * m.read_delay_ms * 1000 * 0.95, 'receiver did not actually apply slow-read pacing');
    integer(sent.max_write_us, 'maximum actual Write duration');
    integer(sent.total_write_us, 'total actual Write duration', sent.max_write_us);
    // These durations are observations, not a backpressure assertion. Small
    // writes may fit socket buffers even while a receiver intentionally waits.
    assert(sent.total_write_us <= f.finished_us - f.started_us, 'Write duration exceeds flow lifetime');
    if (backpressure) {
      for (const endpoint of ['client', 'origin']) for (const key of ['read_bytes', 'write_bytes']) integer(f.socket_buffers?.[endpoint]?.[key], 'actual bounded socket buffer', 1, 8192);
      assert(sent.max_write_us >= m.read_delay_ms * 500, 'no observed blocking Write under backpressure');
    }
  }
  return backpressure;
}

function verifyIdleExpiry(r, m, flows, events) {
  assert.equal(r.idle_expiry_observed, true, 'missing idle-expiry observation');
  const checkpoints = named(r.checkpoints, 'idle-expiry checkpoints');
  const paused = required(checkpoints, 'idle-pause', 'idle checkpoint'), expired = required(checkpoints, 'idle-expired-counts', 'idle checkpoint');
  const begin = required(events, 'idle-window-begin', 'idle event'), complete = required(events, 'idle-expired', 'idle event');
  assert(paused.at_us <= begin.at_us && begin.at_us < expired.at_us && expired.at_us <= complete.at_us, 'idle-expiry timeline');
  const before = named(paused.flows, 'paused flows', 'id'), after = named(expired.flows, 'expired flows', 'id');
  const observations = named(r.idle_observations, 'idle observations', 'id');
  for (const map of [before, after, observations]) assert.equal(map.size, flows.size, 'missing idle-expiry flow');
  let elapsed = Number.MAX_SAFE_INTEGER;
  for (const f of flows.values()) {
    assert.equal(f.mode, m.direction, 'idle-expiry direction');
    assert.equal(f.stop_requested_us, 0, 'test requested stop before natural expiry');
    assert.equal(f.finished_us, 0, 'idle expiry cannot claim natural application completion');
    const observation = required(observations, f.id, 'idle observation');
    const readerName = m.direction === 'download' ? 'client-reader' : 'origin-reader';
    assert.equal(observation.reader, readerName, 'wrong endpoint observed idle expiry');
    const reader = f.workers.find(w => w.name === readerName);
    assert.equal(observation.at_us, reader.at_us, 'idle observation is not the actual reader exit');
    assert.equal(observation.error, reader.error, 'idle observation error differs');
    assert.equal(f.error, observation.error, 'unrelated flow failure');
    const direction = m.direction === 'download' ? 'down' : 'up', e = f.evidence[direction];
    assert.equal(observation.error, `frame ${e.count} header: EOF`, 'not an idle EOF at the next expected frame');
    const firstSide = m.direction === 'download' ? 'origin' : 'server';
    assert.equal(f.half_close[firstSide + '_read_eof'], true, 'initial real EOF absent');
    const eof = integer(f.half_close[firstSide + '_read_eof_us'], 'initial idle EOF', begin.at_us);
    integer(observation.at_us, 'idle expiry timestamp', eof + 750000, eof + 1600000);
    assert(observation.at_us <= expired.at_us, 'idle snapshot precedes observation');
    const secondSide = m.direction === 'download' ? 'server' : 'origin';
    assert.notEqual(f.half_close[secondSide + '_read_eof'], true, 'idle failure misreported as clean application EOF');
    if (m.direction === 'download') integer(f.half_close.client_write_closed_us, 'idle initial write close', begin.at_us, eof + 100000);
    for (const w of f.workers) assert(['', 'idle writer cancelled', observation.error].includes(w.error), 'unrelated worker failure during idle');
    for (const dir of ['up', 'down']) {
      const value = before.get(f.id)[dir + '_frames'], recv = f.evidence[dir], sent = f.evidence['sent_' + dir];
      integer(value, 'idle paused count', recv.count ? 3 : 0);
      assert.equal(value, after.get(f.id)[dir + '_frames'], 'payload moved while idle');
      assert.equal(recv.count, value, 'received payload after idle pause');
      assert.equal(sent.count, value, 'sent payload after idle pause');
      assert.equal(sent.sha256, recv.sha256, 'idle sent/received mismatch');
      if (recv.count) assert(Math.max(recv.last_us, sent.last_us) <= paused.at_us, 'payload timestamp lies inside idle window');
    }
    elapsed = Math.min(elapsed, observation.at_us - eof);
  }
  return elapsed;
}

module.exports = {verify, verifyPair, FRAME_BYTES, LEGACY_CUSTOM_CLIENT_SHA256, frameDigest, frameBucketDigest, verifyManifest, verifyEvidence, verifyProgress};
if (require.main === module) {
  const args = process.argv.slice(2);
  assert(args.length === 3 && args[0] === '--manifest', 'usage: verify.cjs --manifest MANIFEST RESULT');
  assert(fs.statSync(args[2]).size <= 128 * 1024 * 1024, 'result exceeds bounded evidence size');
  const result = JSON.parse(fs.readFileSync(args[2], 'utf8'));
  const exit = fs.readFileSync(path.join(path.dirname(args[1]), 'exit-code.txt'), 'utf8').trim();
  assert(/^-?\d+$/.test(exit), 'independent harness exit missing');
  console.log(JSON.stringify(verify(result, JSON.parse(fs.readFileSync(args[1], 'utf8')), {exitCode: Number(exit)}), null, 2));
}
