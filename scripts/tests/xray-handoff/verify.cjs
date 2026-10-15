'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PATHS = ['via-A', 'direct-REALITY'];
const GENERATIONS = ['b0', 'b1', 'b2'];
const MODES = ['download', 'upload', 'duplex'];
const FRAME_BYTES = 16 * 1024;
const CHECKPOINTS = ['baseline', 'after-handoff', 'after-route', 'before-b0-retire',
  'after-b0-retire', 'before-b1-retire', 'after-b1-retire'];
// The fixture payload repeats every 251 sequences; the cache is bounded even
// for very long runs and independently checks the producer's expected digest.
const payloadDigests = Array.from({ length: 251 }, (_, seq) => {
  const payload = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + seq * 17) % 251;
  return crypto.createHash('sha256').update(payload).digest('hex');
});

function object(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  return value;
}

function array(value, label, minimum = 0) {
  assert(Array.isArray(value) && value.length >= minimum, `${label}: expected at least ${minimum} entries`);
  return value;
}

function integer(value, label, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${label}: expected safe integer >= ${minimum}`);
  return value;
}

function string(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label}: expected nonempty string`);
  return value;
}

function digest(value, label) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label}: expected SHA-256`);
  return value;
}

function finiteTree(value, label = 'result') {
  if (typeof value === 'number') assert(Number.isFinite(value), `${label}: nonfinite number`);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) finiteTree(child, `${label}.${key}`);
  }
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

function required(map, name, label) {
  assert(map.has(name), `${label}: missing ${name}`);
  return map.get(name);
}

function publicListeners(listeners, label) {
  const result = array(listeners, label, 2).filter(listener => listener.role === 'public');
  assert.equal(result.length, 2, `${label}: two public listeners required`);
  const identities = result.map(listener => {
    const address = string(listener.address, `${label}.address`);
    const inode = integer(listener.socket_inode, `${label}.socket_inode`, 1);
    const cookie = integer(listener.socket_cookie, `${label}.socket_cookie`, 1);
    const protocol = integer(listener.protocol, `${label}.protocol`, 1);
    assert.equal(listener.socket_type, 1, `${label}: stream socket required`);
    assert.equal(listener.accept_conn, 1, `${label}: listening socket required`);
    return [address, inode, cookie, protocol];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  for (let field = 0; field < 3; field++) {
    assert.notEqual(identities[0][field], identities[1][field], `${label}: duplicate listener identity`);
  }
  return identities;
}

function verifyResult(result, options) {
  const r = object(result, 'result');
  finiteTree(r);
  assert.equal(r.schema_version, 9, 'schema_version: only strict H9 results are supported');
  string(r.run_id, 'run_id');
  assert(['fixed-to-fixed', 'old-to-fixed'].includes(r.mode), 'mode: unsupported lifecycle claim');
  assert.equal(r.boundary, '', 'boundary: not a lifecycle run');
  assert.equal(r.negative_control, '', 'negative_control: not a positive lifecycle run');
  assert.equal(r.half_close_transport, 'tls-and-tcp', 'half_close_transport: TLS and TCP evidence required');
  string(r.scope, 'scope');
  assert.equal(r.test_failed, false, 'test_failed');
  assert.deepEqual(r.errors, [], 'errors');
  assert.deepEqual(r.stream_errors, [], 'stream_errors');
  assert.equal(r.application_reconnects, 0, 'application_reconnects');
  assert.equal(r.new_request_failures, 0, 'new_request_failures');
  assert.equal(options?.harnessExitCode, 0, 'harness exit code must independently be zero');
  const expected = object(options?.expectedBinarySha256, 'independent binary manifest');
  for (const role of [...GENERATIONS, 'client']) {
    digest(expected[role], `manifest.${role}`);
    assert.equal(r.binary_sha256?.[role], expected[role], `binary_sha256.${role}`);
    assert.equal(r.expected_binary_sha256?.[role], expected[role], `expected_binary_sha256.${role}`);
  }
  assert.equal(expected.b1, expected.b2, 'route update must retain the candidate binary');
  if (r.mode === 'fixed-to-fixed') assert.equal(expected.b0, expected.b1, 'fixed-to-fixed hashes');
  else assert.notEqual(expected.b0, expected.b1, 'old-to-fixed requires distinct binaries');

  const events = named(r.events, 'events');
  let previousTime = -1;
  for (const event of r.events) {
    integer(event.at_us, `events.${event.name}.at_us`);
    assert(event.at_us >= previousTime, 'events: timestamps must be ordered');
    previousTime = event.at_us;
  }
  const event = name => required(events, name, 'events');
  const firstOperation = r.mode === 'fixed-to-fixed' ? 'same-binary-control' : 'binary-upgrade';
  const operationNames = [firstOperation, 'routing-update'];
  const operations = operationNames.map(name => {
    const begin = event(`${name}-begin`);
    const paused = event(`${name}-paused`);
    const committed = event(`${name}-committed`);
    assert(begin.at_us <= paused.at_us && paused.at_us < committed.at_us, `${name}: invalid control window`);
    integer(committed.pause_to_resume_us, `${name}.pause_to_resume_us`, 1);
    integer(committed.total_us, `${name}.total_us`, 1);
    assert(committed.pause_to_resume_us <= committed.total_us, `${name}: pause exceeds operation`);
    return { name, begin, paused, committed };
  });
  const baseline = event('baseline-begin').at_us;
  const end = event('measurement-end').at_us;
  assert(baseline < operations[0].begin.at_us, 'baseline window is empty');
  assert(operations[0].committed.at_us < operations[1].begin.at_us, 'handoff order');
  assert(operations[1].committed.at_us < end, 'route post window is empty');

  const ready = Object.fromEntries(GENERATIONS.map(generation => [generation, event(`${generation}-ready`)]));
  const identities = publicListeners(ready.b0.listeners, 'b0-ready.listeners');
  const pids = new Set();
  for (const generation of GENERATIONS) {
    const entry = ready[generation];
    integer(entry.pid, `${generation}-ready.pid`, 1);
    assert(!pids.has(entry.pid), 'ready: generation PIDs must differ');
    pids.add(entry.pid);
    digest(entry.config_digest, `${generation}-ready.config_digest`);
    assert.equal(entry.binary_sha256, expected[generation], `${generation}-ready.binary_sha256`);
    assert.deepEqual(publicListeners(entry.listeners, `${generation}-ready.listeners`), identities, 'public listener identity changed');
  }
  assert(ready.b0.at_us <= baseline, 'b0 must be ready before baseline');
  assert(ready.b1.at_us <= operations[0].begin.at_us, 'b1 must be ready before handoff');
  assert(ready.b2.at_us <= operations[1].begin.at_us, 'b2 must be ready before route handoff');
  assert.notEqual(ready.b1.config_digest, ready.b2.config_digest, 'route config digest did not change');
  assert.equal(ready.b0.selected_origin, 1, 'b0 origin');
  assert.equal(ready.b1.selected_origin, 1, 'b1 origin');
  assert.equal(ready.b2.selected_origin, 2, 'b2 origin');

  const processes = named(r.processes, 'processes');
  assert.equal(processes.size, 5, 'processes: exactly three generations, relay and client required');
  const processPids = new Set();
  for (const process of r.processes) {
    integer(process.pid, `${process.name}.pid`, 1);
    assert(!processPids.has(process.pid), 'processes: duplicate PID');
    processPids.add(process.pid);
    digest(process.binary_sha256, `${process.name}.binary_sha256`);
    assert.equal(process.wait?.exit_code, 0, `${process.name}: child exit code`);
    assert.equal(process.wait?.signal, '', `${process.name}: child signal`);
    assert.equal(process.wait?.error, '', `${process.name}: wait error`);
    integer(process.wait?.at_us, `${process.name}.wait.at_us`, 1);
    assert.equal(process.cleanup?.forced, false, `${process.name}: forced cleanup is not successful retirement`);
  }
  for (const role of [...GENERATIONS, 'client']) {
    const process = required(processes, role === 'client' ? 'fixed-client' : role, 'processes');
    assert.equal(process.binary_sha256, expected[role], `${role}: process binary mismatch`);
    if (ready[role]) assert.equal(process.pid, ready[role].pid, `${role}: process PID mismatch`);
  }
  assert.equal(required(processes, 'fixed-A', 'processes').binary_sha256, expected.client, 'fixed-A: process binary mismatch');

  const retirement = {};
  for (const generation of ['b0', 'b1']) {
    const certified = event(`${generation}-drain-certified`);
    const signaled = event(`${generation}-retirement-signaled`);
    const exited = event(`${generation}-exit-observed`);
    assert(operations[1].committed.at_us < certified.at_us && certified.at_us <= signaled.at_us && signaled.at_us <= exited.at_us && exited.at_us < end,
      `${generation}: invalid retirement order`);
    const certificate = object(certified.certificate, `${generation}.certificate`);
    assert.equal(certificate.drain_config_version, 1, `${generation}: drain protocol version`);
    assert.equal(certificate.drain_config_digest, ready[generation].config_digest, `${generation}: drain config binding`);
    for (const field of ['active', 'public_active', 'cover_active', 'background_active']) {
      assert.equal(certificate[field], 0, `${generation}: ${field} blocks retirement`);
    }
    for (const field of ['paused', 'public_quiescent', 'cover_paused', 'retire_ready']) {
      assert.equal(certificate[field], true, `${generation}: ${field} required`);
    }
    for (const field of ['accepting', 'drain_scope_unsupported']) {
      assert.equal(certificate[field], false, `${generation}: ${field} blocks retirement`);
    }
    assert.deepEqual(publicListeners(certificate.listeners, `${generation}.certificate.listeners`), identities, `${generation}: certificate listener binding`);
    for (const listener of certificate.listeners) {
      assert.equal(listener.active, 0, `${generation}: active listener blocks retirement`);
      assert.equal(listener.in_accept, false, `${generation}: listener accept still active`);
    }
    assert.equal(exited.pid, ready[generation].pid, `${generation}: exited wrong child`);
    assert.equal(exited.exit_code, 0, `${generation}: exit event code`);
    assert.equal(exited.exit_signal, '', `${generation}: exit event signal`);
    assert.equal(exited.wait_error, '', `${generation}: exit event wait error`);
    const waited = processes.get(generation).wait.at_us;
    assert(signaled.at_us <= waited && waited <= exited.at_us, `${generation}: wait not bound to retirement`);
    retirement[generation] = { certified, signaled, exited };
  }
  assert(retirement.b0.exited.at_us < retirement.b1.certified.at_us, 'retirement generation order');
  for (const name of ['b2', 'fixed-A', 'fixed-client']) {
    const process = processes.get(name);
    const signaled = event(`${name}-retirement-signaled`);
    const exited = event(`${name}-exit-observed`);
    assert(signaled.at_us > end && signaled.at_us <= process.wait.at_us && process.wait.at_us <= exited.at_us,
      `${name}: shutdown did not follow measurement`);
    assert.equal(exited.pid, process.pid, `${name}: exited wrong child`);
    assert.equal(exited.exit_code, 0, `${name}: exit event code`);
    assert.equal(exited.exit_signal, '', `${name}: exit event signal`);
    assert.equal(exited.wait_error, '', `${name}: exit event wait error`);
  }

  const phases = ['baseline', firstOperation, `${firstOperation}-post`, 'routing-update', 'routing-update-post', 'retirement'];
  const windows = [baseline, operations[0].begin.at_us, operations[0].committed.at_us,
    operations[1].begin.at_us, operations[1].committed.at_us,
    event('retirement-begin').at_us, end];
  for (let i = 1; i < windows.length; i++) assert(windows[i] > windows[i - 1], 'request phase windows must be nonempty and ordered');
  const requestCounts = Object.fromEntries(PATHS.map(p => [p, Object.fromEntries(phases.map(phase => [phase, 0]))]));
  const causalCounts = Object.fromEntries(PATHS.map(p => [p, { old: 0, next: 0 }]));
  function validateRequest(request, label) {
    object(request, label);
    assert(PATHS.includes(request.path), `${label}: unknown/missing path`);
    assert.equal(request.error, '', `${label}: request error`);
    for (const key of ['scheduled_us', 'dispatch_us', 'local_adapter_connect_us', 'end_to_end_inner_tls_us', 'http_headers_us', 'total_us']) {
      integer(request[key], `${label}.${key}`);
    }
    assert(request.scheduled_us <= request.dispatch_us, `${label}: dispatch precedes schedule`);
    assert(request.local_adapter_connect_us <= request.end_to_end_inner_tls_us && request.end_to_end_inner_tls_us <= request.http_headers_us && request.http_headers_us <= request.total_us,
      `${label}: latency stages not ordered`);
  }
  for (const [index, request] of array(r.requests, 'requests', 1).entries()) {
    const label = `requests[${index}]`;
    validateRequest(request, label);
    const phase = phases.indexOf(request.phase);
    assert(phase >= 0, `${label}: unknown/missing phase`);
    assert(request.dispatch_us >= windows[phase] && request.dispatch_us < windows[phase + 1], `${label}: phase timestamp mismatch`);
    // Client dispatch is not server Accept: RTT can carry a pre-switch request
    // across the pause barrier. Only genuinely overlapping requests have an
    // ambiguous origin; completed old-window and newly dispatched requests do not.
    const headersAt = request.dispatch_us + request.http_headers_us;
    integer(headersAt, `${label}.headers_at_us`);
    if (request.dispatch_us >= operations[1].paused.at_us) {
      assert.equal(request.marker, 'origin-2', `${label}: wrong origin after route pause`);
      causalCounts[request.path].next++;
    } else if (headersAt < operations[1].paused.at_us) {
      assert.equal(request.marker, 'origin-1', `${label}: wrong origin before route pause`);
      causalCounts[request.path].old++;
    } else {
      assert(['origin-1', 'origin-2'].includes(request.marker), `${label}: wrong origin during route transition`);
    }
    requestCounts[request.path][request.phase]++;
  }
  for (const p of PATHS) for (const phase of ['baseline', `${firstOperation}-post`, 'routing-update-post', 'retirement']) {
    assert(requestCounts[p][phase] > 0, `requests: missing ${p}/${phase}`);
  }
  for (const p of PATHS) {
    assert(causalCounts[p].old > 0, `requests: missing ${p} causally old window`);
    assert(causalCounts[p].next > 0, `requests: missing ${p} causally new window`);
  }
  const probes = new Set();
  for (const [index, request] of array(r.pause_requests, 'pause_requests', 4).entries()) {
    const label = `pause_requests[${index}]`;
    validateRequest(request, label);
    const operation = operations.find(item => item.name === request.operation);
    assert(operation, `${label}: unknown operation`);
    const key = `${request.operation}/${request.path}`;
    assert(!probes.has(key), `${label}: duplicate pause probe`);
    probes.add(key);
    assert(request.dispatch_us >= operation.paused.at_us && request.dispatch_us < operation.committed.at_us, `${label}: request outside pause window`);
    assert.equal(request.marker, operation.name === 'routing-update' ? 'origin-2' : 'origin-1', `${label}: wrong origin`);
  }
  assert.equal(probes.size, 4, 'pause_requests: require both paths in both operation windows');

  const flows = named(r.flows, 'flows', 'id');
  assert.equal(r.initial_persistent_flows, 32, 'initial_persistent_flows');
  assert.equal(flows.size, 44, 'flows: expected 32 original + 6 handoff + 6 route streams');
  let verifiedBytes = 0;
  for (const flow of flows.values()) {
    const label = `flows.${flow.id}`;
    assert(PATHS.includes(flow.path), `${label}: path`);
    assert(GENERATIONS.includes(flow.generation), `${label}: generation`);
    assert(MODES.includes(flow.mode), `${label}: mode`);
    assert.equal(flow.marker, flow.generation === 'b2' ? 'origin-2' : 'origin-1', `${label}: wrong origin`);
    assert.equal(flow.error, '', `${label}: flow error`);
    assert(['client-half-close', 'server-ended', 'client-ended'].includes(flow.completion), `${label}: completion`);
    for (const field of ['started_us', 'stop_requested_us', 'finished_us']) integer(flow[field], `${label}.${field}`, 1);
    assert(flow.started_us < flow.stop_requested_us && flow.stop_requested_us <= flow.finished_us, `${label}: invalid flow lifetime`);
    const requiredDirections = flow.mode === 'download' ? ['down'] : flow.mode === 'upload' ? ['up'] : ['up', 'down'];
    for (const direction of ['up', 'down']) {
      const frames = array(flow[`${direction}_frames`], `${label}.${direction}_frames`, requiredDirections.includes(direction) ? 4 : 0);
      if (!requiredDirections.includes(direction)) assert.equal(frames.length, 0, `${label}: unexpected direction payload`);
      let sum = 0;
      let last = flow.started_us;
      for (const [seq, frame] of frames.entries()) {
        assert.equal(frame.seq, seq, `${label}.${direction}: missing/duplicate sequence`);
        assert.equal(frame.bytes, FRAME_BYTES, `${label}.${direction}: frame size`);
        integer(frame.at_us, `${label}.${direction}.at_us`, 1);
        assert(frame.at_us >= last && frame.at_us <= flow.finished_us, `${label}.${direction}: frame timestamp`);
        last = frame.at_us;
        digest(frame.sha256, `${label}.${direction}.sha256`);
        digest(frame.expected_sha256, `${label}.${direction}.expected_sha256`);
        assert.equal(frame.sha256, frame.expected_sha256, `${label}.${direction}: payload digest mismatch`);
        assert.equal(frame.expected_sha256, payloadDigests[seq % 251], `${label}.${direction}: payload differs from deterministic sequence`);
        sum += frame.bytes;
      }
      assert.equal(flow[`verified_${direction}_bytes`], sum, `${label}.${direction}: byte sum mismatch`);
      integer(sum, `${label}.${direction}: byte sum`);
      verifiedBytes += sum;
      if (frames.length > 0) {
        const startBoundary = flow.generation === 'b0' ? operations[0].begin.at_us : flow.generation === 'b1' ? operations[1].begin.at_us : retirement.b0.certified.at_us;
        const endBoundary = flow.generation === 'b2' ? retirement.b1.exited.at_us : operations[1].committed.at_us;
        assert(frames[0].at_us < startBoundary && frames.at(-1).at_us > endBoundary, `${label}.${direction}: flow did not span required handoff/retirement`);
      }
    }
    assert.equal(flow.sent_up_frames, flow.up_frames.length, `${label}: sent/verified upload frame count`);
    const halfClose = object(flow.half_close, `${label}.half_close`);
    for (const side of ['origin', 'server']) {
      assert.equal(halfClose[`${side}_read_eof`], true, `${label}: missing ${side} clean EOF`);
      integer(halfClose[`${side}_read_eof_us`], `${label}.${side}_read_eof_us`, 1);
      assert(halfClose[`${side}_read_eof_us`] >= flow.started_us && halfClose[`${side}_read_eof_us`] <= flow.finished_us,
        `${label}: EOF outside flow lifetime`);
    }
    if (flow.mode === 'duplex') {
      for (const field of ['client_write_closed_us', 'server_terminal_us']) {
        integer(halfClose[field], `${label}.half_close.${field}`, 1);
        assert(halfClose[field] >= flow.stop_requested_us && halfClose[field] <= flow.finished_us, `${label}: half close outside shutdown lifetime`);
      }
      const clientFirst = flow.completion === 'client-half-close';
      assert(clientFirst || flow.completion === 'server-ended', `${label}: duplex half-close mode`);
      const direction = clientFirst ? 'down' : 'up';
      const atClose = halfClose[clientFirst ? 'down_frames_at_origin_eof' : 'up_frames_at_server_eof'];
      integer(atClose, `${label}: frames at half close`, 1);
      assert(flow[`${direction}_frames`].length - atClose >= 3, `${label}: opposite direction did not advance after half close`);
      const firstClose = halfClose[clientFirst ? 'origin_read_eof_us' : 'server_read_eof_us'];
      const secondClose = halfClose[clientFirst ? 'server_read_eof_us' : 'origin_read_eof_us'];
      assert(firstClose >= flow.stop_requested_us, `${label}: duplex EOF precedes requested shutdown`);
      assert(firstClose < secondClose, `${label}: half close order`);
      assert(flow[`${direction}_frames`].filter(frame => frame.at_us > firstClose).length >= 3, `${label}: missing observed frames after half close`);
    }
    if (flow.generation !== 'b0') {
      const operation = operations[flow.generation === 'b1' ? 0 : 1];
      assert(flow.started_us >= operation.committed.at_us, `${label}: started before its generation committed`);
    }
    if (flow.generation !== 'b2') assert(flow.finished_us <= retirement[flow.generation].certified.at_us, `${label}: certified while its flow was unfinished`);
  }
  integer(verifiedBytes, 'verified total bytes', 1);
  for (const generation of GENERATIONS) for (const p of PATHS) {
    const cohort = [...flows.values()].filter(flow => flow.generation === generation && flow.path === p);
    assert.equal(cohort.length, generation === 'b0' ? 16 : 3, `${generation}/${p}: cohort size`);
    for (const mode of MODES) assert(cohort.some(flow => flow.mode === mode), `${generation}/${p}: missing ${mode}`);
  }

  const checkpoints = named(r.checkpoints, 'checkpoints');
  let checkpointTime = -1;
  for (const name of CHECKPOINTS) {
    const checkpoint = required(checkpoints, name, 'checkpoints');
    integer(checkpoint.at_us, `checkpoints.${name}.at_us`, 1);
    assert(checkpoint.at_us > checkpointTime, 'checkpoints: timestamps not ordered');
    checkpointTime = checkpoint.at_us;
    if (name === 'before-b0-retire') assert.equal(checkpoint.at_us, event(name).at_us, `${name}: checkpoint/event mismatch`);
    const counts = named(checkpoint.flows, `checkpoints.${name}.flows`, 'id');
    const generations = name === 'baseline' ? ['b0'] : name === 'after-handoff' ? ['b0', 'b1'] : name === 'after-route' ? GENERATIONS : ['b2'];
    for (const flow of flows.values()) {
      if (!generations.includes(flow.generation)) continue;
      const count = required(counts, flow.id, `checkpoints.${name}`);
      for (const direction of ['up', 'down']) {
        integer(count[`${direction}_frames`], `checkpoints.${name}.${flow.id}.${direction}_frames`);
        assert(count[`${direction}_frames`] <= flow[`${direction}_frames`].length, `checkpoints.${name}: count exceeds final frames`);
        if (count[`${direction}_frames`] > 0) {
          assert(flow[`${direction}_frames`][count[`${direction}_frames`] - 1].at_us <= checkpoint.at_us,
            `checkpoints.${name}: count includes a future frame`);
        }
      }
    }
  }
  assert(checkpoints.get('baseline').at_us >= baseline && checkpoints.get('baseline').at_us < operations[0].begin.at_us, 'baseline checkpoint outside baseline');
  assert(checkpoints.get('after-handoff').at_us > operations[0].committed.at_us && checkpoints.get('after-handoff').at_us < operations[1].begin.at_us, 'handoff checkpoint outside post window');
  assert(checkpoints.get('after-route').at_us > operations[1].committed.at_us && checkpoints.get('after-route').at_us < event('retirement-begin').at_us, 'route checkpoint outside post window');
  for (const [beforeName, afterName, generations] of [
    ['baseline', 'after-handoff', ['b0']], ['after-handoff', 'after-route', ['b0', 'b1']],
  ]) {
    const beforeCounts = named(checkpoints.get(beforeName).flows, beforeName, 'id');
    const afterCounts = named(checkpoints.get(afterName).flows, afterName, 'id');
    for (const flow of flows.values()) {
      if (!generations.includes(flow.generation)) continue;
      for (const direction of flow.mode === 'download' ? ['down'] : flow.mode === 'upload' ? ['up'] : ['up', 'down']) {
        assert(afterCounts.get(flow.id)[`${direction}_frames`] - beforeCounts.get(flow.id)[`${direction}_frames`] >= 3,
          `${flow.id}/${direction}: no checkpoint progress across handoff`);
      }
    }
  }
  for (const generation of ['b0', 'b1']) {
    const before = checkpoints.get(`before-${generation}-retire`);
    const after = checkpoints.get(`after-${generation}-retire`);
    assert(before.at_us < retirement[generation].certified.at_us && retirement[generation].exited.at_us < after.at_us, `${generation}: checkpoints do not bracket retirement`);
    const beforeCounts = named(before.flows, 'before-retirement flows', 'id');
    const afterCounts = named(after.flows, 'after-retirement flows', 'id');
    for (const flow of flows.values()) {
      if (flow.generation !== 'b2') continue;
      for (const direction of flow.mode === 'download' ? ['down'] : flow.mode === 'upload' ? ['up'] : ['up', 'down']) {
        assert(afterCounts.get(flow.id)[`${direction}_frames`] - beforeCounts.get(flow.id)[`${direction}_frames`] >= 3,
          `${generation}: ${flow.id}/${direction} did not advance across retirement`);
        assert(flow[`${direction}_frames`].filter(frame => frame.at_us > retirement[generation].exited.at_us && frame.at_us <= after.at_us).length >= 3,
          `${generation}: ${flow.id}/${direction} lacks three frames observed after child exit`);
      }
    }
  }
  for (const generation of GENERATIONS) {
    const counters = object(r[`${generation}_stats`], `${generation}_stats`);
    assert(Object.keys(counters).length > 0, `${generation}_stats: empty`);
    for (const [key, value] of Object.entries(counters)) integer(value, `${generation}_stats.${key}`);
    integer(counters['vless>>>vision>>>splice_bytes'], `${generation}: splice bytes`, 1);
  }
  return { schema_version: 9, run_id: r.run_id, mode: r.mode, correctness_passed: true,
    requests: r.requests.length, pause_requests: r.pause_requests.length, flows: flows.size,
    verified_bytes: verifiedBytes, request_counts: requestCounts };
}

function readJSON(filename) {
  assert(fs.statSync(filename).size <= 256 * 1024 * 1024, 'result JSON exceeds 256 MiB limit');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function main(args) {
  assert(args[0] === '--manifest' && args.length >= 3, 'usage: node verify.cjs --manifest hashes.json result.json [...]');
  const expectedBinarySha256 = object(readJSON(args[1]).binary_sha256, 'manifest.binary_sha256');
  const summaries = args.slice(2).map(filename => {
    const exit = fs.readFileSync(path.join(path.dirname(filename), 'exit-code.txt'), 'utf8').trim();
    assert.equal(exit, '0', `${filename}: harness exit-code.txt must contain 0`);
    return { file: filename, ...verifyResult(readJSON(filename), { expectedBinarySha256, harnessExitCode: 0 }) };
  });
  assert.equal(new Set(summaries.map(summary => summary.run_id)).size, summaries.length, 'duplicate run_id in input batch');
  return { schema_version: 9, runs: summaries.length, summaries };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`H9 verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyResult, main, PATHS, CHECKPOINTS, FRAME_BYTES };
