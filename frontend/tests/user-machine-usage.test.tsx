import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchSnapshot, fetchUserMachineUsage, type UserMachineUsage, type UserMachineUsageRow } from '../src/api';
import { machineCells, machineScale, UserMachineUsageCard } from '../src/user-machine-usage';
vi.mock('../src/api', async original => ({
  ...(await original<typeof import('../src/api')>()),
  fetchUserMachineUsage: vi.fn(),
  fetchSnapshot: vi.fn(),
}));
vi.mock('../src/ui/node-name', () => ({ useNodeCountries: () => () => 'HK' }));
const start = 1_792_166_400;
const row = (extra: Partial<UserMachineUsageRow> = {}): UserMachineUsageRow => ({
  node_id: 'n1',
  uplink_bytes: 100,
  downlink_bytes: 900,
  forwarding_bytes: 200,
  has_gap: false,
  expected: true,
  latest_report_unix_secs: start + 5 * 3600,
  points: [
    [start, 100, 900, 200, false, true],
    [start + 3600, 0, 0, 0, false, true],
    [start + 7200, 0, 0, 0, false, false],
  ],
  ...extra,
});
const data = (extra: Partial<UserMachineUsage> = {}): UserMachineUsage => ({
  period: 'day',
  range_start_unix_secs: start,
  range_end_unix_secs: start + 5 * 3600,
  period_end_unix_secs: start + 86400,
  bucket_secs: 3600,
  expected_nodes: 1,
  reporting_nodes: 1,
  rows: [row()],
  ...extra,
});
const fetcher = vi.mocked(fetchUserMachineUsage);
const mount = (user = 'alice', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={client}>
      <UserMachineUsageCard tenantId="fixture" userId={user} nameOf={id => (id === 'n1' ? '香港 DMIT' : id)} />
    </QueryClientProvider>,
  );
beforeEach(() => {
  fetcher.mockReset().mockResolvedValue(data());
  vi.mocked(fetchSnapshot)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 600,
    right: 1000,
    width: 1000,
    height: 600,
    toJSON() {},
  });
});
afterEach(() => cleanup());
it('keeps unknown, observed zero, and future cells distinct and aggregates mobile weeks without losing bytes', () => {
  const cells = machineCells(data(), row(), false);
  expect(cells).toHaveLength(24);
  expect(cells[1]).toMatchObject({ observed: true, gap: false, up: 0, down: 0 });
  expect(cells[2]).toMatchObject({ observed: false, gap: true, future: false });
  expect(cells[6]).toMatchObject({ observed: false, future: true });
  const week = data({ period: 'week', period_end_unix_secs: start + 7 * 86400 });
  const merged = machineCells(week, row(), true);
  expect(merged).toHaveLength(7);
  expect(merged[0]).toMatchObject({ up: 100, down: 900, forwarding: 200, gap: true });
  expect(machineCells(week, row(), false)).toHaveLength(168);
  const scale = machineScale(cells);
  expect(scale.level(0)).toBe('z');
  expect(scale.level(scale.floor / 2)).toBe('t');
  expect([0, 1, 2, 3].map(index => scale.level(scale.floor * 4 ** index))).toEqual(['l1', 'l2', 'l3', 'l4']);
});
it('renders the B matrix, supports keyboard reading and pins aggregate readings without a machine dialog', async () => {
  mount();
  await screen.findByText('香港 DMIT');
  const card = screen.getByRole('region', { name: '机器流量' });
  expect(card.querySelector('header .segsw')).toBeNull();
  expect(card.querySelectorAll('.uxm-strip button')).toHaveLength(24);
  const first = screen.getByRole('button', { name: /香港 DMIT · .*00:00–01:00/ });
  fireEvent.mouseEnter(first);
  expect(screen.getByRole('tooltip').textContent).toContain('含转发');
  const aggregate = within(card).getAllByRole('button', { name: /合计 ·/ })[0];
  expect(aggregate.getAttribute('aria-haspopup')).toBeNull();
  fireEvent.click(aggregate);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭读数' }));
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => first.focus());
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(document.activeElement?.getAttribute('aria-label')).toContain('01:00–02:00');
  expect(screen.getByRole('tooltip').textContent).toContain('0 B');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(screen.getByRole('tooltip').textContent).toContain('不能视为零流量');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it.each([
  ['day', '当天'],
  ['week', '当周'],
  ['month', '当月'],
] as const)('opens the shared machine usage dialog for %s and returns focus after dismissal', async (period, label) => {
  fetcher.mockImplementation(async (_tenantId, _userId, selectedPeriod) =>
    data({
      period: selectedPeriod,
      bucket_secs: selectedPeriod === 'month' ? 86400 : 3600,
      period_end_unix_secs: start + (selectedPeriod === 'month' ? 31 : selectedPeriod === 'week' ? 7 : 1) * 86400,
    }),
  );
  mount();
  await screen.findByText('香港 DMIT');
  expect(fetchSnapshot).not.toHaveBeenCalled();
  const card = screen.getByRole('region', { name: '机器流量' });
  fireEvent.click(within(screen.getByRole('group', { name: '机器统计范围' })).getByRole('button', { name: label }));
  await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('fixture', 'alice', period));
  await waitFor(() =>
    expect(card.querySelectorAll('.uxm-strip button')).toHaveLength(
      period === 'week' ? 168 : period === 'month' ? 31 : 24,
    ),
  );
  const cell = card.querySelector<HTMLButtonElement>('.uxm-strip button')!;
  expect(cell.getAttribute('aria-haspopup')).toBe('dialog');
  act(() => cell.focus());
  fireEvent.click(cell);
  const dialog = await screen.findByRole('dialog', { name: '香港 DMIT · 用量' });
  expect(dialog.querySelector('.node-usage-dialog')).toBeTruthy();
  expect(within(dialog).getByRole('img', { name: 'HK 地区旗' })).toBeTruthy();
  const range = within(dialog).getByRole('group', { name: '流入与流出统计范围' });
  expect(within(range).getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('region', { name: '机器流量' })).toBe(card);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(fetchSnapshot).toHaveBeenCalledOnce();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(cell));
});
it('preserves totals without assigning legacy bytes to a fake hour and reports stale refresh failures', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetcher.mockResolvedValue(
    data({
      rows: [
        row(),
        row({
          node_id: null,
          uplink_bytes: 200,
          downlink_bytes: 800,
          forwarding_bytes: 0,
          expected: false,
          points: [],
        }),
      ],
    }),
  );
  mount('alice', client);
  await screen.findByText('未按机器记录');
  expect(screen.getByText(/没有保留小时明细/).textContent).toContain('1000 B');
  const unknownCells = document.querySelectorAll('.uxm-row.unsplit .uxm-cell');
  expect([...unknownCells].filter(cell => cell.classList.contains('l1'))).toHaveLength(0);
  expect(unknownCells[0].getAttribute('aria-haspopup')).toBeNull();
  fireEvent.click(unknownCells[0]);
  expect(screen.getByRole('tooltip').textContent).toContain('不能视为零流量');
  expect(screen.queryByRole('dialog')).toBeNull();
  fetcher.mockRejectedValue(new Error('offline'));
  await act(() => client.invalidateQueries({ queryKey: ['user-machine-usage'] }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('上次读取的数据');
});
it('labels retained range data during loading and never reuses another user’s reading', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = mount('alice', client);
  await screen.findByText('香港 DMIT');
  fetcher.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(within(screen.getByRole('group', { name: '机器统计范围' })).getByRole('button', { name: '当周' }));
  await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith('fixture', 'alice', 'week'));
  expect(screen.getByRole('status').textContent).toContain('暂时显示当天数据');
  view.rerender(
    <QueryClientProvider client={client}>
      <UserMachineUsageCard tenantId="fixture" userId="bob" />
    </QueryClientProvider>,
  );
  expect(screen.queryByText('香港 DMIT')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('正在读取');
});
it('does not call a no-report response zero traffic', async () => {
  fetcher.mockResolvedValue(data({ expected_nodes: 0, reporting_nodes: 0, rows: [] }));
  mount();
  expect(await screen.findByText(/无法确认本范围是否有流量/)).toBeTruthy();
});

it('dismisses the old machine dialog when the user context changes', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = mount('alice', client);
  await screen.findByText('香港 DMIT');
  fireEvent.click(document.querySelector<HTMLButtonElement>('.uxm-strip button')!);
  await screen.findByRole('dialog', { name: '香港 DMIT · 用量' });
  view.rerender(
    <QueryClientProvider client={client}>
      <UserMachineUsageCard tenantId="fixture" userId="bob" />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(
    <QueryClientProvider client={client}>
      <UserMachineUsageCard tenantId="fixture" userId="alice" />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});
