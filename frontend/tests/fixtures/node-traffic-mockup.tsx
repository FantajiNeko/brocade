// Mockup of the machine detail 流量 tab redesign. Synthetic data only; never imported by the app.
// Serve frontend/ with Vite (configFile: false, plugins: [react()]) and open
//   tests/fixtures/node-traffic-mockup.html?scene=typical&period=day&inflow=bars
// Query: scene=typical|many|solo|gaps|history|quiet|sites-off, period=day|week|month,
//        inflow=bars|flow|chains|time|all, theme=dark|light, w=<frame width>, run=0 freezes the live
//        readings, nav=0 hides the review bar.
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { theme } from '../../src/forge/theme';
import type { SiteUsageChartSeries, SiteUsageColor } from '../../src/site-usage-chart';
import { SegmentedControl } from '../../src/ui/bits';
import { bytes, shareOf } from '../../src/ui/format';
import { Icon, PanelTitle } from '../../src/ui/icons';
import { RegionFlag } from '../../src/ui/region-flag';
import { SiteIcon } from '../../src/ui/site-icon';
import { GeneratedUserAvatar } from '../../src/ui/user-avatar';
import {
  aggregate,
  boundsOf,
  build,
  chainViews,
  GiB,
  hm,
  NON_SITE_IDS,
  NOW,
  periodDates,
  periodLabel,
  PERIODS,
  SCENE_OPTIONS,
  SCENES,
  siteRowsOf,
  type Agg,
  type Built,
  type Period,
  type SceneKey,
  type SiteRow,
} from './node-traffic-mockup-data';
import { INFLOW_OPTIONS, InflowCard, type InflowOption } from './node-traffic-mockup-inflow';
import { LiveCard } from './node-traffic-mockup-live';
import { amount } from './node-traffic-mockup-ui';
import '../../src/styles.css';
import '../../src/user-machine-usage.css';
import './node-traffic-mockup.css';

const SiteUsageChart = lazy(() => import('../../src/site-usage-chart'));

const params = new URLSearchParams(location.search);
if (theme.snapshot() !== (params.get('theme') === 'light' ? 'light' : 'dark')) theme.toggle();
document.documentElement.dataset.palette = params.get('palette') ?? 'dailan';

/* ── 流出统计：生产「站点流量」卡的结构，范围换成本机全部用户，点站点看主要用户 ── */
const RANK_COLORS: SiteUsageColor[] = ['--observe-1', '--observe-6', '--observe-4', '--observe-5', '--observe-7'].map(
  token => ({ token }),
);
const REST_COLOR: SiteUsageColor = { token: '--observe-10' };
const NON_SITE_COLORS: Record<string, SiteUsageColor> = {
  other: { token: '--ink', alpha: 0.44 },
  'sniffing-failed': { token: '--ink', alpha: 0.3 },
  unidentified: { token: '--ink', alpha: 0.19 },
};
const cssColor = ({ token, alpha }: SiteUsageColor) =>
  alpha === undefined ? `var(${token})` : `color-mix(in srgb, var(${token}) ${Math.round(alpha * 100)}%, transparent)`;
const TOP_SITES = 5;

function OutflowCard({ built, agg, monthAgg }: { built: Built; agg: Agg; monthAgg: Agg }) {
  const [focus, setFocus] = useState<string | null>(null);
  const [openSite, setOpenSite] = useState<string | null>(null);
  const [restOpen, setRestOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState<Record<string, boolean>>({});
  const bounds = agg.bounds;
  const rows = useMemo(() => siteRowsOf(built, agg), [built, agg]);
  const palette = useMemo(
    () =>
      siteRowsOf(built, monthAgg)
        .filter(row => !NON_SITE_IDS.includes(row.id) && row.id !== 'forwarding')
        .slice(0, TOP_SITES)
        .map(row => row.id),
    [built, monthAgg],
  );
  const title = (
    <span title="本机认证代理入口的流量按目的站点归类：固定站点域名集合，每条连接只计入一类，不保存 URL。端口转发作为独立类型计入。">
      <PanelTitle of="outbound">流出统计</PanelTitle>
    </span>
  );
  if (!built.world.sites && rows.length === 0) {
    return (
      <section className="panel config-panel site-usage nto-card" aria-label="流出统计">
        <header>
          {title}
          <span className="rut-status" role="status">
            <i className="node-lamp idle" />
            站点统计未开启
          </span>
        </header>
        <div className="site-usage-body panel-full-bleed-body">
          <p className="site-usage-state nto-off">
            流出按目的站点归类，依赖站点统计。在「设置 → 出流量统计」开启后，本机从下一次上报开始统计，不保存 URL。
            <button type="button" className="btn sm">
              前往设置
            </button>
          </p>
        </div>
      </section>
    );
  }
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const down = rows.reduce((sum, row) => sum + row.down, 0);
  const up = rows.reduce((sum, row) => sum + row.up, 0);
  const sites = rows.filter(row => !NON_SITE_IDS.includes(row.id) && row.id !== 'forwarding');
  const forwarding = rows.filter(row => row.id === 'forwarding');
  const unsorted = rows.filter(row => NON_SITE_IDS.includes(row.id));
  const top = sites.filter(row => palette.includes(row.id));
  const rest = sites.filter(row => !palette.includes(row.id));
  const colorOf = (id: string): SiteUsageColor =>
    id === 'forwarding'
      ? { token: '--observe-2' }
      : (NON_SITE_COLORS[id] ?? RANK_COLORS[palette.indexOf(id)] ?? REST_COLOR);
  const future = (index: number) => bounds.start + index * bounds.bucket >= NOW;
  const series: SiteUsageChartSeries[] = [
    ...top.map(row => ({
      key: row.id,
      name: row.name,
      color: colorOf(row.id),
      values: row.values.map((value, index) => (future(index) ? null : value)),
    })),
    ...(rest.length > 0
      ? [
          {
            key: 'rest',
            name: `其余 ${rest.length} 类站点`,
            color: REST_COLOR,
            values: rest[0].values.map((_, index) =>
              future(index) ? null : rest.reduce((sum, row) => sum + row.values[index], 0),
            ),
          },
        ]
      : []),
    ...[...forwarding, ...unsorted].map(row => ({
      key: row.id,
      name: row.name,
      color: colorOf(row.id),
      values: row.values.map((value, index) => (future(index) ? null : value)),
    })),
  ];
  const item = (row: SiteRow, sub = false) => {
    const open = openSite === row.id;
    const focusKey = sub
      ? 'rest'
      : row.id === 'forwarding' || NON_SITE_IDS.includes(row.id) || palette.includes(row.id)
        ? row.id
        : 'rest';
    return (
      <li
        key={row.id}
        className={`site-usage-item nto-site${sub ? ' sub' : ''}${NON_SITE_IDS.includes(row.id) ? ' muted' : ''}${open ? ' open' : ''}`}
        onMouseEnter={() => setFocus(focusKey)}
        onMouseLeave={() => setFocus(null)}
      >
        <button
          type="button"
          className="site-usage-row"
          aria-expanded={open}
          title={`${row.name} · 下行 ${bytes(row.down)} · 上行 ${bytes(row.up)}\n点击查看主要用户`}
          onClick={() => setOpenSite(open ? null : row.id)}
        >
          <i
            className="site-usage-swatch"
            style={{ background: sub ? 'transparent' : cssColor(colorOf(row.id)) }}
            aria-hidden="true"
          />
          {row.id === 'forwarding' ? (
            <span className="site-brand-icon" aria-hidden="true">
              <Icon of="forwarding" size={18} />
            </span>
          ) : (
            <SiteIcon siteId={row.id} />
          )}
          <span className="site-usage-name">{row.name}</span>
          <span className="site-usage-num">{amount(row.total)}</span>
          <span className="site-usage-pct">{shareOf(row.total, total)}</span>
        </button>
        {open && (
          <ol className="nto-users" aria-label={`${row.name} 的主要用户`}>
            {row.users.slice(0, 4).map(user => (
              <li key={user.id}>
                <GeneratedUserAvatar id={user.id} variant="mini" />
                <span className="nti-name">{user.id}</span>
                <span className="nto-bar" aria-hidden="true">
                  <i style={{ width: `${(user.total / row.users[0].total) * 100}%` }} />
                </span>
                <span className="site-usage-num">{amount(user.total)}</span>
                <span className="site-usage-pct">{shareOf(user.total, row.total)}</span>
              </li>
            ))}
            {row.users.length > 4 && (
              <li className="nto-more">
                其余 {row.users.length - 4} 位 · {bytes(row.users.slice(4).reduce((sum, user) => sum + user.total, 0))}
              </li>
            )}
          </ol>
        )}
      </li>
    );
  };
  const scale = bounds.period === 'month' ? 18 : bounds.period === 'week' ? 6.9 : 0.9;
  const details = [
    {
      kind: 'other',
      label: '其他站点',
      by: '按主域名',
      unit: '个主域名',
      items: [
        ['video.cinema.example', 2.6],
        ['news.journal.example', 1.1],
        ['updates.software.example', 0.84],
        ['docs.reference.example', 0.52],
        ['images.gallery.example', 0.37],
        ['audio.radio.example', 0.21],
      ] as [string, number][],
    },
    {
      kind: 'sniffing-failed',
      label: '嗅探失败',
      by: '按目标 IP 与端口',
      unit: '个目标',
      items: [
        ['TCP 192.0.2.1:443', 1.9],
        ['UDP [2001:db8::1]:443', 1.2],
        ['TCP 198.51.100.20:8443', 0.6],
        ['UDP 203.0.113.8:53', 0.2],
      ] as [string, number][],
    },
  ];
  return (
    <section className="panel config-panel site-usage nto-card" aria-label="流出统计">
      <header>
        {title}
        <span className={`rut-status${agg.gapHours > 0 ? ' warn' : ''}`} role="status">
          <i className={`node-lamp${agg.gapHours > 0 ? ' warn' : ''}`} />
          {agg.gapHours > 0 ? `本范围 ${agg.gapHours} 小时无上报` : `最近上报 ${hm(NOW - 30)}`}
        </span>
      </header>
      <div className="site-usage-body panel-full-bleed-body">
        <div className="site-usage-main">
          <section className="site-usage-plot" aria-label="流出随时间分布">
            <div className="site-usage-head">
              {total > 0 ? (
                <>
                  <span className="site-usage-total">{amount(total)}</span>
                  <span className="site-usage-label">
                    {periodDates(bounds)} · 流向 {sites.length} 类站点
                  </span>
                  <span className="site-usage-meta">
                    下行 <b>{bytes(down)}</b> · 上行 <b>{bytes(up)}</b>
                  </span>
                </>
              ) : (
                <span className="site-usage-label">
                  {periodDates(bounds)} · {periodLabel(bounds.period)}没有观测到流量
                </span>
              )}
            </div>
            {total > 0 && (
              <>
                <Suspense fallback={<div className="site-usage-chart" />}>
                  <SiteUsageChart
                    period={bounds.period}
                    startUnixSecs={bounds.start}
                    bucketSecs={bounds.bucket}
                    nowUnixSecs={NOW}
                    observedSinceUnixSecs={null}
                    series={series}
                    focusKey={focus}
                  />
                </Suspense>
                <p className="site-usage-note">
                  {bounds.period === 'month' ? '每天' : '每小时'}一柱 · 固定本月主要 {TOP_SITES}{' '}
                  类站点着色，其余合为一层 · 点右侧站点看主要用户
                </p>
              </>
            )}
          </section>
          <section className="site-usage-side" aria-label="各站点流量">
            {total === 0 ? (
              <p className="site-usage-empty">{periodLabel(bounds.period)}没有站点记录</p>
            ) : (
              <ol className="site-usage-key">
                {top.map(row => item(row))}
                {rest.length > 0 && (
                  <li
                    className="site-usage-item"
                    onMouseEnter={() => setFocus('rest')}
                    onMouseLeave={() => setFocus(null)}
                  >
                    <button
                      type="button"
                      className="site-usage-row"
                      aria-expanded={restOpen}
                      onClick={() => setRestOpen(value => !value)}
                    >
                      <i
                        className="site-usage-swatch"
                        style={{ background: cssColor(REST_COLOR) }}
                        aria-hidden="true"
                      />
                      <Icon of="chevronDown" size={11} className={`site-usage-chevron${restOpen ? ' open' : ''}`} />
                      <span className="site-usage-name">其余 {rest.length} 类站点</span>
                      <span className="site-usage-num">{amount(rest.reduce((sum, row) => sum + row.total, 0))}</span>
                      <span className="site-usage-pct">
                        {shareOf(
                          rest.reduce((sum, row) => sum + row.total, 0),
                          total,
                        )}
                      </span>
                    </button>
                  </li>
                )}
                {restOpen && rest.map(row => item(row, true))}
                {forwarding.map(row => item(row))}
                {unsorted.length > 0 && (
                  <li className="site-usage-group" aria-hidden="true">
                    未归类
                  </li>
                )}
                {unsorted.map(row => item(row))}
              </ol>
            )}
          </section>
        </div>
        {total > 0 &&
          details.map(detail => {
            const open = detailOpen[detail.kind] ?? false;
            const items = detail.items.map(([name, size]) => ({ name, total: size * scale * GiB }));
            const max = items[0].total;
            return (
              <section
                key={detail.kind}
                className={`site-usage-detail${open ? ' open' : ''}`}
                aria-label={`${detail.label}明细`}
              >
                <button
                  type="button"
                  className="site-usage-detail-head"
                  aria-expanded={open}
                  onClick={() => setDetailOpen(current => ({ ...current, [detail.kind]: !open }))}
                >
                  <i
                    className="site-usage-swatch"
                    style={{ background: cssColor(NON_SITE_COLORS[detail.kind]) }}
                    aria-hidden="true"
                  />
                  <span className="site-usage-detail-title">{detail.label}</span>
                  <span className="site-usage-detail-by">{detail.by}</span>
                  {open ? (
                    <span className="site-usage-detail-count">
                      {items.length} {detail.unit}
                    </span>
                  ) : (
                    <span className="site-usage-detail-preview">
                      {items
                        .slice(0, 3)
                        .map(entry => entry.name)
                        .join('、')}{' '}
                      等 {items.length} {detail.unit}
                    </span>
                  )}
                  <Icon of="chevronDown" size={11} className="site-usage-chevron" />
                </button>
                {open && (
                  <>
                    <p className="site-usage-detail-note">
                      {bounds.period === 'day' ? '' : '明细只保留近 24 小时 · '}覆盖{' '}
                      {bytes(items.reduce((sum, entry) => sum + entry.total, 0))}
                    </p>
                    <div className="site-usage-dcols">
                      {[items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))].map(
                        (column, index) => (
                          <ol key={index} className="site-usage-drows">
                            {column.map(entry => (
                              <li key={entry.name} className="site-usage-drow">
                                <span className="site-usage-dname">
                                  <span className="site-usage-dmain">{entry.name}</span>
                                </span>
                                <span className="site-usage-dbar" aria-hidden="true">
                                  <i
                                    style={{
                                      width: `${(entry.total / max) * 100}%`,
                                      background: cssColor(NON_SITE_COLORS[detail.kind]),
                                    }}
                                  />
                                </span>
                                <span className="site-usage-num">{amount(entry.total)}</span>
                              </li>
                            ))}
                          </ol>
                        ),
                      )}
                    </div>
                  </>
                )}
              </section>
            );
          })}
      </div>
    </section>
  );
}

/* ── 统计范围：只管下面两张统计卡；实时卡在它上面，不受影响 ── */
function PeriodBar({ period, onPeriod }: { period: Period; onPeriod: (period: Period) => void }) {
  const bounds = boundsOf(period);
  return (
    <div className="nts-bar" role="group" aria-label="统计范围">
      <span className="nts-title">统计</span>
      <SegmentedControl ariaLabel="统计范围" value={period} options={PERIODS} onChange={onPeriod} />
      <span className="nts-range">
        {periodDates(bounds)} · UTC+8 {period === 'day' ? '自然日' : period === 'week' ? '自然周（周一起）' : '自然月'}
      </span>
      <span className="nts-note">流入、流出两张卡同用此范围</span>
    </div>
  );
}

/* ── 页面外壳：生产的详情页头与页签 ── */
function NodePage({ children }: { children: ReactNode }) {
  const tabs = [
    { key: 'observed', label: '观测', icon: 'observe', badge: <span className="nd-tab-badge gold">1</span> },
    { key: 'traffic', label: '流量', icon: 'usage' },
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
                <h1 className="nd-id">example-hk-edge-01</h1>
              </div>
              <span className="nd-ident-meta">203.0.113.48</span>
            </div>
          </div>
          <div className="nd-tabs" role="tablist" aria-label="机器详情页签">
            <div className="nd-tabs-seg">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={tab.key === 'traffic'}
                  tabIndex={tab.key === 'traffic' ? 0 : -1}
                >
                  <Icon of={tab.icon} size={14} className="nd-tab-ic" />
                  {tab.label}
                  {'badge' in tab && tab.badge}
                </button>
              ))}
            </div>
          </div>
          <div className="nd-tools">
            <div className="nd-acts">
              <button type="button" className="btn fg-more" aria-label="更多操作">
                <Icon of="more" size={14} />
              </button>
            </div>
          </div>
        </header>
        <div className="nd-paper-body">
          <section className="nd-tab-panel nd-tab-traffic nt-tab" role="tabpanel" aria-label="流量">
            {children}
          </section>
        </div>
      </div>
    </div>
  );
}

const WIDTHS = [
  { value: 1280, label: '1280' },
  { value: 1024, label: '1024' },
  { value: 760, label: '760' },
  { value: 390, label: '390' },
];
const INFLOW_CHOICES: { value: InflowOption | 'all'; label: string }[] = [
  ...INFLOW_OPTIONS.map(option => ({ value: option.value, label: option.label })),
  { value: 'all', label: '全部并列' },
];

function App() {
  const initialScene = params.get('scene');
  const [scene, setScene] = useState<SceneKey>(
    initialScene && initialScene in SCENES ? (initialScene as SceneKey) : 'typical',
  );
  const initialPeriod = params.get('period');
  const [period, setPeriod] = useState<Period>(
    initialPeriod === 'week' || initialPeriod === 'month' ? initialPeriod : 'day',
  );
  const initialInflow = params.get('inflow');
  const [inflow, setInflow] = useState<InflowOption | 'all'>(
    INFLOW_CHOICES.some(choice => choice.value === initialInflow) ? (initialInflow as InflowOption | 'all') : 'bars',
  );
  const [width, setWidth] = useState(Number(params.get('w')) || 1280);
  const [mode, setMode] = useState(theme.snapshot());
  const [run, setRun] = useState(params.get('run') !== '0');
  const built = useMemo(() => build(SCENES[scene]()), [scene]);
  const agg = useMemo(() => aggregate(built, period), [built, period]);
  const monthAgg = useMemo(() => aggregate(built, 'month'), [built]);
  const views = useMemo(() => chainViews(built.world, agg, monthAgg), [built, agg, monthAgg]);
  useLayoutEffect(() => {
    const next = new URLSearchParams(location.search);
    next.set('scene', scene);
    next.set('period', period);
    next.set('inflow', inflow);
    next.set('w', String(width));
    next.set('theme', mode);
    if (run) next.delete('run');
    else next.set('run', '0');
    history.replaceState(null, '', `?${next}`);
  }, [scene, period, inflow, width, mode, run]);
  const nav = params.get('nav') !== '0';
  const options = inflow === 'all' ? INFLOW_OPTIONS : INFLOW_OPTIONS.filter(option => option.value === inflow);
  return (
    <>
      {nav && (
        <div className="mk-bar">
          <div className="mk-bar-row">
            <span className="mk-title">
              机器详情 · 流量页签<small>MOCKUP · 合成数据 · 现在 = 10-18 周日 21:40</small>
            </span>
            <div className="mk-controls">
              <label className="mk-ctl">
                <span className="mk-ctl-label">场景</span>
                <select value={scene} onChange={event => setScene(event.target.value as SceneKey)}>
                  {SCENE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="mk-ctl">
                <span className="mk-ctl-label">流入方案</span>
                <SegmentedControl
                  ariaLabel="流入统计方案"
                  value={inflow}
                  options={INFLOW_CHOICES}
                  onChange={setInflow}
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
              <button type="button" className="btn sm" onClick={() => setRun(value => !value)}>
                {run ? '暂停实时' : '继续实时'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="mk-stage">
        <div className="mk-frame" style={{ width: `min(100%, ${width}px)` }}>
          <NodePage>
            <LiveCard built={built} views={views} run={run} />
            <PeriodBar period={period} onPeriod={setPeriod} />
            {options.map(option => (
              <div key={option.value} className="mk-option">
                {nav && (
                  <p className="mk-option-note">
                    <b>方案 {option.label}</b>
                    {option.note}
                  </p>
                )}
                <InflowCard built={built} agg={agg} views={views} option={option.value} />
              </div>
            ))}
            <OutflowCard built={built} agg={agg} monthAgg={monthAgg} />
          </NodePage>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
