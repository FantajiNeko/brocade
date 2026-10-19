import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNodeRealtime } from '../src/node-realtime';
import { useUserTrafficSource } from '../src/user-traffic-source';

class Events {
  static sources: Events[] = [];
  handlers = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  closed = false;
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
const event = (node: string, down: number, extra = {}) => ({
  node_id: node,
  received_at_unix_millis: Date.now(),
  sample: {
    sampled_at_unix_millis: Date.now(),
    user_traffic: {
      state: 'ready',
      all_users: false,
      users: [{ tenant_id: 'p', user_id: 'u', uplink_bytes_per_sec: 0, downlink_bytes_per_sec: down }],
    },
    ...extra,
  },
});
function User() {
  const { payload } = useUserTrafficSource('p', 'u');
  return (
    <output aria-label="user">
      {payload?.nodes
        .map(
          node =>
            `${node.node_id}:${node.connected}:${node.samples.at(-1)?.sample.user_traffic?.users?.[0]?.downlink_bytes_per_sec}`,
        )
        .join(',')}
    </output>
  );
}
function Node() {
  const { last, connected } = useNodeRealtime('a');
  return (
    <output aria-label="node">
      {String(connected)}:{last?.event.sample.user_traffic?.users?.[0]?.downlink_bytes_per_sec}:
      {JSON.stringify(last?.event.sample.mux)}
    </output>
  );
}
beforeEach(() => {
  vi.useFakeTimers({ now: 10_250 });
  Events.sources = [];
  vi.stubGlobal('EventSource', Events);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

it('publishes a whole user aggregate and a separately mounted node on the same beat; status is immediate', async () => {
  render(<User />);
  const user = Events.sources[0];
  act(() =>
    user.send('snapshot', {
      policy: { enabled: true },
      nodes: ['a', 'b'].map(node => ({ node_id: node, connected: true, active: true, samples: [event(node, 1)] })),
    }),
  );
  await advance(200);
  render(<Node />);
  const node = Events.sources[1];
  act(() => node.send('sample', event('a', 1)));
  await advance(100);
  act(() => {
    user.send('sample', event('a', 2));
    node.send('sample', event('a', 2));
  });
  await advance(100);
  act(() => user.send('sample', event('b', 3)));
  expect(screen.getByLabelText('user').textContent).toBe('a:true:1,b:true:1');
  expect(screen.getByLabelText('node').textContent).toBe('true:1:');
  await advance(350);
  expect(screen.getByLabelText('user').textContent).toBe('a:true:2,b:true:3');
  expect(screen.getByLabelText('node').textContent).toBe('true:2:');
  act(() => {
    user.send('status', { node_id: 'b', connected: false, active: false });
    node.send('status', { node_id: 'a', connected: false });
  });
  expect(screen.getByLabelText('user').textContent).toBe('a:true:2,b:false:3');
  expect(screen.getByLabelText('node').textContent).toBe('false:2:');
});

it('merges every diagnostic delta before coalescing metrics and immediately shows lifecycle events', async () => {
  render(<Node />);
  const node = Events.sources[0];
  act(() =>
    node.send(
      'sample',
      event('a', 1, { mux: { boot_id: 'boot', pools: [{ pool_id: 'p', active_sessions: 1 }], events: [] } }),
    ),
  );
  await advance(100);
  act(() =>
    node.send(
      'sample',
      event('a', 2, { mux: { boot_id: 'boot', pools: [{ pool_id: 'p', active_sessions: 2 }], events: [] } }),
    ),
  );
  act(() => node.send('sample', event('a', 3, { diagnostics_unchanged: true })));
  expect(screen.getByLabelText('node').textContent).toContain('true:1:');
  await advance(650);
  expect(screen.getByLabelText('node').textContent).toContain('true:3:');
  expect(screen.getByLabelText('node').textContent).toContain('"active_sessions":2');
  act(() =>
    node.send(
      'sample',
      event('a', 4, { mux: { boot_id: 'boot', pools: [], events: [{ sequence: 1, state: 'DEAD' }] } }),
    ),
  );
  expect(screen.getByLabelText('node').textContent).toContain('DEAD');
});

it('rejects replayed samples and old closed-source callbacks across an SSE renewal', async () => {
  render(<Node />);
  const old = Events.sources[0];
  const first = event('a', 1);
  act(() => old.send('sample', first));
  await advance(100);
  act(() => old.send('sample', event('a', 2)));
  act(() => old.send('sample', first));
  await advance(650);
  expect(screen.getByLabelText('node').textContent).toBe('true:2:');
  act(() => old.send('reset', {}));
  const renewed = Events.sources[1];
  act(() => old.send('sample', event('a', 999)));
  act(() => renewed.send('snapshot', { nodes: [{ node_id: 'a', connected: true, samples: [first] }] }));
  await advance(1000);
  expect(screen.getByLabelText('node').textContent).toBe('true:2:');
});
