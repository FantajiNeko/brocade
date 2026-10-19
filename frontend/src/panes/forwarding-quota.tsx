import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchForwardingQuotaJobs, type ForwardingEntitlement, type ForwardingQuotaJob } from '../api';
import { ErrorBox } from '../ui/bits';
import { Icon } from '../ui/icons';

const GiB = 1024 ** 3;
const JOB_STATE: Record<ForwardingQuotaJob['status'], string> = {
  queued: '等待节点领取',
  running: '等待节点确认',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};

export const forwardingQuotaJobsKey = (tenant: string, user: string, node: string) =>
  ['forwarding-quota-jobs', tenant, user, node] as const;

export function forwardingQuotaBytes(text: string): number | null | undefined {
  if (!text.trim()) return null;
  if (text.length > 24) return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text.trim())) return undefined;
  const [whole, fraction = ''] = text.trim().split('.');
  const value = Number(((BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(GiB) + 50n) / 100n);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A displayed decimal is not a byte-exact round trip; unchanged text keeps its original quota. */
export const forwardingQuotaText = (limit: number | null | undefined) =>
  limit == null ? '' : (limit / GiB).toFixed(2);
export const forwardingQuotaValue = (text: string, initialText: string, initialBytes: number | null) =>
  text === initialText ? initialBytes : forwardingQuotaBytes(text);

export function ForwardingQuotaHistory({
  tenant,
  user,
  entry,
}: {
  tenant: string;
  user: string;
  entry: ForwardingEntitlement;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState<number | undefined>();
  const history = useQuery({
    queryKey: [...forwardingQuotaJobsKey(tenant, user, entry.node_id), before, entry.quota_job_id],
    queryFn: () => fetchForwardingQuotaJobs(tenant, user, entry.node_id, before),
    enabled: open,
    refetchInterval: query =>
      open && query.state.data?.jobs.some(job => job.status === 'queued' || job.status === 'running') ? 5000 : false,
  });
  return (
    <>
      <button
        type="button"
        className={`fwe-link ${entry.quota_job_status ?? ''}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(value => !value)}
      >
        配额工单{entry.quota_job_status ? ` · ${JOB_STATE[entry.quota_job_status]}` : ''}
        <Icon of="chevronDown" size={10} />
      </button>
      {open && (
        <section id={id} className="fwd-quota-history" aria-label="转发配额自动化工单">
          {history.isPending ? (
            <p>正在读取工单…</p>
          ) : history.error ? (
            <ErrorBox error={history.error} />
          ) : (
            <>
              {history.data.jobs.length === 0 ? (
                <p className="dim">暂无配额工单</p>
              ) : (
                <ul className="fwd-quota-jobs">
                  {history.data.jobs.map(job => (
                    <li key={job.id}>
                      <article className="fwd-quota-job" aria-label={`配额工单 #${job.id}`}>
                        <div className="fwd-quota-job-head">
                          <strong>{job.suspended ? '暂停转发' : '恢复转发'}</strong>
                          <span
                            className={`fwd-st${job.status === 'canceled' ? ' off' : job.last_error || job.status === 'failed' ? ' bad' : ''}`}
                          >
                            {JOB_STATE[job.status]}
                          </span>
                        </div>
                        <div className="fwd-quota-job-meta">
                          <code>#{job.id}</code>
                          <small>{job.created_at}</small>
                        </div>
                        {job.last_error && (
                          <p className={job.status === 'canceled' ? 'dim' : 'fwd-quota-job-error'}>{job.last_error}</p>
                        )}
                      </article>
                    </li>
                  ))}
                </ul>
              )}
              <div className="fwd-quota-pages">
                {before !== undefined && (
                  <button className="btn" type="button" onClick={() => setBefore(undefined)}>
                    最新工单
                  </button>
                )}
                {history.data.next_before_id !== null && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setBefore(history.data.next_before_id ?? undefined)}
                  >
                    更早工单
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
