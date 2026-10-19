// Mockup of the machine config tab 「流量统计」 card redesign. Synthetic data only; never imported by the app.
// Serve frontend/ with Vite (configFile: false, plugins: [react()]) and open
//   tests/fixtures/node-traffic-accounting-mockup.html?scene=pump
// Query: scene=<SCENES key>, reading=ledger|compact|all, role=system|readonly|public,
//        edit=none|policy|calibrate|mode, view=page|compare, theme=dark|light, w=<frame width>,
//        nav=0 hides the review bar.
import { createRoot } from 'react-dom/client';
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  NodeAgentStateItem,
  NodeTrafficAccountingMode,
  NodeTrafficCycleKind,
  NodeTrafficItem,
} from '../../src/api';
import { theme } from '../../src/forge/theme';
import { SegmentedControl } from '../../src/ui/bits';
import { Icon, PanelTitle } from '../../src/ui/icons';
import { machineQuotaBytes, machineQuotaTiB } from '../../src/ui/machine-traffic-quota';
import { RegionFlag } from '../../src/ui/region-flag';
import {
  clampNote,
  DAY,
  dayColumns,
  exact,
  GiB,
  gapText,
  hm,
  md,
  MODES,
  modeLabel,
  NOW,
  periodOf,
  periodText,
  readingOf,
  resetText,
  SCENE_OPTIONS,
  SCENES,
  spansOf,
  spanText,
  TiB,
  volume,
  ymd,
  type DayColumn,
  type Reading,
  type Scene,
  type SceneKey,
} from './node-traffic-accounting-mockup-data';
import '../../src/styles.css';
import './node-traffic-accounting-mockup.css';

const params = new URLSearchParams(location.search);
if (theme.snapshot() !== (params.get('theme') === 'light' ? 'light' : 'dark')) theme.toggle();

type Variant = 'ledger' | 'compact';
type Role = 'system' | 'readonly' | 'public';
type Preset = 'none' | 'policy' | 'calibrate' | 'mode';

const VARIANTS: { value: Variant; label: string; note: string }[] = [
  {
    value: 'ledger',
    label: 'A 账本',
    note: '读数为主：已用对额度、剩余、距重置、日均对每天可用；额度条与周期条上下对齐，周期条标出未记账、校准与缺口。管理员的周期条换成逐日柱。',
  },
  {
    value: 'compact',
    label: 'B 一行摘要',
    note: '设置为主：读数压成一行加一根额度条（竖线是时间进度），细节交给流量预测页。',
  },
];

/* ══ 设置表单 ══ */

type Unit = 'GiB' | 'TiB';
interface Form {
  mode: NodeTrafficAccountingMode;
  cycle: NodeTrafficCycleKind;
  resetMonth: string;
  resetDay: string;
  quota: string;
}
interface Calibration {
  value: string;
  unit: Unit;
}

function baseForm(item: NodeTrafficItem): Form {
  return {
    mode: item.accounting_mode,
    cycle: item.cycle_kind,
    resetMonth: String(item.reset_month ?? 1),
    resetDay: String(item.reset_day),
    quota: machineQuotaTiB(item.quota_bytes),
  };
}

/** 与 trafficCalibrationBytes 同一规则：非负、最多 6 位小数。 */
function calibrationBytes(raw: string, unit: Unit): number | null {
  const value = raw.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  return Math.round(Number(value) * (unit === 'TiB' ? TiB : GiB));
}

const quotaLabel = (bytes: string | null) => (bytes === null ? '不限' : `${machineQuotaTiB(bytes)} TiB`);

/* ══ 卡片 ══ */

function TrafficCard({ scene, variant, role, preset }: { scene: Scene; variant: Variant; role: Role; preset: Preset }) {
  const item = scene.item;
  const canEdit = role === 'system';
  const base = baseForm(item);
  const [form, setForm] = useState<Form | null>(() =>
    preset === 'policy'
      ? { ...base, resetDay: '15', quota: base.quota === '2' ? '2.5' : '2' }
      : preset === 'mode'
        ? { ...base, mode: base.mode === 'bidirectional_max' ? 'bidirectional_sum' : 'bidirectional_max' }
        : null,
  );
  const [calibration, setCalibration] = useState<Calibration | null>(() =>
    preset === 'calibrate' ? { value: '1.25', unit: 'TiB' } : null,
  );
  const calibrationInput = useRef<HTMLInputElement>(null);
  const quotaInput = useRef<HTMLInputElement>(null);
  const reading = readingOf(item, NOW);

  const shown = form ?? base;
  const set = (patch: Partial<Form>) => setForm({ ...shown, ...patch });
  const resetDay = Number(shown.resetDay);
  const resetMonth = Number(shown.resetMonth);
  const dayInvalid = !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31;
  const quota = machineQuotaBytes(shown.quota);
  const calibrated =
    calibration && calibration.value.trim() ? calibrationBytes(calibration.value, calibration.unit) : null;
  const calibrationInvalid = calibration !== null && calibration.value.trim() !== '' && calibrated === null;
  const policyChanged =
    shown.mode !== base.mode ||
    shown.cycle !== base.cycle ||
    shown.resetDay !== base.resetDay ||
    (shown.cycle === 'yearly' && shown.resetMonth !== base.resetMonth);
  const dirty =
    policyChanged || shown.quota !== base.quota || (calibration !== null && calibration.value.trim() !== '');
  const invalid = dayInvalid || quota === undefined || calibrationInvalid;

  const openCalibration = () => {
    setCalibration(current => current ?? { value: '', unit: reading.used >= TiB ? 'TiB' : 'GiB' });
    requestAnimationFrame(() => calibrationInput.current?.focus());
  };
  const revert = () => {
    setForm(null);
    setCalibration(null);
  };

  /* 保存后会发生什么。设置不进草稿，保存即生效，所以在按钮旁逐条写明。 */
  const changes: ReactNode[] = [];
  if (!invalid && dirty) {
    const nextMonth = shown.cycle === 'yearly' ? resetMonth : null;
    const [nextStart, nextEnd] = periodOf(shown.cycle, nextMonth, resetDay, NOW);
    const periodMoved = nextStart !== reading.start || nextEnd !== reading.end;
    if (shown.mode !== base.mode) {
      const dropsCalibration = reading.calibratedAt !== null && calibration === null;
      changes.push(
        <>
          计量口径 {modeLabel(base.mode)} → <b>{modeLabel(shown.mode)}</b>：本期总量按新口径重算，原始接收与发送记录不变
          {dropsCalibration &&
            `；${md(reading.calibratedAt!)} 的校准按「${modeLabel(base.mode)}」记录，改口径后不再适用，需要重新校准`}
        </>,
      );
    }
    if (
      shown.cycle !== base.cycle ||
      shown.resetDay !== base.resetDay ||
      (shown.cycle === 'yearly' && shown.resetMonth !== base.resetMonth)
    ) {
      const calibrationLeaves =
        reading.calibratedAt !== null && (reading.calibratedAt < nextStart || reading.calibratedAt >= nextEnd);
      changes.push(
        <>
          重置 {resetText(base.cycle, item.reset_month, item.reset_day)} →{' '}
          <b>{resetText(shown.cycle, nextMonth, resetDay)}</b>
          {periodMoved
            ? `：本期改为 ${periodText(nextStart, nextEnd)}，总量按新范围内的网卡记录重算${calibrationLeaves ? '，原校准落在新范围之外，不再适用' : ''}`
            : '：本期范围不变'}
        </>,
      );
    }
    if (shown.quota !== base.quota) {
      changes.push(
        <>
          额度 {quotaLabel(item.quota_bytes)} → <b>{quota ? `${machineQuotaTiB(quota)} TiB` : '不限'}</b>
        </>,
      );
    }
    if (calibrated !== null) {
      changes.push(
        <>
          本期总量 {exact(reading.used)} → <b>{exact(calibrated)}</b>（校准）
        </>,
      );
    }
  }

  return (
    <div className="panel config-panel node-traffic-accounting nta-card">
      <header>
        <PanelTitle of="usage">流量统计</PanelTitle>
        <span className="sp" />
        <span
          className="nta-source"
          title={
            item.last_reported_at_unix_secs === null
              ? undefined
              : `上报于 ${ymd(item.last_reported_at_unix_secs)} ${hm(item.last_reported_at_unix_secs)} UTC`
          }
        >
          <span className="mono">{item.interface ?? '网卡待上报'}</span>
          {item.last_reported_at_unix_secs !== null && (
            <>
              <span aria-hidden="true">·</span>
              {NOW - item.last_reported_at_unix_secs} 秒前
            </>
          )}
        </span>
      </header>

      {variant === 'ledger' ? (
        <LedgerReading
          scene={scene}
          reading={reading}
          role={role}
          onCalibrate={openCalibration}
          onSetQuota={() => quotaInput.current?.focus()}
        />
      ) : (
        <CompactReading reading={reading} item={item} role={role} onCalibrate={openCalibration} />
      )}

      <div className="fgrid one nta-settings">
        <Row k="计量口径">
          <select
            className="f words nta-select"
            value={shown.mode}
            disabled={!canEdit}
            aria-label="机器流量计量口径"
            onChange={event => set({ mode: event.target.value as NodeTrafficAccountingMode })}
          >
            {MODES.map(mode => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
          <span className="sub">{MODES.find(mode => mode.value === shown.mode)?.note}</span>
        </Row>
        <Row k="重置">
          <span className="nd-ctl-line">
            <SegmentedControl
              value={shown.cycle}
              options={[
                { value: 'monthly' as const, label: '每月' },
                { value: 'yearly' as const, label: '每年' },
              ]}
              disabled={!canEdit}
              ariaLabel="流量重置周期"
              onChange={cycle => set({ cycle })}
            />
            {shown.cycle === 'yearly' && (
              <select
                className="f words nta-month"
                value={shown.resetMonth}
                disabled={!canEdit}
                aria-label="重置月份"
                onChange={event => set({ resetMonth: event.target.value })}
              >
                {Array.from({ length: 12 }, (_, index) => index + 1).map(month => (
                  <option value={month} key={month}>
                    {month} 月
                  </option>
                ))}
              </select>
            )}
            <span className="nta-unit-field">
              <input
                className="f mono nta-day"
                type="number"
                min={1}
                max={31}
                value={shown.resetDay}
                disabled={!canEdit}
                aria-label="重置日"
                aria-invalid={dayInvalid || undefined}
                onChange={event => set({ resetDay: event.target.value })}
              />
              <span>日</span>
            </span>
          </span>
          {dayInvalid ? (
            <span className="sub nta-err">重置日需为 1–31。</span>
          ) : (
            <span className="sub">
              按 UTC 零点切换
              {clampNote(shown.cycle, shown.cycle === 'yearly' ? resetMonth : null, resetDay) &&
                `；${clampNote(shown.cycle, shown.cycle === 'yearly' ? resetMonth : null, resetDay)}`}
              。
            </span>
          )}
        </Row>
        <Row k="流量额度">
          <span className="nta-unit-field">
            <input
              ref={quotaInput}
              className="f mono nta-quota"
              inputMode="decimal"
              placeholder="不限"
              value={shown.quota}
              disabled={!canEdit}
              aria-label="机器流量额度"
              aria-invalid={quota === undefined || undefined}
              onChange={event => set({ quota: event.target.value })}
            />
            <span>TiB</span>
          </span>
          {quota === undefined ? (
            <span className="sub nta-err">需为大于 0 的数字，最多两位小数；留空为不限。</span>
          ) : (
            <span className="sub">服务商给的每期流量。只用于对照和预测，不会据此限速或断网。</span>
          )}
        </Row>
        <Row k="校准">
          {calibration === null ? (
            <>
              <span className="nd-ctl-line">
                <span className={`nta-cal-state${reading.calibratedAt === null ? ' none' : ''}`}>
                  {reading.calibratedAt === null
                    ? '本期未校准'
                    : `${md(reading.calibratedAt)} ${hm(reading.calibratedAt)} 校准`}
                </span>
                {canEdit && reading.measured && !hasCoverageIssue(reading) && (
                  <button type="button" className="btn sm" onClick={openCalibration}>
                    {reading.calibratedAt === null ? '校准本期总量' : '重新校准'}
                  </button>
                )}
              </span>
              {reading.calibratedAt !== null && <span className="sub">之后的总量 = 校准值 + 网卡增量。</span>}
            </>
          ) : (
            <>
              <span className="nd-ctl-line">
                <input
                  ref={calibrationInput}
                  className="f mono nta-quota"
                  inputMode="decimal"
                  placeholder="服务商读数"
                  value={calibration.value}
                  aria-label="本期总量校准值"
                  aria-invalid={calibrationInvalid || undefined}
                  onChange={event => setCalibration({ ...calibration, value: event.target.value })}
                />
                <SegmentedControl
                  value={calibration.unit}
                  options={[
                    { value: 'GiB' as const, label: 'GiB' },
                    { value: 'TiB' as const, label: 'TiB' },
                  ]}
                  ariaLabel="校准单位"
                  onChange={unit => setCalibration({ ...calibration, unit })}
                />
                <button type="button" className="btn sm" onClick={() => setCalibration(null)}>
                  取消
                </button>
              </span>
              {calibrationInvalid ? (
                <span className="sub nta-err">需为非负数字，最多 6 位小数。</span>
              ) : (
                <span className="sub">
                  填服务商面板上的本期用量。保存后本期总量改为该值，之后按网卡增量累计；当前 {exact(reading.used)}
                  {calibrated !== null && (
                    <>
                      {' '}
                      → <b>{exact(calibrated)}</b>（{calibrated >= reading.used ? '+' : '−'}
                      {volume(Math.abs(calibrated - reading.used))}）
                    </>
                  )}
                  。
                </span>
              )}
            </>
          )}
        </Row>
      </div>

      {dirty && (
        <div className="toolbar config-panel-savebar nta-savebar">
          <div className="nta-changes">
            <span className="nta-changes-head">保存后立即生效，不经过草稿与发布</span>
            {changes.length > 0 && (
              <ul>
                {changes.map((change, index) => (
                  <li key={index}>{change}</li>
                ))}
              </ul>
            )}
          </div>
          <span className="sp" />
          <button type="button" className="btn primary" disabled={!canEdit || invalid}>
            保存
          </button>
          <button type="button" className="btn" onClick={revert}>
            还原
          </button>
        </div>
      )}
    </div>
  );
}

/* 机器配置页的一行：标签 + 值。与 nodes.tsx 的 Row 同一结构。 */
function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

/* ══ 方案 A：账本 ══ */

function LedgerReading({
  scene,
  reading,
  role,
  onCalibrate,
  onSetQuota,
}: {
  scene: Scene;
  reading: Reading;
  role: Role;
  onCalibrate: () => void;
  onSetQuota: () => void;
}) {
  const item = scene.item;
  const { measured, used, quota, remaining, rate, allowance } = reading;
  const over = quota !== null && used > quota;
  const fast = !over && rate !== null && allowance !== null && rate > allowance;
  const [figure, unit] = volume(used).split(' ');
  const day = Math.min(Math.max(Math.ceil(reading.elapsedDays), 1), Math.round(reading.totalDays));
  // 逐日账本来自流量预测模型，访客与自助用户读不到；那时周期条只画记录覆盖。
  const daily = role !== 'public';
  const rateTitle =
    reading.rateFrom === null
      ? undefined
      : `本期已用 ÷ ${((NOW - reading.rateFrom) / DAY).toFixed(1)} 天（${md(reading.rateFrom)} ${hm(reading.rateFrom)} 起${reading.calibratedAt !== null ? '，校准补齐了之前' : ''}）`;
  return (
    <section className="nta-read" aria-label="本期用量">
      <div className="nta-hero">
        <span className="nta-label">
          本期已用
          <span className="nta-mode">{modeLabel(item.accounting_mode)}</span>
        </span>
        {measured ? (
          <strong className="nta-value" title={exact(used)}>
            {figure}
            <small>{unit}</small>
            {quota !== null && <span className="nta-of">/ {quotaLabel(item.quota_bytes)}</span>}
          </strong>
        ) : (
          <strong className="nta-value void">—</strong>
        )}
        <span className="nta-hero-sub">
          {measured ? `本期 ${periodText(reading.start, reading.end)} · UTC` : 'Agent 尚未上报网卡累计'}
        </span>
      </div>

      {measured && (
        <dl className="nta-facts">
          {remaining !== null && (
            <div>
              <dt>{over ? '已超出' : '剩余'}</dt>
              <dd className={over ? 'bad' : undefined}>{volume(Math.abs(remaining))}</dd>
            </div>
          )}
          <div>
            <dt>距重置</dt>
            <dd>
              {spanText(reading.left)}
              <small>{md(reading.end)}</small>
            </dd>
          </div>
          <div title={rateTitle}>
            <dt>本期日均</dt>
            <dd className={fast ? 'warn' : undefined}>{rate === null ? '—' : volume(rate)}</dd>
          </div>
          {allowance !== null && (
            <div title={`剩余 ÷ 剩余 ${(reading.left / DAY).toFixed(1)} 天`}>
              <dt>每天可用</dt>
              <dd>{volume(allowance)}</dd>
            </div>
          )}
        </dl>
      )}

      {measured && (
        <div className="nta-bars">
          <div className="nta-bar-row">
            <span className="nta-bar-k">额度</span>
            {quota === null ? (
              <span className="nta-noquota">
                未设额度
                {role === 'system' && (
                  <button type="button" className="nta-link" onClick={onSetQuota}>
                    设置 ›
                  </button>
                )}
              </span>
            ) : (
              <QuotaMeter used={used} quota={quota} />
            )}
            <span className={`nta-bar-v${over ? ' bad' : ''}`}>
              {quota !== null ? `${Math.round((used / quota) * 100)}%` : ''}
            </span>
          </div>
          <div className={`nta-bar-row${daily ? ' daily' : ''}`}>
            <span className="nta-bar-k">周期</span>
            <PeriodStrip reading={reading} days={daily ? scene.days : null} />
            <span className="nta-bar-v">
              {day}/{Math.round(reading.totalDays)} 天
            </span>
          </div>
        </div>
      )}

      {measured && <DirectionRow item={item} reading={reading} role={role} />}

      <CoverageNote reading={reading} role={role} onCalibrate={onCalibrate} />
    </section>
  );
}

/** 额度条：满格 = max(额度, 已用)。额度以内用数据色，超出部分用错误色，竖线标出额度（同流量预测页跑道）。 */
function QuotaMeter({ used, quota, pace }: { used: number; quota: number; pace?: number }) {
  const full = Math.max(quota, used, 1);
  const at = (value: number) => (Math.min(Math.max(value, 0), full) / full) * 100;
  return (
    <span
      className="nta-meter"
      role="img"
      aria-label={`已用 ${exact(used)}，额度 ${volume(quota)}${pace === undefined ? '' : `，时间已过 ${Math.round(pace * 100)}%`}`}
    >
      <span className="cap-bar">
        <i className="u" style={{ left: 0, width: `${at(Math.min(used, quota))}%` }} />
        {used > quota && <i className="u x" style={{ left: `${at(quota)}%`, width: `${at(used) - at(quota)}%` }} />}
      </span>
      {used > quota && <i className="cap-q" style={{ left: `${at(quota)}%` }} />}
      {pace !== undefined && <i className="nta-pace" style={{ left: `${pace * 100}%` }} />}
    </span>
  );
}

/** 周期条：横轴是本期时间。访客看记录覆盖（未记账斜纹、校准、缺口、今天）；管理员读得到逐日账本时画成逐日柱。 */
function PeriodStrip({ reading, days }: { reading: Reading; days: Scene['days'] | null }) {
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { start, end } = reading;
  const span = end - start;
  const x = (secs: number) => (Math.min(Math.max(secs, start), end) - start) / span;
  const nowAt = x(NOW);
  const spans = spansOf(reading, NOW);
  const yearly = reading.totalDays > 62;

  /* 刻度：期初、期末、今天必画；记账起点与校准只在不和它们挤在一起时画。 */
  type Tick = { at: number; text: string; kind: 'start' | 'end' | 'now' | 'mark' };
  const ticks: Tick[] = [
    { at: 0, text: yearly ? ymd(start) : md(start), kind: 'start' },
    { at: 1, text: yearly ? ymd(end) : md(end), kind: 'end' },
    { at: nowAt, text: md(NOW), kind: 'now' },
  ];
  if (reading.lateStart && reading.tracking !== null)
    ticks.push({ at: x(reading.tracking), text: `${md(reading.tracking)} 起记账`, kind: 'mark' });
  if (reading.calibratedAt !== null)
    ticks.push({ at: x(reading.calibratedAt), text: `${md(reading.calibratedAt)} 校准`, kind: 'mark' });
  // 10px 等宽字：ASCII 约 6.2px，汉字约 10.5px。
  const room = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x7f ? 10.5 : 6.2), 0);
  const extent = (tick: Tick): [number, number] => {
    const px = tick.at * width;
    const w = room(tick.text);
    return tick.kind === 'start' ? [px, px + w] : tick.kind === 'end' ? [px - w, px] : [px - w / 2, px + w / 2];
  };
  const placed: Tick[] = [];
  for (const tick of ticks) {
    const [a, b] = extent(tick);
    if (
      width > 0 &&
      placed.some(other => {
        const [c, d] = extent(other);
        return a < d + 8 && c < b + 8;
      })
    )
      continue;
    placed.push(tick);
  }

  const daily = days !== null;
  const columns = days !== null ? bucketed(dayColumns(reading, days, NOW), yearly ? 7 : 1) : [];
  const peak = Math.max(1, ...columns.map(column => column.bytes ?? 0));
  const label = [
    `本期 ${periodText(start, end)}，已过 ${Math.round(nowAt * 100)}%`,
    reading.lateStart && reading.tracking !== null ? `${md(reading.tracking)} 起记账` : null,
    reading.calibratedAt !== null ? `${md(reading.calibratedAt)} 校准` : null,
    reading.gap ? gapText(reading.gap) : null,
  ]
    .filter(Boolean)
    .join('；');

  return (
    <span className={`nta-strip-wrap${daily ? ' daily' : ''}`}>
      <span className="nta-strip" ref={box} role="img" aria-label={label}>
        {daily ? (
          <span className="nta-days" aria-hidden="true">
            {columns.map(column => (
              <i
                key={column.day}
                className={column.kind}
                style={
                  column.bytes === null
                    ? undefined
                    : { height: column.bytes === 0 ? '1px' : `${Math.max(6, (column.bytes / peak) * 100)}%` }
                }
                title={columnTitle(column, yearly)}
              />
            ))}
          </span>
        ) : (
          <span className="nta-track" aria-hidden="true">
            {spans.map(item => (
              <i
                key={`${item.kind}-${item.from}`}
                className={item.kind}
                style={{ left: `${x(item.from) * 100}%`, width: `${(x(item.to) - x(item.from)) * 100}%` }}
              />
            ))}
          </span>
        )}
        {!daily && <i className="nta-now" style={{ left: `${nowAt * 100}%` }} aria-hidden="true" />}
        {reading.gap && (
          <i
            className="nta-gap"
            style={{ left: `${x(reading.gap.at) * 100}%` }}
            title={gapText(reading.gap)}
            aria-hidden="true"
          />
        )}
        {reading.calibratedAt !== null && (
          <i className="nta-cal" style={{ left: `${x(reading.calibratedAt) * 100}%` }} aria-hidden="true" />
        )}
      </span>
      <span className="nta-axis" aria-hidden="true">
        {placed.map(tick => (
          <span key={tick.kind + tick.text} className={tick.kind} style={{ left: `${tick.at * 100}%` }}>
            {tick.text}
          </span>
        ))}
      </span>
    </span>
  );
}

/** 年度周期把逐日柱按 7 天一组合并，否则 365 根柱挤不进卡片。 */
function bucketed(columns: DayColumn[], size: number): DayColumn[] {
  if (size === 1) return columns;
  const out: DayColumn[] = [];
  for (let index = 0; index < columns.length; index += size) {
    const group = columns.slice(index, index + size);
    const kinds = new Set(group.map(column => column.kind));
    const kind: DayColumn['kind'] = kinds.has('today')
      ? 'today'
      : kinds.has('rec')
        ? 'rec'
        : kinds.has('un')
          ? 'un'
          : kinds.has('cal')
            ? 'cal'
            : 'future';
    const bytes =
      kind === 'rec' || kind === 'today' ? group.reduce((sum, column) => sum + (column.bytes ?? 0), 0) : null;
    out.push({ day: group[0].day, kind, bytes });
  }
  return out;
}

function columnTitle(column: DayColumn, weekly: boolean): string {
  const when = weekly ? `${md(column.day)} 起一周` : md(column.day);
  switch (column.kind) {
    case 'rec':
      return `${when} · ${volume(column.bytes ?? 0)}`;
    case 'today':
      return `${when} · ${volume(column.bytes ?? 0)}（进行中）`;
    case 'un':
      return `${when} · 未记账`;
    case 'cal':
      return `${when} · 由校准补齐`;
    case 'future':
      return when;
  }
}

/** 接收 / 发送：网卡原始记录。按口径标出哪一方计入；校准后总量不再等于两者的组合，改写基准。 */
function DirectionRow({ item, reading, role }: { item: NodeTrafficItem; reading: Reading; role: Role }) {
  const { rx, tx } = reading;
  const mode = item.accounting_mode;
  const counts = {
    rx: mode === 'bidirectional_sum' || mode === 'inbound_only' || (mode === 'bidirectional_max' && rx >= tx),
    tx: mode === 'bidirectional_sum' || mode === 'outbound_only' || (mode === 'bidirectional_max' && tx > rx),
  };
  const formula =
    reading.calibratedAt !== null
      ? `${md(Math.max(reading.tracking ?? reading.calibratedAt, reading.start))} 起的网卡记录 · 总量以校准为准`
      : mode === 'bidirectional_sum'
        ? '相加即本期总量'
        : mode === 'bidirectional_max'
          ? `取较大的${counts.rx ? '接收' : '发送'}`
          : mode === 'outbound_only'
            ? '只计发送'
            : '只计接收';
  return (
    <div className="nta-io">
      <span className={`rx${counts.rx ? '' : ' off'}`}>
        <i aria-hidden="true" />
        接收 <b>{exact(rx)}</b>
      </span>
      <span className={`tx${counts.tx ? '' : ' off'}`}>
        <i aria-hidden="true" />
        发送 <b>{exact(tx)}</b>
      </span>
      <span className="nta-formula">{formula}</span>
      {role !== 'public' && (
        <button type="button" className="nta-link nta-forecast">
          流量预测 ›
        </button>
      )}
    </div>
  );
}

const hasCoverageIssue = (reading: Reading) => reading.lateStart || reading.gap !== null;

/** 总量完整性：记账晚于期初、缺口。卡片是校准的入口，所以缺什么、为什么、去哪里补写在一起。
 *  提示在时，校准按钮只放在提示里，下方「校准」一行只写状态，不出现两个同名按钮。 */
function CoverageNote({ reading, role, onCalibrate }: { reading: Reading; role: Role; onCalibrate: () => void }) {
  const parts: string[] = [];
  if (reading.lateStart && reading.tracking !== null) {
    parts.push(
      `${md(reading.tracking)} ${hm(reading.tracking)} 起才开始记账，${md(reading.anchor)} → ${md(reading.tracking)} 的流量没有计入`,
    );
  }
  if (reading.gap) parts.push(gapText(reading.gap));
  if (parts.length === 0) return null;
  return (
    <div className={`callout nta-callout${reading.lateStart ? ' warn' : ''}`}>
      <p>
        {parts.join('；')}。
        {role === 'system' ? '按服务商面板的本期读数校准后，总量以校准值为准。' : '需由系统管理员按服务商读数校准。'}
      </p>
      {role === 'system' && (
        <button type="button" className="btn sm" onClick={onCalibrate}>
          校准本期总量
        </button>
      )}
    </div>
  );
}

/* ══ 方案 B：一行摘要 ══ */

function CompactReading({
  reading,
  item,
  role,
  onCalibrate,
}: {
  reading: Reading;
  item: NodeTrafficItem;
  role: Role;
  onCalibrate: () => void;
}) {
  const { measured, used, quota } = reading;
  const over = quota !== null && used > quota;
  const pace = reading.elapsedDays / reading.totalDays;
  return (
    <section className="nta-compact" aria-label="本期用量">
      <div className="nta-compact-line">
        <span className="nta-compact-used">
          <span className="nta-label">本期</span>
          <b>{measured ? exact(used) : '—'}</b>
          {quota !== null && <span className="nta-of">/ {quotaLabel(item.quota_bytes)}</span>}
          {quota !== null && measured && (
            <span className={`nta-compact-pct${over ? ' bad' : ''}`}>{Math.round((used / quota) * 100)}%</span>
          )}
        </span>
        <span className="sp" />
        <span className="nta-compact-reset">
          {spanText(reading.left)}后重置 · {md(reading.end)}
        </span>
      </div>
      {quota !== null && <QuotaMeter used={measured ? used : 0} quota={quota} pace={pace} />}
      {measured ? (
        <DirectionRow item={item} reading={reading} role={role} />
      ) : (
        <p className="nta-hero-sub">Agent 尚未上报网卡累计</p>
      )}
      <CoverageNote reading={reading} role={role} onCalibrate={onCalibrate} />
    </section>
  );
}

/* ══ 对照：生产里现在的卡片，同一份数据 ══ */

const LegacyCard = lazy(async () => {
  const module = await import('../../src/panes/nodes');
  return { default: module.TrafficAccountingCard };
});

function Legacy({ scene, role }: { scene: Scene; role: Role }) {
  const client = useMemo(() => {
    const created = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false },
      },
    });
    created.setQueryData(['node-traffic'], { nodes: [scene.item] });
    return created;
  }, [scene]);
  return (
    <QueryClientProvider client={client}>
      <Suspense fallback={<div className="panel config-panel">读取现状组件…</div>}>
        <LegacyCard
          node={{ node_id: scene.item.node_id, name: scene.item.name } as NodeAgentStateItem}
          canEdit={role === 'system'}
        />
      </Suspense>
    </QueryClientProvider>
  );
}

/* ══ 页面外壳：机器详情 → 配置页签 ══ */

function NodePage({ children }: { children: ReactNode }) {
  const tabs = [
    { key: 'observed', label: '观测', icon: 'observe', badge: <span className="nd-tab-badge gold">1</span> },
    { key: 'config', label: '配置', icon: 'config' },
    { key: 'chains', label: '规则', icon: 'chains', badge: <span className="nd-tab-badge dim">5</span> },
  ] as const;
  return (
    <div className="nd-sheet nd-page nd-node-detail">
      <div className="fg-sheet nd-paper">
        <header className="nd-page-head">
          <div className="nd-page-identity">
            <span className="nd-idplate">
              <span className="nd-idplate-clip">
                <RegionFlag code="HK" square />
              </span>
              <i className="node-lamp" aria-label="在线" />
            </span>
            <div className="nd-ident-text">
              <div className="nd-ident-row">
                <h1 className="nd-id">香港 PUMP</h1>
              </div>
              <span className="nd-ident-meta">38.76.***.***</span>
            </div>
          </div>
          <div className="nd-tabs" role="tablist" aria-label="机器详情页签">
            <div className="nd-tabs-seg">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={tab.key === 'config'}
                  tabIndex={tab.key === 'config' ? 0 : -1}
                >
                  <Icon of={tab.icon} size={14} className="nd-tab-ic" />
                  {tab.label}
                  {'badge' in tab && tab.badge}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="nd-paper-body">{children}</div>
      </div>
    </div>
  );
}

/** 身份与 DNS 卡只为让改版卡落在真实的版面里，内容是静态的。 */
function IdentityStub({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="panel config-panel">
      <header>
        <PanelTitle of="identity">身份</PanelTitle>
      </header>
      <div className="fgrid one">
        <Row k="名称">
          <input className="f" style={{ width: 220 }} defaultValue="香港 PUMP" disabled={!canEdit} />
        </Row>
        <Row k="公网 IPv4">
          <input className="f" style={{ width: 220 }} defaultValue="38.76.***.***" disabled={!canEdit} />
          <span className="egress ok">出口一致</span>
        </Row>
      </div>
    </div>
  );
}

function DnsStub({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="panel config-panel">
      <header>
        <PanelTitle of="dns">DNS</PanelTitle>
      </header>
      <div className="fgrid one">
        <Row k="服务器">
          <input className="f" style={{ width: 200 }} defaultValue="system" disabled={!canEdit} />
          <span className="sub">留空或填 system = 跟随系统解析。</span>
        </Row>
        <Row k="域名解析">
          <select className="f" style={{ width: 200 }} defaultValue="UseIPv6v4" disabled={!canEdit}>
            <option>UseIPv6v4</option>
          </select>
        </Row>
      </div>
    </div>
  );
}

/* ══ 审阅外壳 ══ */

const WIDTHS = [
  { value: 1280, label: '1280' },
  { value: 760, label: '760' },
  { value: 390, label: '390' },
];
const ROLES: { value: Role; label: string }[] = [
  { value: 'system', label: '系统管理员' },
  { value: 'readonly', label: '只读管理员' },
  { value: 'public', label: '访客' },
];
const PRESETS: { value: Preset; label: string }[] = [
  { value: 'none', label: '未编辑' },
  { value: 'policy', label: '改重置日与额度' },
  { value: 'calibrate', label: '校准' },
  { value: 'mode', label: '改口径' },
];
const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

function App() {
  const [sceneKey, setSceneKey] = useState<SceneKey>(
    pick(params.get('scene'), Object.keys(SCENES) as SceneKey[], 'pump'),
  );
  const [reading, setReading] = useState<Variant | 'all'>(
    pick(params.get('reading'), ['ledger', 'compact', 'all'] as const, 'ledger'),
  );
  const [role, setRole] = useState<Role>(pick(params.get('role'), ['system', 'readonly', 'public'] as const, 'system'));
  const [preset, setPreset] = useState<Preset>(
    pick(params.get('edit'), ['none', 'policy', 'calibrate', 'mode'] as const, 'none'),
  );
  const [view, setView] = useState<'page' | 'compare'>(pick(params.get('view'), ['page', 'compare'] as const, 'page'));
  const [width, setWidth] = useState(Number(params.get('w')) || 1280);
  const [mode, setMode] = useState(theme.snapshot());
  const nav = params.get('nav') !== '0';
  useLayoutEffect(() => {
    const next = new URLSearchParams(location.search);
    next.set('scene', sceneKey);
    next.set('reading', reading);
    next.set('role', role);
    next.set('edit', preset);
    next.set('view', view);
    next.set('w', String(width));
    next.set('theme', mode);
    history.replaceState(null, '', `?${next}`);
  }, [sceneKey, reading, role, preset, view, width, mode]);
  const scene = SCENES[sceneKey];
  const variants = reading === 'all' ? VARIANTS : VARIANTS.filter(item => item.value === reading);
  const canEdit = role === 'system';
  const cards = variants.map(variant => (
    <Fragment key={variant.value}>
      {nav && reading === 'all' && (
        <p className="mk-option-note">
          <b>方案 {variant.label}</b>
          {variant.note}
        </p>
      )}
      <TrafficCard
        key={`${sceneKey}-${variant.value}-${role}-${preset}`}
        scene={scene}
        variant={variant.value}
        role={role}
        preset={preset}
      />
    </Fragment>
  ));
  return (
    <>
      {nav && (
        <div className="mk-bar">
          <div className="mk-bar-row">
            <span className="mk-title">
              机器配置 · 流量统计<small>MOCKUP · 现在 = 10-19 18:15 (UTC+8)</small>
            </span>
            <div className="mk-controls">
              <label className="mk-ctl">
                <span className="mk-ctl-label">场景</span>
                <select value={sceneKey} onChange={event => setSceneKey(event.target.value as SceneKey)}>
                  {SCENE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="mk-ctl">
                <span className="mk-ctl-label">读数</span>
                <SegmentedControl
                  ariaLabel="读数方案"
                  value={reading}
                  options={[
                    { value: 'ledger' as const, label: 'A 账本' },
                    { value: 'compact' as const, label: 'B 摘要' },
                    { value: 'all' as const, label: '并排' },
                  ]}
                  onChange={setReading}
                />
              </span>
              <label className="mk-ctl">
                <span className="mk-ctl-label">身份</span>
                <select value={role} onChange={event => setRole(event.target.value as Role)}>
                  {ROLES.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mk-ctl">
                <span className="mk-ctl-label">编辑</span>
                <select value={preset} onChange={event => setPreset(event.target.value as Preset)}>
                  {PRESETS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="mk-ctl">
                <span className="mk-ctl-label">视图</span>
                <SegmentedControl
                  ariaLabel="视图"
                  value={view}
                  options={[
                    { value: 'page' as const, label: '页面' },
                    { value: 'compare' as const, label: '对照现状' },
                  ]}
                  onChange={setView}
                />
              </span>
              <span className="mk-ctl">
                <span className="mk-ctl-label">宽度</span>
                <SegmentedControl ariaLabel="画框宽度" value={width} options={WIDTHS} onChange={setWidth} />
              </span>
              <span className="mk-ctl">
                <span className="mk-ctl-label">主题</span>
                <SegmentedControl
                  ariaLabel="主题"
                  value={mode}
                  options={[
                    { value: 'dark', label: '暗' },
                    { value: 'light', label: '亮' },
                  ]}
                  onChange={next => {
                    if (theme.snapshot() !== next) theme.toggle();
                    setMode(next);
                  }}
                />
              </span>
            </div>
          </div>
          <p className="mk-scene-note">{scene.note}</p>
        </div>
      )}
      <div className="mk-stage">
        <div className="mk-frame" style={{ width: `min(100%, ${width}px)` }}>
          <NodePage>
            {view === 'compare' ? (
              <section className="nd-tab-config nd-tab-panel mk-compare" role="tabpanel" aria-label="配置">
                <div>
                  {nav && (
                    <p className="mk-option-note">
                      <b>生产组件</b>TrafficAccountingCard（已按方案 B 落地），同一份数据
                    </p>
                  )}
                  <Legacy scene={scene} role={role} />
                </div>
                <div>
                  {nav && reading !== 'all' && (
                    <p className="mk-option-note">
                      <b>改版 · 方案 {variants[0].label}</b>
                      {variants[0].note}
                    </p>
                  )}
                  {cards}
                </div>
              </section>
            ) : (
              <section className="nd-tab-config nd-tab-panel" role="tabpanel" aria-label="配置">
                <div>
                  <IdentityStub canEdit={canEdit} />
                  {cards}
                </div>
                <div>
                  <DnsStub canEdit={canEdit} />
                </div>
              </section>
            )}
          </NodePage>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
