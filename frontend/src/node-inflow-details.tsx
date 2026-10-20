import { useId, useMemo, useState } from 'react';
import { fetchNodeInflowDetails, type NodeInflowDetailRow, type SiteUsagePeriod, type TrafficTimeRange } from './api';
import { trafficRangeText } from './node-traffic-range';
import { fallbackSource, type TrafficSource } from './user-traffic-realtime';
import { CopyButton } from './ui/copy-button';
import { DialogClose, DialogLayer } from './ui/dialog';
import { bytes, shareOf } from './ui/format';
import { Icon, PanelTitle } from './ui/icons';
import { PanelLoading } from './ui/loading';
import { useMetricQuery } from './ui/metric-cadence';
import { RegionFlag } from './ui/region-flag';
import { GeneratedUserAvatar } from './ui/user-avatar';

const sourceKey = (row: NodeInflowDetailRow) =>
  row.source === 'chain' ? JSON.stringify([row.app_id, row.chain_id, row.ingress_id]) : row.source;

function resolvedSource(row: NodeInflowDetailRow, sourceOf: (key: string) => TrafficSource) {
  const source = sourceOf(sourceKey(row));
  if (row.source === 'forwarding') return { ...source, name: '端口转发' };
  if (row.source === 'unattributed') return { ...source, name: '未按接入链记录' };
  return {
    ...source,
    name: source.muted ? (row.chain_id ? `接入链 ${row.chain_id}` : `历史接入点 ${row.ingress_id ?? ''}`) : source.name,
  };
}

type Order = 'down' | 'up' | 'total';
const totalOf = (row: NodeInflowDetailRow) => row.uplink_bytes + row.downlink_bytes;
const rowKey = (row: NodeInflowDetailRow) =>
  JSON.stringify([row.tenant_id, row.user_id, sourceKey(row), row.source_ip]);

export function NodeInflowDetailsDialog({
  nodeId,
  nodeName,
  tenantId,
  userId,
  period,
  range,
  sourceOf = fallbackSource,
  onClose,
}: {
  nodeId: string;
  nodeName?: string;
  tenantId: string;
  userId: string;
  period: SiteUsagePeriod;
  range?: TrafficTimeRange;
  sourceOf?: (key: string) => TrafficSource;
  onClose: () => void;
}) {
  const titleId = useId();
  const [sort, setSort] = useState<Order>('total');
  const [ascending, setAscending] = useState(false);
  const query = useMetricQuery({
    queryKey: ['node-inflow-details', nodeId, tenantId, userId, period, range],
    queryFn: () => fetchNodeInflowDetails(nodeId, tenantId, userId, period, range),
    staleTime: 15_000,
    refetchInterval: 30_000,
    metricFacts: data => [data.limited, data.accounting_mismatch],
  });
  const rows = useMemo(
    () =>
      [...(query.data?.rows ?? [])].sort((a, b) => {
        const value = (row: NodeInflowDetailRow) =>
          sort === 'total' ? totalOf(row) : sort === 'down' ? row.downlink_bytes : row.uplink_bytes;
        return (value(b) - value(a)) * (ascending ? -1 : 1) || rowKey(a).localeCompare(rowKey(b));
      }),
    [query.data, sort, ascending],
  );
  const down = rows.reduce((sum, row) => sum + row.downlink_bytes, 0);
  const up = rows.reduce((sum, row) => sum + row.uplink_bytes, 0);
  const total = up + down;
  const order = (key: Order) => {
    setAscending(sort === key && !ascending);
    setSort(key);
  };
  const renderSort = (key: Order, label: string) => (
    <th
      scope="col"
      className="nid-number"
      aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" onClick={() => order(key)} className="nid-sort" aria-label={`按${label}排序`}>
        {label}
        <span aria-hidden="true">{sort === key ? (ascending ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );
  return (
    <DialogLayer label={`${userId} · 流入明细`} onClose={onClose}>
      <section className="dialog-surface node-inflow-dialog" aria-labelledby={titleId}>
        <header className="node-usage-header">
          <div className="node-usage-identity">
            <PanelTitle of="usage">
              <span id={titleId}>流入明细</span>
            </PanelTitle>
            <span className="nid-identity">
              {nodeName || nodeId} ／ {userId}
            </span>
          </div>
          <DialogClose className="btn sm node-usage-close" aria-label="关闭流入明细">
            <Icon of="close" size={16} />
          </DialogClose>
        </header>
        {query.data && (
          <div className="nid-range">
            <Icon of="clock" size={14} />
            <span>{trafficRangeText(query.data.range_start_unix_secs, query.data.range_end_unix_secs)}</span>
            <span>UTC+8</span>
          </div>
        )}
        <div className="nid-body" aria-busy={query.isFetching}>
          {query.isPending && <PanelLoading label="加载来源流量明细" />}
          {query.isError && (
            <p role="alert" className="nid-note">
              {query.data ? '明细刷新失败，当前显示上次读取的数据。' : '明细读取失败。'}
              <button type="button" className="btn text sm" onClick={() => query.refetch()}>
                重试
              </button>
            </p>
          )}
          {query.data && (
            <>
              <div className="nid-summary">
                <strong>{bytes(total)}</strong>
                <span>
                  下行 <b>{bytes(down)}</b>
                </span>
                <span>
                  上行 <b>{bytes(up)}</b>
                </span>
                <span className="nid-count">
                  {new Set(rows.map(sourceKey)).size} 个接入来源 ·{' '}
                  {new Set(rows.flatMap(row => (row.source_ip ? [row.source_ip] : []))).size} 个来源 IP
                </span>
              </div>
              {rows.length > 0 ? (
                <div className="nid-table-scroll">
                  <table className="nid-table" aria-label="用户接入链与来源流量明细">
                    <thead>
                      <tr>
                        <th scope="col">用户</th>
                        <th scope="col">接入 chain</th>
                        <th scope="col">来源地址</th>
                        {renderSort('down', '下行')}
                        {renderSort('up', '上行')}
                        {renderSort('total', '流量总量')}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => {
                        const source = resolvedSource(row, sourceOf);
                        return (
                          <tr key={rowKey(row)}>
                            <td>
                              <span className="nid-user">
                                <GeneratedUserAvatar id={row.user_id} variant="mini" />
                                <span>{row.user_id}</span>
                              </span>
                            </td>
                            <td>
                              <span className="nt-chain">
                                {row.source === 'forwarding' ? (
                                  <Icon of="forwarding" size={14} />
                                ) : source.country ? (
                                  <RegionFlag code={source.country} />
                                ) : null}
                                <span className="nid-chain-name">{source.name}</span>
                              </span>
                            </td>
                            <td>
                              {row.source_ip ? (
                                <span className="nid-source">
                                  <code>{row.source_ip}</code>
                                  <CopyButton
                                    text={row.source_ip}
                                    label={`复制来源 IP ${row.source_ip}`}
                                    className="btn text sm"
                                    iconOnly
                                  />
                                </span>
                              ) : (
                                <span className="nid-unknown">
                                  {row.source === 'forwarding' ? '未按来源拆分' : '未归属来源'}
                                  <small>{row.source === 'forwarding' ? '端口转发合计' : '仅有用户与接入统计'}</small>
                                </span>
                              )}
                            </td>
                            <td className="nid-number">{bytes(row.downlink_bytes)}</td>
                            <td className="nid-number">{bytes(row.uplink_bytes)}</td>
                            <td className="nid-number">
                              <strong>{bytes(totalOf(row))}</strong>
                              <span
                                className="nid-meter"
                                aria-hidden="true"
                                title={`占合计 ${shareOf(totalOf(row), total)}`}
                              >
                                <i
                                  className="down"
                                  style={{ width: `${total > 0 ? (row.downlink_bytes / total) * 100 : 0}%` }}
                                />
                                <i
                                  className="up"
                                  style={{ width: `${total > 0 ? (row.uplink_bytes / total) * 100 : 0}%` }}
                                />
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" colSpan={3}>
                          合计
                        </th>
                        <td className="nid-number">{bytes(down)}</td>
                        <td className="nid-number">{bytes(up)}</td>
                        <td className="nid-number">{bytes(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="nid-note">所选时段没有已记录的流入明细。</p>
              )}
              <footer className="nid-notes">
                <p>
                  来源流量需启用在线来源统计，从新版采集启用后记录；历史、遗漏和端口转发保留为未拆分的合计，不按 IP
                  均摊。
                </p>
                {query.data.limited && (
                  <p className="warn" role="status">
                    来源观测不完整或达到容量／保留上限，仅展示已记录数据。
                  </p>
                )}
                {query.data.accounting_mismatch && (
                  <p className="warn">
                    来源观测与用量汇总的接入归属或采样窗口存在差异，无法确认的部分合并到未归属行；用量统计为下行{' '}
                    {bytes(query.data.accounting_downlink_bytes)}、上行 {bytes(query.data.accounting_uplink_bytes)}。
                  </p>
                )}
                {rows.some(row => row.has_gap) && <p className="warn">所选时段存在用量采集缺口。</p>}
                <span>{rows.length} 条明细</span>
              </footer>
            </>
          )}
        </div>
      </section>
    </DialogLayer>
  );
}
