import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DataRetentionView } from '../src/api';

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { DataRetentionSection } = await import('../src/panes/settings');

const view: DataRetentionView = {
  policies: [
    {
      table_name: 'node_ping_probe_samples',
      title: 'Ping 探测样本',
      description: '机器到探测目标的逐次延迟。',
      category: 'history',
      ttl_hours: 168,
      default_ttl_hours: 168,
      min_ttl_hours: 1,
      max_ttl_hours: 87600,
      customized: false,
      estimated_rows: 17_117_236,
      total_bytes: 1_671_168_000,
    },
    {
      table_name: 'usage_report_receipts',
      title: '用量上报回执',
      description: '重复上报的短期幂等响应。',
      category: 'temporary',
      ttl_hours: 168,
      default_ttl_hours: 168,
      min_ttl_hours: 1,
      max_ttl_hours: 87600,
      customized: false,
      estimated_rows: 12,
      total_bytes: 65_536,
    },
  ],
};

function Harness() {
  const query = useQuery({ queryKey: ['data-retention'], queryFn: async () => view, initialData: view });
  return <DataRetentionSection editable data={query.data} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('groups only catalogued bounded tables and saves a shorter TTL after confirmation', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const next = {
      policies: view.policies.map(policy =>
        policy.table_name === 'node_ping_probe_samples'
          ? { ...policy, ttl_hours: body.ttl_hours, customized: true }
          : policy,
      ),
    };
    return Response.json(next);
  });
  vi.stubGlobal('fetch', fetch);

  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );

  const details = document.getElementById('set-data-retention') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector('summary')!);
  expect(details.open).toBe(true);
  expect(screen.getByText('历史数据 · 1 张表')).toBeDefined();
  expect(screen.getByText('临时数据 · 1 张表')).toBeDefined();
  expect(screen.getByText('node_ping_probe_samples')).toBeDefined();
  expect(screen.queryByText('users')).toBeNull();

  const row = screen.getByText('node_ping_probe_samples').closest<HTMLElement>('[role="listitem"]')!;
  const ttl = within(row).getByLabelText('Ping 探测样本 TTL');
  expect((ttl as HTMLInputElement).value).toBe('7');
  fireEvent.change(ttl, { target: { value: '3' } });
  fireEvent.click(details.querySelector('summary')!);
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector('summary')!);
  expect((ttl as HTMLInputElement).value).toBe('3');
  fireEvent.click(within(row).getByRole('button', { name: '保存' }));

  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('永久删除'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0][0]).toBe('/data-retention/node_ping_probe_samples');
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ ttl_hours: 72 });
  await waitFor(() => expect((screen.getByLabelText('Ping 探测样本 TTL') as HTMLInputElement).value).toBe('3'));
});

it('does not send an invalid TTL', () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.click(document.querySelector('#set-data-retention > summary')!);
  const ttl = screen.getByLabelText('Ping 探测样本 TTL');
  fireEvent.change(ttl, { target: { value: '0' } });
  expect(screen.getByText(/TTL 需为/)).toBeDefined();
  const row = screen.getByText('node_ping_probe_samples').closest<HTMLElement>('[role="listitem"]')!;
  expect((within(row).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
