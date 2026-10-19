import type { NodeRealtimeEvent } from './node-realtime';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);

/** Keep lifecycle facts immediate while counters, rates and ages use the metric beat.
 * Event sequence is a fact; report sequence/timestamps merely identify a new measurement. */
function diagnosticFacts(value: unknown, sampledAt: number) {
  if (value == null) return null;
  const report = record(value);
  const identity = (row: Record<string, unknown>) => [
    row.pool_id,
    row.worker_id,
    row.outbound_id,
    row.slot,
    row.server_id,
    row.pair,
    row.role,
    row.kind,
    row.state,
    row.phase,
    row.reason,
    row.used,
    row.draining,
    row.active_slot,
  ];
  return [
    report.boot_id,
    typeof (report.sampled_at_unix_ms ?? report.sampled_at_unix_millis) === 'number'
      ? sampledAt - Number(report.sampled_at_unix_ms ?? report.sampled_at_unix_millis) > 15_000
      : false,
    rows(report.pools).map(identity),
    rows(report.workers).map(identity),
    rows(report.backends).map(identity),
    rows(report.events).map(event => event.sequence),
  ];
}

export function realtimeFacts(event: NodeRealtimeEvent | undefined, now: number) {
  if (!event) return null;
  const traffic = event.sample.user_traffic;
  return [
    now - event.received_at_unix_millis > 15_000,
    traffic
      ? [
          traffic.state,
          traffic.all_users,
          traffic.has_gap,
          traffic.truncated,
          traffic.forwarding_supported,
          traffic.forwarding_expected,
        ]
      : null,
    diagnosticFacts(event.sample.reverse_health, event.sample.sampled_at_unix_millis),
    diagnosticFacts(event.sample.mux, event.sample.sampled_at_unix_millis),
    diagnosticFacts(event.sample.vpngate, event.sample.sampled_at_unix_millis),
  ];
}
