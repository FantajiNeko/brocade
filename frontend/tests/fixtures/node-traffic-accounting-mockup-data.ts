// Scenes and derived readings for the 流量统计 card mockup. Synthetic data except the `pump` scene,
// which copies the production /node-traffic row for pump-hk-plan-b-bgp read on 2026-10-19.
import type { NodeTrafficAccountingMode, NodeTrafficCycleKind, NodeTrafficItem } from '../../src/api';
import { trafficGapReason } from '../../src/ui/traffic-gap';

export const DAY = 86_400;
const KiB = 1024;
const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const TiB = 1024 ** 4;

/** 2026-10-19 10:15:11 UTC：香港 PUMP 最后一次上报之后 34 秒。 */
export const NOW = 1_792_404_911;
const at = (iso: string) => Date.parse(iso) / 1000;

/* ══ 读数格式 ══ */

const pad2 = (n: number) => String(n).padStart(2, '0');
export const md = (secs: number) => {
  const date = new Date(secs * 1000);
  return `${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};
export const hm = (secs: number) => {
  const date = new Date(secs * 1000);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
};
export const ymd = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

/** 主读数：两位小数，与机器卡片底部「本月」网卡累计同一写法（exactBytes）。 */
export function exact(n: number): string {
  const units: [string, number][] = [
    ['TiB', TiB],
    ['GiB', GiB],
    ['MiB', MiB],
    ['KiB', KiB],
  ];
  const unit = units.find(([, size]) => n >= size);
  return unit ? `${(n / unit[1]).toFixed(2)} ${unit[0]}` : `${Math.round(n)} B`;
}

/** 次要读数：三位有效数字，与流量预测页同一写法（capacity.tsx volume）。 */
export function volume(n: number): string {
  if (n >= 999.5 * GiB) return `${(n / TiB).toFixed(2)} TiB`;
  if (n >= 99.95 * GiB) return `${(n / GiB).toFixed(0)} GiB`;
  if (n >= 9.995 * GiB) return `${(n / GiB).toFixed(1)} GiB`;
  if (n >= 999.5 * MiB) return `${(n / GiB).toFixed(2)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(0)} MiB`;
  if (n >= KiB) return `${(n / KiB).toFixed(0)} KiB`;
  return `${n.toFixed(0)} B`;
}

/** 距某时刻：两天以内按小时，以上按整天（舍去），与「第 19/31 天」相加等于本期天数。 */
export function spanText(secs: number): string {
  return secs < 2 * DAY ? `${Math.max(1, Math.round(secs / 3600))} 小时` : `${Math.floor(secs / DAY)} 天`;
}

/* ══ 计量口径 ══ */

export const MODES: { value: NodeTrafficAccountingMode; label: string; note: string }[] = [
  { value: 'bidirectional_sum', label: '双向合计', note: '接收与发送相加。' },
  { value: 'bidirectional_max', label: '双向取大', note: '整个账期累计后取接收、发送中较大的一方，不按天取大。' },
  { value: 'outbound_only', label: '单向出站', note: '只计发送，接收不计入。' },
  { value: 'inbound_only', label: '单向入站', note: '只计接收，发送不计入。' },
];
export const modeLabel = (mode: NodeTrafficAccountingMode) => MODES.find(item => item.value === mode)?.label ?? mode;

function totalOf(mode: NodeTrafficAccountingMode, rx: number, tx: number): number {
  switch (mode) {
    case 'bidirectional_sum':
      return rx + tx;
    case 'bidirectional_max':
      return Math.max(rx, tx);
    case 'outbound_only':
      return tx;
    case 'inbound_only':
      return rx;
  }
}

/* ══ 周期边界：与 NODE_TRAFFIC_VIEW_SQL 相同，短月取月末 ══ */

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const utcDay = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / 1000;
const shiftMonth = (year: number, month: number, months: number): [number, number] => {
  const index = year * 12 + month - 1 + months;
  return [Math.floor(index / 12), (index % 12) + 1];
};

export function periodOf(
  cycle: NodeTrafficCycleKind,
  resetMonth: number | null,
  resetDay: number,
  now: number,
): [number, number] {
  const today = new Date(now * 1000);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const todayStart = utcDay(year, month, today.getUTCDate());
  const anchor = ([y, m]: [number, number]) => utcDay(y, m, Math.min(resetDay, daysIn(y, m)));
  let base: [number, number];
  if (cycle === 'monthly') base = anchor([year, month]) <= todayStart ? [year, month] : shiftMonth(year, month, -1);
  else {
    const m = resetMonth ?? 1;
    base = anchor([year, m]) <= todayStart ? [year, m] : [year - 1, m];
  }
  return [anchor(base), anchor(shiftMonth(base[0], base[1], cycle === 'monthly' ? 1 : 12))];
}

/** 周期首尾跨年时日期带年份。 */
export function periodText(start: number, end: number): string {
  const sameYear = new Date(start * 1000).getUTCFullYear() === new Date(end * 1000).getUTCFullYear();
  return sameYear ? `${md(start)} → ${md(end)}` : `${ymd(start)} → ${ymd(end)}`;
}

export function resetText(cycle: NodeTrafficCycleKind, resetMonth: number | null, resetDay: number): string {
  return cycle === 'yearly' ? `每年 ${resetMonth} 月 ${resetDay} 日` : `每月 ${resetDay} 日`;
}

/** 重置日在部分月份不存在时的落点说明。 */
export function clampNote(cycle: NodeTrafficCycleKind, resetMonth: number | null, resetDay: number): string | null {
  if (cycle === 'yearly') {
    if (resetMonth === 2 && resetDay === 29) return '非闰年在 2 月 28 日重置';
    const longest = daysIn(2024, resetMonth ?? 1);
    return resetDay > longest ? `${resetMonth} 月没有 ${resetDay} 日，在月末重置` : null;
  }
  return resetDay > 28 ? `没有 ${resetDay} 日的月份在月末重置` : null;
}

/* ══ 场景 ══ */

export interface DayBytes {
  day: number;
  bytes: number;
}

export interface Scene {
  label: string;
  note: string;
  item: NodeTrafficItem;
  /** 流量预测模型里本期每个 UTC 日的计费字节；只有管理员读得到。没有字节的日子不出现。 */
  days: DayBytes[];
}

/** 按日分摊合成的账本：每天的份额 = 当天落在 [from, to) 的比例 × 起伏；dip 那天打七折。 */
function spread(total: number, from: number, to: number, seed: number, dip?: number): DayBytes[] {
  const parts: [number, number][] = [];
  for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
    const covered = (Math.min(day + DAY, to) - Math.max(day, from)) / DAY;
    if (covered <= 0) continue;
    const index = day / DAY;
    const wave = 1 + 0.2 * Math.sin(index * 1.7 + seed) + 0.12 * Math.sin(index * 0.55 + seed * 2);
    const weekend = [0, 6].includes(new Date(day * 1000).getUTCDay()) ? 1.18 : 1;
    const dipped = dip !== undefined && day === Math.floor(dip / DAY) * DAY ? 0.72 : 1;
    parts.push([day, covered * wave * weekend * dipped]);
  }
  const sum = parts.reduce((acc, [, weight]) => acc + weight, 0);
  return parts.map(([day, weight]) => ({ day, bytes: Math.round((total * weight) / sum) }));
}

interface SceneInput {
  label: string;
  note: string;
  cycle?: NodeTrafficCycleKind;
  resetMonth?: number;
  resetDay?: number;
  mode?: NodeTrafficAccountingMode;
  quota?: number | null;
  rx: number;
  tx: number;
  /** 不给时按口径从 rx/tx 算出。 */
  total?: number;
  tracking?: number | null;
  calibration?: { at: number; target: number; ledgerBefore: number };
  gap?: { at: number; reason: string };
  iface?: string | null;
  reported?: number | null;
  seed?: number;
}

function scene(raw: SceneInput): Scene {
  // 接口返回的是整数字节的十进制字符串；合成值先取整，exactBytes 才读得出来。
  const input: SceneInput = {
    ...raw,
    quota: raw.quota == null ? raw.quota : Math.round(raw.quota),
    rx: Math.round(raw.rx),
    tx: Math.round(raw.tx),
    total: raw.total === undefined ? undefined : Math.round(raw.total),
    calibration: raw.calibration && {
      ...raw.calibration,
      target: Math.round(raw.calibration.target),
      ledgerBefore: Math.round(raw.calibration.ledgerBefore),
    },
  };
  const cycle = input.cycle ?? 'monthly';
  const resetMonth = cycle === 'yearly' ? (input.resetMonth ?? 1) : null;
  const resetDay = input.resetDay ?? 1;
  const mode = input.mode ?? 'bidirectional_sum';
  const [start, end] = periodOf(cycle, resetMonth, resetDay, NOW);
  const tracking = input.tracking === undefined ? start - 40 * DAY : input.tracking;
  const ledgerTotal = totalOf(mode, input.rx, input.tx);
  const calibration = input.calibration;
  const total =
    input.total ?? (calibration ? calibration.target + (ledgerTotal - calibration.ledgerBefore) : ledgerTotal);
  const ledgerFrom = Math.max(start, tracking ?? NOW);
  const days =
    tracking === null
      ? []
      : spread(ledgerTotal, ledgerFrom, NOW, input.seed ?? 1, input.gap?.at).filter(day => day.bytes > 0);
  const anchor = Math.max(start, calibration?.at ?? start);
  return {
    label: input.label,
    note: input.note,
    days,
    item: {
      node_id: 'pump-hk-plan-b-bgp',
      tenant_id: 'platform',
      name: '香港 PUMP',
      cycle_kind: cycle,
      accounting_mode: mode,
      reset_month: resetMonth,
      reset_day: resetDay,
      quota_bytes: input.quota == null ? null : String(input.quota),
      period_start_unix_secs: start,
      period_end_unix_secs: end,
      rx_bytes: String(input.rx),
      tx_bytes: String(input.tx),
      total_bytes: String(total),
      interface: input.iface === undefined ? 'eth0' : input.iface,
      tracking_started_at_unix_secs: tracking,
      last_reported_at_unix_secs: input.reported === undefined ? NOW - 34 : input.reported,
      calibrated_at_unix_secs: calibration?.at ?? null,
      last_gap_at_unix_secs: input.gap?.at ?? null,
      last_gap_reason: input.gap?.reason ?? null,
      has_gap: (tracking !== null && tracking > anchor) || input.gap !== undefined,
    },
  };
}

export const SCENES = {
  pump: scene({
    label: '香港 PUMP 实况',
    note: '生产 10-19 18:15 的真实读数：10-12 起记账、10-18 重启、未校准，额度 2 TiB。逐日柱为合成数据。',
    quota: 2_199_023_255_552,
    rx: 646_862_548_718,
    tx: 570_996_492_159,
    total: 1_217_859_040_877,
    tracking: 1_791_796_232,
    gap: { at: 1_792_354_731, reason: 'machine-reboot' },
    reported: 1_792_404_877,
    seed: 3,
  }),
  steady: scene({
    label: '整期记录 · 余量充足',
    note: '记账早于期初，本期没有缺口。',
    quota: 3 * TiB,
    rx: 0.55 * TiB,
    tx: 0.47 * TiB,
    seed: 5,
  }),
  calibrated: scene({
    label: '已校准',
    note: '每月 15 日重置。10-16 重装 Agent 后按服务商面板校准为 66 GiB；之后 = 校准值 + 网卡增量，接收/发送只含重装之后。',
    resetDay: 15,
    quota: TiB,
    rx: 51.4 * GiB,
    tx: 40.9 * GiB,
    tracking: at('2026-10-16T03:02:00Z'),
    calibration: { at: at('2026-10-16T03:20:00Z'), target: 66 * GiB, ledgerBefore: 0.3 * GiB },
    seed: 7,
  }),
  near: scene({
    label: '接近额度',
    note: '每月 26 日重置，还剩 6 天，已用 91%。',
    resetDay: 26,
    quota: TiB,
    rx: 0.5 * TiB,
    tx: 0.41 * TiB,
    seed: 2,
  }),
  over: scene({
    label: '已超额',
    note: '每月 24 日重置，额度 1 TiB，已超出 12%。',
    resetDay: 24,
    quota: TiB,
    rx: 0.62 * TiB,
    tx: 0.5 * TiB,
    seed: 4,
  }),
  unlimited: scene({
    label: '未设额度',
    note: '没有额度时不画额度条。',
    quota: null,
    rx: 1.3 * TiB,
    tx: 1.13 * TiB,
    seed: 6,
  }),
  max: scene({
    label: '双向取大',
    note: '接收大于发送：本期总量 = 接收。',
    mode: 'bidirectional_max',
    quota: 2 * TiB,
    rx: 1.06 * TiB,
    tx: 0.97 * TiB,
    seed: 8,
  }),
  outbound: scene({
    label: '单向出站',
    note: '只计发送：接收不计入额度。',
    mode: 'outbound_only',
    quota: TiB,
    rx: 2.31 * TiB,
    tx: 0.62 * TiB,
    seed: 9,
  }),
  yearly: scene({
    label: '每年 2 月 29 日重置',
    note: '年度周期；非闰年在 2 月 28 日重置。',
    cycle: 'yearly',
    resetMonth: 2,
    resetDay: 29,
    quota: 12 * TiB,
    rx: 4.1 * TiB,
    tx: 3.74 * TiB,
    tracking: at('2026-01-10T06:00:00Z'),
    seed: 10,
  }),
  gap: scene({
    label: '中途重启',
    note: '整期都有记录，10-07 机器重启。',
    quota: 2 * TiB,
    rx: 0.47 * TiB,
    tx: 0.39 * TiB,
    gap: { at: at('2026-10-07T21:42:00Z'), reason: 'machine-reboot' },
    seed: 11,
  }),
  'report-gap': scene({
    label: '控制面跨日失联',
    note: '跨日没有收到上报：可能把上期流量算进本期。',
    quota: 2 * TiB,
    rx: 0.52 * TiB,
    tx: 0.44 * TiB,
    gap: { at: at('2026-10-02T00:20:00Z'), reason: 'report-gap' },
    seed: 12,
  }),
  unreported: scene({
    label: 'Agent 尚未上报',
    note: '新机器：额度已预先填好，网卡累计还没有上报。',
    quota: TiB,
    rx: 0,
    tx: 0,
    tracking: null,
    iface: null,
    reported: null,
  }),
} satisfies Record<string, Scene>;

export type SceneKey = keyof typeof SCENES;
export const SCENE_OPTIONS = (Object.keys(SCENES) as SceneKey[]).map(key => ({
  value: key,
  label: SCENES[key].label,
}));

/* ══ 读数推导：卡片只看保存后的值 ══ */

export interface Reading {
  measured: boolean;
  used: number;
  rx: number;
  tx: number;
  quota: number | null;
  start: number;
  end: number;
  totalDays: number;
  elapsedDays: number;
  left: number;
  /** 校准与期初两者较晚者：记账起点晚于它，说明中间的流量没有计入。 */
  anchor: number;
  lateStart: boolean;
  tracking: number | null;
  calibratedAt: number | null;
  gap: { at: number; reason: string | null } | null;
  /** 本期日均的分母从这一刻算起：校准补齐了校准之前，否则从记账起点算起。 */
  rateFrom: number | null;
  rate: number | null;
  remaining: number | null;
  /** 额度内每天可用 = 剩余 ÷ 剩余天数。 */
  allowance: number | null;
}

export function readingOf(item: NodeTrafficItem, now: number): Reading {
  const start = item.period_start_unix_secs;
  const end = item.period_end_unix_secs;
  const tracking = item.tracking_started_at_unix_secs;
  const calibratedAt = item.calibrated_at_unix_secs;
  const measured = tracking !== null || calibratedAt !== null;
  const used = Number(item.total_bytes);
  const quota = item.quota_bytes === null ? null : Number(item.quota_bytes);
  const anchor = Math.max(start, calibratedAt ?? start);
  const rateFrom = !measured ? null : calibratedAt !== null ? start : Math.max(start, tracking ?? start);
  const recordedDays = rateFrom === null ? 0 : (now - rateFrom) / DAY;
  const left = Math.max(end - now, 0);
  const remaining = quota === null || !measured ? null : quota - used;
  return {
    measured,
    used,
    rx: Number(item.rx_bytes),
    tx: Number(item.tx_bytes),
    quota,
    start,
    end,
    totalDays: (end - start) / DAY,
    elapsedDays: Math.min(Math.max(now - start, 0), end - start) / DAY,
    left,
    anchor,
    lateStart: tracking !== null && tracking > anchor,
    tracking,
    calibratedAt,
    gap: item.last_gap_at_unix_secs === null ? null : { at: item.last_gap_at_unix_secs, reason: item.last_gap_reason },
    rateFrom,
    rate: measured && recordedDays >= 0.25 ? used / recordedDays : null,
    remaining,
    allowance: remaining !== null && remaining > 0 && left > 0 ? remaining / (left / DAY) : null,
  };
}

/** 跨日失联不丢字节，只可能把上期的流量算进本期；其余缺口是前后的流量可能没有计入。（同 capacity.tsx） */
export const gapEffect = (reason: string | null) =>
  reason === 'report-gap' ? '可能计入了上期流量' : '可能有流量未计入';

export const gapText = (gap: { at: number; reason: string | null }) =>
  `${md(gap.at)} ${trafficGapReason(gap.reason)}，${gapEffect(gap.reason)}`;

/** 周期条上的一段：记录、未记账、由校准补齐。 */
export interface Span {
  from: number;
  to: number;
  kind: 'rec' | 'un' | 'cal';
}

export function spansOf(reading: Reading, now: number): Span[] {
  const { start, end } = reading;
  const nowAt = Math.min(Math.max(now, start), end);
  if (!reading.measured) return [{ from: start, to: nowAt, kind: 'un' }];
  const spans: Span[] = [];
  if (reading.calibratedAt !== null) spans.push({ from: start, to: reading.calibratedAt, kind: 'cal' });
  const tracked = Math.max(reading.anchor, reading.tracking ?? reading.anchor);
  if (tracked > reading.anchor) spans.push({ from: reading.anchor, to: tracked, kind: 'un' });
  spans.push({ from: tracked, to: nowAt, kind: 'rec' });
  return spans.filter(span => span.to > span.from);
}

export interface DayColumn {
  day: number;
  kind: 'rec' | 'today' | 'un' | 'cal' | 'future';
  bytes: number | null;
}

/** 逐日柱：没有账本条目但在记录范围内的日子是 0（零也是数据），记录范围之外的日子不画柱。 */
export function dayColumns(reading: Reading, days: DayBytes[], now: number): DayColumn[] {
  const byDay = new Map(days.map(day => [day.day, day.bytes]));
  const columns: DayColumn[] = [];
  const spans = spansOf(reading, now);
  for (let day = reading.start; day < reading.end; day += DAY) {
    if (day >= now) {
      columns.push({ day, kind: 'future', bytes: null });
      continue;
    }
    const dayEnd = Math.min(day + DAY, now);
    const overlap = (kind: Span['kind']) =>
      spans
        .filter(span => span.kind === kind)
        .reduce((sum, span) => sum + Math.max(0, Math.min(span.to, dayEnd) - Math.max(span.from, day)), 0);
    if (overlap('rec') > 0) {
      columns.push({ day, kind: day + DAY > now ? 'today' : 'rec', bytes: byDay.get(day) ?? 0 });
    } else {
      columns.push({ day, kind: overlap('cal') >= overlap('un') ? 'cal' : 'un', bytes: null });
    }
  }
  return columns;
}
