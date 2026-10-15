import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchNodeUserTrafficHistory, fetchUserTrafficHistory, type UserTrafficHistory } from './api';
import { useNodeRealtime, type RealtimeUserTrafficRate } from './node-realtime';
import { throughputAxis } from './panes/telemetry-format';
import { SegmentedControl } from './ui/bits';
import { bytes, shareOf } from './ui/format';
import { Icon, PanelTitle } from './ui/icons';
import { observeBpsReadingParts } from './ui/observe-chart';
import { sparklinePaths } from './ui/sparkline';
import { FRESH_MILLIS, useUserTrafficSource, type UserTrafficNode } from './user-traffic-source';

/* 用户实时流量卡（机器详情 / 用户详情）。两路数据分开呈现，不拼接：
 * - 近 1 小时：Agent 每 30 秒上报的计费窗口，打开时读取、每 30 秒重读，画成走势。
 * - 当前：打开页面后按需订阅的每秒速率，只画成读数（顶部合计加上下行占比条，每格数值）。打开前没有秒级数据，
 *   画成时间序列会在打开时出现空图。
 * 出现过的行保留到离开页面：机器详情的 all 模式不上报速率为 0 的用户，按最新报告重建列表
 * 会让用户每秒出现又消失。默认按名称排列且不自动重排；选了下行 / 上行 / 近 1 小时后每 5 秒
 * 按数值重排一次，指针停在列表上时暂停。 */

const LazyThroughputChart = lazy(() =>
  import('./panes/telemetry').then(module => ({ default: module.ThroughputChart })),
);

const HOUR_SECS = 3_600;
const SLOT_SECS = 30;
const SLOTS = HOUR_SECS / SLOT_SECS;
/** 连续这么久没有流量才算空闲：突发流量之间的空档不改变行的样式。 */
const IDLE_MILLIS = 10_000;
const RESORT_MILLIS = 5_000;
const HISTORY_REFRESH_MILLIS = 30_000;
/** 两个页面都排成多列紧凑格；默认显示前 18 项（宽屏三列六行）。 */
const FOLD = 18;
/** 与协议 MAX_REALTIME_USER_TRAFFIC_ROWS 一致：一台机器一份报告最多这么多行。 */
const RETAINED_LIMIT = 2_048;
const SPARK_HEIGHT = 28;
const SCOPE_NOTE = '统计入口 Xray 的接入与转发；中继不提供最终用户身份';
const NO_TARGETS: readonly string[] = [];

type TrafficPhase =
  'pending' | 'ready' | 'unavailable' | 'offline' | 'unsupported' | 'disabled' | 'empty' | 'forwarding-unsupported';
const PHASE_TEXT: Record<TrafficPhase, string> = {
  pending: '正在建立速率基线',
  ready: '实时 · 每秒更新',
  unavailable: 'Xray 用户统计暂不可用',
  offline: '实时通道未连接',
  unsupported: '当前 Agent 尚未支持用户速率',
  disabled: '实时观测已关闭',
  empty: '尚未授权接入线路或转发入口',
  'forwarding-unsupported': '转发实时待升级 Agent',
};

type TrafficSort = 'name' | 'down' | 'up' | 'hour';
const SORTS: readonly { value: TrafficSort; label: string }[] = [
  { value: 'name', label: '名称' },
  { value: 'down', label: '下行' },
  { value: 'up', label: '上行' },
  { value: 'hour', label: '近 1 小时' },
];

/** 一个对象的当前速率（B/s）。null 表示最新报告给不出这个值：未就绪、被截断或未连接。 */
export interface LiveTrafficRow {
  key: string;
  name: string;
  detail: string;
  down: number | null;
  up: number | null;
  /** 用户详情：这台入口机器的实时通道未连接或数据已过期。 */
  offline?: boolean;
  /** 用户详情：该用户在这台机器上报告的接入点数。 */
  ingresses?: number;
  forwardingDown?: number;
  forwardingUp?: number;
}

interface RetainedRow extends LiveTrafficRow {
  lastActiveMs: number | null;
}

/** 一个对象近 1 小时的窗口字节，按 30 秒格对齐；null 是该格没有采集到窗口。 */
interface HourRow {
  key: string;
  tenant?: string;
  user?: string;
  down: (number | null)[];
  up: (number | null)[];
  hourDown: number;
  hourUp: number;
  lastActiveMs: number | null;
  unplaced?: boolean;
  forwarding?: boolean;
}

interface HourModel {
  rangeStart: number;
  rangeEnd: number;
  slots: number[];
  rows: Map<string, HourRow>;
  totalDown: (number | null)[];
  totalUp: (number | null)[];
  /** 全体对象的窗口平均速率峰值（B/s），各行走势的缩放下限由它决定。 */
  peak: number;
}

export interface CardRow {
  key: string;
  name: string;
  detail: string;
  down: number | null;
  up: number | null;
  offline: boolean;
  ingresses?: number;
  forwardingDown?: number;
  forwardingUp?: number;
  hour: HourRow | null;
  hourBytes: number;
  lastActiveMs: number | null;
}

const userKey = (tenantId: string, userId: string) => `${tenantId}/${userId}`;
const slotOf = (unixSecs: number) => Math.floor(unixSecs / SLOT_SECS) * SLOT_SECS;

/** 同一用户可能经由多个接入点；租户不同的同名用户是两个人。 */
export function aggregateUserTraffic(users: RealtimeUserTrafficRate[]): LiveTrafficRow[] {
  const grouped = new Map<string, LiveTrafficRow & { down: number; up: number }>();
  for (const user of users) {
    const key = userKey(user.tenant_id, user.user_id);
    const row = grouped.get(key) ?? { key, name: user.user_id, detail: user.tenant_id, down: 0, up: 0 };
    row.down += user.downlink_bytes_per_sec;
    row.up += user.uplink_bytes_per_sec;
    if (user.forwarding_rule_id !== undefined) {
      row.forwardingDown = (row.forwardingDown ?? 0) + user.downlink_bytes_per_sec;
      row.forwardingUp = (row.forwardingUp ?? 0) + user.uplink_bytes_per_sec;
    }
    grouped.set(key, row);
  }
  return [...grouped.values()];
}

/** 近 1 小时的窗口落在 30 秒格上（与机器详情 XRAY 流量同一对齐方式）。格内有窗口而没有字节是
 * 空闲，记 0；格内没有窗口是未采集，记 null。用户详情的合计跨机器相加，任一台采集到即算采集。 */
function legacyHourModel(history: UserTrafficHistory, page: 'node' | 'user'): HourModel {
  const last = slotOf(history.range_end_unix_secs);
  const slots = Array.from({ length: SLOTS }, (_, index) => last - (SLOTS - 1 - index) * SLOT_SECS);
  const indexOf = new Map(slots.map((slot, index) => [slot, index]));
  const collectedBy = new Map(
    history.nodes.map(node => [node.node_id, new Set(node.window_ends_unix_secs.map(slotOf))]),
  );
  const blank = (collected: Set<number> | undefined): (number | null)[] =>
    slots.map(slot => (collected?.has(slot) ? 0 : null));
  const rows = new Map<string, HourRow>();
  const rowFor = (key: string, nodeId: string) => {
    let row = rows.get(key);
    if (!row) {
      const collected = collectedBy.get(nodeId);
      row = { key, down: blank(collected), up: blank(collected), hourDown: 0, hourUp: 0, lastActiveMs: null };
      rows.set(key, row);
    }
    return row;
  };
  // 用户详情列出该用户的全部入口机器，近 1 小时没有流量的也列出。
  if (page === 'user') history.nodes.forEach(node => rowFor(node.node_id, node.node_id));
  for (const series of history.series) {
    const key = page === 'node' ? userKey(series.tenant_id, series.user_id) : series.node_id;
    const row = rowFor(key, series.node_id);
    row.tenant = series.tenant_id;
    row.user = series.user_id;
    for (const [end, up, down] of series.points) {
      row.hourDown += down;
      row.hourUp += up;
      if (up + down > 0) row.lastActiveMs = Math.max(row.lastActiveMs ?? 0, end * 1000);
      const index = indexOf.get(slotOf(end));
      if (index === undefined) continue;
      row.down[index] = (row.down[index] ?? 0) + down;
      row.up[index] = (row.up[index] ?? 0) + up;
    }
  }
  const collectedAny = new Set([...collectedBy.values()].flatMap(set => [...set]));
  const totalDown: (number | null)[] = slots.map(slot => (collectedAny.has(slot) ? 0 : null));
  const totalUp = [...totalDown];
  let peak = 0;
  for (const row of rows.values()) {
    row.down.forEach((value, index) => {
      if (value !== null) totalDown[index] = (totalDown[index] ?? 0) + value;
      const up = row.up[index];
      if (value !== null || up !== null) peak = Math.max(peak, ((value ?? 0) + (up ?? 0)) / SLOT_SECS);
    });
    row.up.forEach((value, index) => {
      if (value !== null) totalUp[index] = (totalUp[index] ?? 0) + value;
    });
  }
  return {
    rangeStart: history.range_start_unix_secs,
    rangeEnd: history.range_end_unix_secs,
    slots,
    rows,
    totalDown,
    totalUp,
    peak,
  };
}

type Interval = readonly [number, number];
function mergedIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function activeIntervals(start: number, end: number, zeros: readonly Interval[]): Interval[] {
  const active: Interval[] = [];
  let cursor = start;
  for (const [zeroStart, zeroEnd] of zeros) {
    if (zeroEnd <= cursor || zeroStart >= end) continue;
    if (zeroStart > cursor) active.push([cursor, Math.min(zeroStart, end)]);
    cursor = Math.max(cursor, zeroEnd);
  }
  if (cursor < end) active.push([cursor, end]);
  return active;
}

function intersectIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const intersections: Interval[] = [];
  let i = 0,
    j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0], right[j][0]),
      end = Math.min(left[i][1], right[j][1]);
    if (end > start) intersections.push([start, end]);
    if (left[i][1] < right[j][1]) i++;
    else j++;
  }
  return intersections;
}

const overlap = (start: number, end: number, intervals: readonly Interval[]) =>
  intervals.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(end, b) - Math.max(start, a)), 0);

/** Use actual measured intervals, not the report's endpoint bucket. Long cumulative windows
 * preserve byte totals and draw their average rate across every covered slot. Only confirmed
 * downtime is zero; uncovered time remains null. This is chart resampling, not ledger rewriting. */
export function hourModel(history: UserTrafficHistory, page: 'node' | 'user'): HourModel {
  if (history.nodes.every(node => node.windows === undefined)) return legacyHourModel(history, page);
  const rangeStart = history.range_start_unix_secs;
  const rangeEnd = history.range_end_unix_secs;
  const first = slotOf(rangeStart);
  const count = Math.ceil((rangeEnd - first) / SLOT_SECS);
  const slots = Array.from({ length: count }, (_, index) => first + index * SLOT_SECS);
  const bounds = slots.map(slot => [Math.max(slot, rangeStart), Math.min(slot + SLOT_SECS, rangeEnd)] as const);
  const zeros = new Map(
    history.nodes.map(node => [
      node.node_id,
      mergedIntervals((node.zero_windows ?? []).map(([a, b]) => [a / 1000, b / 1000])),
    ]),
  );
  const collected = new Map(
    history.nodes.map(node => [
      node.node_id,
      mergedIntervals([
        ...(node.windows ?? []),
        ...(node.forwarding_windows ?? []),
        ...(zeros.get(node.node_id) ?? []),
      ]),
    ]),
  );
  const rowKey = (series: UserTrafficHistory['series'][number]) =>
    page === 'node' ? userKey(series.tenant_id, series.user_id) : series.node_id;
  const measuredByRow = new Map<string, Interval[]>();
  const sourcesByRow = new Map<string, UserTrafficHistory['series']>();
  for (const series of history.series) {
    const key = rowKey(series);
    const grouped = sourcesByRow.get(key) ?? [];
    grouped.push(series);
    sourcesByRow.set(key, grouped);
  }
  for (const [key, sources] of sourcesByRow) {
    const intervals: Interval[] = [];
    for (const node of history.nodes) {
      const relevant = sources.filter(source => source.node_id === node.node_id);
      if (relevant.length === 0) continue;
      const access = mergedIntervals([...(node.windows ?? []), ...(zeros.get(node.node_id) ?? [])]);
      const forwarding = mergedIntervals([...(node.forwarding_windows ?? []), ...(zeros.get(node.node_id) ?? [])]);
      const hasAccess = relevant.some(s => !s.forwarding),
        hasForwarding = relevant.some(s => s.forwarding);
      intervals.push(
        ...(hasAccess && hasForwarding ? intersectIntervals(access, forwarding) : hasForwarding ? forwarding : access),
      );
    }
    measuredByRow.set(key, mergedIntervals(intervals));
  }
  const blank = (nodeId: string, key: string) =>
    bounds.map(([start, end]) =>
      overlap(start, end, measuredByRow.get(key) ?? collected.get(nodeId) ?? []) >= end - start - 0.001 ? 0 : null,
    );
  const rows = new Map<string, HourRow>();
  const rowFor = (key: string, nodeId: string) => {
    let row = rows.get(key);
    if (!row) {
      row = { key, down: blank(nodeId, key), up: blank(nodeId, key), hourDown: 0, hourUp: 0, lastActiveMs: null };
      rows.set(key, row);
    }
    return row;
  };
  if (page === 'user') history.nodes.forEach(node => rowFor(node.node_id, node.node_id));
  for (const series of history.series) {
    const row = rowFor(page === 'node' ? userKey(series.tenant_id, series.user_id) : series.node_id, series.node_id);
    row.tenant = series.tenant_id;
    row.user = series.user_id;
    row.forwarding ||= !!series.forwarding;
    row.hourUp += series.unplaced_uplink_bytes ?? 0;
    row.hourDown += series.unplaced_downlink_bytes ?? 0;
    row.unplaced ||= (series.unplaced_uplink_bytes ?? 0) + (series.unplaced_downlink_bytes ?? 0) > 0;
    const windows = series.windows ?? series.points.map(([end, up, down]) => [end - SLOT_SECS, end, up, down]);
    for (const [start, end, up, down] of windows) {
      if (end <= start) continue;
      const active = activeIntervals(start, end, zeros.get(series.node_id) ?? []);
      const duration = overlap(start, end, active);
      if (duration <= 0) continue;
      const visible = overlap(rangeStart, rangeEnd, active) / duration;
      row.hourUp += up * visible;
      row.hourDown += down * visible;
      if (up + down > 0) row.lastActiveMs = Math.max(row.lastActiveMs ?? 0, end * 1000);
      bounds.forEach(([a, b], index) => {
        const seconds = overlap(a, b, active);
        // Values retain the historical "bytes per 30 seconds" shape. The partial boundary
        // slots use their actual visible width, so conversion to bit/s stays correct.
        const weight = ((seconds / duration) * SLOT_SECS) / (b - a);
        if (row.up[index] !== null) row.up[index] += up * weight;
        if (row.down[index] !== null) row.down[index] += down * weight;
      });
    }
  }
  const totalDown: (number | null)[] = bounds.map(([a, b], index) =>
    (
      rows.size > 0
        ? [...rows.values()].some(row => row.down[index] !== null)
        : [...collected.values()].some(intervals => overlap(a, b, intervals) >= b - a - 0.001)
    )
      ? 0
      : null,
  );
  const totalUp = [...totalDown];
  let peak = 0;
  for (const row of rows.values()) {
    row.down.forEach((down, index) => {
      const up = row.up[index];
      if (down !== null) totalDown[index] = (totalDown[index] ?? 0) + down;
      if (up !== null) totalUp[index] = (totalUp[index] ?? 0) + up;
      peak = Math.max(peak, ((down ?? 0) + (up ?? 0)) / SLOT_SECS);
    });
  }
  return { rangeStart, rangeEnd, slots, rows, totalDown, totalUp, peak };
}

/** 合并一份新报告。未就绪或未连接（null）的读数不覆盖最后一次有效数据；报告完整时，
 * 不在其中的已有行即为空闲。行数受协议上限约束，超出时先丢最久未活跃的。 */
export function mergeRetained(
  previous: ReadonlyMap<string, RetainedRow>,
  live: readonly LiveTrafficRow[],
  complete: boolean,
  at: number,
): Map<string, RetainedRow> {
  const next = new Map(previous);
  const seen = new Set<string>();
  for (const row of live) {
    seen.add(row.key);
    const before = previous.get(row.key);
    const known = row.down !== null && row.up !== null;
    const active = (row.down ?? 0) + (row.up ?? 0) > 0;
    next.set(row.key, {
      ...row,
      down: known ? row.down : (before?.down ?? null),
      up: known ? row.up : (before?.up ?? null),
      ingresses: row.ingresses ?? before?.ingresses,
      forwardingDown: known ? row.forwardingDown : before?.forwardingDown,
      forwardingUp: known ? row.forwardingUp : before?.forwardingUp,
      lastActiveMs: active ? at : (before?.lastActiveMs ?? null),
    });
  }
  if (complete) {
    for (const [key, row] of previous)
      if (!seen.has(key))
        next.set(key, {
          ...row,
          down: 0,
          up: 0,
          forwardingDown: row.forwardingDown === undefined ? undefined : 0,
          forwardingUp: row.forwardingUp === undefined ? undefined : 0,
        });
  }
  if (next.size > RETAINED_LIMIT) {
    const evict = [...next.values()]
      .sort((a, b) => (a.lastActiveMs ?? 0) - (b.lastActiveMs ?? 0))
      .slice(0, next.size - RETAINED_LIMIT);
    evict.forEach(row => next.delete(row.key));
  }
  return next;
}

/** 渲染期按新报告调整保留的行（React 的「上一次渲染的信息」写法）：同一份报告只合并一次。 */
function useRetained(at: number | null, live: readonly LiveTrafficRow[], complete: boolean) {
  const [state, setState] = useState<{ at: number | null; rows: ReadonlyMap<string, RetainedRow> }>({
    at: null,
    rows: new Map(),
  });
  if (at !== null && at !== state.at) {
    const next = { at, rows: mergeRetained(state.rows, live, complete, at) };
    setState(next);
    return next;
  }
  return state;
}

const totalOf = (row: CardRow) => (row.down ?? 0) + (row.up ?? 0);
const nameOrder = new Intl.Collator('zh-CN', { numeric: true });
function compareRows(sort: TrafficSort) {
  return (a: CardRow, b: CardRow) => {
    const byName = nameOrder.compare(a.name, b.name) || a.key.localeCompare(b.key);
    if (sort === 'name') return byName;
    if (sort === 'hour') return b.hourBytes - a.hourBytes || byName;
    const known = Number(b.down !== null) - Number(a.down !== null);
    if (known) return known;
    const recent = (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0);
    if (sort === 'up') return (b.up ?? 0) - (a.up ?? 0) || (b.down ?? 0) - (a.down ?? 0) || recent || byName;
    return (b.down ?? 0) - (a.down ?? 0) || (b.up ?? 0) - (a.up ?? 0) || recent || byName;
  };
}

interface ListOrder {
  keys: string[];
  at: number;
  sort: TrafficSort;
}

/** 下一份顺序；不需要变化时原样返回，调用方据此决定是否更新状态。 */
export function nextListOrder(
  order: ListOrder,
  rows: readonly CardRow[],
  sort: TrafficSort,
  hold: boolean,
  now: number,
): ListOrder {
  const known = new Set(order.keys);
  const added = rows.filter(row => !known.has(row.key)).map(row => row.key);
  const present = new Set(rows.map(row => row.key));
  const dynamic = sort !== 'name';
  const resort =
    order.sort !== sort ||
    (order.keys.length === 0 && rows.length > 0) ||
    (!dynamic && added.length > 0) ||
    (dynamic && !hold && now - order.at >= RESORT_MILLIS);
  if (resort) return { keys: [...rows].sort(compareRows(sort)).map(row => row.key), at: now, sort };
  if (added.length > 0) return { ...order, keys: [...order.keys.filter(key => present.has(key)), ...added] };
  return order;
}

function useListOrder(rows: readonly CardRow[], sort: TrafficSort, hold: boolean, now: number) {
  const [order, setOrder] = useState<ListOrder>({ keys: [], at: Number.NEGATIVE_INFINITY, sort });
  const next = nextListOrder(order, rows, sort, hold, now);
  if (next !== order) setOrder(next);
  return next.keys;
}

/** 位置变化的行从旧位置平移到新位置（FLIP）；只在顺序或可见集合变化后执行。返回挂在列表上的 ref。 */
function useFlip(signature: string) {
  const listRef = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const current = new Map<string, DOMRect>();
    const moved: HTMLElement[] = [];
    for (const child of list.children) {
      if (!(child instanceof HTMLElement) || !child.dataset.key) continue;
      child.style.transition = 'none';
      child.style.transform = '';
      const box = child.getBoundingClientRect();
      current.set(child.dataset.key, box);
      const before = previous.current.get(child.dataset.key);
      if (!before || reduce) continue;
      const dx = before.left - box.left;
      const dy = before.top - box.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      child.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(child);
    }
    previous.current = current;
    if (moved.length === 0) return;
    void list.offsetHeight;
    for (const child of moved) {
      child.style.transition = 'transform 320ms cubic-bezier(.2,.7,.2,1)';
      child.style.transform = '';
    }
  }, [signature]);
  return listRef;
}

/* ── 读数 ── */

/** 当前速率：bit/s，与机器详情吞吐图同一套阶梯；成对读数按较大者取同一档单位。 */
function Rate({ value, pair }: { value: number | null; pair: number }) {
  if (value === null) return <>—</>;
  if (value === 0) return <>0</>;
  const reading = observeBpsReadingParts(value * 8, pair * 8);
  return (
    <>
      {reading.number}
      <small>{reading.unit}</small>
    </>
  );
}

/** 读数栏里的速率是纯文本（与「用量与额度」读数栏一致），数值与单位之间留一个空格。 */
function rateText(value: number, pair: number) {
  if (value === 0) return '0';
  const reading = observeBpsReadingParts(value * 8, pair * 8);
  return `${reading.number} ${reading.unit}`;
}

function Bytes({ value }: { value: number }) {
  if (value === 0) return <>0</>;
  const [number, unit] = bytes(value).split(' ');
  return (
    <>
      {number}
      <small>{unit}</small>
    </>
  );
}

const idleLabel = (idleMillis: number) =>
  !Number.isFinite(idleMillis)
    ? '近 1 小时无流量'
    : idleMillis < 60_000
      ? '空闲'
      : idleMillis < 3_600_000
        ? `空闲 ${Math.floor(idleMillis / 60_000)} 分钟`
        : `空闲 ${Math.floor(idleMillis / 3_600_000)} 小时`;

/** 近 1 小时走势：每格一个窗口的平均速率，下行画面积、上行画细线（与上方合计图同一编码）；
 * 缺失的格断开。按本行峰值缩放，下限是全体峰值的 6%，零星流量不会被放大成满格。 */
const HourSpark = memo(function HourSpark({ hour, peak }: { hour: HourRow | null; peak: number }) {
  const paths = useMemo(() => {
    if (!hour) return null;
    const perSecond = (values: (number | null)[]) => values.map(value => (value === null ? null : value / SLOT_SECS));
    const down = perSecond(hour.down);
    const up = perSecond(hour.up);
    const own = Math.max(0, ...down.map(value => value ?? 0), ...up.map(value => value ?? 0));
    const scale = Math.max(own, peak * 0.06, 1024) * 1.06;
    return { down: sparklinePaths(down, scale, SPARK_HEIGHT), up: sparklinePaths(up, scale, SPARK_HEIGHT) };
  }, [hour, peak]);
  return (
    <svg
      className="rut-spark"
      viewBox={`0 0 ${SLOTS - 1} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths?.down.areas.map((path, index) => (
        <path key={`a${index}`} className="rut-spark-area" d={path} />
      ))}
      {paths?.up.lines.map((path, index) => (
        <path key={`u${index}`} className="rut-spark-up" d={path} />
      ))}
      {paths?.down.lines.map((path, index) => (
        <path key={`d${index}`} className="rut-spark-line" d={path} />
      ))}
    </svg>
  );
});

function RateCell({ value, pair, direction }: { value: number | null; pair: number; direction: 'd' | 'u' }) {
  return (
    <span className={`rut-rate ${direction}${value === null ? ' none' : ''}`}>
      <span className="rut-rate-text">
        <Rate value={value} pair={pair} />
      </span>
      <i className="rut-dot" aria-hidden="true" />
    </span>
  );
}

function TrafficItem({ row, meta, idle, peak }: { row: CardRow; meta: string; idle: boolean; peak: number }) {
  const pair = Math.max(row.down ?? 0, row.up ?? 0);
  const label = `${row.name}：当前下行 ${row.down === null ? '未知' : bytes(row.down) + '/s'}，当前上行 ${
    row.up === null ? '未知' : bytes(row.up) + '/s'
  }，近 1 小时 ${bytes(row.hourBytes)}`;
  return (
    <div
      className={`rut-item${idle ? ' idle' : ''}${row.offline ? ' offline' : ''}`}
      role="listitem"
      aria-label={label}
      data-key={row.key}
    >
      <span className="rut-who">
        <b className="rut-name">{row.name}</b>
        <span className={`rut-meta${row.offline ? ' warn' : ''}`} title={meta}>
          {meta}
        </span>
      </span>
      <HourSpark hour={row.hour} peak={peak} />
      <RateCell value={row.down} pair={pair} direction="d" />
      <RateCell value={row.up} pair={pair} direction="u" />
    </div>
  );
}

/* ── 卡片 ── */

interface TrafficCardProps {
  page: 'node' | 'user';
  phase: TrafficPhase;
  partial: boolean;
  /** 实时通道断开时，最后一次有效数据的时刻。 */
  staleSince: number | null;
  now: number;
  live: ReadonlyMap<string, RetainedRow>;
  /** 最新报告完整时，不在报告里的已知对象当前为 0。 */
  complete: boolean;
  history: { model: HourModel | null; pending: boolean; failed: boolean };
  nameOf: (key: string) => string;
  /** 用户详情：快照列出的全部入口机器。 */
  targets?: readonly string[];
  className?: string;
}

function TrafficCard({
  page,
  phase,
  partial,
  staleSince,
  now,
  live,
  complete,
  history,
  nameOf,
  targets = NO_TARGETS,
  className = '',
}: TrafficCardProps) {
  const [sort, setSort] = useState<TrafficSort>('name');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  // 机器详情列的是用户，用户详情列的是入口机器；两者都排成多列紧凑格
  const users = page === 'node';
  const unit = users ? '位' : '台';
  const stale = phase === 'offline' && staleSince !== null;
  const showsLive = phase === 'ready' || stale;

  const rows = useMemo(() => {
    const keys = new Set<string>([...live.keys(), ...targets]);
    history.model?.rows.forEach((_, key) => keys.add(key));
    return [...keys].map((key): CardRow => {
      const retained = live.get(key);
      const hour = history.model?.rows.get(key) ?? null;
      const absent = phase === 'ready' && complete ? 0 : null;
      const [tenant, user] = users ? key.split('/') : [undefined, undefined];
      return {
        key,
        name: users ? (retained?.name ?? hour?.user ?? user ?? key) : nameOf(key),
        detail: users ? (retained?.detail ?? hour?.tenant ?? tenant ?? '') : '',
        down: showsLive ? (retained?.down ?? absent) : null,
        up: showsLive ? (retained?.up ?? absent) : null,
        offline: !!retained?.offline,
        ingresses: retained?.ingresses,
        forwardingDown: retained?.forwardingDown,
        forwardingUp: retained?.forwardingUp,
        hour,
        hourBytes: hour ? hour.hourDown + hour.hourUp : 0,
        lastActiveMs: Math.max(retained?.lastActiveMs ?? 0, hour?.lastActiveMs ?? 0) || null,
      };
    });
  }, [complete, users, history.model, live, nameOf, phase, showsLive, targets]);

  const dynamic = sort !== 'name';
  const held = hover && dynamic;
  const order = useListOrder(rows, sort, held, now);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const ordered = order.map(key => byKey.get(key)).filter((row): row is CardRow => !!row);
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? ordered.filter(row => row.name.toLowerCase().includes(needle) || row.detail.toLowerCase().includes(needle))
    : ordered;
  const visible = expanded ? matched : matched.slice(0, FOLD);
  const listRef = useFlip(visible.map(row => row.key).join('\n'));

  const totals = rows.reduce(
    (sum, row) => {
      sum.down += row.down ?? 0;
      sum.up += row.up ?? 0;
      if (totalOf(row) > 0) sum.active += 1;
      return sum;
    },
    { down: 0, up: 0, active: 0 },
  );
  const currentSum = totals.down + totals.up;
  const hero = observeBpsReadingParts(currentSum * 8);
  const pair = Math.max(totals.down, totals.up);
  const peak = history.model?.peak ?? 0;

  const chart = useMemo(() => {
    const model = history.model;
    if (!model) return null;
    const toBits = (value: number | null) => (value === null ? null : (value * 8) / SLOT_SECS);
    const rx = model.totalDown.map(toBits);
    const tx = model.totalUp.map(toBits);
    return {
      rx,
      tx,
      unit: throughputAxis(rx, tx).unit,
      total: [...model.rows.values()].reduce((sum, row) => sum + row.hourDown + row.hourUp, 0),
    };
  }, [history.model]);

  const lamp = phase === 'ready' && !partial ? '' : phase === 'ready' || phase === 'pending' ? 'idle' : 'warn';
  const status = phase === 'ready' && partial ? '部分数据待恢复' : PHASE_TEXT[phase];
  const emptyText =
    rows.length === 0
      ? history.pending
        ? null
        : users
          ? `近 1 小时没有用户流量（${SCOPE_NOTE}）`
          : '尚未授权入口机器'
      : needle && matched.length === 0
        ? `没有匹配「${query.trim()}」的${users ? '用户' : '机器'}`
        : null;
  const rest = matched.length - FOLD;

  const metaOf = (row: CardRow) => {
    const idleFor = row.lastActiveMs === null ? Number.POSITIVE_INFINITY : now - row.lastActiveMs;
    const idle = phase === 'ready' && totalOf(row) === 0 && idleFor >= IDLE_MILLIS;
    // 第二行：租户（机器详情）或接入点数（用户详情）· 近 1 小时用量 · 空闲或未连接
    const parts = [
      users ? row.detail : row.ingresses ? `${row.ingresses} 个接入点` : '',
      row.forwardingDown !== undefined || row.hour?.forwarding ? '含转发' : '',
      bytes(row.hourBytes),
      row.hour?.unplaced ? '部分历史无精确时间' : '',
      row.offline ? '未连接' : idle ? idleLabel(idleFor) : '',
    ].filter(Boolean);
    return { text: parts.join(' · '), idle };
  };

  return (
    <section
      className={`panel config-panel realtime-user-traffic${stale ? ' stale' : ''} ${className}`}
      aria-label="用户实时流量"
    >
      <header>
        <span title={SCOPE_NOTE}>
          <PanelTitle of="usage">用户实时流量</PanelTitle>
        </span>
        <span className={`rut-status${lamp === 'warn' ? ' warn' : ''}`} role="status">
          <i className={`node-lamp${lamp ? ` ${lamp}` : ''}`} />
          {status}
        </span>
      </header>
      <div className="rut-body">
        <div className="rut-cockpit">
          <section className="rut-now" aria-label="当前速率">
            <div className="user-usage-hero">
              <span className="user-usage-hero-label">当前速率</span>
              <strong className="user-usage-hero-value">
                {showsLive ? (
                  <>
                    {currentSum > 0 ? hero.number : '0'} <small>{hero.unit}</small>
                  </>
                ) : (
                  <span className="rut-wait">—</span>
                )}
              </strong>
              <span className="rut-hero-sub">
                {showsLive ? (
                  <>
                    <b>{totals.active}</b> {unit}活跃 · 共 <b>{rows.length}</b> {unit}
                  </>
                ) : (
                  `共 ${rows.length} ${unit}`
                )}
              </span>
            </div>
            <div>
              <div className="usage-split" aria-hidden="true">
                {totals.down > 0 && <i className="down" style={{ flexGrow: totals.down }} />}
                {totals.up > 0 && <i className="up" style={{ flexGrow: totals.up }} />}
              </div>
              <dl className="usage-io">
                <div className="down">
                  <dt>
                    <i aria-hidden="true" />
                    下行
                  </dt>
                  <dd>{showsLive ? rateText(totals.down, pair) : '—'}</dd>
                  <dd className="usage-share">{showsLive && currentSum > 0 ? shareOf(totals.down, currentSum) : ''}</dd>
                </div>
                <div className="up">
                  <dt>
                    <i aria-hidden="true" />
                    上行
                  </dt>
                  <dd>{showsLive ? rateText(totals.up, pair) : '—'}</dd>
                  <dd className="usage-share">{showsLive && currentSum > 0 ? shareOf(totals.up, currentSum) : ''}</dd>
                </div>
              </dl>
            </div>
          </section>
          <section className="rut-hour" aria-label="近 1 小时">
            <div className="rut-hour-head">
              <span title="按真实采样窗口计算平均速率；确认重启停机期间为 0，未知缺失仍为空">近 1 小时 · 每 30 秒</span>
              {chart && <span className="chart-unit">({chart.unit.name})</span>}
              <span className="rut-legend" aria-hidden="true">
                <i className="d" />
                下行
                <i className="u" />
                上行
              </span>
              {chart && (
                <b>
                  <Bytes value={chart.total} />
                </b>
              )}
            </div>
            {history.model && chart && history.model.totalDown.some(value => value !== null) ? (
              <Suspense fallback={<div className="rut-chart-wait" />}>
                <LazyThroughputChart
                  timesUnixSecs={history.model.slots}
                  rangeStartUnixSecs={history.model.rangeStart}
                  rangeEndUnixSecs={history.model.rangeEnd}
                  rx={chart.rx}
                  tx={chart.tx}
                  rxName="下行"
                  txName="上行"
                />
              </Suspense>
            ) : (
              <div className="rut-chart-wait">
                {history.failed ? (
                  <span className="rut-chart-note">近 1 小时数据暂不可用</span>
                ) : history.model ? (
                  <span className="rut-chart-note">近 1 小时没有上报记录</span>
                ) : null}
              </div>
            )}
          </section>
        </div>
        <div className="rut-main">
          <div className="rut-tools">
            <span className="user-list-search">
              <Icon of="search" size={13} className="user-list-search-icon" />
              <input
                type="search"
                value={query}
                aria-label={users ? '搜索用户' : '搜索机器'}
                placeholder={users ? '搜索用户或租户' : '搜索机器'}
                autoComplete="off"
                spellCheck={false}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') setQuery('');
                }}
              />
              {query && (
                <button type="button" aria-label="清空搜索" title="清空" onClick={() => setQuery('')}>
                  <Icon of="close" size={13} />
                </button>
              )}
            </span>
            {needle && (
              <span className="rut-count">
                {matched.length} / {ordered.length}
              </span>
            )}
            {held && <span className="rut-hold">排序已暂停</span>}
            <SegmentedControl className="rut-sort" ariaLabel="排序" value={sort} onChange={setSort} options={SORTS} />
          </div>
          {stale && (
            <p className="rut-notice" role="status">
              <i className="node-lamp warn" />
              实时通道未连接：当前速率停在 {clockText(staleSince)}，近 1 小时仍每 30 秒更新
            </p>
          )}
          <p className="rut-caption" aria-hidden="true">
            <span>走势：近 1 小时 · 每 30 秒</span>
            <span className="rut-legend">
              <i className="d" />
              当前下行
              <i className="u" />
              当前上行
            </span>
            <span>用量：近 1 小时</span>
          </p>
          <div
            ref={listRef}
            className="rut-grid"
            role="list"
            aria-label={users ? '各用户流量' : '各入口机器流量'}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
          >
            {visible.map(row => {
              const meta = metaOf(row);
              return <TrafficItem key={row.key} row={row} meta={meta.text} idle={meta.idle} peak={peak} />;
            })}
          </div>
          {emptyText && <p className="rut-empty">{emptyText}</p>}
          {rest > 0 && (
            <button
              className="btn text sm rut-more"
              type="button"
              onClick={() => setExpanded(value => !value)}
              aria-expanded={expanded}
            >
              {expanded ? '收起' : `显示其余 ${rest} ${unit}`}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

const clockText = (millis: number | null) =>
  millis === null ? '—' : new Date(millis).toLocaleTimeString('zh-CN', { hour12: false });

function useHourHistory(queryKey: readonly unknown[], load: () => Promise<UserTrafficHistory>, page: 'node' | 'user') {
  const history = useQuery({
    queryKey,
    queryFn: load,
    refetchInterval: HISTORY_REFRESH_MILLIS,
    staleTime: HISTORY_REFRESH_MILLIS / 2,
  });
  const model = useMemo(() => (history.data ? hourModel(history.data, page) : null), [history.data, page]);
  return { model, pending: history.isPending, failed: history.isError && !history.data };
}

/* ── 机器详情 ── */

export function NodeUserTrafficCard({ nodeId }: { nodeId: string }) {
  return <NodeTrafficCard key={nodeId} nodeId={nodeId} />;
}

function NodeTrafficCard({ nodeId }: { nodeId: string }) {
  const { last, now, connected, enabled, observingSince } = useNodeRealtime(nodeId);
  const report = last?.event.sample.user_traffic;
  const fresh =
    !!last && now - last.arrived <= FRESH_MILLIS && now - last.event.received_at_unix_millis <= FRESH_MILLIS;
  let phase: TrafficPhase = 'pending';
  if (enabled === false) phase = 'disabled';
  else if (!connected && (last || now - observingSince > 5000)) phase = 'offline';
  else if (last && !fresh) phase = 'offline';
  else if (fresh && !report) phase = 'unsupported';
  else if (report?.state === 'unavailable') phase = 'unavailable';
  else if (report?.forwarding_expected && !report.forwarding_supported) phase = 'forwarding-unsupported';
  else if (
    fresh &&
    report?.state === 'ready' &&
    report.all_users &&
    (!(report.has_gap || report.truncated) || (report.users?.length ?? 0) > 0)
  )
    phase = 'ready';
  const ready = phase === 'ready' && !!report;
  const complete = ready && !report.has_gap && !report.truncated;
  const liveRows = useMemo(() => (ready ? aggregateUserTraffic(report?.users ?? []) : []), [ready, report]);
  const at = ready ? (last?.event.received_at_unix_millis ?? null) : null;
  const retained = useRetained(at, liveRows, complete);
  const history = useHourHistory(
    ['user-traffic-history', 'node', nodeId],
    () => fetchNodeUserTrafficHistory(nodeId),
    'node',
  );
  const nameOf = useMemo(() => (key: string) => key, []);
  return (
    <TrafficCard
      page="node"
      phase={phase}
      partial={!!(report?.has_gap || report?.truncated)}
      staleSince={phase === 'offline' && retained.rows.size > 0 ? retained.at : null}
      now={now}
      live={retained.rows}
      complete={complete}
      history={history}
      nameOf={nameOf}
    />
  );
}

/* ── 用户详情 ── */

/** 用户详情的一台入口机器：当前速率、是否在线，以及这一份数据能否代表全部授权。 */
function userNodeRow(node: UserTrafficNode, tenantId: string, userId: string, now: number) {
  const event = node.samples.at(-1);
  const report = event?.sample.user_traffic;
  const base = { key: node.node_id, name: node.node_id, detail: '' };
  if (!node.connected || !event || now - event.received_at_unix_millis > FRESH_MILLIS) {
    return { row: { ...base, down: null, up: null, offline: true }, state: 'offline' as const, at: null };
  }
  if (!report) return { row: { ...base, down: null, up: null }, state: 'unsupported' as const, at: null };
  if (report.forwarding_expected && !report.forwarding_supported)
    return { row: { ...base, down: null, up: null }, state: 'forwarding-unsupported' as const, at: null };
  if (report.state === 'unavailable') {
    return { row: { ...base, down: null, up: null }, state: 'unavailable' as const, at: null };
  }
  if (report.state !== 'ready') return { row: { ...base, down: null, up: null }, state: 'pending' as const, at: null };
  const users = (report.users ?? []).filter(user => user.tenant_id === tenantId && user.user_id === userId);
  if ((report.has_gap || report.truncated) && users.length === 0) {
    return { row: { ...base, down: null, up: null }, state: 'missing' as const, at: null };
  }
  const forwarding = users.filter(user => user.forwarding_rule_id !== undefined);
  const hasForwarding = report.forwarding_expected || forwarding.length > 0;
  return {
    row: {
      ...base,
      down: users.reduce((sum, user) => sum + user.downlink_bytes_per_sec, 0),
      up: users.reduce((sum, user) => sum + user.uplink_bytes_per_sec, 0),
      ingresses: new Set(users.map(user => user.ingress_id).filter(Boolean)).size,
      forwardingDown: hasForwarding
        ? forwarding.reduce((sum, user) => sum + user.downlink_bytes_per_sec, 0)
        : undefined,
      forwardingUp: hasForwarding ? forwarding.reduce((sum, user) => sum + user.uplink_bytes_per_sec, 0) : undefined,
    },
    state: (report.has_gap || report.truncated ? 'partial' : 'ready') as 'partial' | 'ready',
    at: event.received_at_unix_millis,
  };
}

export function UserRealtimeTrafficCard({
  tenantId,
  userId,
  nameOf,
}: {
  tenantId: string;
  userId: string;
  nameOf: (id: string) => string;
}) {
  const { payload, now, failed } = useUserTrafficSource(tenantId, userId);
  const nodes = useMemo(
    () => (payload?.nodes ?? []).map(node => userNodeRow(node, tenantId, userId, now)),
    [now, payload, tenantId, userId],
  );
  const ready = nodes.filter(node => node.state === 'ready' || node.state === 'partial');
  let phase: TrafficPhase = 'pending';
  if (!payload && failed) phase = 'unavailable';
  else if (payload && !payload.policy.enabled) phase = 'disabled';
  else if (payload?.nodes.length === 0) phase = 'empty';
  else if (ready.length > 0) phase = 'ready';
  else if (nodes.some(node => node.state === 'forwarding-unsupported')) phase = 'forwarding-unsupported';
  else if (nodes.some(node => node.state === 'unsupported')) phase = 'unsupported';
  else if (nodes.some(node => node.state === 'unavailable')) phase = 'unavailable';
  else if (payload && nodes.every(node => node.state === 'offline')) phase = 'offline';
  const liveRows = useMemo(() => nodes.map(node => node.row), [nodes]);
  const at = ready.length > 0 ? Math.max(...ready.map(node => node.at ?? 0)) : null;
  const retained = useRetained(at, liveRows, false);
  // 未连接的机器只标记离线，读数保留最后一次有效数据
  const live = useMemo(() => {
    const next = new Map(retained.rows);
    for (const node of nodes) {
      const row = next.get(node.row.key);
      if (row) next.set(node.row.key, { ...row, offline: node.state === 'offline' });
    }
    return next;
  }, [nodes, retained]);
  const history = useHourHistory(
    ['user-traffic-history', 'user', tenantId, userId],
    () => fetchUserTrafficHistory(tenantId, userId),
    'user',
  );
  const targets = useMemo(() => (payload?.nodes ?? []).map(node => node.node_id), [payload]);
  return (
    <TrafficCard
      page="user"
      phase={phase}
      partial={nodes.some(node => node.state !== 'ready')}
      staleSince={phase === 'offline' && retained.rows.size > 0 ? retained.at : null}
      now={now}
      live={live}
      complete={false}
      history={history}
      nameOf={nameOf}
      targets={targets}
      className="user-dcard"
    />
  );
}
