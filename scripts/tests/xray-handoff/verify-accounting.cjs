#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const crash = ['intent','fenced','cover_draining','drained','checkpoint_prepared','signal','finalized','committed'];
const io = ['fenced','cover_draining','drained','accounting_prepare','checkpoint_prepared','signal','accounting_finalize','finalized','committed'];
const cases = ['zero-old','nonzero-old',...crash.map(x=>'crash-'+x),...io.map(x=>'io-'+x)];
function nonempty(v,label) { assert(typeof v==='string' && v.length>0,label+': nonempty string required'); }
function uint(v,label,min=0) { assert(Number.isSafeInteger(v) && v>=min,label+': safe nonnegative integer required'); }
function digest(v,label) { assert(typeof v==='string' && /^[a-f0-9]{64}$/.test(v),label+': SHA256 required'); }
function finite(v) { if(typeof v==='number') assert(Number.isFinite(v),'nonfinite evidence'); else if(v && typeof v==='object') for(const x of Object.values(v)) finite(x); }
function publicIdentity(s) {
  assert(Array.isArray(s.listeners),'missing listeners');const a=s.listeners.filter(l=>l.role==='public');assert.equal(a.length,1);
  for(const socket of s.listeners) {
    assert(['public','cover'].includes(socket.role),'unreviewed listener role');nonempty(socket.address,'listener address');
    for(const k of ['socket_inode','socket_cookie','protocol']) uint(socket[k],'listener '+k,1);
    assert.equal(socket.socket_type,1);assert.equal(socket.accept_conn,1);
  }
  const l=a[0];nonempty(l.address,'address');for(const k of ['socket_inode','socket_cookie','protocol']) uint(l[k],k,1);
  assert.equal(l.socket_type,1);assert.equal(l.accept_conn,1);return [l.address,l.socket_inode,l.socket_cookie,l.protocol];
}
function verifyIdentity(s,generation) {
  assert(s && typeof s==='object','missing process identity');assert.equal(s.generation_id,generation);uint(s.pid,'pid',1);nonempty(s.boot_id,'boot id');
  assert(typeof s.pid_start_ticks==='string' && /^[1-9][0-9]*$/.test(s.pid_start_ticks),'pid start ticks');digest(s.drain_config_digest,'config digest');
  assert.equal(s.drain_config_version,1);assert.equal(s.drain_scope_version,1);assert.equal(s.ready,true);assert.equal(s.require_fence,true);return publicIdentity(s);
}
function verifyLifecycle(l,operation,previousFence=false) {
  nonempty(operation,'operation id');assert.equal(l.operation_id,operation);assert.equal(l.version,6);assert.equal(l.phase,'committed');assert.equal(l.action,'Retire');
  assert.equal(l.owner,'candidate');assert.equal(l.target,'old');uint(l.epoch,'fence epoch',1);nonempty(l.fence_intent,'fence intent');
  for(const role of ['old','candidate']) { nonempty(l[role].binary,role+' binary');nonempty(l[role].control,role+' control'); }
  assert.equal(l.old.retired,true);assert.equal(l.candidate.retired,false);
  const old=l.old.identity,next=l.candidate.identity,p=l.drain_proof,identity=verifyIdentity(old,'old');
  assert.deepEqual(verifyIdentity(next,'new'),identity,'candidate listener binding');assert.notEqual(old.pid,next.pid);
  assert.deepEqual(verifyIdentity(p,'old'),identity,'drain listener binding');
  const sockets=s=>s.listeners.map(x=>[x.role,x.address,x.socket_inode,x.socket_cookie,x.protocol]).sort((a,b)=>a[1].localeCompare(b[1]));
  assert.deepEqual(sockets(p),sockets(old),'complete drain listener binding');
  for(const k of ['pid','pid_start_ticks','boot_id','drain_config_digest']) assert.equal(p[k],old[k],'drain identity '+k);
  for(const k of ['active','public_active','cover_active','background_active']) assert.equal(p[k],0,k+' blocks retirement');
  for(const k of ['paused','cover_paused','retire_ready']) assert.equal(p[k],true,k+' required');
  // The Rust durable projection omits this summary in some recovery paths.
  // Always reconstruct it from paused/accepting/activity and every listener's
  // Accept state below; an explicitly false summary must still be rejected.
  if('public_quiescent' in p) assert.equal(p.public_quiescent,true,'public_quiescent required');
  for(const k of ['accepting','drain_scope_unsupported']) assert.equal(p[k],false,k+' blocks retirement');
  // Recovery after the old process has exited advances the attempt fence but
  // must retain the durable proof observed before signaling that process.
  uint(p.fence_epoch,'proof fence epoch',1);nonempty(p.fence_intent,'proof fence intent');
  assert.equal(p.fence_epoch,l.epoch-(previousFence?1:0));
  if(previousFence) assert.notEqual(p.fence_intent,l.fence_intent);else assert.equal(p.fence_intent,l.fence_intent);
  assert.equal(p.fence_allowed,'retire');
  for(const socket of p.listeners) { assert.equal(socket.active,0,'active listener');assert.equal(socket.in_accept,false,'listener in Accept'); }
  return identity;
}
function verifyReceipt(r,duplicate) {
  nonempty(r.node_id,'receipt node');nonempty(r.agent_instance_id,'receipt instance');uint(r.sequence,'receipt sequence',1);uint(r.usage_generation_id,'receipt generation',1);
  for(const k of ['accepted_readings','inserted_samples','gap_samples','rejected_counters','skipped_counters']) uint(r[k],'receipt '+k);
  for(const k of ['gap_samples','rejected_counters','skipped_counters']) assert.equal(r[k],0);
  if('window_start_unix_secs' in r) uint(r.window_start_unix_secs,'receipt window',1);assert.equal(r.duplicate,duplicate);
}
const receiptKey=r=>JSON.stringify([r.node_id,r.agent_instance_id,r.sequence]);
function verifyAckReplay(r,http,duplicates) {
  assert.match(http,/^HTTP\/1\.1 200 /);const offset=http.indexOf('\r\n\r\n');assert(offset>=0,'HTTP header boundary');
  const ack=JSON.parse(http.slice(offset+4));verifyReceipt(ack,false);assert(ack.accepted_readings>0);
  const stored=r.receipts.find(x=>receiptKey(x)===receiptKey(ack));assert(stored,'ACK from different case');assert.deepEqual(ack,stored,'ACK differs from stored receipt');
  const retries=duplicates.filter(x=>receiptKey(x)===receiptKey(ack));assert(retries.length>0,'missing duplicate HTTP retry');
  for(const retry of retries) { verifyReceipt(retry,true);assert.deepEqual({...retry,duplicate:false},stored,'retry changed original receipt'); }
}
function verifyGuard(g,name) {
  finite(g);assert.equal(g.status,'PASS');assert.equal(g.case,name);
  const fields=name==='reject-v4-drain-contract'?['old_alive','durable_state_unchanged','fresh_requests_continue','old_same_tcp_continues']:
    name==='unsupported-udp-retire-guard'?['old_alive','durable_state_unchanged','fresh_candidate_tcp','retirement_refused','udp_echo_before_and_after_switch','unsupported']:null;
  assert(fields,'unknown guard');for(const k of fields) assert.equal(g[k],true,'guard '+k);
  if(name==='reject-v4-drain-contract') assert.equal(g.candidate_accepted,0);else assert.equal(g.old_active,0);
}
function verifyHeldCover(c) {
  finite(c);assert.equal(c.status,'PASS');for(const k of ['existing_cover_tls_completed_after_pause','same_operation_recovery']) assert.equal(c[k],true);
  assert.equal(c.old_exit_code,0);assert.equal(c.old_user_bytes_each_direction,2048);assert.equal(c.candidate_same_tcp_bytes_each_direction,3072);
  const identity=verifyLifecycle(c.lifecycle,c.lifecycle.operation_id),s=c.draining_status;assert.deepEqual(verifyIdentity(s,'old'),identity);
  for(const k of ['pid','pid_start_ticks','boot_id','drain_config_digest']) assert.equal(s[k],c.lifecycle.old.identity[k],'held cover identity '+k);
  assert.equal(s.retire_ready,false);uint(s.cover_active,'held cover active',1);assert.equal(s.public_active,0);assert.equal(s.public_quiescent,true);assert.equal(s.paused,true);assert.equal(s.accepting,false);
}
function verifyCase(r, name, mode) {
  finite(r);assert(['plain','tls','reality'].includes(mode),'unknown security mode');
  assert(cases.includes(name),'unknown accounting case');
  const amounts=name==='zero-old'?[0,7168]:name==='nonzero-old'?[40960,18432]:[29696,7168],expected=amounts[0]+amounts[1];
  assert.equal(r.status,'PASS');
  assert.equal(r.case,name);
  assert.equal(r.security,mode);
  assert.equal(r.failpoint,name.startsWith('io-')?'io:'+name.slice(3):name.startsWith('crash-')?name.slice(6):'');
  assert.equal(r.coordinator,'Rust normal Agent module');assert.equal(r.runtime,'v6-fenced-whole-configuration-drain');
  for(const key of ['old_final_each_direction','new_live_each_direction']) uint(r[key],key);
  assert.deepEqual([r.old_final_each_direction,r.new_live_each_direction],amounts,'native per-generation exact totals');
  assert.deepEqual(r.postgres_totals,[expected,expected],'Postgres exact totals');
  assert.equal(r.old_final_each_direction+r.new_live_each_direction,expected,'native exact total');
  assert.equal(r.application_reconnect_attempts,0);
  assert.equal(r.old_exit_code,0);
  assert.equal(r.new_active_after_retire,1);
  assert.equal(r.node_zero_windows,0);
  assert.equal(r.real_console_commit_ack_drop,true);
  assert.equal(r.stale_resume_http,409);
  assert(Number.isSafeInteger(r.same_listener_inode) && r.same_listener_inode>0);
  const previousFence=['crash-signal','crash-finalized','io-accounting_finalize','io-finalized','io-committed'].includes(name);
  assert.equal(verifyLifecycle(r.lifecycle,r.operation_id,previousFence)[1],r.same_listener_inode);
  assert.equal(r.ledger.prepared,null);
  assert.equal(r.ledger.ownership,1);uint(r.ledger.started,'ledger start',1);
  const labels=Object.keys(r.ledger.totals);assert.equal(labels.length,1);nonempty(labels[0],'counter label');
  const totals = Object.values(r.ledger.totals);
  assert.equal(totals.length,1);
  assert.deepEqual(totals[0],[expected,expected],'durable ledger exact total');
  assert.equal(r.ledger.sources.length,2);
  const retired = r.ledger.sources.filter(source=>source.final_report);
  assert.equal(retired.length,1);
  const oldSource=retired[0],liveSource=r.ledger.sources.find(source=>source!==oldSource),report=oldSource.final_report;
  for(const [source,role] of [[oldSource,'old'],[liveSource,'candidate']]) {
    nonempty(source.epoch,'source epoch');assert.equal(source.control,r.lifecycle[role].control,'source control binding');assert.equal(source.intent,null);
  }
  assert.notEqual(oldSource.epoch,liveSource.epoch);assert.equal(r.ledger.epoch,oldSource.epoch);
  assert.equal(oldSource.final_operation,r.operation_id);uint(oldSource.stopped_at,'stopped_at',1);
  assert.equal(liveSource.final_operation,null);assert.equal(liveSource.final_report,null);assert.equal(liveSource.stopped_at,null);
  nonempty(report.agent_instance_id,'final report instance');uint(report.sequence,'final report sequence',1);uint(report.usage_generation_id,'final report generation',1);
  uint(report.read_at_unix_secs,'final read time',1);uint(report.xray_started_at_unix_secs,'final start time',1);
  assert(report.read_at_unix_secs>=report.xray_started_at_unix_secs);assert.equal(report.xray_epoch,oldSource.epoch);
  assert.deepEqual(Object.keys(r.ledger.heads).sort(),[oldSource.epoch,liveSource.epoch].sort());
  for(const [source,amount] of [[oldSource,amounts[0]],[liveSource,amounts[1]]]) assert.deepEqual(r.ledger.heads[source.epoch],{[labels[0]]:[amount,amount]},'source head exact totals');
  assert.equal(retired[0].final_report.counters.length,1);
  assert.equal(report.counters[0].label,labels[0]);
  for(const field of ['uplink_bytes','downlink_bytes']) assert.equal(retired[0].final_report.counters[0][field],r.old_final_each_direction);
  assert(Array.isArray(r.receipts) && r.receipts.length>=3,'missing actual Console receipts');
  // PG stores the original receipt, not the duplicate HTTP response; replay
  // must not insert a second receipt or increase the exact totals above.
  assert(r.receipts.every(x=>x.duplicate===false),'stored receipt was rewritten by replay');
  assert.equal(new Set(r.receipts.map(x=>x.node_id)).size,1,'mixed receipt nodes');
  assert.equal(new Set(r.receipts.map(receiptKey)).size,r.receipts.length);
  assert(r.receipts.some(x=>x.duplicate===false && x.accepted_readings>0),'missing accepted receipt');
  for(const receipt of r.receipts) {
    verifyReceipt(receipt,false);assert.equal(receipt.agent_instance_id,report.agent_instance_id,'receipt instance binding');assert.equal(receipt.usage_generation_id,report.usage_generation_id,'receipt generation binding');
    assert.equal(receipt.gap_samples,0);
    assert.equal(receipt.rejected_counters,0);
    assert.equal(receipt.skipped_counters,0);
  }
  return expected;
}
function verifyDirectory(root) {
  const read = file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
  const inputs = read('inputs.json');
  const sha = file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.deepEqual(Object.keys(inputs.paths).sort(),['agent','client','legacy','manager','runtime']);
  assert.deepEqual(Object.keys(inputs.sha256).sort(),Object.keys(inputs.paths).sort());
  for(const [key,file] of Object.entries(inputs.paths)) { digest(inputs.sha256[key],'input '+key);assert.equal(sha(file),inputs.sha256[key],'changed input '+key); }
  const reports=[];
  for(const mode of ['plain','tls','reality']) {
    const exit=read(mode+'-exit.json');
    assert.equal(exit.code,0);assert.equal(exit.signal,null);assert(!exit.error);
    // The first frozen runner predates this diagnostic field; its successful
    // code/signal pair remains required. New records must explicitly be false.
    if('timed_out' in exit) assert.equal(exit.timed_out,false);
    const duplicates=fs.readFileSync(path.join(root,mode+'.log'),'utf8').split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(r=>r.duplicate===true);
    const names=fs.readdirSync(path.join(root,mode)).filter(name=>fs.statSync(path.join(root,mode,name)).isDirectory());
    const guards=mode==='plain'?['reject-v4-drain-contract','unsupported-udp-retire-guard']:[];
    assert.deepEqual(names.sort(),[...cases,...guards].sort(),'complete exact case set');
    let bytes=0;
    const operations=new Set();
    for(const name of cases) {
      const r=read(path.join(mode,name,'result.json'));bytes+=verifyCase(r,name,mode);
      assert(!operations.has(r.operation_id),'duplicate case operation');operations.add(r.operation_id);
      assert.equal(sha(path.join(root,mode,name,'xray')),inputs.sha256.runtime);
      const http=fs.readFileSync(path.join(root,mode,name,'real-console-committed-but-ack-dropped.http'),'utf8');
      verifyAckReplay(r,http,duplicates);
    }
    for(const name of guards) {
      const guard=read(path.join(mode,name,'result.json'));
      verifyGuard(guard,name);
    }
    assert.equal(bytes,693248);
    reports.push({mode,fixtures:names.length,accounting:cases.length,bytes_each_direction:bytes});
  }
  const exit=read('held-cover-exit.json');assert.equal(exit.code,0);assert.equal(exit.signal,null);assert(!exit.error);if('timed_out' in exit) assert.equal(exit.timed_out,false);
  const cover=read('held-cover/held-cover-rust-recover/result.json');
  verifyHeldCover(cover);
  return {status:'PASS',inputs:inputs.sha256,cases:reports,total_fixtures:60,total_actual_console_pg_cases:57,held_cover:true};
}
module.exports={verifyCase,verifyDirectory,verifyLifecycle,verifyAckReplay,verifyGuard,verifyHeldCover};
if(require.main===module) {
  const root=process.argv[2];
  if(!root) throw new Error('usage: verify-accounting.cjs RESULT_DIRECTORY');
  console.log(JSON.stringify(verifyDirectory(path.resolve(root)),null,2));
}
