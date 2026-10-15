import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { VpngateRealtimeReport } from './vpngate-realtime';

export interface RealtimeUserTrafficRate {
  tenant_id: string;
  user_id: string;
  ingress_id?: string | null;
  forwarding_rule_id?: number;
  uplink_bytes_per_sec: number;
  downlink_bytes_per_sec: number;
}

export interface RealtimeUserTrafficReport {
  state: 'warming' | 'ready' | 'unavailable';
  all_users: boolean;
  elapsed_millis?: number;
  users?: RealtimeUserTrafficRate[];
  truncated?: boolean;
  has_gap?: boolean;
  forwarding_supported?: boolean;
  forwarding_expected?: boolean;
}

export interface NodeRealtimeEvent {
  node_id?: string;
  received_at_unix_millis: number;
  sample: {
    /** Heavy worker reports are a lower-frequency delta; absent fields retain the last complete
     * report only when this flag is true. Without the flag, absence authoritatively clears it. */
    diagnostics_unchanged?: boolean;
    /** The current event refreshes other diagnostics but keeps the previous Mux baseline. */
    mux_unchanged?: boolean;
    sampled_at_unix_millis: number;
    reverse_health?: unknown;
    mux?: unknown;
    vpngate?: VpngateRealtimeReport | null;
    user_traffic?: RealtimeUserTrafficReport | null;
  };
}

export interface NodeRealtimeState {
  nodeId: string;
  last: { event: NodeRealtimeEvent; arrived: number } | null;
  now: number;
  connected: boolean;
  enabled?: boolean;
  observingSince: number;
}

interface NodeRealtimeSnapshot {
  node_id?: string;
  connected?: boolean;
  samples: NodeRealtimeEvent[];
}

const NodeRealtimeContext = createContext<NodeRealtimeState | null>(null);

/** `mux_unchanged` is a fresh observation of the previous normalized Mux state, not merely an
 * instruction to keep rendering an old object. Materializing the confirmation time prevents an
 * idle pool from becoming stale while its five-second diagnostic heartbeat remains healthy. */
function confirmMuxReport(mux: unknown, sampledAtUnixMillis: number): unknown {
  if (!mux || typeof mux !== 'object' || Array.isArray(mux)) return mux;
  return { ...mux, sampled_at_unix_ms: sampledAtUnixMillis };
}

/** Merge only an explicitly marked diagnostics delta. A complete event with absent diagnostics
 * must clear old state, otherwise removing a worker pool would leave a ghost card indefinitely. */
export function mergeNodeRealtimeEvent(
  previous: NodeRealtimeEvent | undefined,
  event: NodeRealtimeEvent,
): NodeRealtimeEvent {
  if (!previous) return event;
  if (event.sample.diagnostics_unchanged) {
    return {
      ...event,
      // Delta markers describe only the incoming frame. Do not retain an earlier mux_unchanged
      // marker across ordinary one-second NIC samples.
      sample: {
        ...previous.sample,
        ...event.sample,
        mux_unchanged: event.sample.mux_unchanged,
        // User rates are complete every round, independent of diagnostic refreshes.
        user_traffic: event.sample.user_traffic,
      },
    };
  }
  if (event.sample.mux_unchanged) {
    return {
      ...event,
      sample: {
        ...event.sample,
        mux: confirmMuxReport(previous.sample.mux, event.sample.sampled_at_unix_millis),
      },
    };
  }
  return event;
}

function useNodeRealtimeSource(nodeId: string | null): NodeRealtimeState {
  const [last, setLast] = useState<{ nodeId: string; event: NodeRealtimeEvent; arrived: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [connectedNodeId, setConnectedNodeId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<{ nodeId: string; value: boolean } | null>(null);
  const [observation, setObservation] = useState(() => ({ nodeId, startedAt: Date.now() }));
  if (observation.nodeId !== nodeId) {
    // Reset synchronously with the requested node so the previous node's observation window can
    // never suppress or prematurely trigger this node's first-frame state.
    setObservation({ nodeId, startedAt: now });
  }

  useEffect(() => {
    if (!nodeId) return;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollAbort: AbortController | undefined;
    let polling = false;
    let stopped = false;
    const accept = (event: NodeRealtimeEvent, connected = true) => {
      setLast(previous => {
        const previousEvent = previous?.nodeId === nodeId ? previous.event : undefined;
        const merged = mergeNodeRealtimeEvent(previousEvent, event);
        return { nodeId, event: merged, arrived: Date.now() };
      });
      if (connected) setConnectedNodeId(nodeId);
    };
    const acceptSnapshot = (nodes: NodeRealtimeSnapshot[], policyEnabled = true) => {
      setEnabled({ nodeId, value: policyEnabled });
      const node = nodes.find(value => value.node_id === nodeId) ?? nodes[0];
      setConnectedNodeId(node?.connected ? nodeId : null);
      const sample = node?.samples.at(-1);
      if (sample) accept(sample, false);
    };
    const poll = async () => {
      if (stopped) return;
      const abort = new AbortController();
      pollAbort = abort;
      try {
        const response = await fetch(`/realtime/nodes/${encodeURIComponent(nodeId)}/snapshot`, {
          credentials: 'include',
          cache: 'no-store',
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`realtime snapshot returned ${response.status}`);
        const payload = (await response.json()) as { nodes?: NodeRealtimeSnapshot[]; policy?: { enabled?: boolean } };
        if (!Array.isArray(payload.nodes)) throw new Error('realtime snapshot has no nodes');
        acceptSnapshot(payload.nodes, payload.policy?.enabled);
      } catch {
        // A failed browser-to-Console request does not prove that the Agent disconnected. Keep the
        // last authoritative connection state and let the existing 15-second sample-age checks
        // expire it. Clearing it here made one transient proxy/TLS failure flash every realtime
        // card as stale even when the preceding sample was only a second old.
      } finally {
        if (!stopped) pollTimer = setTimeout(() => void poll(), 2000);
      }
    };
    const startPolling = () => {
      if (stopped || polling) return;
      polling = true;
      source?.close();
      void poll();
    };
    const open = () => {
      if (stopped) return;
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      const opened = new EventSource(`/realtime/nodes/${encodeURIComponent(nodeId)}/events`, { withCredentials: true });
      source = opened;
      opened.addEventListener('sample', e => {
        try {
          accept(JSON.parse((e as MessageEvent).data));
        } catch {
          // Ignore one malformed frame; the last valid sample will age out if the stream stays bad.
        }
      });
      opened.addEventListener('snapshot', e => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as {
            nodes: NodeRealtimeSnapshot[];
            policy?: { enabled?: boolean };
          };
          acceptSnapshot(payload.nodes, payload.policy?.enabled);
        } catch {
          // Ignore one malformed frame; the last valid sample will age out if the stream stays bad.
        }
      });
      opened.addEventListener('status', e => {
        try {
          const status = JSON.parse((e as MessageEvent).data) as { node_id?: string; connected?: boolean };
          if (!status.node_id || status.node_id === nodeId) setConnectedNodeId(status.connected ? nodeId : null);
        } catch {
          // Only a decoded status=false frame is authoritative evidence of an Agent disconnect.
        }
      });
      opened.addEventListener('reset', () => {
        opened.close();
        if (source === opened) open();
      });
      opened.onerror = () => {
        if (source === opened) startPolling();
      };
    };
    open();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      source?.close();
      pollAbort?.abort();
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(timer);
    };
  }, [nodeId]);

  return {
    nodeId: nodeId ?? '',
    last: last?.nodeId === nodeId ? last : null,
    now,
    connected: connectedNodeId === nodeId,
    enabled: enabled?.nodeId === nodeId ? enabled.value : true,
    observingSince: observation.nodeId === nodeId ? observation.startedAt : now,
  };
}

export function NodeRealtimeProvider({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const state = useNodeRealtimeSource(nodeId);
  return <NodeRealtimeContext.Provider value={state}>{children}</NodeRealtimeContext.Provider>;
}

/** Cards remain independently renderable in tests and other pages. Inside NodeRealtimeProvider
 * they share its one EventSource; outside it a card opens its own source as before. */
export function useNodeRealtime(nodeId: string): NodeRealtimeState {
  const shared = useContext(NodeRealtimeContext);
  const owned = useNodeRealtimeSource(shared?.nodeId === nodeId ? null : nodeId);
  return shared?.nodeId === nodeId ? shared : owned;
}
