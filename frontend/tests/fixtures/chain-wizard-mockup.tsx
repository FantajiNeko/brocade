// Mockup of the 建链向导 redesign. Synthetic data only; never imported by the app.
// Serve frontend/ with Vite (configFile: false, plugins: [react()]) and open
//   tests/fixtures/chain-wizard-mockup.html?scene=relay
// Query: scene=<SCENES key>, view=new|current (current = production wizard on the same fleet),
//        theme=dark|light, w=<frame width>, nav=0 hides the review bar.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExternalOutbound, Rule } from '../../src/api';
import { ChainWizard } from '../../src/panes/chain-wizard';
import { SessionProvider } from '../../src/session';
import { theme } from '../../src/forge/theme';
import { SegmentedControl } from '../../src/ui/bits';
import { agentNodes, APPS, compileView, SETTINGS, snapshot, TENANTS, usersList } from './chain-wizard-mockup-data';
import {
  ChainWizardMockup,
  DEFAULT_PROTO,
  hopTo,
  routeTables,
  withException,
  type Draft,
  type Entry,
  type World,
} from './chain-wizard-mockup-ui';
import '../../src/styles.css';
import './chain-wizard-mockup.css';

const params = new URLSearchParams(location.search);
const themeName = params.get('theme') === 'light' ? 'light' : 'dark';
if (theme.snapshot() !== themeName) theme.toggle();
const width = Number(params.get('w')) || 1180;
const view = params.get('view') === 'current' ? 'current' : 'new';
const showNav = params.get('nav') !== '0';

const SCENES = {
  blank: '空白（从线路进入）',
  direct: '直出',
  relay: '一跳中转',
  branches: '多跳 + 例外',
  blocked: '有阻塞项',
  node: '从机器进入',
  crowd: '42 位用户',
} as const;
type SceneKey = keyof typeof SCENES;
const scene: SceneKey = (params.get('scene') as SceneKey) in SCENES ? (params.get('scene') as SceneKey) : 'relay';

const fleetSnapshot = snapshot();
const world: World = {
  nodes: agentNodes(),
  apps: APPS,
  snapNodes: fleetSnapshot.snapshot.nodes as World['snapNodes'],
  outbounds: fleetSnapshot.snapshot.external_outbounds as unknown as ExternalOutbound[],
  users: usersList(scene === 'crowd').users,
  tenants: TENANTS,
  settings: SETTINGS,
  system: compileView().system,
};

const fixedApp = { id: APPS[0].id, label: APPS[0].label };
const entry: Entry = scene === 'node' ? { node: 'hk-bgp' } : { fixedApp };

function sceneDraft(key: SceneKey): Draft {
  const base: Draft = {
    name: null,
    app: APPS[0].id,
    newAppLabel: '',
    root: null,
    tables: {},
    ports: {},
    wires: {},
    proto: DEFAULT_PROTO,
    users: [],
    sel: { t: 'choose', purpose: 'entry' },
  };
  const users = (...ids: string[]) => ids.map(id => (id.includes('/') ? id : `platform/${id}`));
  if (key === 'blank') return base;
  if (key === 'direct')
    return {
      ...base,
      root: 'hk-hkix',
      tables: routeTables(world, ['hk-hkix']),
      users: users('alice', 'bob', 'carol'),
      sel: { t: 'node', id: 'hk-hkix' },
    };
  if (key === 'relay')
    return {
      ...base,
      root: 'hk-bgp',
      tables: routeTables(world, ['hk-bgp', 'jp-iij']),
      users: users('alice', 'bob', 'carol'),
      sel: { t: 'ingress' },
    };
  if (key === 'branches') {
    let tables = routeTables(world, ['hk-bgp', 'tw-hinet', 'jp-iij']);
    const cn: Rule = { m: { t: 'geoip', v: ['cn'] }, a: { t: 'egress', send_through: null } };
    const netflix: Rule = {
      m: { t: 'geosite', v: ['netflix', 'disney'] },
      a: { t: 'proxy', outbound: 'ob-netflix-sg' },
    };
    const openai: Rule = {
      m: { t: 'domain_suffix', v: ['openai.com', 'chatgpt.com'] },
      a: hopTo(world, 'jp-iij', 'us-9929'),
    };
    tables = withException(world, tables, 'hk-bgp', cn);
    tables = withException(world, tables, 'jp-iij', netflix);
    tables = withException(world, tables, 'jp-iij', openai);
    return {
      ...base,
      name: '亚太三跳 · 解锁',
      root: 'hk-bgp',
      tables,
      users: users('alice', 'bob', 'carol', 'dave', 'erin'),
      sel: { t: 'node', id: 'jp-iij' },
    };
  }
  if (key === 'blocked')
    return {
      ...base,
      name: '',
      root: 'hk-home',
      tables: routeTables(world, ['hk-home', 'de-fra']),
      proto: { ...DEFAULT_PROTO, mtproto: true, vlessPort: '14443', anytlsPort: '14443' },
      users: users('alice', 'studio/niaj'),
      sel: { t: 'ingress' },
    };
  if (key === 'node')
    return {
      ...base,
      root: 'hk-bgp',
      tables: routeTables(world, ['hk-bgp']),
      sel: { t: 'node', id: 'hk-bgp' },
    };
  return {
    ...base,
    root: 'hk-hkix',
    tables: routeTables(world, ['hk-hkix', 'us-gia']),
    users: users('alice', 'bob', 'carol', 'dave', 'grace', 'ken', 'mia', 'oscar', 'zane'),
    sel: { t: 'users' },
  };
}

/* ══ Production wizard on the same fleet ══ */

function seeded() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } },
  });
  client.setQueryData(['nodes'], { nodes: world.nodes });
  client.setQueryData(['tenants'], { tenants: TENANTS });
  client.setQueryData(['settings'], SETTINGS);
  client.setQueryData(['revisions'], { current_revision: 41, revisions: [{ id: 41 }] });
  client.setQueryData(['compile', 41], compileView());
  client.setQueryData(['users'], { users: world.users });
  client.setQueryData(['snapshot'], fleetSnapshot);
  return client;
}

globalThis.fetch = async () => Response.json({ error: '示例不提供此接口' }, { status: 404 });

const who = {
  operator_id: 'admin',
  role: 'system-admin' as const,
  tenant_scope: 'platform',
  token_prefix: null,
  masked_assets: false,
};

/* ══ Review bar ══ */

function href(patch: Record<string, string>) {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(patch)) next.set(key, value);
  return `?${next}`;
}

function ReviewBar() {
  return (
    <div className="mk-bar">
      <div className="mk-bar-row">
        <span className="mk-title">建链向导 · 改版 mockup</span>
        <div className="mk-controls">
          <label className="mk-ctl">
            <span className="mk-ctl-label">场景</span>
            <select value={scene} onChange={event => (location.search = href({ scene: event.target.value }))}>
              {Object.entries(SCENES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span className="mk-ctl">
            <SegmentedControl
              ariaLabel="版本"
              value={view}
              options={[
                { value: 'new', label: '新版' },
                { value: 'current', label: '现版' },
              ]}
              onChange={value => (location.search = href({ view: value }))}
            />
          </span>
          <span className="mk-ctl">
            <SegmentedControl
              ariaLabel="宽度"
              value={String(width)}
              options={[
                { value: '1180', label: '桌面' },
                { value: '900', label: '窄窗' },
                { value: '390', label: '手机' },
              ]}
              onChange={value => (location.search = href({ w: value }))}
            />
          </span>
          <span className="mk-ctl">
            <SegmentedControl
              ariaLabel="主题"
              value={themeName}
              options={[
                { value: 'dark', label: '暗' },
                { value: 'light', label: '亮' },
              ]}
              onChange={value => (location.search = href({ theme: value }))}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={seeded()}>
    <SessionProvider value={{ who, initial: { node_count: 12, chain_group_count: [] } }} onIdentityChange={() => {}}>
      {showNav && <ReviewBar />}
      <div className="mk-stage">
        <div className="mk-frame" style={{ width: `min(100%, ${width}px)` }}>
          {view === 'current' ? (
            <ChainWizard
              key={scene}
              node={entry.node ? world.nodes.find(node => node.node_id === entry.node) : undefined}
              fixedApp={entry.fixedApp}
              onDone={() => undefined}
            />
          ) : (
            <ChainWizardMockup key={scene} world={world} entry={entry} initial={sceneDraft(scene)} />
          )}
        </div>
      </div>
    </SessionProvider>
  </QueryClientProvider>,
);
