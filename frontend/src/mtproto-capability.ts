import type { NodeAgentStateItem } from './api';

export interface MtprotoNodeEligibility {
  eligible: boolean;
  reason: string | null;
}

/** Keep the UI gate aligned with the store/compiler invariant for Telegram MTProxy listeners. */
export function mtprotoNodeEligibility(node: NodeAgentStateItem | null | undefined): MtprotoNodeEligibility {
  if (!node?.public_ipv4?.trim()) {
    return { eligible: false, reason: '当前机器没有配置公网 IPv4，不能启用 MTProxy' };
  }
  if (node.public_ipv4_nat) {
    return { eligible: false, reason: '当前机器的公网 IPv4 未直接配置在网卡上，不能启用 MTProxy' };
  }
  return { eligible: true, reason: null };
}
