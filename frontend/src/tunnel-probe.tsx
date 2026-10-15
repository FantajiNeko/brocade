import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  cancelTunnelProbe,
  fetchTunnelProbe,
  fetchTunnelProbeCapability,
  fetchTunnelProbes,
  startTunnelProbe,
  updateTunnelProbePolicy,
  type TunnelProbeHealth,
  type TunnelProbeHealthReason,
  type TunnelProbeListItem,
  type TunnelProbeResultStatus,
  type TunnelProbeRun,
  type TunnelProbeSource,
  type TunnelProbeView,
} from './api';
import { draft } from './draft';
import { ErrorBox, Loading, SegmentedControl } from './ui/bits';
import { DialogClose, DialogLayer } from './ui/dialog';
import { Icon, PanelTitle } from './ui/icons';
import { confirmDiscardChanges, useUnsavedChanges } from './ui/navigation-guard';
import { RegionFlag } from './ui/region-flag';

const INTERVALS = [
  { value: 60, label: '每分钟' },
  { value: 300, label: '每 5 分钟' },
  { value: 900, label: '每 15 分钟' },
  { value: 1800, label: '每 30 分钟' },
  { value: 3600, label: '每小时' },
] as const;

const healthText: Record<TunnelProbeHealth, string> = {
  healthy: '正常',
  degraded: '变慢',
  down: '故障',
  paused: '未监测',
  unknown: '暂无结论',
};

const resultText: Record<TunnelProbeResultStatus, string> = {
  ok: '成功',
  timeout: '超时',
  'connect-failed': '连接失败',
  'target-failed': '落点失败',
  unsupported: '不支持',
  canceled: '已取消',
  interrupted: '执行中断',
};

/** Results that count as a failed run. Canceled and unsupported runs never reached the target. */
const FAILED_RESULTS = new Set<TunnelProbeResultStatus>(['timeout', 'connect-failed', 'target-failed', 'interrupted']);
const COUNTED_RESULTS = new Set<TunnelProbeResultStatus>(['ok', 'timeout', 'connect-failed', 'target-failed']);

const phaseOrder = ['queued', 'preparing', 'starting-xray', 'requesting'] as const;
const phaseText = ['排队', '冻结配置', '启动 Xray', '请求落点'] as const;

const WINDOWS = [
  { value: 86_400, label: '24 小时' },
  { value: 604_800, label: '7 天' },
] as const;
const windowText = (seconds: number) => WINDOWS.find(option => option.value === seconds)?.label ?? `${seconds} 秒`;

/** Records shown before the operator asks for the rest of the retained list. */
const RUNS_SHOWN = 5;

const isActive = (run: TunnelProbeRun | null | undefined) => run?.status === 'queued' || run?.status === 'running';
const intervalText = (seconds: number) => INTERVALS.find(option => option.value === seconds)?.label ?? `${seconds} 秒`;
const dateText = (seconds: number | null) =>
  seconds === null ? '—' : new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });

const two = (value: number) => String(value).padStart(2, '0');
/** HH:MM for today, MM-DD HH:MM otherwise; probe records span at most the retention week. */
export function probeClock(seconds: number, nowMs = Date.now()): string {
  const date = new Date(seconds * 1000);
  const now = new Date(nowMs);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return date.toDateString() === now.toDateString()
    ? time
    : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`;
}

/** One decimal, rounded down so a single failure never reads as 100%. */
const successRateText = (rate: number) => {
  const tenths = Math.floor(rate * 1000) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
};

function sinceText(seconds: number, nowMs = Date.now()): string {
  const elapsed = Math.max(0, Math.round(nowMs / 1000 - seconds));
  if (elapsed < 60) return '刚刚';
  if (elapsed < 3_600) return `${Math.round(elapsed / 60)} 分钟前`;
  if (elapsed < 86_400) return `${Math.round(elapsed / 3_600)} 小时前`;
  return `${Math.round(elapsed / 86_400)} 天前`;
}

function HealthBadge({ health }: { health: TunnelProbeHealth }) {
  return <span className={`tunnel-probe-health ${health}`}>{healthText[health]}</span>;
}

export const tunnelProbeQueryKey = (tenantId: string, outboundId: string, windowSecs: number) =>
  ['tunnel-probe', tenantId, outboundId, windowSecs] as const;

/** The detail page header and the probe panel read one query, so a window switch or a poll is
 * one request. Switching windows keeps the previous window on screen until the next one arrives. */
export function useTunnelProbeView(tenantId: string, outboundId: string, windowSecs: number, enabled = true) {
  return useQuery({
    queryKey: tunnelProbeQueryKey(tenantId, outboundId, windowSecs),
    queryFn: () => fetchTunnelProbe(tenantId, outboundId, windowSecs),
    enabled,
    staleTime: 15_000,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    placeholderData: keepPreviousData,
    refetchInterval: query => (isActive(query.state.data?.item.latest_run) ? 2_000 : 15_000),
  });
}

// ECharts stays out of the tunnel list and Settings: only a tunnel detail loads the chart module,
// and it gates its first paint on the module so the page appears complete at once.
const importTunnelProbeChart = () => import('./tunnel-probe-chart');
type TunnelProbeChartComponent = Awaited<ReturnType<typeof importTunnelProbeChart>>['TunnelProbeChart'];
export type TunnelProbeChartState =
  { status: 'pending' } | { status: 'ready'; Chart: TunnelProbeChartComponent } | { status: 'error'; error: unknown };

let loadedTunnelProbeChart: TunnelProbeChartComponent | null = null;
let tunnelProbeChartPromise: Promise<TunnelProbeChartComponent> | null = null;

function loadTunnelProbeChart(): Promise<TunnelProbeChartComponent> {
  if (loadedTunnelProbeChart) return Promise.resolve(loadedTunnelProbeChart);
  tunnelProbeChartPromise ??= importTunnelProbeChart().then(module => {
    loadedTunnelProbeChart = module.TunnelProbeChart;
    return loadedTunnelProbeChart;
  });
  return tunnelProbeChartPromise;
}

export function useTunnelProbeChart(enabled = true): TunnelProbeChartState {
  const [state, setState] = useState<TunnelProbeChartState>(() =>
    loadedTunnelProbeChart ? { status: 'ready', Chart: loadedTunnelProbeChart } : { status: 'pending' },
  );
  useEffect(() => {
    if (!enabled || state.status !== 'pending') return;
    let active = true;
    loadTunnelProbeChart().then(
      Chart => {
        if (active) setState({ status: 'ready', Chart });
      },
      error => {
        if (active) setState({ status: 'error', error });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, state.status]);
  return state;
}

export type TunnelProbeTone = 'ok' | 'warn' | 'err' | 'idle';
export interface TunnelProbeStatus {
  /** `unpublished`: the tunnel has no Serving copy, so only a draft can be probed. */
  key: TunnelProbeHealth | 'unpublished';
  word: string;
  tone: TunnelProbeTone;
  why: string;
}

const TONE: Record<TunnelProbeHealth, TunnelProbeTone> = {
  healthy: 'ok',
  degraded: 'warn',
  down: 'err',
  paused: 'idle',
  unknown: 'idle',
};

function reasonText(reason: TunnelProbeHealthReason, failure: TunnelProbeRun | undefined, nowMs: number): string {
  const detail = failure?.error_detail ? `：${failure.error_detail}` : '';
  switch (reason.kind) {
    case 'not-scheduled':
      return '定时监测未启用';
    case 'no-samples':
      return '最近 7 天没有 Serving 拨测';
    case 'stale':
      return reason.latest_finished_at_unix_secs === null
        ? '最近一次拨测没有完成'
        : `最近一次拨测在 ${sinceText(reason.latest_finished_at_unix_secs, nowMs)}，已超过 3 个周期`;
    case 'consecutive-failures':
      return `连续 ${reason.count} 次失败，最近一次${reason.latest ? resultText[reason.latest] : '失败'}${detail}`;
    case 'latest-failed':
      return `最近一次${reason.result ? resultText[reason.result] : '失败'}${detail}`;
    case 'low-success-rate':
      return `最近 ${reason.samples} 次成功 ${reason.succeeded} 次`;
    case 'slow':
      return reason.samples === 1
        ? `最近一次拨测首字节 ${reason.max_ttfb_ms} ms，超过 ${reason.threshold_ms} ms`
        : `最近 ${reason.samples} 次拨测首字节最高 ${reason.max_ttfb_ms} ms，超过 ${reason.threshold_ms} ms`;
    case 'healthy':
      return reason.max_ttfb_ms === null
        ? `最近 ${reason.samples} 次全部成功`
        : `最近 ${reason.samples} 次全部成功，首字节最高 ${reason.max_ttfb_ms} ms`;
  }
}

/** Status of a custom tunnel as the Console judged it. `view` is null when the Console has no
 * record of the tunnel at all, which only happens before it is published or first probed. */
export function tunnelProbeStatus(view: TunnelProbeView | null, nowMs = Date.now()): TunnelProbeStatus {
  if (!view || !view.item.supported) {
    return {
      key: 'unpublished',
      word: '未发布',
      tone: 'idle',
      why: view?.item.unsupported_reason ?? '尚未进入 Serving；发布后才能启用定时监测或拨测 Serving',
    };
  }
  const { health, health_reason: reason } = view.item;
  const failure = view.recent_runs.find(
    run => run.source === 'serving' && run.result !== null && COUNTED_RESULTS.has(run.result) && run.result !== 'ok',
  );
  return {
    key: health,
    word: healthText[health],
    tone: TONE[health],
    why: reason ? reasonText(reason, failure, nowMs) : '',
  };
}

/** The newest run that reported where traffic leaves the tunnel. */
export const tunnelExitRun = (view: TunnelProbeView | null | undefined) =>
  view?.recent_runs.find(run => run.exit_ip) ?? (view?.item.latest_run?.exit_ip ? view.item.latest_run : null);

function ProbeProgress({ run, source }: { run: TunnelProbeRun; source: TunnelProbeSource }) {
  const current = Math.max(0, phaseOrder.indexOf(run.phase as (typeof phaseOrder)[number]));
  return (
    <div className="tnd-verdict is-run" role="status">
      <span className="cg-lamp run" aria-hidden />
      <b>拨测中</b>
      <span className="tnd-why">
        {phaseText[current]} · 第 {current + 1} 步，共 {phaseText.length} 步 · {source === 'draft' ? '草稿' : 'Serving'}
      </span>
      <ol className="tnd-steps" aria-label="拨测进度">
        {phaseText.map((label, index) => (
          <li
            className={index < current ? 'done' : index === current ? 'current' : ''}
            key={label}
            title={label}
            aria-label={label}
          />
        ))}
      </ol>
    </div>
  );
}

function Verdict({ status, view }: { status: TunnelProbeStatus; view: TunnelProbeView | null }) {
  const policy = view?.item.policy;
  const lastServing = view?.recent_runs.find(run => run.source === 'serving' && run.finished_at_unix_secs !== null);
  const lastAny = view?.recent_runs.find(run => run.finished_at_unix_secs !== null);
  const timing =
    status.key !== 'unpublished' && policy?.enabled
      ? `上次 ${lastServing?.finished_at_unix_secs ? probeClock(lastServing.finished_at_unix_secs) : '—'} · 下次 ${
          policy.next_run_at_unix_secs ? probeClock(policy.next_run_at_unix_secs) : '—'
        }`
      : lastAny?.finished_at_unix_secs
        ? `上次 ${probeClock(lastAny.finished_at_unix_secs)}`
        : '';
  return (
    <div className={`tnd-verdict tone-${status.tone}`}>
      <span className={`cg-lamp ${status.tone}`} aria-hidden />
      <b>{status.word}</b>
      <span className="tnd-why" title={status.why}>
        {status.why}
      </span>
      {timing && <span className="tnd-when">{timing}</span>}
    </div>
  );
}

interface MetricCell {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  tone?: 'warn' | 'err';
  wide?: boolean;
}

function exitCell(view: TunnelProbeView | null, windowSecs: number): MetricCell {
  const exit = tunnelExitRun(view);
  if (!exit?.exit_ip) return { label: '出口', value: '—', sub: '拨测成功后显示', wide: true };
  const seen = exit.finished_at_unix_secs ?? exit.queued_at_unix_secs;
  const many = view && view.summary.exit_ips > 1 ? ` · ${windowText(windowSecs)}内 ${view.summary.exit_ips} 个 IP` : '';
  return {
    label: '出口',
    value: (
      <>
        <RegionFlag code={exit.exit_loc} />
        <span className="tnd-ip">{exit.exit_ip}</span>
      </>
    ),
    sub: `${exit.exit_loc ?? '未知地区'} · ${probeClock(seen)}${many}`,
    wide: true,
  };
}

function Metrics({
  view,
  status,
  windowSecs,
}: {
  view: TunnelProbeView | null;
  status: TunnelProbeStatus;
  windowSecs: number;
}) {
  let cells: MetricCell[];
  if (status.key === 'unpublished') {
    const runs = view?.recent_runs.filter(run => run.finished_at_unix_secs !== null) ?? [];
    const latest = runs[0];
    if (!latest) return null;
    cells = [
      {
        label: '最近一次',
        value:
          latest.result === 'ok' ? (
            <>
              {latest.ttfb_ms}
              <span className="u">ms</span>
            </>
          ) : (
            <span className="err">{latest.result ? resultText[latest.result] : '未完成'}</span>
          ),
        sub: `${latest.source === 'draft' ? `草稿 ${latest.draft_sha256?.slice(0, 8) ?? '—'}` : 'Serving'} · ${probeClock(latest.finished_at_unix_secs!)}`,
      },
      {
        label: '草稿拨测',
        value: (
          <>
            {runs.filter(run => run.result === 'ok').length}
            <span className="u">/ {runs.length} 成功</span>
          </>
        ),
        sub: '手动发起',
      },
      exitCell(view, windowSecs),
    ];
  } else {
    const summary = view!.summary;
    const split = [
      ['超时', summary.timeouts],
      ['连接', summary.connect_failures],
      ['落点', summary.target_failures],
    ]
      .filter(([, count]) => Number(count) > 0)
      .map(([label, count]) => `${label} ${count}`)
      .join(' · ');
    cells = [
      {
        label: '可用率',
        value:
          summary.success_rate === null ? (
            '—'
          ) : (
            <>
              {successRateText(summary.success_rate)}
              <span className="u">%</span>
            </>
          ),
        sub: `${summary.succeeded} / ${summary.total} 次 · ${windowText(windowSecs)}`,
      },
      {
        label: '首字节 P50',
        value:
          summary.p50_ms === null ? (
            '—'
          ) : (
            <>
              {summary.p50_ms}
              <span className="u">ms</span>
            </>
          ),
        sub: '中位数',
      },
      {
        label: 'P95',
        value:
          summary.p95_ms === null ? (
            '—'
          ) : (
            <>
              {summary.p95_ms}
              <span className="u">ms</span>
            </>
          ),
        sub: '慢尾',
      },
      {
        label: '失败',
        value: summary.failures,
        sub: split || '—',
        tone: summary.failures === 0 ? undefined : status.key === 'down' ? 'err' : 'warn',
      },
      exitCell(view, windowSecs),
    ];
  }
  return (
    <dl className={`tnd-metrics is-${cells.length}`}>
      {cells.map(cell => (
        <div className={cell.wide ? 'is-wide' : undefined} key={cell.label}>
          <dt>{cell.label}</dt>
          <dd className={cell.tone}>{cell.value}</dd>
          <small>{cell.sub}</small>
        </div>
      ))}
    </dl>
  );
}

function RunRows({ runs }: { runs: TunnelProbeRun[] }) {
  const [all, setAll] = useState(false);
  if (runs.length === 0) return <p className="tnd-none">还没有拨测记录。</p>;
  const shown = all ? runs : runs.slice(0, RUNS_SHOWN);
  return (
    <>
      <div className="tnd-runs">
        {shown.map(run => {
          const failed = run.result !== null && FAILED_RESULTS.has(run.result);
          const tone = run.result === 'ok' ? 'ok' : failed ? 'fail' : isActive(run) ? 'run' : 'muted';
          const revision =
            run.source === 'draft'
              ? `点击时冻结的草稿，基于修订 r${run.topology_revision}`
              : `Serving G${run.serving_generation ?? '—'} · r${run.topology_revision}`;
          return (
            <article className={`tnd-run is-${tone}`} key={run.id} title={revision}>
              <span className="tnd-run-when">{probeClock(run.finished_at_unix_secs ?? run.queued_at_unix_secs)}</span>
              <span className="tnd-run-ic" aria-hidden>
                {tone === 'ok' ? (
                  <Icon of="check" size={11} />
                ) : tone === 'fail' ? (
                  <Icon of="close" size={11} />
                ) : (
                  <Icon of="clock" size={11} />
                )}
              </span>
              <b className="tnd-run-val">
                {run.result === 'ok' && run.ttfb_ms !== null ? (
                  <>
                    {run.ttfb_ms}
                    <span className="u">ms</span>
                  </>
                ) : run.result ? (
                  resultText[run.result]
                ) : run.status === 'running' ? (
                  '运行中'
                ) : (
                  '等待执行'
                )}
              </b>
              <span className="tnd-run-detail">
                {run.result === 'ok' ? (
                  <>
                    {run.http_status !== null && <span>HTTP {run.http_status}</span>}
                    {run.exit_ip && (
                      <>
                        <RegionFlag code={run.exit_loc} />
                        <span className="tnd-ip">{run.exit_ip}</span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="tnd-run-error">{run.error_detail ?? ''}</span>
                )}
              </span>
              <span className="tnd-run-tags">
                {run.trigger === 'manual' && <span className="tnd-tag">手动</span>}
                {run.source === 'draft' && (
                  <span className="tnd-tag draft">草稿 {run.draft_sha256?.slice(0, 8) ?? '—'}</span>
                )}
              </span>
            </article>
          );
        })}
      </div>
      {runs.length > RUNS_SHOWN && (
        <button className="tnd-more" type="button" onClick={() => setAll(value => !value)}>
          {all ? '收起' : `显示最近 ${runs.length} 次`}
        </button>
      )}
    </>
  );
}

const endpointText = (url: string) => url.replace(/^https?:\/\//, '');

function PolicyLine({
  item,
  published,
  endpointUrl,
  editable,
  onEdit,
}: {
  item: TunnelProbeListItem | null;
  published: boolean;
  endpointUrl: string | null;
  editable: boolean;
  onEdit: () => void;
}) {
  const policy = item?.policy;
  return (
    <div className="tnd-policy">
      <span className="tnd-k">定时监测</span>
      {!published ? (
        <span>发布后可启用</span>
      ) : policy?.enabled ? (
        <span>
          {intervalText(policy.interval_secs)} · 超时 {policy.timeout_secs} 秒
        </span>
      ) : (
        <span className="warn">{policy ? '已暂停' : '未启用'}</span>
      )}
      {endpointUrl && (
        <span className="tnd-route" title="拨测从 Console 发起，经这条隧道请求落点">
          Console → {endpointText(endpointUrl)}
        </span>
      )}
      {published && item && (
        <button className="btn tnd-mini" type="button" disabled={!editable} onClick={onEdit}>
          {policy?.enabled ? '修改' : '设置'}
        </button>
      )}
    </div>
  );
}

export function TunnelProbePolicyDialog({
  item,
  onClose,
  onSaved,
}: {
  item: TunnelProbeListItem;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(item.policy?.enabled ?? false);
  const [interval, setIntervalValue] = useState(item.policy?.interval_secs ?? 300);
  const [timeout, setTimeoutValue] = useState(String(item.policy?.timeout_secs ?? 10));
  const dirty =
    enabled !== (item.policy?.enabled ?? false) ||
    interval !== (item.policy?.interval_secs ?? 300) ||
    timeout !== String(item.policy?.timeout_secs ?? 10);
  const guardScope = `tunnel-probe:${item.tenant_id}:${item.outbound_id}`;
  useUnsavedChanges(dirty, `${item.name} 的定时监测`, guardScope);
  const validTimeout = Number.isInteger(Number(timeout)) && Number(timeout) >= 1 && Number(timeout) <= 120;
  const save = useMutation({
    mutationFn: () =>
      updateTunnelProbePolicy(item.tenant_id, item.outbound_id, {
        enabled,
        interval_secs: interval,
        timeout_secs: Number(timeout),
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tunnel-probes'] }),
        qc.invalidateQueries({ queryKey: ['tunnel-probe', item.tenant_id, item.outbound_id] }),
      ]);
      onSaved?.();
      onClose();
    },
  });

  return (
    <DialogLayer
      label={`设置 ${item.name} 定时监测`}
      onClose={onClose}
      canClose={() => confirmDiscardChanges(guardScope)}
    >
      <section className="dialog-surface tunnel-dialog narrow tunnel-probe-dialog">
        <header>
          <b>定时监测</b>
          <span className="sp" />
          <DialogClose className="btn">关闭</DialogClose>
        </header>
        <div className="tunnel-dialog-body">
          <p className="tunnel-probe-dialog-name">
            <b>{item.name}</b>
            <span className="mono">
              {item.tenant_id} / {item.outbound_id}
            </span>
          </p>
          <div className="fgrid one tunnel-probe-policy-fields">
            <div className="row">
              <span className="k">状态</span>
              <span className="v">
                <SegmentedControl
                  value={enabled}
                  options={[
                    { value: false, label: '暂停' },
                    { value: true, label: '启用' },
                  ]}
                  onChange={setEnabled}
                  ariaLabel="定时监测状态"
                />
              </span>
            </div>
            <label className="row">
              <span className="k">监测间隔</span>
              <span className="v">
                <select className="f" value={interval} onChange={event => setIntervalValue(Number(event.target.value))}>
                  {INTERVALS.map(option => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="row">
              <span className="k">首字节超时</span>
              <span className="v tunnel-probe-timeout-field">
                <input
                  className="f"
                  type="number"
                  min={1}
                  max={120}
                  value={timeout}
                  aria-invalid={!validTimeout || undefined}
                  onChange={event => setTimeoutValue(event.target.value)}
                />
                <span>秒</span>
              </span>
            </label>
          </div>
          <p className="guard">计划在 Console 机器上执行；采用当前 Serving 修订，不会改动节点配置。</p>
          {save.error && <ErrorBox error={save.error} />}
        </div>
        <footer>
          <span className="hint">间隔带稳定抖动，避免同一秒集中发起。</span>
          <span className="sp" />
          <DialogClose className="btn">取消</DialogClose>
          <button className="btn primary" disabled={!validTimeout || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </DialogLayer>
  );
}

export function TunnelProbePanel({
  tenantId,
  outboundId,
  draftSupported,
  editable,
  windowSecs,
  onWindowChange,
}: {
  tenantId: string;
  outboundId: string;
  draftSupported: boolean;
  editable: boolean;
  windowSecs: number;
  onWindowChange: (windowSecs: number) => void;
}) {
  const qc = useQueryClient();
  const draftEntries = useSyncExternalStore(draft.subscribe, draft.snapshot);
  const [policyOpen, setPolicyOpen] = useState(false);
  const capability = useQuery({
    queryKey: ['tunnel-probe-capability'],
    queryFn: fetchTunnelProbeCapability,
    staleTime: 60_000,
    enabled: editable,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
  });
  // The probe target is Console configuration; only operators who may change policies read it.
  const inventory = useQuery({
    queryKey: ['tunnel-probes'],
    queryFn: fetchTunnelProbes,
    staleTime: 60_000,
    enabled: editable,
    retry: false,
  });
  const probe = useTunnelProbeView(tenantId, outboundId, windowSecs);
  const chart = useTunnelProbeChart();
  const refresh = () => qc.invalidateQueries({ queryKey: ['tunnel-probe', tenantId, outboundId] });
  const start = useMutation({
    mutationFn: (source: TunnelProbeSource) => startTunnelProbe(tenantId, outboundId, source),
    onSuccess: refresh,
  });
  const cancel = useMutation({ mutationFn: (id: number) => cancelTunnelProbe(id), onSuccess: refresh });
  const available = capability.data?.available ?? false;

  if (probe.isPending) return <Loading variant="panel" />;
  const missing = probe.error instanceof ApiError && probe.error.status === 404;
  if (probe.error && !missing) return <ErrorBox error={probe.error} />;
  const view = missing ? null : (probe.data ?? null);
  const status = tunnelProbeStatus(view);
  const published = status.key !== 'unpublished';
  const active = view?.recent_runs.find(isActive) ?? (isActive(view?.item.latest_run) ? view!.item.latest_run : null);
  // A published tunnel can still carry an unpublished edit; its draft is then worth probing too.
  const draftChanged = draftEntries.some(
    entry =>
      entry.op.op === 'upsert_external_outbound' &&
      entry.op.outbound.tenant_id === tenantId &&
      entry.op.outbound.id === outboundId,
  );
  const blocked = !editable || !available || start.isPending;
  const blockedReason = !editable
    ? undefined
    : !available
      ? (capability.data?.reason ?? 'Console 拨测组件不可用')
      : undefined;

  return (
    <section className="panel config-panel cg-sec tnd-probe">
      <header>
        <PanelTitle of="observe">拨测</PanelTitle>
        <span className="sp" />
        {published && (
          <SegmentedControl
            className="tnd-seg"
            value={windowSecs}
            options={WINDOWS}
            onChange={onWindowChange}
            ariaLabel="拨测统计范围"
          />
        )}
        {active ? (
          <button
            className="btn"
            type="button"
            disabled={!editable || cancel.isPending || active.cancel_requested}
            onClick={() => cancel.mutate(active.id)}
          >
            {active.cancel_requested || cancel.isPending ? '取消中…' : '取消'}
          </button>
        ) : (
          <>
            {published && draftChanged && draftSupported && (
              <button
                className="btn"
                type="button"
                disabled={blocked}
                title={blockedReason ?? '草稿修改了这条隧道；拨测点击时冻结的草稿'}
                onClick={() => start.mutate('draft')}
              >
                拨测草稿
              </button>
            )}
            {(published || draftSupported) && (
              <button
                className="btn primary"
                type="button"
                disabled={blocked}
                title={blockedReason}
                onClick={() => start.mutate(published ? 'serving' : 'draft')}
              >
                {start.isPending ? '排队中…' : published ? '立即拨测' : '拨测草稿'}
              </button>
            )}
          </>
        )}
      </header>
      {active ? <ProbeProgress run={active} source={active.source} /> : <Verdict status={status} view={view} />}
      {editable && capability.data && !available && (
        <p className="tnd-notice">{capability.data.reason ?? 'Console 拨测组件不可用'}</p>
      )}
      {capability.error && <ErrorBox error={capability.error} />}
      {(start.error || cancel.error) && <ErrorBox error={start.error ?? cancel.error} />}
      <Metrics view={view} status={status} windowSecs={windowSecs} />
      {!published ? (
        <p className="tnd-chart-note">发布后开始定时拨测</p>
      ) : chart.status === 'ready' ? (
        <chart.Chart
          points={view!.points}
          windowSecs={windowSecs}
          endUnixSecs={Math.floor(probe.dataUpdatedAt / 1000)}
          bucketSecs={view!.bucket_secs}
          intervalSecs={view!.item.policy?.interval_secs ?? null}
          p50Ms={view!.summary.p50_ms}
          slowMs={view!.slow_ttfb_ms}
        />
      ) : chart.status === 'error' ? (
        <ErrorBox error={chart.error} />
      ) : (
        <div className="tnd-chart" aria-hidden />
      )}
      <div className="tnd-subhead">
        <b>拨测记录</b>
        <span>保留 {view?.retention_days ?? 7} 天 · 含手动与草稿</span>
      </div>
      <RunRows runs={view?.recent_runs ?? []} />
      <PolicyLine
        item={view?.item ?? null}
        published={published}
        endpointUrl={inventory.data?.endpoint_url ?? null}
        editable={editable}
        onEdit={() => setPolicyOpen(true)}
      />
      {policyOpen && view && <TunnelProbePolicyDialog item={view.item} onClose={() => setPolicyOpen(false)} />}
    </section>
  );
}

export function TunnelProbeSettingsSection({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TunnelProbeListItem | null>(null);
  const probes = useQuery({
    queryKey: ['tunnel-probes'],
    queryFn: fetchTunnelProbes,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const capability = useQuery({
    queryKey: ['tunnel-probe-capability'],
    queryFn: fetchTunnelProbeCapability,
    staleTime: 60_000,
  });
  const toggle = useMutation({
    mutationFn: ({ item, enabled }: { item: TunnelProbeListItem; enabled: boolean }) =>
      updateTunnelProbePolicy(item.tenant_id, item.outbound_id, {
        enabled,
        interval_secs: item.policy?.interval_secs ?? 300,
        timeout_secs: item.policy?.timeout_secs ?? 10,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnel-probes'] }),
  });

  // Both reads are required to describe this section. On the initial mount, extend the settings
  // page's existing loading boundary instead of replacing this one section with a second skeleton.
  if (probes.isPending || capability.isPending) return <Loading variant="settings" />;
  const items = probes.data?.items.filter(item => item.supported) ?? [];

  return (
    <section className="panel config-panel tunnel-probe-settings" id="set-tunnel-probes">
      <header>
        <PanelTitle of="tunnels">隧道定时监测</PanelTitle>
        <span className="tunnel-probe-setting-count">{items.length} 条隧道</span>
      </header>
      <p className="cardsub">由 Console 定时验证隧道可用性</p>
      {probes.error || capability.error ? (
        <ErrorBox error={probes.error ?? capability.error} />
      ) : (
        <div className="setgrp settings-block tunnel-probe-setting-content">
          <p className="eyebrow">执行环境</p>
          <div className="tunnel-probe-setting-facts">
            <span>Console</span>
            <code>{probes.data!.endpoint_url}</code>
            <b>{capability.data?.available ? `Xray ${capability.data.version ?? ''}` : '不可用'}</b>
          </div>
          {capability.data && !capability.data.available && (
            <p className="tunnel-probe-warning">{capability.data.reason ?? 'Console 拨测组件不可用'}</p>
          )}
          {toggle.error && <ErrorBox error={toggle.error} />}
          <p className="eyebrow tunnel-probe-setting-list-title">监测隧道</p>
          <div className="tunnel-probe-setting-list">
            {items.map(item => {
              const busy = toggle.isPending && toggle.variables.item.outbound_id === item.outbound_id;
              return (
                <article className="tunnel-probe-setting-row" key={`${item.tenant_id}/${item.outbound_id}`}>
                  <span className="tunnel-probe-setting-name">
                    <b>{item.name}</b>
                    <small>
                      {item.tenant_id} · {item.protocol}
                    </small>
                  </span>
                  <HealthBadge health={item.health} />
                  <span className="tunnel-probe-setting-schedule">
                    <b>{item.policy?.enabled ? intervalText(item.policy.interval_secs) : '未启用'}</b>
                    <small>
                      {item.policy?.enabled
                        ? `下次 ${dateText(item.policy.next_run_at_unix_secs)}`
                        : (item.unsupported_reason ?? '可随时手动拨测')}
                    </small>
                  </span>
                  <label className={`switch${!item.supported || !editable ? ' disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={item.policy?.enabled ?? false}
                      disabled={!item.supported || !editable || busy}
                      aria-label={`${item.name} 定时监测`}
                      onChange={event => toggle.mutate({ item, enabled: event.target.checked })}
                    />
                    <span className="switch-ui">
                      <span />
                    </span>
                    <span className="switch-label">{busy ? '保存中' : item.policy?.enabled ? '已启用' : '已暂停'}</span>
                  </label>
                  <button className="btn" disabled={!item.supported || !editable} onClick={() => setEditing(item)}>
                    设置
                  </button>
                </article>
              );
            })}
            {items.length === 0 && <p className="tunnel-probe-inline-empty">还没有可监测的隧道。</p>}
          </div>
        </div>
      )}
      {editing && <TunnelProbePolicyDialog item={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
