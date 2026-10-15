import { useCallback, useState, useSyncExternalStore } from 'react';

import type { NodeRealtimeEvent } from './node-realtime';

/* 用户详情的实时订阅源：一位用户的各台入口机器最近一帧秒级采样。
   「用户实时流量」与「转发入口」两张卡同时需要它；订阅按用户引用计数共享，一页只开一条
   EventSource（不可用时退回 2 秒轮询），最后一个使用者卸载时关闭。 */

/** 秒级采样超过这么久没有更新，就不再当作「当前」读数。 */
export const FRESH_MILLIS = 15_000;

export interface UserTrafficNode {
  node_id: string;
  connected: boolean;
  active: boolean;
  samples: NodeRealtimeEvent[];
}

export interface UserTrafficSnapshot {
  policy: { enabled: boolean };
  nodes: UserTrafficNode[];
}

interface SourceState {
  payload: UserTrafficSnapshot | null;
  failed: boolean;
  /* 每秒推进一次，读数按它判断新鲜度。0 表示尚未开始订阅。 */
  now: number;
}

interface SourceEntry {
  refs: number;
  state: SourceState;
  listeners: Set<() => void>;
  stop: () => void;
}

const IDLE: SourceState = { payload: null, failed: false, now: 0 };
const entries = new Map<string, SourceEntry>();

function start(tenantId: string, userId: string, entry: SourceEntry) {
  let stopped = false;
  let source: EventSource | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollAbort: AbortController | undefined;
  let polling = false;
  const base = `/users/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}/realtime`;
  const set = (next: Partial<SourceState>) => {
    if (stopped) return;
    entry.state = { ...entry.state, ...next };
    entry.listeners.forEach(listener => listener());
  };
  const updateNodes = (update: (node: UserTrafficNode) => UserTrafficNode) => {
    const payload = entry.state.payload;
    if (payload) set({ payload: { ...payload, nodes: payload.nodes.map(update) } });
  };
  const snapshot = (payload: UserTrafficSnapshot) => {
    if (!Array.isArray(payload.nodes)) return;
    set({ payload, failed: false });
  };
  const poll = async () => {
    pollAbort = new AbortController();
    try {
      const response = await fetch(`${base}/snapshot`, {
        credentials: 'include',
        cache: 'no-store',
        signal: pollAbort.signal,
      });
      if (!response.ok) throw new Error('realtime unavailable');
      snapshot((await response.json()) as UserTrafficSnapshot);
    } catch {
      set({ failed: true });
    } finally {
      if (!stopped) pollTimer = setTimeout(() => void poll(), 2000);
    }
  };
  const startPolling = () => {
    if (polling || stopped) return;
    polling = true;
    source?.close();
    void poll();
  };
  const open = () => {
    if (stopped) return;
    if (typeof EventSource === 'undefined') return startPolling();
    const opened = new EventSource(`${base}/events`, { withCredentials: true });
    source = opened;
    opened.addEventListener('snapshot', e => {
      try {
        snapshot(JSON.parse((e as MessageEvent).data) as UserTrafficSnapshot);
      } catch {
        /* A malformed frame expires by its age. */
      }
    });
    opened.addEventListener('sample', e => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as NodeRealtimeEvent;
        updateNodes(node => (node.node_id === event.node_id ? { ...node, connected: true, samples: [event] } : node));
      } catch {
        /* Keep the last valid frame until it expires. */
      }
    });
    opened.addEventListener('status', e => {
      try {
        const status = JSON.parse((e as MessageEvent).data) as {
          node_id: string;
          connected: boolean;
          active: boolean;
        };
        updateNodes(node => (node.node_id === status.node_id ? { ...node, ...status } : node));
      } catch {
        /* Only decoded status frames are authoritative. */
      }
    });
    opened.addEventListener('reset', () => {
      opened.close();
      if (source === opened) open();
    });
    opened.onerror = startPolling;
  };
  open();
  const timer = setInterval(() => set({ now: Date.now() }), 1000);
  return () => {
    stopped = true;
    source?.close();
    pollAbort?.abort();
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(timer);
  };
}

function acquire(key: string, tenantId: string, userId: string, listener: () => void) {
  let entry = entries.get(key);
  if (!entry) {
    const created: SourceEntry = {
      refs: 0,
      state: { payload: null, failed: false, now: Date.now() },
      listeners: new Set(),
      stop: () => undefined,
    };
    created.stop = start(tenantId, userId, created);
    entries.set(key, created);
    entry = created;
  }
  const owned = entry;
  owned.refs += 1;
  owned.listeners.add(listener);
  return () => {
    owned.listeners.delete(listener);
    owned.refs -= 1;
    if (owned.refs > 0) return;
    owned.stop();
    if (entries.get(key) === owned) entries.delete(key);
  };
}

const noSubscription = () => () => undefined;

/** 订阅一位用户的实时采样。`enabled` 为 false 时不发请求（无权查看实时的身份）。 */
export function useUserTrafficSource(tenantId: string, userId: string, enabled = true) {
  const key = `${tenantId}/${userId}`;
  const subscribe = useCallback(
    (listener: () => void) => acquire(key, tenantId, userId, listener),
    [key, tenantId, userId],
  );
  const state = useSyncExternalStore(
    enabled ? subscribe : noSubscription,
    () => (enabled ? (entries.get(key)?.state ?? IDLE) : IDLE),
    () => IDLE,
  );
  const [mountedAt] = useState(() => Date.now());
  return { payload: state.payload, now: state.now || mountedAt, failed: state.failed };
}

export interface ForwardingRuleRates {
  /** 规则 id → 当前速率（字节/秒）。 */
  rates: Map<number, { down: number; up: number }>;
  /** 报告新鲜、就绪且完整的机器：这些机器上不在 rates 里的规则当前没有流量。 */
  covered: Set<string>;
}

/** 从实时采样里取出这位用户每条转发规则的当前速率。机器离线、报告未就绪、旧 Agent 不支持转发
 *  实时时，该机器不进 covered，规则读数是未知而不是 0；报告有缺口或截断时只采信列出的条目。 */
export function forwardingRuleRates(
  payload: UserTrafficSnapshot | null,
  tenantId: string,
  userId: string,
  now: number,
): ForwardingRuleRates {
  const rates = new Map<number, { down: number; up: number }>();
  const covered = new Set<string>();
  for (const node of payload?.nodes ?? []) {
    const event = node.samples.at(-1);
    const report = event?.sample.user_traffic;
    if (!node.connected || !event || now - event.received_at_unix_millis > FRESH_MILLIS) continue;
    if (!report || report.state !== 'ready' || !report.forwarding_supported) continue;
    for (const user of report.users ?? []) {
      if (user.tenant_id !== tenantId || user.user_id !== userId || user.forwarding_rule_id === undefined) continue;
      const current = rates.get(user.forwarding_rule_id) ?? { down: 0, up: 0 };
      rates.set(user.forwarding_rule_id, {
        down: current.down + user.downlink_bytes_per_sec,
        up: current.up + user.uplink_bytes_per_sec,
      });
    }
    if (!report.has_gap && !report.truncated) covered.add(node.node_id);
  }
  return { rates, covered };
}
