import { describe, expect, it } from 'vitest';
import { mergeNodeRealtimeEvent, type NodeRealtimeEvent } from '../src/node-realtime';
import { olderRealtimeEvent } from '../src/realtime-order';

const event = (sample: NodeRealtimeEvent['sample']): NodeRealtimeEvent => ({
  node_id: 'n1',
  received_at_unix_millis: 2_000,
  sample,
});

it('rejects late receipts and tied older sequences, but accepts a restarted Agent sequence after reconnect', () => {
  const frame = (received: number, sequence: number) => ({ received_at_unix_millis: received, sample: { sequence } });
  expect(olderRealtimeEvent(frame(999, 20), frame(1000, 10))).toBe(true);
  expect(olderRealtimeEvent(frame(1000, 9), frame(1000, 10))).toBe(true);
  expect(olderRealtimeEvent(frame(1000, 11), frame(1000, 10))).toBe(false);
  expect(olderRealtimeEvent(frame(1001, 1), frame(1000, 10))).toBe(false);
});

describe('realtime diagnostics deltas', () => {
  it('never retains an old user rate under a diagnostics delta', () => {
    const previous = event({ sampled_at_unix_millis: 1_000, user_traffic: { state: 'ready', all_users: true } });
    const next = event({ sampled_at_unix_millis: 2_000, diagnostics_unchanged: true });
    expect(mergeNodeRealtimeEvent(previous, next).sample.user_traffic).toBeUndefined();
  });
  it('retains large reports only for an explicitly marked lightweight sample', () => {
    const previous = event({
      sampled_at_unix_millis: 1_000,
      reverse_health: { workers: ['a'] },
      mux: { pools: ['p1'] },
      vpngate: null,
    });
    const next = event({ sampled_at_unix_millis: 2_000, diagnostics_unchanged: true });

    expect(mergeNodeRealtimeEvent(previous, next).sample).toMatchObject({
      sampled_at_unix_millis: 2_000,
      reverse_health: { workers: ['a'] },
      mux: { pools: ['p1'] },
      vpngate: null,
    });
  });

  it('lets a complete sample clear reports that no longer exist', () => {
    const previous = event({ sampled_at_unix_millis: 1_000, mux: { pools: ['p1'] } });
    const complete = event({ sampled_at_unix_millis: 2_000 });

    expect(mergeNodeRealtimeEvent(previous, complete)).toBe(complete);
    expect(mergeNodeRealtimeEvent(previous, complete).sample.mux).toBeUndefined();
  });

  it('retains only mux when the other diagnostics are a fresh baseline', () => {
    const previous = event({
      sampled_at_unix_millis: 1_000,
      reverse_health: { workers: ['old'] },
      mux: { sampled_at_unix_ms: 1_000, pools: ['p1'] },
    });
    const next = event({
      sampled_at_unix_millis: 2_000,
      mux_unchanged: true,
      reverse_health: { workers: ['new'] },
      vpngate: null,
    });

    expect(mergeNodeRealtimeEvent(previous, next).sample).toMatchObject({
      sampled_at_unix_millis: 2_000,
      reverse_health: { workers: ['new'] },
      mux: { sampled_at_unix_ms: 2_000, pools: ['p1'] },
      vpngate: null,
    });
  });

  it('does not retain a mux delta marker across later NIC-only samples', () => {
    const previous = event({
      sampled_at_unix_millis: 1_000,
      mux_unchanged: true,
      mux: { sampled_at_unix_ms: 1_000, pools: ['p1'] },
    });
    const next = event({ sampled_at_unix_millis: 2_000, diagnostics_unchanged: true });

    expect(mergeNodeRealtimeEvent(previous, next).sample.mux_unchanged).toBeUndefined();
  });
});
