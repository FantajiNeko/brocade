import { CONFIG_XRAY_FORCE_RETIREMENT_PROTOCOL_VERSION, type NodeAgentStateItem } from './api';

export interface ConfigHandoffForceCandidate {
  deploymentId: number;
  claimGeneration: number;
  activeConnections: number;
}

/**
 * Keep the destructive action narrower than the status card: only an expired configuration
 * drain with a fresh, healthy candidate and a capable Agent is actionable. The server and Agent
 * repeat every check; this predicate exists so the UI never advertises unsafe authority.
 */
export function configHandoffForceCandidate(node: NodeAgentStateItem): ConfigHandoffForceCandidate | null {
  const runtime = node.xray_upgrade;
  const source = runtime?.source;
  const activeConnections = runtime?.old.active_connections ?? 0;
  if (
    !node.runtime_report_fresh ||
    node.agent_protocol_version == null ||
    node.agent_protocol_version < CONFIG_XRAY_FORCE_RETIREMENT_PROTOCOL_VERSION ||
    !runtime ||
    source?.kind !== 'config-deployment' ||
    runtime.phase !== 'blocked' ||
    runtime.strategy !== 'handoff' ||
    !runtime.old.alive ||
    activeConnections <= 0 ||
    !runtime.candidate?.alive ||
    runtime.candidate.accepting !== true
  ) {
    return null;
  }
  return {
    deploymentId: source.deployment_id,
    claimGeneration: source.claim_generation,
    activeConnections,
  };
}
