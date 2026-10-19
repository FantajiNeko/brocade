// Browser acceptance uses production components with the mockup's deterministic seven scenes.
// Never imported by the app. Serve frontend with Vite configFile:false, plugins:[react()].
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConsoleSnapshot,
  NodeInflowUsage,
  NodeSiteUsage,
  SiteUsagePeriod,
  UserTrafficHistory,
} from '../../src/api';
import type { NodeRealtimeEvent } from '../../src/node-realtime';
import { NodeTrafficDialog } from '../../src/node-traffic';
import { theme } from '../../src/forge/theme';
import {
  aggregate,
  build,
  chainViews,
  inflowOf,
  liveHistory,
  liveRates,
  NOW,
  SCENES,
  siteRowsOf,
  type SceneKey,
} from './node-traffic-mockup-data';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'typical';
if (!(scene in SCENES)) throw new Error(`Unknown acceptance scene: ${scene}`);
const world = SCENES[scene as SceneKey]();
const built = build(world);
if (theme.snapshot() !== (params.get('theme') === 'light' ? 'light' : 'dark')) theme.toggle();
const snapshot: ConsoleSnapshot = {
  redacted: false,
  node_egress_dns: [],
  snapshot: {
    revision: 1,
    apps: [
      {
        id: 'app',
        label: '示例',
        chains: world.chains.map(chain => ({
          id: chain.id,
          name: chain.name,
          tenant: 'platform',
          subscription_country: chain.country,
        })),
        ingresses: world.chains.map((chain, i) => ({
          id: chain.id,
          chain: chain.id,
          node: 'n1',
          port: 2000 + i,
          bind: '0.0.0.0',
          projection: {},
          guard: {
            no_private: false,
            no_bittorrent: false,
            no_mail: false,
            no_udp_amplification: false,
            tcp_and_quic_only: false,
            cn_source_block: 'off',
          },
          identity: {},
          wires: {},
        })),
        fronts: [],
        steps: [],
        grants: [...world.grants].flatMap(key => {
          const [user, ingress] = key.split('/');
          const owner = world.users.find(candidate => candidate.id === user);
          return owner && world.chains.some(chain => chain.id === ingress)
            ? [{ tenant: owner.tenant, user, ingress }]
            : [];
        }),
      },
    ],
  },
};
function inflow(period: SiteUsagePeriod): NodeInflowUsage {
  const agg = aggregate(built, period),
    views = chainViews(world, agg, aggregate(built, 'month')),
    input = inflowOf(world, agg, views);
  return {
    period,
    range_start_unix_secs: agg.bounds.start,
    range_end_unix_secs: NOW,
    period_end_unix_secs: agg.bounds.end,
    latest_report_unix_secs: NOW,
    rows: input.rows.flatMap(user =>
      views.flatMap(view => {
        const cell = user.cells.get(view.id);
        if (!cell?.total) return [];
        return [
          {
            tenant_id: user.tenant,
            user_id: user.id,
            source: view.kind === 'chain' ? 'chain' : view.kind === 'fwd' ? 'forwarding' : 'unattributed',
            app_id: view.kind === 'chain' ? 'app' : null,
            chain_id: view.kind === 'chain' ? view.id : null,
            ingress_id: null,
            uplink_bytes: Math.round(cell.up),
            downlink_bytes: Math.round(cell.down),
            has_gap: cell.gap,
          },
        ];
      }),
    ),
    idle_users: input.idle.map(user => ({ tenant_id: user.tenant, user_id: user.id })),
  };
}
function sites(period: SiteUsagePeriod): NodeSiteUsage {
  const agg = aggregate(built, period),
    rows = world.sites ? siteRowsOf(built, agg) : [];
  return {
    period,
    collection_enabled: world.sites,
    catalog_version: 1,
    range_start_unix_secs: agg.bounds.start,
    range_end_unix_secs: NOW,
    period_end_unix_secs: agg.bounds.end,
    bucket_secs: agg.bounds.bucket,
    reporting_nodes: world.sites ? 1 : 0,
    expected_nodes: 1,
    limited: false,
    latest_report_unix_secs: world.sites ? NOW : null,
    observed_since_unix_secs: agg.bounds.start,
    rows: rows.map(row => ({
      site_id: row.id,
      name: row.name,
      uplink_bytes: Math.round(row.up),
      downlink_bytes: Math.round(row.down),
    })),
    series: rows.map(row => ({
      site_id: row.id,
      points: row.values.map(
        (value, i) => [agg.bounds.start + i * agg.bounds.bucket, 0, Math.round(value)] as [number, number, number],
      ),
    })),
    top_users: rows.map(row => ({
      site_id: row.id,
      users: row.users.slice(0, 4).map(user => ({
        tenant_id: world.users.find(u => u.id === user.id)!.tenant,
        user_id: user.id,
        uplink_bytes: 0,
        downlink_bytes: Math.round(user.total),
      })),
      other_users: Math.max(0, row.users.length - 4),
      other_uplink_bytes: 0,
      other_downlink_bytes: Math.round(row.users.slice(4).reduce((sum, user) => sum + user.total, 0)),
    })),
  };
}
const hour = liveHistory(built);
const history: UserTrafficHistory = {
  range_start_unix_secs: NOW - 3600,
  range_end_unix_secs: NOW,
  nodes: [{ node_id: 'n1', window_ends_unix_secs: hour.slots }],
  series: [...hour.users].map(([user, values]) => ({
    node_id: 'n1',
    tenant_id: world.users.find(row => row.id === user)!.tenant,
    user_id: user,
    points: hour.slots.map((at, i) => [at, Math.round(values.up[i]), Math.round(values.down[i])]),
  })),
};
function sample(second: number): NodeRealtimeEvent {
  return {
    node_id: 'n1',
    received_at_unix_millis: Date.now(),
    sample: {
      sampled_at_unix_millis: Date.now(),
      user_traffic: {
        state: 'ready',
        all_users: true,
        forwarding_supported: true,
        users: liveRates(built, hour, second).flatMap(user =>
          user.chains.map(chain => ({
            tenant_id: user.tenant,
            user_id: user.id,
            ...(chain.col === 'fwd' ? { forwarding_rule_id: 1 } : { ingress_id: chain.col }),
            uplink_bytes_per_sec: chain.up,
            downlink_bytes_per_sec: chain.down,
          })),
        ),
      },
    },
  };
}
class FixtureEvents extends EventTarget {
  onerror = null;
  timer: ReturnType<typeof setInterval>;
  constructor() {
    super();
    let second = 0;
    setTimeout(() => this.dispatchEvent(new MessageEvent('sample', { data: JSON.stringify(sample(second)) })), 20);
    this.timer = setInterval(
      () =>
        this.dispatchEvent(
          new MessageEvent('sample', { data: JSON.stringify(sample(params.get('run') === '0' ? 0 : ++second)) }),
        ),
      1000,
    );
  }
  close() {
    clearInterval(this.timer);
  }
}
Object.defineProperty(window, 'EventSource', { value: FixtureEvents });
const nativeFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const period = (url.searchParams.get('period') ?? 'day') as SiteUsagePeriod;
  const detail = {
    collection_enabled: false,
    top_n: 128,
    range_start_unix_secs: NOW - 86400,
    range_end_unix_secs: NOW,
    reporting_nodes: 0,
    expected_nodes: 1,
    limited: false,
    observed_since_unix_secs: null,
    latest_report_unix_secs: null,
    rows: [],
  };
  if (url.pathname.endsWith('/inflow-usage')) return Response.json(inflow(period));
  if (url.pathname.endsWith('/site-usage')) return Response.json(sites(period));
  if (url.pathname.endsWith('/other-domains') || url.pathname.endsWith('/sniffing-failed-targets'))
    return Response.json(detail);
  if (url.pathname.endsWith('/user-history')) return Response.json(history);
  return nativeFetch(input, init);
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
client.setQueryData(['snapshot'], snapshot);
function Acceptance() {
  const [open, setOpen] = useState(false);
  return (
    <div className="fg-sheet cardpage" style={{ maxWidth: 1280, margin: '0 auto', padding: 16 }}>
      <h1>用量</h1>
      <button className="btn" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">
        香港测试机器
      </button>
      {open && <NodeTrafficDialog nodeId="n1" name="香港测试机器" country="HK" onClose={() => setOpen(false)} />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Acceptance />
  </QueryClientProvider>,
);
