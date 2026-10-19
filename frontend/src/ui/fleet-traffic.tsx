import { useEffect, useMemo, useState } from 'react';
import { useNow } from './clock';
import { useMetricQuery, useMetricValue } from './metric-cadence';
import { olderRealtimeEvent } from '../realtime-order';
import { fetchNodeNicListWindows, type NodeNicView } from '../api';
import { Icon } from './icons';
import { observeBpsReading, observeBpsReadingParts } from './observe-chart';

// The crumb renders only the current aggregate. Historical curves belong to the machine page;
// asking for two hours here made every Console route download the same unused 120-window series.
const FLEET_TRAFFIC_WINDOWS = 1;
const FLEET_TRAFFIC_REFETCH_MS = 30_000;
const FLEET_TRAFFIC_FRESH_SECS = 90;
const FLEET_REALTIME_MIN_FRESH_MS = 10_000;

interface FleetRealtimeEvent {
  node_id: string;
  received_at_unix_millis: number;
  sample: {
    sequence?: number;
    rx_bytes_per_sec: number;
    tx_bytes_per_sec: number;
    has_gap: boolean;
  };
}

interface FleetRealtimeNode {
  connected: boolean;
  active: boolean;
  intervalSecs: number;
  latest: FleetRealtimeEvent | null;
}

interface FleetRealtimeView {
  nodes: Map<string, FleetRealtimeNode>;
  nowMillis: number;
}

export interface FleetTrafficSummary {
  rxBps: number;
  txBps: number;
  peakBps: number;
  latestWindowEnd: number;
  sampledNodes: number;
  totalNodes: number;
}

/**
 * Build a fleet reading from each machine's newest 30-second window.
 *
 * The endpoint deliberately keeps an offline machine's final history so its card does not go
 * blank. That history must not be counted as current fleet throughput, hence the wall-clock
 * freshness bound here.
 */
export function summarizeFleetTraffic(nodes: NodeNicView[], nowUnixSecs: number): FleetTrafficSummary | null {
  const live = nodes.flatMap(node => {
    const latest = node.series.at(-1);
    if (!latest || latest.has_gap || nowUnixSecs - latest.window_end_unix_secs > FLEET_TRAFFIC_FRESH_SECS) return [];
    return [{ node, latest }];
  });
  if (live.length === 0) return null;

  let rxBps = 0;
  let txBps = 0;
  let latestWindowEnd = 0;
  for (const { latest } of live) {
    rxBps += latest.nic_rx_bps;
    txBps += latest.nic_tx_bps;
    latestWindowEnd = Math.max(latestWindowEnd, latest.window_end_unix_secs);
  }

  return {
    rxBps,
    txBps,
    peakBps: Math.max(rxBps, txBps),
    latestWindowEnd,
    sampledNodes: live.length,
    totalNodes: nodes.length,
  };
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const finiteRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseRealtimeEvent(value: unknown): FleetRealtimeEvent | null {
  const event = recordOf(value);
  const sample = recordOf(event?.sample);
  if (
    typeof event?.node_id !== 'string' ||
    !finiteRate(event.received_at_unix_millis) ||
    !finiteRate(sample?.rx_bytes_per_sec) ||
    !finiteRate(sample.tx_bytes_per_sec) ||
    typeof sample.has_gap !== 'boolean'
  ) {
    return null;
  }
  return {
    node_id: event.node_id,
    received_at_unix_millis: event.received_at_unix_millis,
    sample: {
      sequence: finiteRate(sample.sequence) ? sample.sequence : undefined,
      rx_bytes_per_sec: sample.rx_bytes_per_sec,
      tx_bytes_per_sec: sample.tx_bytes_per_sec,
      has_gap: sample.has_gap,
    },
  };
}

function latestRealtimeEvent(values: unknown): FleetRealtimeEvent | null {
  if (!Array.isArray(values)) return null;
  let latest: FleetRealtimeEvent | null = null;
  for (const value of values) {
    const event = parseRealtimeEvent(value);
    if (event && (!latest || event.received_at_unix_millis > latest.received_at_unix_millis)) latest = event;
  }
  return latest;
}

function realtimeSummary(
  nodes: Map<string, FleetRealtimeNode>,
  nowMillis: number,
  historical: FleetTrafficSummary | null,
): FleetTrafficSummary | null {
  let rxBps = 0;
  let txBps = 0;
  let latestWindowEnd = 0;
  let sampledNodes = 0;
  for (const node of nodes.values()) {
    const event = node.latest;
    const freshnessMillis = Math.max(FLEET_REALTIME_MIN_FRESH_MS, node.intervalSecs * 3_000);
    if (
      !node.connected ||
      !node.active ||
      !event ||
      event.sample.has_gap ||
      nowMillis - event.received_at_unix_millis > freshnessMillis
    ) {
      continue;
    }
    // The realtime protocol transports counter deltas in bytes/s. Historical NIC windows and
    // the presentation formatter use bits/s, so normalize before combining nodes.
    rxBps += event.sample.rx_bytes_per_sec * 8;
    txBps += event.sample.tx_bytes_per_sec * 8;
    latestWindowEnd = Math.max(latestWindowEnd, Math.floor(event.received_at_unix_millis / 1_000));
    sampledNodes += 1;
  }
  if (sampledNodes === 0) return null;
  return {
    rxBps,
    txBps,
    peakBps: Math.max(historical?.peakBps ?? 0, rxBps, txBps),
    latestWindowEnd,
    sampledNodes,
    totalNodes: Math.max(historical?.totalNodes ?? 0, nodes.size),
  };
}

function useFleetRealtime(): FleetRealtimeView {
  const [nodes, setNodes] = useState<Map<string, FleetRealtimeNode>>(() => new Map());
  const nowMillis = useNow();
  const displayedNodes = useMetricValue(
    nodes,
    'fleet',
    JSON.stringify(
      [...nodes].map(([id, node]) => [id, node.connected, node.active, node.latest?.sample.has_gap ?? false]),
    ),
  );

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let stopped = false;
    let source: EventSource | undefined;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingNodes = new Map<string, FleetRealtimeNode>();
    const open = () => {
      if (stopped) return;
      const opened = new EventSource('/realtime/nodes/events', { withCredentials: true });
      source = opened;
      opened.addEventListener('snapshot', raw => {
        if (stopped || source !== opened) return;
        try {
          const payload = recordOf(JSON.parse((raw as MessageEvent).data));
          if (!Array.isArray(payload?.nodes)) throw new Error('fleet realtime snapshot has no nodes');
          const next = new Map<string, FleetRealtimeNode>();
          for (const value of payload.nodes) {
            const node = recordOf(value);
            if (typeof node?.node_id !== 'string') continue;
            const incoming = latestRealtimeEvent(node.samples);
            const previous = pendingNodes.get(node.node_id)?.latest;
            next.set(node.node_id, {
              connected:
                payload.policy && recordOf(payload.policy)?.enabled === false ? false : node.connected === true,
              active: node.active === true,
              intervalSecs: finiteRate(node.interval_secs) ? node.interval_secs : 5,
              latest: incoming && olderRealtimeEvent(incoming, previous) ? previous! : incoming,
            });
          }
          pendingNodes = next;
          setNodes(next);
        } catch {
          // Keep the last valid reading until its original freshness deadline.
        }
      });
      opened.addEventListener('sample', raw => {
        if (stopped || source !== opened) return;
        try {
          const event = parseRealtimeEvent(JSON.parse((raw as MessageEvent).data));
          if (!event) throw new Error('invalid fleet realtime sample');
          const next = new Map(pendingNodes);
          const previous = pendingNodes.get(event.node_id);
          if (olderRealtimeEvent(event, previous?.latest)) return;
          next.set(event.node_id, {
            connected: true,
            active: true,
            intervalSecs: previous?.intervalSecs ?? 5,
            latest: event,
          });
          pendingNodes = next;
          setNodes(next);
        } catch {
          // Keep the last valid reading until its original freshness deadline.
        }
      });
      opened.addEventListener('status', raw => {
        if (stopped || source !== opened) return;
        try {
          const status = recordOf(JSON.parse((raw as MessageEvent).data));
          if (typeof status?.node_id !== 'string') return;
          const nodeId = status.node_id;
          const next = new Map(pendingNodes);
          const previous = pendingNodes.get(nodeId);
          next.set(nodeId, {
            connected: status.connected === true,
            active: status.active === true,
            intervalSecs: finiteRate(status.interval_secs) ? status.interval_secs : (previous?.intervalSecs ?? 5),
            latest: previous?.latest ?? null,
          });
          pendingNodes = next;
          setNodes(next);
        } catch {
          // Keep the last valid reading until its original freshness deadline.
        }
      });
      opened.addEventListener('reset', () => {
        opened.close();
        if (source === opened && !stopped) reopenTimer = setTimeout(open, 0);
      });
      // SSE reconnects and authorization resets are transport events, not a new measurement.
      // Fresh samples remain usable; never flash the slower historical average on reconnect.
      opened.onerror = () => undefined;
    };
    open();
    return () => {
      stopped = true;
      source?.close();
      if (reopenTimer) clearTimeout(reopenTimer);
    };
  }, []);

  return { nodes: displayedNodes, nowMillis };
}

function TrafficReading({ direction, value, reference }: { direction: 'rx' | 'tx'; value: number; reference: number }) {
  const label = direction === 'rx' ? '接收' : '发送';
  const reading = observeBpsReadingParts(value, reference);
  return (
    <span
      className="ft-rd"
      title={`${label} ${observeBpsReading(value)}`}
      aria-label={`${label} ${observeBpsReading(value)}`}
    >
      <Icon of={direction} size={12} className="ft-ic" />
      <span className="ft-rd-value">{reading.number}</span>
      <span className="ft-rd-unit">{reading.unit}</span>
    </span>
  );
}

function FleetTrafficReadout({ summary }: { summary: FleetTrafficSummary }) {
  const reference = Math.max(summary.rxBps, summary.txBps);
  return (
    <span className="ft-now">
      <TrafficReading direction="rx" value={summary.rxBps} reference={reference} />
      <TrafficReading direction="tx" value={summary.txBps} reference={reference} />
    </span>
  );
}

/** The root-page breadcrumb replacement shared by every primary Console page. */
export function FleetTrafficMeter() {
  const query = useMetricQuery({
    queryKey: ['node-nic-list', 'windows', FLEET_TRAFFIC_WINDOWS],
    queryFn: () => fetchNodeNicListWindows(FLEET_TRAFFIC_WINDOWS),
    refetchInterval: FLEET_TRAFFIC_REFETCH_MS,
    retry: false,
  });
  const summary = useMemo(
    () => summarizeFleetTraffic(query.data?.nodes ?? [], Math.floor(query.dataUpdatedAt / 1_000)),
    [query.data, query.dataUpdatedAt],
  );
  const realtime = useFleetRealtime();
  const realtimeReading = useMemo(
    () => realtimeSummary(realtime.nodes, realtime.nowMillis, summary),
    [realtime.nodes, realtime.nowMillis, summary],
  );
  const reading = realtimeReading ?? summary;

  if (query.error && !reading) {
    return (
      <span className="ft" role="status">
        <span className="ft-state bad">网卡读数不可用</span>
      </span>
    );
  }
  if (query.isPending && !reading) {
    return (
      <span className="ft" role="status">
        <span className="ft-state">
          <i className="ft-beat idle" aria-hidden="true" />
          正在读取整批流量
        </span>
      </span>
    );
  }
  if (!reading) {
    return (
      <span className="ft" role="status">
        <span className="ft-state">
          <i className="ft-beat idle" aria-hidden="true" />
          尚无实时网卡读数
        </span>
      </span>
    );
  }
  return (
    <span
      className="ft"
      aria-label="整批机器实时流量"
      title={`${realtimeReading ? '各机最近有效速率合计，非同一采样窗口' : '最近 30 秒窗口均值'} · ${reading.sampledNodes} / ${reading.totalNodes} 台有读数`}
    >
      <FleetTrafficReadout summary={reading} />
      {!realtimeReading ? (
        <span className="ft-state">30 秒均值</span>
      ) : reading.sampledNodes < reading.totalNodes ? (
        <span className="ft-state">
          {reading.sampledNodes}/{reading.totalNodes}
        </span>
      ) : null}
    </span>
  );
}
