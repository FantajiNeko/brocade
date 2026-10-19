export type HeatKind = 'idle' | 'l1' | 'l2' | 'l3' | 'l4';
/** 固定十进档（bit/s）：安静时段的涓流始终是浅色，不随全机队最大值放大成满格。 */
export const HEAT_STEPS: readonly { kind: HeatKind; below: number; label: string }[] = [
  { kind: 'l1', below: 1e6, label: '< 1' },
  { kind: 'l2', below: 1e7, label: '1–10' },
  { kind: 'l3', below: 1e8, label: '10–100' },
  { kind: 'l4', below: Number.POSITIVE_INFINITY, label: '≥ 100 Mbit/s' },
];

export function heatOf(bytesPerSecond: number): HeatKind {
  const bits = bytesPerSecond * 8;
  if (!(bits > 0)) return 'idle';
  return HEAT_STEPS.find(step => bits < step.below)!.kind;
}
