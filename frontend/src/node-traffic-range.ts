import type { TrafficTimeRange } from './api';

/** Statistics use UTC+8 independently of the browser's local timezone. */
export const trafficDateInput = (seconds: number) => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19);

export function parseTrafficRange(start: string, end: string, now = Date.now() / 1000): TrafficTimeRange | string {
  const from = Date.parse(`${start}+08:00`) / 1000;
  const to = Date.parse(`${end}+08:00`) / 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '请选择完整的开始和结束时间。';
  if (from <= 0 || to <= from) return '结束时间必须晚于开始时间。';
  if (to > now) return '结束时间不能晚于当前时间。';
  if (to - from > 31 * 86400) return '一次最多查询 31 天。';
  if (from % 30 !== 0 || to % 30 !== 0) return '时间需对齐到 30 秒采样边界。';
  return { start_unix_secs: from, end_unix_secs: to };
}

export function trafficRangeText(start: number, end: number) {
  const format = (value: number) =>
    new Date(value * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Taipei',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  return `${format(start)} — ${format(end)}`;
}
