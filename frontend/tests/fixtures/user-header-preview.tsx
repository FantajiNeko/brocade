// Visual acceptance fixture: the production users pane with synthetic users only; no network access.
// ?user=alice|carol|erin chooses the detail, ?role=system-admin|readonly|user the viewer, ?theme=dark|light.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminRole, ConsoleSnapshot, SnapshotIngress, UserListItem } from '../../src/api';
import { UsersPane } from '../../src/panes/users';
import { SessionProvider } from '../../src/session';
import { theme } from '../../src/forge/theme';
import type { Win } from '../../src/wm/store';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
if (theme.snapshot() !== (params.get('theme') === 'light' ? 'light' : 'dark')) theme.toggle();
document.documentElement.dataset.palette = 'dailan';
const role = (params.get('role') ?? 'system-admin') as AdminRole;
const selected = params.get('user') ?? 'alice';
const tenant = 'preview';
const GiB = 1024 ** 3;
const person = (id: string, extra: Partial<UserListItem> = {}): UserListItem => ({
  tenant_id: tenant,
  id,
  status: 'active',
  created_at: '2026-10-01T00:00:00Z',
  created_revision: 1,
  uuid: '00000000-0000-4000-8000-000000000000',
  login_enabled: true,
  ...extra,
});
const users = [
  person('alice', { direct_login_enabled: true }),
  person('carol', { account_type: 'test' }),
  person('a-very-long-user-name-for-layout', {}),
  person('erin', { status: 'disabled' }),
];
const chains = ['hk-01', 'jp-01', 'tw-01'];
const snapshot = {
  snapshot: {
    revision: 1,
    apps: [
      {
        id: 'apac',
        label: 'APAC Premium',
        chains: chains.map(id => ({ id, name: id.toUpperCase(), subscription_country: id.slice(0, 2).toUpperCase() })),
        steps: [],
        fronts: [],
        ingresses: chains.map(
          (chain, i) => ({ id: `in-${chain}`, chain, node: 'n1', port: 8448 + i }) as SnapshotIngress,
        ),
        grants: users.flatMap(user => chains.map(chain => ({ tenant, user: user.id, ingress: `in-${chain}` }))),
      },
    ],
  },
  node_egress_dns: [],
  redacted: false,
} as unknown as ConsoleSnapshot;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
client.setQueryData(['snapshot'], snapshot);
client.setQueryData(['nodes'], { nodes: [{ node_id: 'n1', name: '示例节点' }] });
client.setQueryData(['users'], { users });
client.setQueryData(['user-presence', role], { freshness_secs: 120, users: [] });
client.setQueryData(['tenants'], { tenants: [{ id: tenant, name: '示例' }] });
client.setQueryData(['quotas'], { quotas: [] });
client.setQueryData(['usage-monthly'], {
  views: users.map((user, i) => ({
    tenant_id: tenant,
    user_id: user.id,
    app_id: 'apac',
    uplink_bytes: GiB,
    downlink_bytes: (120 + i * 40) * GiB,
    has_gap: false,
  })),
});
if (role === 'user') client.setQueryData(['me-user'], users[0]);
const empty = { rows: [], series: [], sources: [], entitlements: [], rules: [], nodes: [] };
globalThis.fetch = async input => {
  const path = String(input);
  if (path.endsWith('/forwarding')) return Response.json({ tenant_id: tenant, user_id: selected, ...empty });
  if (path.endsWith('/presence-history'))
    return Response.json({ tenant_id: tenant, user_id: selected, retention_days: 30, truncated: false, sources: [] });
  if (path === '/grant-probes/capability') return Response.json({ available: false, reason: '示例不拨测' });
  return Response.json({ error: `示例未提供 ${path}` }, { status: 404 });
};
const win: Win = {
  id: 1,
  key: 'tab:users',
  title: '用户',
  x: 0,
  y: 0,
  w: 1200,
  h: 900,
  z: 1,
  min: false,
  home: 'desk',
  data: { drill: { p: 'user', id: selected } },
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <SessionProvider
      value={{
        who: {
          operator_id: role === 'user' ? 'alice' : 'operator',
          role,
          tenant_scope: null,
          token_prefix: null,
          self_user: role === 'user' ? { tenant_id: tenant, user_id: 'alice' } : undefined,
          masked_assets: role === 'user',
        },
        initial: { node_count: 1, chain_group_count: [] },
      }}
    >
      <UsersPane win={win} />
    </SessionProvider>
  </QueryClientProvider>,
);
