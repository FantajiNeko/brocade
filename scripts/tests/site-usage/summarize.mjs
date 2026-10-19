import { readFileSync } from 'node:fs';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const noise = row => {
  const reasons = [];
  if ([20, 21, 22, 23].some(cpu => !Number.isFinite(row.core_busy_percent?.[`cpu${cpu}`]))) {
    return ['缺少独立核心占用观测'];
  }
  // These four E cores never belong to any endpoint in the fixed matrix.
  if (median([20, 21, 22, 23].map(cpu => row.core_busy_percent[`cpu${cpu}`])) > 10) {
    reasons.push('未分配 E 核的中位占用超过 10%');
  }
  const siblings = row.profile === 'p1' ? [5] : row.profile === 'p4' ? [1, 3, 5, 7] : [];
  if (siblings.some(cpu => row.core_busy_percent[`cpu${cpu}`] > 15)) {
    reasons.push('Xray 的 SMT 兄弟占用超过 15%');
  }
  return reasons;
};
const pairs = new Map();
if (process.argv.length < 3) throw new Error('usage: node summarize.mjs <JSONL or archived results JSON> ...');
for (const file of process.argv.slice(2)) {
  const content = readFileSync(file, 'utf8').trim();
  const rows = file.endsWith('.json') ? JSON.parse(content).matrix : content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  rows.forEach((item, index) => {
    const row = { ...item, file, line: index + 1 };
    const key = `${file}:${row.profile}:${row.direction}:${row.repeat}`;
    const pair = pairs.get(key) ?? [];
    pair.push(row);
    pairs.set(key, pair);
  });
}
const all = [...pairs.values()];
for (const pair of all) {
  if (pair.length !== 2 || pair[0].enabled === pair[1].enabled) {
    throw new Error(`incomplete or duplicate pair: ${JSON.stringify(pair)}`);
  }
}
const rejected = all.filter(pair => pair.some(row => noise(row).length));
const clean = all.filter(pair => !pair.some(row => noise(row).length));
for (const [label, selected] of [['全部配对', all], ['按独立核心占用筛选后的配对', clean]]) {
  console.log(`\n${label}：${selected.length} 对\n`);
  console.log('| 场景 | 方向 | 配对数 | 关闭 Gbps（中位数／范围） | 开启 Gbps（中位数／范围） | 吞吐变化 | CPU ms/GiB 关→开 | RSS MiB 关→开 |');
  console.log('| --- | --- | ---: | --- | --- | ---: | --- | --- |');
  const groups = new Map();
  for (const pair of selected) {
    const key = `${pair[0].profile}|${pair[0].direction}`;
    groups.set(key, [...(groups.get(key) ?? []), ...pair]);
  }
  for (const [key, rows] of groups) {
    const off = rows.filter(row => !row.enabled);
    const on = rows.filter(row => row.enabled);
    const value = (group, field) => median(group.map(row => row[field]));
    const rate = group => `${value(group, 'gbps').toFixed(2)} / ${Math.min(...group.map(row => row.gbps)).toFixed(2)}–${Math.max(...group.map(row => row.gbps)).toFixed(2)}`;
    const change = (value(on, 'gbps') / value(off, 'gbps') - 1) * 100;
    console.log(`| ${key.replace('|', ' | ')} | ${off.length} | ${rate(off)} | ${rate(on)} | ${change.toFixed(1)}% | ${value(off, 'xray_cpu_ms_per_gib').toFixed(1)}→${value(on, 'xray_cpu_ms_per_gib').toFixed(1)} | ${(value(off, 'xray_rss_peak_kib') / 1024).toFixed(1)}→${(value(on, 'xray_rss_peak_kib') / 1024).toFixed(1)} |`);
  }
}
console.log('\n排除记录（整对排除，不按吞吐高低筛选）：');
for (const pair of rejected) {
  for (const row of pair) {
    const reasons = noise(row);
    if (reasons.length) console.log(`${row.file} [matrix row ${row.line}] ${row.profile}/${row.direction}/${row.repeat} enabled=${row.enabled}: ${reasons.join('；')}`);
  }
}
