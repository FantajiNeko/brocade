import { describe, expect, it } from 'vitest';
import { type NodeAgentStateItem } from '../src/api';
import { configHandoffForceCandidate } from '../src/xray-handoff';

const blockedNode = (protocol = 33): NodeAgentStateItem =>
  ({
    node_id: 'n1',
    agent_protocol_version: protocol,
    runtime_report_fresh: true,
    xray_upgrade: {
      source: { kind: 'config-deployment', deployment_id: 604, claim_generation: 0 },
      release_id: -604,
      attempt: 0,
      strategy: 'handoff',
      phase: 'blocked',
      old: {
        pid: 10,
        pid_start_ticks: 100,
        boot_id: 'boot',
        sha256: 'a'.repeat(64),
        alive: true,
        accepting: false,
        active_connections: 14,
      },
      candidate: {
        pid: 11,
        pid_start_ticks: 101,
        boot_id: 'boot',
        sha256: 'a'.repeat(64),
        alive: true,
        accepting: true,
        active_connections: 3,
      },
      drain_deadline_unix_secs: 1,
    },
  }) as NodeAgentStateItem;

describe('configuration Xray force-retirement action', () => {
  it('exposes the exact blocked deployment and old connection count', () => {
    expect(configHandoffForceCandidate(blockedNode())).toEqual({
      deploymentId: 604,
      claimGeneration: 0,
      activeConnections: 14,
    });
  });

  it('stays hidden from Agents that cannot consume the command', () => {
    expect(configHandoffForceCandidate(blockedNode(32))).toBeNull();
  });

  it('does not duplicate an automatic force already in progress', () => {
    const node = blockedNode();
    node.xray_upgrade!.strategy = 'handoff-force';
    node.xray_upgrade!.phase = 'forcing';
    expect(configHandoffForceCandidate(node)).toBeNull();
  });
});
