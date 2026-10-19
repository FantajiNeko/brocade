// 流入统计的四个方案 for the machine traffic tab mockup. Synthetic data only; never imported by the app.
import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SiteUsageChartSeries, SiteUsageColor } from '../../src/site-usage-chart';
import { bytes, shareOf } from '../../src/ui/format';
import { Icon, PanelTitle } from '../../src/ui/icons';
import { RegionFlag } from '../../src/ui/region-flag';
import { GeneratedUserAvatar } from '../../src/ui/user-avatar';
import {
  DAY,
  FWD,
  hm,
  inflowOf,
  lastTraffic,
  lastTrafficText,
  md,
  NOW,
  periodDates,
  periodLabel,
  seriesOf,
  slotLabel,
  type Agg,
  type Built,
  type ChainView,
  type Inflow,
  type InflowRow,
} from './node-traffic-mockup-data';
import { amount, ChainName, Swatch, useTip, useWidth } from './node-traffic-mockup-ui';

const SiteUsageChart = lazy(() => import('../../src/site-usage-chart'));

export type InflowOption = 'bars' | 'flow' | 'chains' | 'time';
export const INFLOW_OPTIONS: { value: InflowOption; label: string; note: string }[] = [
  {
    value: 'bars',
    label: 'A 排行条形',
    note: '用户按流量排行，每人一根条，条内按接入链分段；点图例里的链，各行的该段对齐到左端便于比较；点一行展开分链读数。',
  },
  {
    value: 'flow',
    label: 'B 流向图',
    note: '左侧用户、右侧接入链，带宽度 = 流量；一眼看出谁从哪条链进来、各链由谁撑起。悬停用户或链只亮它的流向。',
  },
  {
    value: 'chains',
    label: 'C 按接入链',
    note: '每条接入链一张卡：总量与占比、本范围的走势、主要用户；适合按链（出口）排查负载与异常。',
  },
  {
    value: 'time',
    label: 'D 时间堆叠',
    note: '与下方「流出统计」同一结构：左图按接入链堆叠的时间分布，右侧链的排行；下面是用户表，点用户把图切到这个人。',
  },
];

type ShowTip = (element: Element, body: ReactNode, above?: boolean) => void;
const FOLD = 12;

function colorOf(view: ChainView): SiteUsageColor {
  if (view.token) return { token: view.token };
  if (view.kind === 'fwd') return { token: '--ink', alpha: 0.4 };
  if (view.kind === 'unsplit') return { token: '--ink', alpha: 0.2 };
  return { token: '--observe-10', alpha: 0.75 };
}

function cellTip(agg: Agg, inflow: Inflow, row: InflowRow | null, view: ChainView | null) {
  const cell = row && view ? row.cells.get(view.id)! : null;
  const total = cell ? cell.total : row ? row.total : view ? inflow.columnTotal(view.id) : inflow.grand;
  const down = cell ? cell.down : row ? row.down : null;
  const up = cell ? cell.up : row ? row.up : null;
  return (
    <>
      <div className="uxm-tip-head">
        {periodLabel(agg.bounds.period)} · {periodDates(agg.bounds)}
      </div>
      <div className="uxm-tip-name">{[row?.id, view?.name].filter(Boolean).join(' · ')}</div>
      <div className="uxm-tip-value">{bytes(total)}</div>
      {down !== null && up !== null && (
        <>
          <div className="uxm-tip-row">
            下行 <b>{bytes(down)}</b>
          </div>
          <div className="uxm-tip-row">
            上行 <b>{bytes(up)}</b>
          </div>
        </>
      )}
      {row && view && (
        <>
          <div className="uxm-tip-row dim">
            占 {row.id} <b>{shareOf(total, row.total)}</b>
          </div>
          <div className="uxm-tip-row dim">
            占{view.kind === 'chain' ? '该链' : view.name} <b>{shareOf(total, inflow.columnTotal(view.id))}</b>
          </div>
        </>
      )}
      {(row === null) !== (view === null) && (
        <div className="uxm-tip-row dim">
          占本机 <b>{shareOf(total, inflow.grand)}</b>
        </div>
      )}
      {cell?.gap && <p className="uxm-tip-warn">采集有缺口，仅含已记录的流量</p>}
      {view?.kind === 'unsplit' && <p className="uxm-tip-dim">按接入链统计上线前只保留了用户合计</p>}
    </>
  );
}

function Who({ row }: { row: InflowRow }) {
  return (
    <span className="nti-who">
      <GeneratedUserAvatar id={row.id} variant="mini" />
      <span className="nti-name">{row.id}</span>
      <span className="nti-tenant">{row.tenant}</span>
    </span>
  );
}

/* ── A · 排行条形 ── */
function BarsBody({ agg, inflow, views, show, hide }: BodyProps) {
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const visible = views.filter(view => inflow.columnTotal(view.id) > 0);
  const max = inflow.rows[0]?.total || 1;
  const rows = expanded || inflow.rows.length <= FOLD + 2 ? inflow.rows : inflow.rows.slice(0, FOLD);
  /* 聚焦一条链时，把它的段挪到每根条的最左端，各行从同一基线开始，才能直接比较长短。 */
  const ordered = focus
    ? [...visible.filter(view => view.id === focus), ...visible.filter(view => view.id !== focus)]
    : visible;
  return (
    <>
      <div className="nti-legend" role="group" aria-label="接入链（点击聚焦）">
        {visible.map(view => {
          const total = inflow.columnTotal(view.id);
          return (
            <button
              key={view.id}
              type="button"
              className={`nti-key${focus === view.id ? ' on' : ''}${focus && focus !== view.id ? ' dim' : ''}`}
              aria-pressed={focus === view.id}
              title={`${view.name} · ${view.via}`}
              onClick={() => setFocus(current => (current === view.id ? null : view.id))}
            >
              <Swatch view={view} />
              <ChainName view={view} />
              <b>{amount(total)}</b>
              <span className="nti-share">{shareOf(total, inflow.grand)}</span>
            </button>
          );
        })}
      </div>
      <ol className="nti-bars">
        {rows.map(row => {
          const parts = ordered
            .map(view => ({ view, cell: row.cells.get(view.id)! }))
            .filter(part => part.cell.total > 0);
          const focused = focus ? row.cells.get(focus) : null;
          const isOpen = open === row.id;
          return (
            <li key={row.id} className={`nti-bar-row${isOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="nti-bar-btn"
                aria-expanded={isOpen}
                onClick={() => setOpen(current => (current === row.id ? null : row.id))}
              >
                <Who row={row} />
                <span className="nti-track">
                  <span className="nti-bar" style={{ width: `${Math.max(0.6, (row.total / max) * 100)}%` }}>
                    {parts.map(({ view, cell }) => (
                      <i
                        key={view.id}
                        className={focus && focus !== view.id ? 'dim' : undefined}
                        style={{ flexGrow: cell.total, background: view.color }}
                        onMouseEnter={event => show(event.currentTarget, cellTip(agg, inflow, row, view))}
                        onMouseLeave={hide}
                      />
                    ))}
                  </span>
                  {focused && (
                    <span className={`nti-bar-note${focused.total > 0 ? '' : ' none'}`}>
                      {focused.total > 0 ? amount(focused.total) : focused.granted ? '0' : '未授权'}
                    </span>
                  )}
                </span>
                <span className="nti-num">{amount(row.total)}</span>
                <span className="nti-pct">{shareOf(row.total, inflow.grand)}</span>
              </button>
              {isOpen && (
                <div className="nti-detail">
                  {visible
                    .map(view => ({ view, cell: row.cells.get(view.id)! }))
                    .filter(({ cell }) => cell.granted || cell.total > 0)
                    .sort((a, b) => b.cell.total - a.cell.total)
                    .map(({ view, cell }) => (
                      <span key={view.id} className={`nti-dchip${cell.total === 0 ? ' zero' : ''}`}>
                        <Swatch view={view} />
                        <ChainName view={view} />
                        <b>{cell.total > 0 ? amount(cell.total) : '0'}</b>
                        {cell.total > 0 && <span className="nti-share">{shareOf(cell.total, row.total)}</span>}
                        {cell.gap && <span className="nti-gap" title="采集有缺口，仅含已记录的流量" />}
                      </span>
                    ))}
                  <span className="nti-detail-note">
                    下行 {bytes(row.down)} · 上行 {bytes(row.up)}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {inflow.rows.length > FOLD + 2 && (
        <button type="button" className="btn sm nti-more" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
          {expanded ? '收起' : `展开其余 ${inflow.rows.length - FOLD} 位用户`}
        </button>
      )}
    </>
  );
}

/* ── B · 流向图 ── */
function FlowBody({ agg, inflow, views, show, hide }: BodyProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [hot, setHot] = useState<{ user: string | null; col: string | null } | null>(null);
  const right = views.filter(view => inflow.columnTotal(view.id) > 0);
  const LEFT_MAX = 10;
  const top = inflow.rows.slice(0, LEFT_MAX);
  const rest = inflow.rows.slice(LEFT_MAX);
  const restRow: InflowRow | null =
    rest.length > 0
      ? {
          id: `其余 ${rest.length} 位`,
          tenant: '',
          down: rest.reduce((sum, row) => sum + row.down, 0),
          up: rest.reduce((sum, row) => sum + row.up, 0),
          total: rest.reduce((sum, row) => sum + row.total, 0),
          cells: new Map(
            right.map(view => {
              const cells = rest.map(row => row.cells.get(view.id)!);
              return [
                view.id,
                {
                  down: cells.reduce((sum, cell) => sum + cell.down, 0),
                  up: cells.reduce((sum, cell) => sum + cell.up, 0),
                  total: cells.reduce((sum, cell) => sum + cell.total, 0),
                  gap: cells.some(cell => cell.gap),
                  granted: true,
                },
              ];
            }),
          ),
        }
      : null;
  const left = restRow ? [...top, restRow] : top;
  const LABEL_L = 186;
  const LABEL_R = 250;
  const NODE = 10;
  /* 带宽与流量成正比；小节点另外保留一格标签高度，标签不会叠在一起。 */
  const SLOT = 24;
  const GAP = 6;
  const plot = Math.max(120, width - LABEL_L - LABEL_R);
  const k = (Math.max(200, Math.max(left.length, right.length) * 28) * 0.72) / inflow.grand;
  const place = (values: number[]) => {
    const slots = values.map(value => Math.max(value * k, SLOT));
    return { slots, sum: slots.reduce((sum, slot) => sum + slot, 0) + GAP * (values.length - 1) };
  };
  const leftSlots = place(left.map(row => row.total));
  const rightSlots = place(right.map(view => inflow.columnTotal(view.id)));
  const height = Math.max(leftSlots.sum, rightSlots.sum);
  const stack = (values: number[], layout: { slots: number[]; sum: number }) => {
    let cursor = (height - layout.sum) / 2;
    return values.map((value, index) => {
      const h = value * k;
      const position = { y: cursor + (layout.slots[index] - h) / 2, h };
      cursor += layout.slots[index] + GAP;
      return position;
    });
  };
  const leftPos = stack(
    left.map(row => row.total),
    leftSlots,
  );
  const rightPos = stack(
    right.map(view => inflow.columnTotal(view.id)),
    rightSlots,
  );
  const sourceUsed = left.map(() => 0);
  const targetUsed = right.map(() => 0);
  const x0 = NODE;
  const x1 = plot - NODE;
  const xm = (x0 + x1) / 2;
  const links = left.flatMap((row, i) =>
    right.flatMap((view, j) => {
      const value = row.cells.get(view.id)?.total ?? 0;
      if (value <= 0) return [];
      const h = value * k;
      const y0 = leftPos[i].y + sourceUsed[i];
      const y1 = rightPos[j].y + targetUsed[j];
      sourceUsed[i] += h;
      targetUsed[j] += h;
      const d = `M${x0} ${y0}C${xm} ${y0} ${xm} ${y1} ${x1} ${y1}L${x1} ${y1 + h}C${xm} ${y1 + h} ${xm} ${y0 + h} ${x0} ${y0 + h}Z`;
      return [{ row, view, d }];
    }),
  );
  const state = (user: string | null, col: string | null) => {
    if (!hot) return '';
    const match = (hot.user === null || hot.user === user) && (hot.col === null || hot.col === col);
    return match ? ' on' : ' dim';
  };
  return (
    <div ref={box} className="ntf-box" style={{ height }} onMouseLeave={() => setHot(null)}>
      <div className="ntf-labels left" style={{ width: LABEL_L }}>
        {left.map((row, index) => (
          <span
            key={row.id}
            className={`ntf-label left${state(row.tenant ? row.id : null, null)}`}
            style={{ top: leftPos[index].y + leftPos[index].h / 2 }}
            onMouseEnter={() => row.tenant && setHot({ user: row.id, col: null })}
          >
            {row.tenant ? <GeneratedUserAvatar id={row.id} variant="mini" /> : <span className="ntf-rest" />}
            <span className="ntf-name">{row.id}</span>
            <b>{amount(row.total)}</b>
          </span>
        ))}
      </div>
      <svg className="ntf-svg" width={plot} height={height} style={{ left: LABEL_L }} aria-label="用户到接入链的流向">
        {links.map(({ row, view, d }) => (
          <path
            key={`${row.id}/${view.id}`}
            className={`ntf-link${state(row.tenant ? row.id : null, view.id)}`}
            d={d}
            style={{ fill: view.color }}
            onMouseEnter={event => {
              setHot({ user: row.tenant ? row.id : null, col: view.id });
              show(event.currentTarget, cellTip(agg, inflow, row, view));
            }}
            onMouseLeave={hide}
          />
        ))}
        {left.map((row, index) => (
          <rect
            key={row.id}
            className={`ntf-node${state(row.tenant ? row.id : null, null)}`}
            x={0}
            y={leftPos[index].y}
            width={NODE}
            height={Math.max(2, leftPos[index].h)}
            rx={2}
          />
        ))}
        {right.map((view, index) => (
          <rect
            key={view.id}
            className={`ntf-node right${state(null, view.id)}`}
            x={plot - NODE}
            y={rightPos[index].y}
            width={NODE}
            height={Math.max(2, rightPos[index].h)}
            rx={2}
            style={{ fill: view.color }}
          />
        ))}
      </svg>
      <div className="ntf-labels right" style={{ width: LABEL_R }}>
        {right.map((view, index) => {
          const total = inflow.columnTotal(view.id);
          return (
            <span
              key={view.id}
              className={`ntf-label right${state(null, view.id)}`}
              style={{ top: rightPos[index].y + rightPos[index].h / 2 }}
              title={view.via}
              onMouseEnter={() => setHot({ user: null, col: view.id })}
            >
              <ChainName view={view} />
              <b>{amount(total)}</b>
              <span className="nti-share">{shareOf(total, inflow.grand)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── C · 按接入链 ── */
function MiniBars({
  agg,
  values,
  color,
  name,
  show,
  hide,
}: {
  agg: Agg;
  values: number[];
  color: string;
  name: string;
  show: ShowTip;
  hide: () => void;
}) {
  const peak = Math.max(0, ...values);
  const count = values.length;
  const gap = count > 60 ? 0 : 0.22;
  const nowAt = (NOW - agg.bounds.start) / agg.bounds.bucket;
  const edge = (time: number) =>
    agg.bounds.period === 'day' ? hm(time) : agg.bounds.period === 'week' ? md(time) : md(time);
  return (
    <div className="ntc-plot">
      <svg className="ntc-bars" viewBox={`0 0 ${count} 40`} preserveAspectRatio="none" aria-hidden="true">
        {agg.buckets.map((bucket, index) =>
          bucket.observed === 'none' && !bucket.future ? (
            <rect key={`g${index}`} className="ntc-gap" x={index} y={0} width={1} height={40} />
          ) : null,
        )}
        {values.map((value, index) =>
          value > 0 ? (
            <rect
              key={index}
              x={index + gap / 2}
              y={40 - Math.max(1.2, (value / (peak || 1)) * 38)}
              width={1 - gap}
              height={Math.max(1.2, (value / (peak || 1)) * 38)}
              style={{ fill: color }}
            />
          ) : null,
        )}
        {nowAt < count && <line className="ntc-now" x1={nowAt} x2={nowAt} y1={0} y2={40} />}
        {agg.buckets.map((bucket, index) => (
          <rect
            key={`h${index}`}
            className="ntc-hit"
            x={index}
            y={0}
            width={1}
            height={40}
            onMouseEnter={event =>
              show(
                event.currentTarget,
                <>
                  <div className="uxm-tip-head">{slotLabel(agg.bounds, bucket.at)} · UTC+8</div>
                  <div className="uxm-tip-name">{name}</div>
                  {bucket.future ? (
                    <p>尚未到来</p>
                  ) : bucket.observed === 'none' ? (
                    <p className="uxm-tip-warn">本机没有上报，不能视为零流量</p>
                  ) : (
                    <div className="uxm-tip-value">{bytes(values[index])}</div>
                  )}
                </>,
              )
            }
            onMouseLeave={hide}
          />
        ))}
      </svg>
      <span className="ntc-axis" aria-hidden="true">
        <span>{edge(agg.bounds.start)}</span>
        <span>{agg.bounds.period === 'day' ? '24:00' : md(agg.bounds.end - DAY)}</span>
      </span>
    </div>
  );
}

const CARD_FOLD = 6;
function ChainCardsBody({ agg, inflow, views, show, hide, idleRows }: BodyProps & { idleRows: InflowRow[] }) {
  const [expanded, setExpanded] = useState(false);
  /* 卡片按本范围流量排；颜色仍按本月固定，换范围只换顺序不换色。 */
  const cards = views
    .filter(
      view =>
        inflow.columnTotal(view.id) > 0 ||
        (view.kind === 'chain' && [...inflow.rows, ...idleRows].some(row => row.cells.get(view.id)?.granted)),
    )
    .sort((a, b) => inflow.columnTotal(b.id) - inflow.columnTotal(a.id));
  const shown = expanded || cards.length <= CARD_FOLD + 1 ? cards : cards.slice(0, CARD_FOLD);
  return (
    <>
      <div className="ntc-grid">
        {shown.map(view => {
          const total = inflow.columnTotal(view.id);
          const users = inflow.rows
            .map(row => ({ row, cell: row.cells.get(view.id)! }))
            .filter(item => item.cell.total > 0)
            .sort((a, b) => b.cell.total - a.cell.total);
          const granted = [...inflow.rows, ...idleRows].filter(row => row.cells.get(view.id)?.granted).length;
          const restBytes = users.slice(4).reduce((sum, item) => sum + item.cell.total, 0);
          return (
            <article key={view.id} className={`ntc-card${total === 0 ? ' empty' : ''}`}>
              <header className="ntc-head">
                <Swatch view={view} />
                <span className="ntc-title">
                  <ChainName view={view} />
                  <small>{view.via}</small>
                </span>
                <span className="ntc-total">
                  <span className="ntc-total-v">{total > 0 ? amount(total) : '0'}</span>
                  <span className="ntc-total-s">{total > 0 ? shareOf(total, inflow.grand) : '没有流量'}</span>
                </span>
              </header>
              {total > 0 ? (
                <MiniBars
                  agg={agg}
                  values={seriesOf(agg, null, view.id)}
                  color={view.color}
                  name={view.name}
                  show={show}
                  hide={hide}
                />
              ) : (
                <p className="ntc-none">{periodLabel(agg.bounds.period)}没有流量</p>
              )}
              {users.length > 0 && (
                <ol className="ntc-users">
                  {users.slice(0, 4).map(({ row, cell }) => (
                    <li
                      key={row.id}
                      onMouseEnter={event => show(event.currentTarget, cellTip(agg, inflow, row, view))}
                      onMouseLeave={hide}
                    >
                      <GeneratedUserAvatar id={row.id} variant="mini" />
                      <span className="nti-name">{row.id}</span>
                      <span className="ntc-bar" aria-hidden="true">
                        <i style={{ width: `${(cell.total / users[0].cell.total) * 100}%`, background: view.color }} />
                      </span>
                      <span className="nti-num">{amount(cell.total)}</span>
                      <span className="nti-pct">{shareOf(cell.total, total)}</span>
                    </li>
                  ))}
                </ol>
              )}
              <footer className="ntc-foot">
                {users.length > 4 && (
                  <span>
                    其余 {users.length - 4} 位 · {bytes(restBytes)}
                  </span>
                )}
                {view.kind === 'chain' && (
                  <span>
                    {users.length} / {granted} 位已授权用户有流量
                  </span>
                )}
                {view.kind === 'fwd' && <span>{users.length} 位用户的转发规则</span>}
              </footer>
            </article>
          );
        })}
      </div>
      {cards.length > CARD_FOLD + 1 && (
        <button type="button" className="btn sm nti-more" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
          {expanded
            ? '收起'
            : `显示其余 ${cards.length - CARD_FOLD} 张：${cards
                .slice(CARD_FOLD)
                .map(view => view.name)
                .join('、')}`}
        </button>
      )}
    </>
  );
}

/* ── D · 时间堆叠 ── */
function TimeBody({ agg, inflow, views }: BodyProps) {
  const [focus, setFocus] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const visible = views.filter(view => inflow.columnTotal(view.id) > 0);
  const selected = inflow.rows.find(row => row.id === user) ?? null;
  const series: SiteUsageChartSeries[] = visible.map(view => ({
    key: view.id,
    name: view.name,
    color: colorOf(view),
    values: seriesOf(agg, user, view.id).map((value, index) => (agg.buckets[index].future ? null : value)),
  }));
  const rows = expanded || inflow.rows.length <= FOLD + 2 ? inflow.rows : inflow.rows.slice(0, FOLD);
  const valueOf = (view: ChainView) => (selected ? selected.cells.get(view.id)!.total : inflow.columnTotal(view.id));
  const whole = selected ? selected.total : inflow.grand;
  return (
    <>
      <div className="site-usage-main ntd-main">
        <section className="site-usage-plot ntd-plot" aria-label="流入随时间分布">
          {selected && (
            <div className="ntd-filter">
              <span className="nt-scope on">
                只看 {selected.id}
                <button type="button" className="nt-scope-x" aria-label="回到全部用户" onClick={() => setUser(null)}>
                  <Icon of="close" size={10} />
                </button>
              </span>
              <span className="ntd-filter-note">
                {bytes(selected.total)} · 占本机 {shareOf(selected.total, inflow.grand)}
              </span>
            </div>
          )}
          <Suspense fallback={<div className="site-usage-chart" />}>
            <SiteUsageChart
              period={agg.bounds.period}
              startUnixSecs={agg.bounds.start}
              bucketSecs={agg.bounds.bucket}
              nowUnixSecs={NOW}
              observedSinceUnixSecs={null}
              series={series}
              focusKey={focus}
            />
          </Suspense>
          <p className="site-usage-note">
            {agg.bounds.period === 'month' ? '每天' : '每小时'}一柱 · 按接入链堆叠，颜色按本月流量固定 ·
            点下方用户只看此人
          </p>
        </section>
        <section className="site-usage-side" aria-label="各接入链流量">
          <ol className="site-usage-key">
            {visible.map(view => {
              const value = valueOf(view);
              return (
                <li
                  key={view.id}
                  className={`site-usage-item${view.kind === 'chain' ? '' : ' muted'}`}
                  onMouseEnter={() => setFocus(view.id)}
                  onMouseLeave={() => setFocus(null)}
                >
                  <span className="site-usage-row ntd-row" title={view.via}>
                    <i className="site-usage-swatch" style={{ background: view.color }} aria-hidden="true" />
                    <span className="ntd-flag">{view.country && <RegionFlag code={view.country} />}</span>
                    <span className="site-usage-name">{view.name}</span>
                    <span className="site-usage-num">{value > 0 ? amount(value) : '0'}</span>
                    <span className="site-usage-pct">{shareOf(value, whole)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
      <ol className="ntd-users" aria-label="各用户流入">
        {rows.map(row => {
          const parts = visible
            .map(view => ({ view, cell: row.cells.get(view.id)! }))
            .filter(part => part.cell.total > 0)
            .sort((a, b) => b.cell.total - a.cell.total);
          return (
            <li key={row.id} className={user === row.id ? 'on' : undefined}>
              <button
                type="button"
                className="ntd-user"
                aria-pressed={user === row.id}
                onClick={() => setUser(current => (current === row.id ? null : row.id))}
              >
                <Who row={row} />
                <span className="ntd-parts">
                  {parts.map(({ view, cell }) => (
                    <span key={view.id} className="ntd-part">
                      <Swatch view={view} />
                      <ChainName view={view} flag={false} />
                      <b>{amount(cell.total)}</b>
                      {cell.gap && <span className="nti-gap" title="采集有缺口，仅含已记录的流量" />}
                    </span>
                  ))}
                </span>
                <span className="nti-num">{amount(row.total)}</span>
                <span className="nti-pct">{shareOf(row.total, inflow.grand)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {inflow.rows.length > FOLD + 2 && (
        <button type="button" className="btn sm nti-more" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
          {expanded ? '收起' : `展开其余 ${inflow.rows.length - FOLD} 位用户`}
        </button>
      )}
    </>
  );
}

interface BodyProps {
  agg: Agg;
  inflow: Inflow;
  views: ChainView[];
  show: ShowTip;
  hide: () => void;
}

export function InflowCard({
  built,
  agg,
  views,
  option,
}: {
  built: Built;
  agg: Agg;
  views: ChainView[];
  option: InflowOption;
}) {
  const card = useRef<HTMLElement>(null);
  const width = useWidth(card);
  const { show, hide, layer } = useTip(card);
  const inflow = useMemo(() => inflowOf(built.world, agg, views), [built, agg, views]);
  const bounds = agg.bounds;
  const forwarding = views.some(view => view.kind === 'fwd') ? inflow.columnTotal(FWD) : 0;
  const last = inflow.grand === 0 ? lastTraffic(built) : null;
  // 流向图需要两侧标签的宽度；卡片太窄时退回排行条形。
  const effective: InflowOption = option === 'flow' && width > 0 && width < 720 ? 'bars' : option;
  const props: BodyProps = { agg, inflow, views, show, hide };
  return (
    <section ref={card} className={`panel config-panel nti-card nti-opt-${effective}`} aria-label="流入统计">
      <header>
        <span title="从本机进入的用户流量：经本机接入的接入链与本机上的端口转发。中继、落地流量没有用户身份，不在此列。按 UTC+8 自然日、周一起的自然周和自然月。">
          <PanelTitle of="ingress">流入统计</PanelTitle>
        </span>
        {agg.gapHours > 0 ? (
          <span className="rut-status warn" title="这些小时里本机没有用量上报，期间的流量无法确认">
            <i className="node-lamp warn" />
            本范围 {agg.gapHours} 小时无上报
          </span>
        ) : (
          <span className="rut-status" title="本机最近一次用量上报（每 30 秒）">
            <i className="node-lamp" />
            最近上报 {hm(NOW - 30)}
          </span>
        )}
      </header>
      <div className="panel-full-bleed-body nti-body">
        <div className="site-usage-head nti-head">
          {inflow.grand > 0 ? (
            <>
              <span className="site-usage-total">{amount(inflow.grand)}</span>
              <span className="site-usage-label">
                {periodDates(bounds)} · {inflow.rows.length} 位用户 · {inflow.activeChains} 条接入链
              </span>
              <span className="site-usage-meta">
                下行 <b>{bytes(inflow.down)}</b> · 上行 <b>{bytes(inflow.up)}</b>
                {forwarding > 0 && (
                  <>
                    {' '}
                    · 含端口转发 <b>{bytes(forwarding)}</b>
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="site-usage-label">
              {periodDates(bounds)} · {periodLabel(bounds.period)}没有记录到流量
            </span>
          )}
        </div>
        {inflow.grand === 0 ? (
          <p className="uxm-empty nti-empty">
            本机上报正常，{periodLabel(bounds.period)}没有用户流量。{inflow.idle.length} 位用户已授权{' '}
            {built.world.chains.length} 条接入链{last !== null && <>；最近一次有流量在 {lastTrafficText(last)}</>}。
          </p>
        ) : effective === 'bars' ? (
          <BarsBody {...props} />
        ) : effective === 'flow' ? (
          <FlowBody {...props} />
        ) : effective === 'chains' ? (
          <ChainCardsBody {...props} idleRows={inflow.idle} />
        ) : (
          <TimeBody {...props} />
        )}
        {option === 'flow' && effective !== 'flow' && inflow.grand > 0 && (
          <p className="uxm-idle">卡片较窄，流向图改以排行条形显示。</p>
        )}
        {inflow.grand > 0 && inflow.idle.length > 0 && (
          <p className="uxm-idle">
            另有 {inflow.idle.length} 位已授权用户{periodLabel(bounds.period)}没有流量：
            {inflow.idle.map(row => row.id).join('、')}
          </p>
        )}
        {views.some(view => view.kind === 'unsplit') && (
          <p className="uxm-idle">
            “未按接入链记录”是按接入链统计上线前（{md(built.world.chainSplitSince!)}{' '}
            之前）的用户合计，计入合计，无法分到接入链。
          </p>
        )}
      </div>
      {layer}
    </section>
  );
}
