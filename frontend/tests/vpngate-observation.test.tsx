import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VpngateObservationCard } from '../src/vpngate-observation';

class Events {
  static current: Events;
  handlers = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  constructor() {
    Events.current = this;
  }
  addEventListener(name: string, callback: (event: { data: string }) => void) {
    this.handlers.set(name, callback);
  }
  close() {}
  send(name: string, value: unknown) {
    this.handlers.get(name)?.({ data: JSON.stringify(value) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Events);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shows both backend roles, failover reason and replenishment counters', () => {
  render(<VpngateObservationCard nodeId="node-a" />);
  const now = Date.now();
  act(() =>
    Events.current.send('sample', {
      node_id: 'node-a',
      received_at_unix_millis: now,
      sample: {
        sampled_at_unix_millis: now,
        vpngate: {
          boot_id: 'boot-a',
          sequence: 9,
          sampled_at_unix_millis: now,
          pools: [
            {
              outbound_id: 'vpngate-jp',
              country_code: 'JP',
              state: 'degraded',
              reason: 'egress_unreachable',
              active_slot: 1,
              ready_standbys: 0,
              candidate_count: 16,
              consecutive_failures: 1,
              last_success_age_millis: 5000,
              probes: 20,
              probe_failures: 2,
              failovers: 1,
              refill_attempts: 2,
              refill_failures: 1,
              refill_backoff_remaining_millis: 10000,
            },
          ],
          backends: [
            {
              outbound_id: 'vpngate-jp',
              slot: 1,
              role: 'active',
              state: 'healthy',
              server_id: 'vpn-jp-2',
              last_success_age_millis: 1000,
              consecutive_failures: 0,
              backoff_remaining_millis: 0,
            },
          ],
          events: [
            {
              sequence: 3,
              at_unix_millis: now,
              outbound_id: 'vpngate-jp',
              kind: 'failover_completed',
              from_slot: 0,
              to_slot: 1,
              reason: 'egress_unreachable',
              recovery_elapsed_millis: 13000,
            },
          ],
        },
      },
    }),
  );

  expect(screen.getByLabelText('VPN Gate 实时路径').textContent).toContain('候选 16');
  fireEvent.click(screen.getByText('JP'));
  expect(screen.getByText('vpn-jp-2')).toBeTruthy();
  expect(screen.getByText(/探活 20 \/ 失败 2/)).toBeTruthy();
  fireEvent.click(screen.getByText(/状态事件/));
  expect(screen.getByText('切换完成')).toBeTruthy();
  expect(screen.getAllByText('出口黑洞').length).toBeGreaterThan(0);
});

it('treats an old initial VPN Gate snapshot as warm-up before declaring it stale', () => {
  render(<VpngateObservationCard nodeId="node-a" />);
  const now = Date.now();
  act(() =>
    Events.current.send('sample', {
      node_id: 'node-a',
      received_at_unix_millis: now,
      sample: {
        sampled_at_unix_millis: now,
        vpngate: {
          boot_id: 'boot-a',
          sequence: 1,
          sampled_at_unix_millis: now - 16_000,
          pools: [
            {
              outbound_id: 'vpngate-us',
              country_code: 'US',
              state: 'healthy',
              ready_standbys: 1,
              candidate_count: 16,
              consecutive_failures: 0,
              probes: 1,
              probe_failures: 0,
              failovers: 0,
              refill_attempts: 0,
              refill_failures: 0,
              refill_backoff_remaining_millis: 0,
            },
          ],
          backends: [],
          events: [],
        },
      },
    }),
  );

  expect(screen.getByRole('status').textContent).toBe('正在获取实时状态…');
  expect(screen.queryByText(/正在同步实时数据/)).toBeNull();
  expect(screen.getByLabelText('VPN Gate 实时路径').textContent).not.toContain('出口池');
  expect(screen.getByLabelText('VPN Gate 实时路径').textContent).not.toContain('vpngate-us');
  expect(screen.queryByText(/实时数据连接已中断/)).toBeNull();

  act(() => vi.advanceTimersByTime(16_000));
  expect(screen.getByText(/实时数据连接已中断，或数据已超过 15 秒未更新/)).toBeTruthy();
});

it('keeps a fresh report live through a transient fallback polling failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('temporary proxy failure')));
  render(<VpngateObservationCard nodeId="node-a" />);
  const now = Date.now();
  act(() =>
    Events.current.send('sample', {
      node_id: 'node-a',
      received_at_unix_millis: now,
      sample: {
        sampled_at_unix_millis: now,
        vpngate: {
          boot_id: 'boot-a',
          sequence: 1,
          sampled_at_unix_millis: now,
          pools: [
            {
              outbound_id: 'vpngate-us',
              country_code: 'US',
              state: 'healthy',
              ready_standbys: 1,
              candidate_count: 16,
              consecutive_failures: 0,
              probes: 1,
              probe_failures: 0,
              failovers: 0,
              refill_attempts: 0,
              refill_failures: 0,
              refill_backoff_remaining_millis: 0,
            },
          ],
          backends: [],
          events: [],
        },
      },
    }),
  );
  expect(screen.queryByText(/实时数据连接已中断/)).toBeNull();

  await act(async () => {
    Events.current.onerror?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.queryByText(/实时数据连接已中断/)).toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000);
  });
  expect(screen.getByText(/实时数据连接已中断，或数据已超过 15 秒未更新/)).toBeTruthy();
});
