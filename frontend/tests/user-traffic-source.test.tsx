import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeRealtimeEvent, RealtimeUserTrafficRate, RealtimeUserTrafficReport } from '../src/node-realtime';
import { forwardingRuleRates, useUserTrafficSource, type UserTrafficSnapshot } from '../src/user-traffic-source';

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

function Probe({ id, enabled = true }: { id: string; enabled?: boolean }) {
  const { payload } = useUserTrafficSource('platform', 'alice', enabled);
  return <span data-testid={id}>{payload ? String(payload.nodes.length) : 'none'}</span>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Events.sources = [];
});

describe('用户实时订阅源', () => {
  it('两张卡订阅同一位用户时只开一条连接，最后一个卸载后关闭', () => {
    vi.stubGlobal('EventSource', Events);
    const view = render(
      <>
        <Probe id="traffic" />
        <Probe id="forwarding" />
      </>,
    );
    expect(Events.sources).toHaveLength(1);
    expect(Events.sources[0].url).toBe('/users/platform/alice/realtime/events');

    act(() =>
      Events.sources[0].send('snapshot', {
        policy: { enabled: true },
        nodes: [{ node_id: 'n1', connected: true, active: true, samples: [] }],
      }),
    );
    expect(view.getByTestId('traffic').textContent).toBe('1');
    expect(view.getByTestId('forwarding').textContent).toBe('1');

    view.unmount();
    expect(Events.sources[0].closed).toBe(true);
  });

  it('无权查看实时的身份不发起订阅', () => {
    vi.stubGlobal('EventSource', Events);
    const view = render(<Probe id="off" enabled={false} />);
    expect(Events.sources).toHaveLength(0);
    expect(view.getByTestId('off').textContent).toBe('none');
  });
});

describe('转发规则的当前速率', () => {
  const now = 1_760_000_000_000;
  const rate = (rule: number | undefined, down: number, up: number): RealtimeUserTrafficRate => ({
    tenant_id: 'platform',
    user_id: 'alice',
    ...(rule === undefined ? { ingress_id: 'in-1' } : { forwarding_rule_id: rule }),
    downlink_bytes_per_sec: down,
    uplink_bytes_per_sec: up,
  });
  const node = (id: string, report: Partial<RealtimeUserTrafficReport>, age = 1_000) => {
    const event: NodeRealtimeEvent = {
      node_id: id,
      received_at_unix_millis: now - age,
      sample: {
        sampled_at_unix_millis: now - age,
        user_traffic: { state: 'ready', all_users: false, forwarding_supported: true, users: [], ...report },
      },
    };
    return { node_id: id, connected: true, active: true, samples: [event] };
  };

  it('只采信新鲜、就绪、支持转发的完整报告；其余机器上的规则读作未知', () => {
    const payload: UserTrafficSnapshot = {
      policy: { enabled: true },
      nodes: [
        node('tokyo', { users: [rate(1, 100, 10), rate(undefined, 5, 5), { ...rate(2, 7, 7), user_id: 'bob' }] }),
        node('old-agent', { forwarding_supported: false, users: [rate(3, 50, 5)] }),
        node('gap', { has_gap: true, users: [rate(4, 20, 2)] }),
        node('warming', { state: 'warming' }),
      ],
    };
    const result = forwardingRuleRates(payload, 'platform', 'alice', now);
    expect(result.rates.get(1)).toEqual({ down: 100, up: 10 });
    expect(result.rates.get(4)).toEqual({ down: 20, up: 2 });
    expect(result.rates.has(2)).toBe(false);
    expect(result.rates.has(3)).toBe(false);
    expect([...result.covered]).toEqual(['tokyo']);

    // 超过新鲜度的报告不再算作「当前」
    expect(forwardingRuleRates(payload, 'platform', 'alice', now + 20_000).covered.size).toBe(0);
  });
});
