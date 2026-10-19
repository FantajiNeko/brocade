import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const workspace = path.resolve(import.meta.dirname, '../../..');
const agent = process.env.BROCADE_AGENT_BIN || path.join(workspace, 'target/debug/brocade-agent');
const sourceXray = process.env.BROCADE_XRAY_BIN || path.join(workspace, '.tools/xray');
for (const binary of [agent, sourceXray]) {
  if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`missing binary: ${binary}`);
  }
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brocade-xray-recovery-'));
const xray = path.join(stateDir, 'xray');
fs.copyFileSync(sourceXray, xray);
fs.chmodSync(xray, 0o755);

const listenTcp = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = server => new Promise(resolve => server.close(resolve));
const reservePort = async () => {
  const server = await listenTcp();
  const port = server.address().port;
  await close(server);
  return port;
};
const apiPort = await reservePort();
const vlessPort = await reservePort();
const forwardingPort = await reservePort();
const target = await listenTcp();
const collision = await listenTcp();
const targetPort = target.address().port;
const collisionPort = collision.address().port;

const baseConfig = {
  log: { loglevel: 'warning' },
  api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
  stats: {},
  policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } },
  inbounds: [
    {
      tag: 'api', listen: '127.0.0.1', port: apiPort, protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    },
    {
      tag: 'test-vless', listen: '127.0.0.1', port: vlessPort, protocol: 'vless',
      settings: { clients: [], decryption: 'none' },
    },
  ],
  outbounds: [{ tag: 'out:forward', protocol: 'freedom', settings: { ipsBlocked: [] } }],
  routing: { rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }] },
};
const oldContent = JSON.stringify(baseConfig, null, 2);
fs.writeFileSync(path.join(stateDir, 'xray.json'), oldContent, { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, 'forwarding-desired.json'), JSON.stringify({
  generation: 72,
  rules: [{
    id: 42,
    protocol: 'tcp',
    listen_port: forwardingPort,
    target_host: '127.0.0.1',
    target_port: targetPort,
  }],
}, null, 2), { mode: 0o600 });
const grantCount = Number(process.env.BROCADE_RECOVERY_GRANT_COUNT || 64);
if (!Number.isSafeInteger(grantCount) || grantCount < 0 || grantCount > 4096) {
  throw new Error(`invalid BROCADE_RECOVERY_GRANT_COUNT: ${process.env.BROCADE_RECOVERY_GRANT_COUNT}`);
}
const grantClients = Array.from({ length: grantCount }, (_, index) => ({
  email: `recovery-test-${index.toString().padStart(2, '0')}`,
  uuid: `b831381d-6324-4d53-ad4f-${index.toString(16).padStart(12, '0')}`,
  flow: null,
  level: 0,
}));
fs.writeFileSync(path.join(stateDir, 'grants.desired.json'), JSON.stringify([{
  tag: 'test-vless',
  clients: grantClients,
}], null, 2), { mode: 0o600 });

const environment = { ...process.env, BROCADE_XRAY_BIN: xray };
const runAgent = args => new Promise(resolve => {
  const child = spawn(agent, args, { env: environment });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
});
const requireSuccess = (result, phase) => {
  if (result.code !== 0) {
    throw new Error(`${phase} failed (${result.code}): ${result.stdout}\n${result.stderr}`);
  }
};
const connectForwarding = () => new Promise((resolve, reject) => {
  const socket = net.connect(forwardingPort, '127.0.0.1');
  socket.once('connect', () => {
    socket.destroy();
    resolve();
  });
  socket.once('error', reject);
});
const queryUser = () => spawnSync(xray, [
  'api', 'inbounduser', `--server=127.0.0.1:${apiPort}`, '-tag=test-vless',
], { encoding: 'utf8', timeout: 5000 });
const requireBusinessState = async phase => {
  await connectForwarding();
  const users = queryUser();
  const reportedGrants = users.stdout.match(/recovery-test-/g)?.length || 0;
  if (users.status !== 0 || reportedGrants !== grantCount) {
    throw new Error(`${phase} grant missing: ${users.stdout}\n${users.stderr}`);
  }
  if (fs.existsSync(path.join(stateDir, 'xray.recovery-degraded'))) {
    throw new Error(`${phase} remained degraded: ${fs.readFileSync(path.join(stateDir, 'xray.recovery-degraded'), 'utf8')}`);
  }
};
const managedPid = () => {
  const rows = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n');
  const row = rows.find(value => value.includes(`${xray} run -config`)
    && value.includes(`${stateDir}/xray.json`));
  if (!row) throw new Error('managed Xray process not found');
  return Number(row.trim().split(/\s+/, 1)[0]);
};

let consoleServer;
let guardServer;
let residentAgent;
let lastPid;
try {
  const initialStarted = Date.now();
  const initialRepair = await runAgent(['repair', '--state-dir', stateDir]);
  requireSuccess(initialRepair, 'initial repair');
  const initialRepairMs = Date.now() - initialStarted;
  await requireBusinessState('initial');
  const initialRecoveryMs = Date.now() - initialStarted;
  const initialVerificationMs = initialRecoveryMs - initialRepairMs;

  guardServer = http.createServer((_request, reply) => {
    reply.writeHead(204);
    reply.end();
  });
  await new Promise((resolve, reject) => {
    guardServer.once('error', reject);
    guardServer.listen(0, '127.0.0.1', resolve);
  });
  residentAgent = spawn(agent, [
    'run',
    '--server', `http://127.0.0.1:${guardServer.address().port}`,
    '--token', 'broc_node_test',
    '--state-dir', stateDir,
    '--apply', 'linux',
  ], { env: environment });
  let residentError = '';
  residentAgent.stdout.on('data', () => {});
  residentAgent.stderr.on('data', chunk => { residentError += chunk; });
  await new Promise(resolve => setTimeout(resolve, 250));
  const crashedPid = managedPid();
  process.kill(crashedPid, 'SIGKILL');
  const crashStarted = Date.now();
  const deadline = crashStarted + 3500;
  let recovered = false;
  while (Date.now() < deadline) {
    try {
      const replacementPid = managedPid();
      if (replacementPid !== crashedPid) {
        await requireBusinessState('automatic crash recovery');
        recovered = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!recovered) {
    throw new Error(`one-second Xray guard did not restore business state: ${residentError}`);
  }
  const crashRecoveryMs = Date.now() - crashStarted;
  residentAgent.kill('SIGTERM');
  await new Promise(resolve => residentAgent.once('exit', resolve));
  residentAgent = undefined;
  await new Promise(resolve => guardServer.close(resolve));
  guardServer = undefined;
  const preRollbackPid = managedPid();
  if (preRollbackPid === crashedPid) throw new Error('crashed PID was not replaced');

  const brokenConfig = structuredClone(baseConfig);
  brokenConfig.inbounds.push({
    tag: 'runtime-bind-conflict',
    listen: '127.0.0.1',
    port: collisionPort,
    protocol: 'dokodemo-door',
    settings: { address: '127.0.0.1', port: targetPort, network: 'tcp' },
  });
  const brokenContent = JSON.stringify(brokenConfig, null, 2);
  const digest = crypto.createHash('sha256').update(brokenContent).digest('hex');
  const desiredResponse = JSON.stringify({
    t: 'deployment',
    v: {
      deployment: {
        deployment_id: 9001,
        node_id: 'local-recovery-test',
        claim_generation: 1,
        wave: 0,
        actions: ['apply-xray'],
        usage_generation_id: null,
        desired: {
          phantun: { state: 'unmanaged', reason: 'test' },
          wireguard: { state: 'unmanaged', reason: 'test' },
          xray: { state: 'present', content: brokenContent, sha256: digest },
          hy2_port_hop: { state: 'unmanaged', reason: 'test' },
          grants: { state: 'unmanaged', reason: 'test' },
        },
        phantun_binary: null,
      },
      certificates: [],
    },
  });
  let observation;
  consoleServer = http.createServer((request, reply) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'GET' && request.url === '/agent/v1/desired') {
        reply.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(desiredResponse),
        });
        reply.end(desiredResponse);
      } else if (request.method === 'POST' && request.url === '/agent/v1/observation') {
        observation = JSON.parse(body);
        reply.writeHead(204);
        reply.end();
      } else {
        reply.writeHead(404);
        reply.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    consoleServer.once('error', reject);
    consoleServer.listen(0, '127.0.0.1', resolve);
  });

  const rollbackStarted = Date.now();
  const applied = await runAgent([
    'apply-once',
    '--server', `http://127.0.0.1:${consoleServer.address().port}`,
    '--token', 'broc_node_test',
    '--state-dir', stateDir,
    '--apply', 'linux',
  ]);
  const rollbackRecoveryMs = Date.now() - rollbackStarted;
  if (applied.code === 0) throw new Error('broken candidate unexpectedly converged');
  if (!applied.stderr.includes('已恢复上一份配置')) {
    throw new Error(`rollback was not reported: ${applied.stdout}\n${applied.stderr}`);
  }
  if (fs.readFileSync(path.join(stateDir, 'xray.json'), 'utf8') !== oldContent) {
    throw new Error('xray.json was not restored byte-for-byte');
  }
  await requireBusinessState('config rollback');
  lastPid = managedPid();
  if (lastPid === preRollbackPid) throw new Error('runtime-conflicting candidate never replaced the old PID');
  if (!observation || observation.result !== 'failed-dirty') {
    throw new Error(`missing failed-dirty observation: ${JSON.stringify(observation)}`);
  }

  process.stdout.write(`${JSON.stringify({
    initialRecoveryMs,
    initialRepairMs,
    initialVerificationMs,
    crashRecoveryMs,
    rollbackRecoveryMs,
    configRestoredByteForByte: true,
    forwardingRestored: true,
    grantRestored: true,
    grantCount,
    observationResult: observation.result,
    stateDir: process.env.BROCADE_KEEP_RECOVERY_STATE ? stateDir : undefined,
  }, null, 2)}\n`);
} finally {
  if (consoleServer) await new Promise(resolve => consoleServer.close(resolve));
  if (residentAgent) {
    residentAgent.kill('SIGKILL');
    await new Promise(resolve => residentAgent.once('exit', resolve));
  }
  if (guardServer) await new Promise(resolve => guardServer.close(resolve));
  try { process.kill(lastPid || managedPid(), 'SIGKILL'); } catch {}
  await close(target);
  await close(collision);
  if (!process.env.BROCADE_KEEP_RECOVERY_STATE) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
