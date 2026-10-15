import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserTrafficHistory } from '../src/api';
import { NodeRealtimeProvider } from '../src/node-realtime';
import {
  aggregateUserTraffic,
  hourModel,
  mergeRetained,
  nextListOrder,
  NodeUserTrafficCard,
  UserRealtimeTrafficCard,
  type CardRow,
} from '../src/user-traffic-realtime';

// This suite verifies card aggregation and source labels; the real canvas is covered by
// browser checks. Letting the lazy chart import settle between tests makes jsdom timing-dependent.
vi.mock('../src/panes/telemetry', () => ({ ThroughputChart: () => null }));

class Events {
  static sources: Events[] = [];
  handlers = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    Events.sources.push(this);
  }
  addEventListener(name: string, callback: (event: { data: string }) => void) {
    this.handlers.set(name, callback);
  }
  close() {
    this.closed = true;
  }
  send(name: string, value: unknown) {
    this.handlers.get(name)?.({ data: JSON.stringify(value) });
  }
}

// 1_760_000_025 落在 30 秒格的中间：格起点是 …010，窗口结束于 T-30 / T-60 / T-90 各落在前一格。
const T = 1_760_000_025;
const rate = (user = 'alice', ingress = 'entry', uplink = 1024, downlink = 2048, tenant = 'platform') => ({
  tenant_id: tenant,
  user_id: user,
  ingress_id: ingress,
  uplink_bytes_per_sec: uplink,
  downlink_bytes_per_sec: downlink,
});
const event = (node = 'n1', users = [rate()], all = true, report: Record<string, unknown> = {}) => ({
  node_id: node,
  received_at_unix_millis: Date.now(),
  sample: {
    sampled_at_unix_millis: Date.now(),
    user_traffic: { state: 'ready', all_users: all, elapsed_millis: 1000, users, ...report },
  },
});
const node = (id: string, users = [rate()]) => ({
  node_id: id,
  connected: true,
  active: true,
  samples: [event(id, users, false)],
});
const history = (
  nodes: Record<string, number[]>,
  series: Array<[string, string, Array<[number, number, number]>]> = [],
): UserTrafficHistory => ({
  range_start_unix_secs: T - 3_600,
  range_end_unix_secs: T,
  nodes: Object.entries(nodes).map(([node_id, window_ends_unix_secs]) => ({ node_id, window_ends_unix_secs })),
  series: series.map(([node_id, user, points]) => ({ node_id, tenant_id: 'platform', user_id: user, points })),
});

let served: UserTrafficHistory;
const renderCard = (card: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {card}
    </QueryClientProvider>,
  );
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const names = (list: HTMLElement) =>
  within(list)
    .queryAllByRole('listitem')
    .map(item => item.querySelector('.rut-name')?.textContent);
const item = (list: HTMLElement, name: string) => {
  const found = within(list)
    .queryAllByRole('listitem')
    .find(row => row.querySelector('.rut-name')?.textContent === name);
  if (!found) throw new Error(`row ${name} is missing`);
  return found;
};
const currentDown = (row: HTMLElement) => row.querySelector('.rut-rate.d .rut-rate-text')?.textContent;

beforeEach(() => {
  Events.sources = [];
  vi.useFakeTimers({ now: T * 1000 });
  vi.stubGlobal('EventSource', Events);
  served = history({ n1: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/user-history') || path.endsWith('/realtime/history')) return Response.json(served);
      return new Promise<Response>(() => {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('realtime user traffic data', () => {
  it('combines access and forwarding for one user while retaining source rates', () => {
    const rows = aggregateUserTraffic([
      rate(),
      {
        tenant_id: 'platform',
        user_id: 'alice',
        forwarding_rule_id: 7,
        uplink_bytes_per_sec: 100,
        downlink_bytes_per_sec: 200,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ up: 1124, down: 2248, forwardingUp: 100, forwardingDown: 200 });
  });

  it('uses actual forwarding windows and keeps unplaced legacy bytes out of the curve', () => {
    const end = Math.floor(T / 30) * 30;
    const model = hourModel(
      {
        range_start_unix_secs: end - 60,
        range_end_unix_secs: end,
        nodes: [
          {
            node_id: 'n1',
            window_ends_unix_secs: [],
            windows: [],
            forwarding_windows: [
              [end - 60, end - 45],
              [end - 45, end - 30],
              [end - 30, end - 15],
              [end - 15, end],
            ],
          },
        ],
        series: [
          {
            node_id: 'n1',
            tenant_id: 'platform',
            user_id: 'alice',
            forwarding: true,
            points: [],
            windows: [
              [end - 60, end - 45, 15, 30],
              [end - 45, end - 30, 15, 30],
              [end - 30, end - 15, 15, 30],
              [end - 15, end, 15, 30],
            ],
            unplaced_uplink_bytes: 7,
            unplaced_downlink_bytes: 11,
          },
        ],
      },
      'node',
    );
    expect(model.rows.get('platform/alice')).toMatchObject({
      up: [30, 30],
      down: [60, 60],
      hourUp: 67,
      hourDown: 131,
      unplaced: true,
    });
    expect(model.totalDown).toEqual([60, 60]);
  });

  it('does not turn missing forwarding collection into zero when access still reports', () => {
    const end = Math.floor(T / 30) * 30;
    const model = hourModel(
      {
        range_start_unix_secs: end - 60,
        range_end_unix_secs: end,
        nodes: [
          {
            node_id: 'n1',
            window_ends_unix_secs: [],
            windows: [[end - 60, end]],
            forwarding_windows: [[end - 30, end]],
          },
        ],
        series: [
          { node_id: 'n1', tenant_id: 'platform', user_id: 'alice', points: [], windows: [[end - 60, end, 60, 120]] },
          {
            node_id: 'n1',
            tenant_id: 'platform',
            user_id: 'alice',
            forwarding: true,
            points: [],
            windows: [[end - 30, end, 30, 60]],
          },
        ],
      },
      'node',
    );
    expect(model.rows.get('platform/alice')?.down).toEqual([null, 120]);
    expect(model.totalDown).toEqual([null, 120]);
  });
  it('groups one user across ingress labels without combining tenants', () => {
    const rows = aggregateUserTraffic([rate(), rate('alice', 'second'), rate('alice', 'entry', 1, 1, 'other')]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: 'platform/alice', up: 2048, down: 4096 });
  });

  it('keeps idle windows at zero and uncollected windows empty', () => {
    const model = hourModel(
      history({ n1: [T - 90, T - 60, T - 30] }, [
        [
          'n1',
          'alice',
          [
            [T - 90, 30, 60],
            [T - 30, 3, 6],
          ],
        ],
      ]),
      'node',
    );
    const row = model.rows.get('platform/alice');
    const last = model.slots.length - 1;
    expect(row?.down.slice(last - 3)).toEqual([60, 0, 6, null]);
    expect(row?.down[0]).toBeNull();
    expect(row).toMatchObject({ hourDown: 66, hourUp: 33, lastActiveMs: (T - 30) * 1000 });
    expect(model.totalDown.slice(last - 3)).toEqual([60, 0, 6, null]);
  });

  it('lists every granted machine on the user page and sums machines in the total', () => {
    const model = hourModel(
      history({ n1: [T - 30], n2: [T - 30] }, [
        ['n1', 'alice', [[T - 30, 1, 2]]],
        ['n2', 'alice', [[T - 30, 3, 4]]],
      ]),
      'user',
    );
    expect([...model.rows.keys()].sort()).toEqual(['n1', 'n2']);
    expect(model.totalDown[model.slots.length - 2]).toBe(6);
  });

  it('spreads a 45-second reading by its real duration instead of creating an empty bucket', () => {
    const end = Math.floor(T / 30) * 30;
    const input: UserTrafficHistory = {
      range_start_unix_secs: end - 90,
      range_end_unix_secs: end,
      nodes: [
        {
          node_id: 'n1',
          window_ends_unix_secs: [end - 45, end],
          windows: [
            [end - 90, end - 45],
            [end - 45, end],
          ],
          zero_windows: [],
        },
      ],
      series: [
        {
          node_id: 'n1',
          tenant_id: 'platform',
          user_id: 'alice',
          points: [[end, 90, 450]],
          windows: [[end - 45, end, 90, 450]],
        },
      ],
    };
    const model = hourModel(input, 'node');
    expect(model.totalDown).toEqual([0, 150, 300]);
    expect(model.rows.get('platform/alice')).toMatchObject({ hourDown: 450, hourUp: 90 });
    expect(model.peak).toBe(12);
  });

  it('draws confirmed restart downtime as zero but leaves unknown intervals missing', () => {
    const end = Math.floor(T / 30) * 30;
    const input: UserTrafficHistory = {
      range_start_unix_secs: end - 120,
      range_end_unix_secs: end,
      nodes: [
        {
          node_id: 'n1',
          window_ends_unix_secs: [end - 60, end],
          windows: [[end - 90, end]],
          zero_windows: [[(end - 60) * 1000, (end - 30) * 1000]],
        },
      ],
      series: [
        {
          node_id: 'n1',
          tenant_id: 'platform',
          user_id: 'alice',
          points: [[end, 60, 600]],
          windows: [[end - 90, end, 60, 600]],
        },
      ],
    };
    const model = hourModel(input, 'node');
    expect(model.totalDown).toEqual([null, 300, 0, 300]);
    expect(model.totalUp).toEqual([null, 30, 0, 30]);
    expect(model.rows.get('platform/alice')).toMatchObject({ hourDown: 600, hourUp: 60 });
  });

  it('clips boundary windows while retaining the right rate for a partial 30-second slot', () => {
    const end = Math.floor(T / 30) * 30 + 15;
    const input: UserTrafficHistory = {
      range_start_unix_secs: end - 30,
      range_end_unix_secs: end,
      nodes: [{ node_id: 'n1', window_ends_unix_secs: [end], windows: [[end - 60, end]], zero_windows: [] }],
      series: [
        {
          node_id: 'n1',
          tenant_id: 'platform',
          user_id: 'alice',
          points: [[end, 0, 600]],
          windows: [[end - 60, end, 0, 600]],
        },
      ],
    };
    const model = hourModel(input, 'node');
    expect(model.totalDown).toEqual([300, 300]);
    expect(model.rows.get('platform/alice')?.hourDown).toBe(300);
    expect(model.peak).toBe(10);
  });

  it('retains rows between reports and zeroes them only when a report is complete', () => {
    const first = mergeRetained(new Map(), [{ key: 'a', name: 'a', detail: 't', down: 10, up: 1 }], true, 1_000);
    const idle = mergeRetained(first, [], true, 2_000);
    expect(idle.get('a')).toMatchObject({ down: 0, up: 0, lastActiveMs: 1_000 });
    const truncated = mergeRetained(first, [], false, 2_000);
    expect(truncated.get('a')).toMatchObject({ down: 10, up: 1 });
    const unknown = mergeRetained(first, [{ key: 'a', name: 'a', detail: 't', down: null, up: null }], false, 3_000);
    expect(unknown.get('a')).toMatchObject({ down: 10, up: 1, lastActiveMs: 1_000 });
  });

  it('keeps the name order fixed and reorders by rate only on the chosen cadence', () => {
    const row = (key: string, down: number, hourBytes = 0): CardRow => ({
      key,
      name: key,
      detail: '',
      down,
      up: 0,
      offline: false,
      hour: null,
      hourBytes,
      lastActiveMs: null,
    });
    const start = { keys: [], at: Number.NEGATIVE_INFINITY, sort: 'name' as const };
    const named = nextListOrder(start, [row('b', 10), row('a', 5)], 'name', false, 0);
    expect(named.keys).toEqual(['a', 'b']);
    expect(nextListOrder(named, [row('b', 99), row('a', 5)], 'name', false, 60_000)).toBe(named);
    expect(nextListOrder(named, [row('b', 1), row('c', 1), row('a', 1)], 'name', false, 1_000).keys).toEqual([
      'a',
      'b',
      'c',
    ]);
    const byDown = nextListOrder(named, [row('b', 10), row('a', 5)], 'down', false, 1_000);
    expect(byDown.keys).toEqual(['b', 'a']);
    const swapped = [row('b', 1), row('a', 50)];
    expect(nextListOrder(byDown, swapped, 'down', false, 3_000)).toBe(byDown);
    expect(nextListOrder(byDown, swapped, 'down', true, 9_000)).toBe(byDown);
    expect(nextListOrder(byDown, swapped, 'down', false, 9_000).keys).toEqual(['a', 'b']);
  });
});

describe('machine user traffic card', () => {
  it('does not present old access-only Agent reports as complete forwarding traffic', async () => {
    renderCard(
      <NodeRealtimeProvider nodeId="n1">
        <NodeUserTrafficCard nodeId="n1" />
      </NodeRealtimeProvider>,
    );
    await settle();
    act(() =>
      Events.sources[0].send(
        'sample',
        event('n1', [rate()], true, { forwarding_expected: true, forwarding_supported: false }),
      ),
    );
    expect(screen.getByText('转发实时待升级 Agent')).toBeTruthy();
    expect(screen.getByRole('region', { name: '当前速率' }).textContent).toContain('—');
  });
  it('opens with the last hour, keeps idle users and keeps the list when the channel drops', async () => {
    served = history({ n1: [T - 90, T - 60, T - 30] }, [['n1', 'bob', [[T - 60, 300, 600]]]]);
    renderCard(
      <NodeRealtimeProvider nodeId="n1">
        <NodeUserTrafficCard nodeId="n1" />
      </NodeRealtimeProvider>,
    );
    await settle();
    const list = screen.getByRole('list', { name: '各用户流量' });
    expect(names(list)).toEqual(['bob']);
    expect(screen.getByRole('region', { name: '近 1 小时' }).textContent).toContain('900');

    act(() => Events.sources[0].send('sample', event('n1', [rate('alice')])));
    expect(names(list)).toEqual(['alice', 'bob']);
    expect(currentDown(item(list, 'alice'))).toBe('16.4Kbit/s');
    expect(currentDown(item(list, 'bob'))).toBe('0');

    // all 模式不再上报 alice：她的行保留，当前为 0
    act(() => {
      vi.advanceTimersByTime(1_000);
      Events.sources[0].send('sample', event('n1', []));
    });
    expect(names(list)).toEqual(['alice', 'bob']);
    expect(currentDown(item(list, 'alice'))).toBe('0');

    act(() => {
      vi.advanceTimersByTime(1_000);
      Events.sources[0].send('sample', event('n1', [rate('alice')]));
    });
    act(() => Events.sources[0].send('status', { node_id: 'n1', connected: false }));
    expect(screen.getByText('实时通道未连接')).toBeTruthy();
    expect(screen.getByText(/当前速率停在/)).toBeTruthy();
    expect(names(list)).toEqual(['alice', 'bob']);
    expect(currentDown(item(list, 'alice'))).toBe('16.4Kbit/s');
  });

  it('searches and sorts without dropping retained users', async () => {
    served = history({ n1: [T - 30] }, [['n1', 'carol', [[T - 30, 9_000, 9_000]]]]);
    renderCard(
      <NodeRealtimeProvider nodeId="n1">
        <NodeUserTrafficCard nodeId="n1" />
      </NodeRealtimeProvider>,
    );
    await settle();
    act(() =>
      Events.sources[0].send('sample', event('n1', [rate('alice', 'entry', 1, 5_000), rate('bob', 'entry', 1, 50)])),
    );
    const list = screen.getByRole('list', { name: '各用户流量' });
    expect(names(list)).toEqual(['alice', 'bob', 'carol']);

    fireEvent.click(screen.getByRole('button', { name: '近 1 小时' }));
    expect(names(list)).toEqual(['carol', 'alice', 'bob']);
    fireEvent.click(screen.getByRole('button', { name: '下行' }));
    expect(names(list)).toEqual(['alice', 'bob', 'carol']);

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索用户' }), { target: { value: 'bo' } });
    expect(names(list)).toEqual(['bob']);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索用户' }), { target: { value: 'zz' } });
    expect(screen.getByText('没有匹配「zz」的用户')).toBeTruthy();
  });

  it('does not present a reset counter baseline as zero traffic', async () => {
    renderCard(
      <NodeRealtimeProvider nodeId="n1">
        <NodeUserTrafficCard nodeId="n1" />
      </NodeRealtimeProvider>,
    );
    await settle();
    act(() => Events.sources[0].send('sample', event('n1', [], true, { has_gap: true })));
    expect(screen.getByText('正在建立速率基线')).toBeTruthy();
    const now = screen.getByRole('region', { name: '当前速率' });
    expect(now.querySelector('.user-usage-hero-value')?.textContent).toBe('—');
    expect([...now.querySelectorAll('.usage-io dd:not(.usage-share)')].map(cell => cell.textContent)).toEqual([
      '—',
      '—',
    ]);
  });
});

describe('user realtime traffic card', () => {
  it('labels forwarding only on the machine that actually carries it, including idle rules', async () => {
    served = history({ n1: [], n2: [] });
    renderCard(<UserRealtimeTrafficCard tenantId="platform" userId="alice" nameOf={id => id} />);
    act(() =>
      Events.sources[0].send('snapshot', {
        policy: { enabled: true },
        nodes: [
          {
            ...node('n1'),
            samples: [event('n1', [rate()], false, { forwarding_expected: false, forwarding_supported: true })],
          },
          {
            ...node('n2'),
            samples: [event('n2', [rate()], false, { forwarding_expected: true, forwarding_supported: true })],
          },
        ],
      }),
    );
    await settle();
    const list = screen.getByRole('list', { name: '各入口机器流量' });
    expect(item(list, 'n1').textContent).not.toContain('含转发');
    expect(item(list, 'n2').textContent).toContain('含转发');
  });

  it('sums only the selected user across machines and keeps the last rates when they expire', async () => {
    served = history({ n1: [T - 30], n2: [T - 30] }, [['n1', 'alice', [[T - 30, 10, 20]]]]);
    renderCard(<UserRealtimeTrafficCard tenantId="platform" userId="alice" nameOf={id => `机器 ${id}`} />);
    expect(Events.sources[0].url).toBe('/users/platform/alice/realtime/events');
    act(() =>
      Events.sources[0].send('snapshot', {
        policy: { enabled: true },
        nodes: [node('n1', [rate(), rate('bob')]), node('n2')],
      }),
    );
    await settle();
    const list = screen.getByRole('list', { name: '各入口机器流量' });
    expect(names(list)).toEqual(['机器 n1', '机器 n2']);
    expect(screen.queryByText('bob')).toBeNull();
    expect(screen.getByRole('region', { name: '当前速率' }).textContent).toContain('32.8');

    act(() => vi.advanceTimersByTime(16_000));
    expect(screen.getByText('实时通道未连接')).toBeTruthy();
    expect(names(list)).toEqual(['机器 n1', '机器 n2']);
    expect(currentDown(item(list, '机器 n1'))).toBe('16.4Kbit/s');
  });

  it('distinguishes an old Agent from idle and unsubscribes on navigation', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <UserRealtimeTrafficCard tenantId="platform" userId="alice" nameOf={id => id} />
      </QueryClientProvider>,
    );
    act(() =>
      Events.sources[0].send('snapshot', {
        policy: { enabled: true },
        nodes: [{ ...node('n1'), samples: [{ ...event(), sample: { sampled_at_unix_millis: Date.now() } }] }],
      }),
    );
    await settle();
    expect(screen.getByText('当前 Agent 尚未支持用户速率')).toBeTruthy();
    view.rerender(
      <QueryClientProvider client={client}>
        <UserRealtimeTrafficCard tenantId="platform" userId="bob" nameOf={id => id} />
      </QueryClientProvider>,
    );
    expect(Events.sources[0].closed).toBe(true);
    expect(screen.getByText('正在建立速率基线')).toBeTruthy();
    view.unmount();
    expect(Events.sources[1].closed).toBe(true);
  });
});
