import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchNodeInflowDetails, type NodeInflowDetails, type NodeInflowDetailRow } from '../src/api';
import { NodeInflowDetailsDialog } from '../src/node-inflow-details';
import { parseTrafficRange, trafficDateInput } from '../src/node-traffic-range';
import { copyText } from '../src/ui/platform';

vi.mock('../src/api', async original => ({
  ...(await original<typeof import('../src/api')>()),
  fetchNodeInflowDetails: vi.fn(),
}));
vi.mock('../src/ui/platform', async original => ({
  ...(await original<typeof import('../src/ui/platform')>()),
  copyText: vi.fn(async () => true),
}));
const start = 1792454400;
const row = (
  ip: string | null,
  down: number,
  up: number,
  source: NodeInflowDetailRow['source'] = 'chain',
): NodeInflowDetailRow => ({
  tenant_id: 'platform.acme',
  user_id: 'alice',
  source,
  app_id: source === 'chain' ? 'app' : null,
  chain_id: source === 'chain' ? 'a' : null,
  ingress_id: null,
  source_ip: ip,
  downlink_bytes: down,
  uplink_bytes: up,
  has_gap: false,
});
const data = (extra: Partial<NodeInflowDetails> = {}): NodeInflowDetails => ({
  range_start_unix_secs: start,
  range_end_unix_secs: start + 300,
  observed_since_unix_secs: start,
  latest_report_unix_secs: start + 300,
  limited: false,
  accounting_mismatch: false,
  accounting_downlink_bytes: 420,
  accounting_uplink_bytes: 180,
  rows: [row('192.0.2.1', 210, 90), row('2001:db8::1', 140, 60), row(null, 70, 30, 'forwarding')],
  ...extra,
});
const mount = (user = 'alice', range = { start_unix_secs: start, end_unix_secs: start + 300 }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeInflowDetailsDialog
        nodeId="n1"
        tenantId="platform.acme"
        userId={user}
        period="day"
        range={range}
        sourceOf={key => ({ key, name: '澳门示例 01', country: 'MO' })}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
};
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.mocked(fetchNodeInflowDetails).mockResolvedValue(data());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('shows per-source directions and totals, sorts independently and copies the exact source', async () => {
  mount();
  const table = await screen.findByRole('table', { name: '用户接入链与来源流量明细' });
  const body = table.querySelector('tbody')!;
  expect(body.rows).toHaveLength(3);
  expect(table.textContent).not.toContain('platform.acme');
  expect(table.querySelector('[title="platform.acme"]')).toBeNull();
  expect(body.rows[0].textContent).toContain('192.0.2.1');
  expect(body.rows[0].textContent).toContain('210 B');
  expect(body.rows[0].textContent).toContain('90 B');
  expect(body.rows[0].textContent).toContain('300 B');
  expect(table.querySelector('tfoot')?.textContent).toContain('600 B');
  expect(screen.getByText('未按来源拆分')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '按流量总量排序' }));
  expect(body.rows[0].textContent).toContain('端口转发');
  expect(
    within(table)
      .getByRole('columnheader', { name: /流量总量/ })
      .getAttribute('aria-sort'),
  ).toBe('ascending');
  fireEvent.click(screen.getByRole('button', { name: '复制来源 IP 2001:db8::1' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith('2001:db8::1'));
  expect(vi.mocked(fetchNodeInflowDetails)).toHaveBeenCalledWith('n1', 'platform.acme', 'alice', 'day', {
    start_unix_secs: start,
    end_unix_secs: start + 300,
  });
});

it('keeps missing source bytes explicit and exposes incomplete observations and accounting mismatches', async () => {
  vi.mocked(fetchNodeInflowDetails).mockResolvedValue(
    data({ rows: [row(null, 420, 180)], limited: true, accounting_mismatch: true }),
  );
  mount();
  await screen.findByText('未归属来源');
  expect(screen.queryByRole('button', { name: /复制来源 IP/ })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('来源观测不完整');
  expect(screen.getByText(/接入归属或采样窗口存在差异/)).toBeTruthy();
});

it('shows a retryable error and never turns a failed request into empty or zero traffic', async () => {
  vi.mocked(fetchNodeInflowDetails).mockRejectedValueOnce(new Error('offline'));
  mount();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('明细读取失败');
  expect(screen.queryByText('所选时段没有已记录的流入明细。')).toBeNull();
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  await screen.findByRole('table');
});

it('interprets time inputs at UTC+8 and rejects inverted, future, oversized and partial windows', () => {
  const now = 1792458000;
  expect(trafficDateInput(start)).toBe('2026-10-20T08:00:00');
  expect(parseTrafficRange(trafficDateInput(start), trafficDateInput(start + 300), now)).toEqual({
    start_unix_secs: start,
    end_unix_secs: start + 300,
  });
  for (const [from, to] of [
    ['', ''],
    [trafficDateInput(start + 300), trafficDateInput(start)],
    [trafficDateInput(start), trafficDateInput(now + 300)],
    [trafficDateInput(start - 32 * 86400), trafficDateInput(start)],
    [trafficDateInput(start + 1), trafficDateInput(start + 300)],
  ]) {
    expect(typeof parseTrafficRange(from, to, now)).toBe('string');
  }
});
