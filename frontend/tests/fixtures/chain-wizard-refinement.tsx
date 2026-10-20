// Local-only refinement of the existing creation layout using Claude Code's mockup language.
// Query: scene=blank|direct|relay|branches|blocked|node|crowd, view=refined|current|claude,
// theme=light|dark, w=1180|900|620|390, nav=0. No production requests or draft writes.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExternalOutbound, Rule, UserListItem } from '../../src/api';
import { theme } from '../../src/forge/theme';
import { ChainWizard } from '../../src/panes/chain-wizard';
import { WizardPathEditor, type WizardDnsChange } from '../../src/panes/chain-wizard-path';
import { reachableWizardTables } from '../../src/panes/chain-wizard-graph';
import { isValidSlug, occupiedPorts } from '../../src/panes/ports';
import { SessionProvider } from '../../src/session';
import { SegmentedControl } from '../../src/ui/bits';
import { Icon } from '../../src/ui/icons';
import { GeneratedUserAvatar } from '../../src/ui/user-avatar';
import { WizardCard, WizardPaperHeader } from '../../src/ui/wizard-paper';
import { agentNodes, APPS, compileView, SETTINGS, snapshot, TENANTS, usersList } from './chain-wizard-mockup-data';
import {
  actionsFor,
  ChainWizardMockup,
  DEFAULT_PROTO,
  derive,
  hopTo,
  NEW_APP,
  routeTables,
  withException,
  type Draft,
  type Entry,
  type World,
} from './chain-wizard-mockup-ui';
import { RefinedIngressPanel } from './chain-wizard-refinement-protocols';
import '../../src/styles.css';
import './chain-wizard-mockup.css';
import './chain-wizard-refinement.css';

const params = new URLSearchParams(location.search);
const pick = <T extends string>(value: string | null, values: readonly T[], fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;
const SCENES = {
  blank: '空白起步',
  direct: '单机直出',
  relay: '一跳中转',
  branches: '多跳与例外',
  blocked: '待补全与冲突',
  node: '从机器创建',
  crowd: '41 位用户',
} as const;
type SceneKey = keyof typeof SCENES;
type View = 'refined' | 'current' | 'claude';
const fleetSnapshot = snapshot();
const makeWorld = (scene: SceneKey): World => ({
  nodes: agentNodes(),
  apps: APPS,
  snapNodes: fleetSnapshot.snapshot.nodes as World['snapNodes'],
  outbounds: fleetSnapshot.snapshot.external_outbounds as unknown as ExternalOutbound[],
  users: usersList(scene === 'crowd').users,
  tenants: TENANTS,
  settings: SETTINGS,
  system: compileView().system,
});
function initialDraft(scene: SceneKey, world: World): Draft {
  const root =
    scene === 'blank'
      ? null
      : scene === 'blocked'
        ? 'hk-home'
        : scene === 'direct' || scene === 'crowd'
          ? 'hk-hkix'
          : 'hk-bgp';
  const path = !root
    ? []
    : scene === 'branches'
      ? [root, 'tw-hinet', 'jp-iij']
      : scene === 'relay'
        ? [root, 'jp-iij']
        : scene === 'blocked'
          ? [root, 'de-fra']
          : scene === 'crowd'
            ? [root, 'us-gia']
            : [root];
  let tables = routeTables(world, path);
  if (scene === 'branches') {
    const cn: Rule = { m: { t: 'geoip', v: ['cn'] }, a: { t: 'egress', send_through: null } };
    tables = withException(world, tables, 'hk-bgp', cn);
    tables = withException(world, tables, 'jp-iij', {
      m: { t: 'geosite', v: ['netflix', 'disney'] },
      a: { t: 'proxy', outbound: 'ob-netflix-sg' },
    });
    tables = withException(world, tables, 'jp-iij', {
      m: { t: 'domain_suffix', v: ['openai.com', 'chatgpt.com'] },
      a: hopTo(world, 'jp-iij', 'us-9929'),
    });
  }
  const selected =
    scene === 'blank' || scene === 'node'
      ? []
      : scene === 'crowd'
        ? ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan']
        : ['alice', 'bob', 'carol'];
  return {
    name: scene === 'blocked' ? '' : scene === 'branches' ? '亚太三跳 · 解锁' : null,
    app: APPS[0].id,
    newAppLabel: '',
    root,
    tables,
    ports: {},
    wires: {},
    proto:
      scene === 'blocked'
        ? { ...DEFAULT_PROTO, mtproto: true, vlessPort: '14443', anytlsPort: '14443' }
        : { ...DEFAULT_PROTO },
    users: selected.map(id => `platform/${id}`),
    sel: { t: 'ingress' },
  };
}
function seed(world: World) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  for (const [key, value] of [
    [['nodes'], { nodes: world.nodes }],
    [['tenants'], { tenants: TENANTS }],
    [['settings'], SETTINGS],
    [['revisions'], { current_revision: 41, revisions: [{ id: 41 }] }],
    [['compile', 41], compileView()],
    [['users'], { users: world.users }],
    [['snapshot'], fleetSnapshot],
  ] as const)
    client.setQueryData(key, value);
  return client;
}
globalThis.fetch = async () => Response.json({ error: '本地示例不连接生产接口' }, { status: 404 });

function RefinedWizard({
  initialWorld,
  entry,
  initial,
  onCancel,
}: {
  initialWorld: World;
  entry: Entry;
  initial: Draft;
  onCancel: () => void;
}) {
  const [world, setWorld] = useState(initialWorld);
  const [draft, setDraft] = useState(initial);
  const [query, setQuery] = useState('');
  const [newUser, setNewUser] = useState(false);
  const [newId, setNewId] = useState('');
  const [dnsChanges, setDnsChanges] = useState<WizardDnsChange[]>([]);
  const [preview, setPreview] = useState(false);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const d = derive(world, entry, draft);
  const newTenant = d.tenant || (world.tenants.length === 1 ? world.tenants[0].id : '');
  const act = actionsFor(d, setDraft);
  const taken = useMemo(() => occupiedPorts(world.apps, world.nodes, world.system), [world]);
  const q = query.trim().toLowerCase();
  const visibleUsers = d.userRows.filter(user => !q || user.id.toLowerCase().includes(q));
  const selectable = visibleUsers.filter(user => !user.blocked);
  const userIdValid = isValidSlug(newId.trim());
  const duplicateUser = world.users.some(user => user.id === newId.trim() && user.tenant_id === newTenant);
  const addUser = () => {
    if (!newTenant || !userIdValid || duplicateUser) return;
    const user = { id: newId.trim(), tenant_id: newTenant, status: 'active' } as UserListItem;
    setWorld(current => ({ ...current, users: [...current.users, user] }));
    act.setUsers([...draft.users, `${newTenant}/${user.id}`]);
    setNewId('');
    setNewUser(false);
    setQuery('');
  };
  const blockers = d.issues;
  const ready = blockers.length === 0;
  const issueGo = (go: (typeof blockers)[number]['go']) => {
    const id =
      go === 'name' ? 'cr-name' : go === 'group' ? 'cr-group' : go.t === 'ingress' ? 'cr-protocols' : 'cr-path';
    const element = document.getElementById(id);
    element?.scrollIntoView({ block: 'center', behavior: 'auto' });
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.focus();
  };
  const summarize = () => ({
    name: d.name,
    group: d.appMode === 'new' ? draft.newAppLabel : world.apps.find(app => app.id === draft.app)?.label,
    users: d.granted.map(user => user.id),
    protocols: { ...draft.proto, ...d.ports },
    route: d.spine.map(d.nameOf),
  });
  return (
    <div className="nd-sheet nd-page pv-page cr-page">
      <form
        className="fg-sheet nd-paper cr-paper"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          if (!ready || save !== 'idle') return;
          setSave('saving');
          timer.current = setTimeout(() => setSave('saved'), 650);
        }}
      >
        <WizardPaperHeader
          title="新建链"
          icon="chains"
          meta={
            <>
              {' '}
              {d.name || '未命名'} <span>·</span>{' '}
              {d.appMode === 'new'
                ? draft.newAppLabel || '新分组'
                : world.apps.find(app => app.id === draft.app)?.label}{' '}
            </>
          }
          stages={[
            { label: '配置链', state: 'current' },
            { label: '提交草稿', state: 'next' },
            { label: '预览发布', state: 'next' },
          ]}
          aside={
            <span className="cr-draft-mark">
              <Icon of="artifacts" size={12} />
              草稿
            </span>
          }
        />
        <fieldset className="cr-content" disabled={save !== 'idle'}>
          <div className="cr-top-grid">
            <WizardCard title="基本信息" icon="identity" hint={<>{d.granted.length} 人已选</>} className="cr-basic">
              <div className="cr-meta-fields">
                <label className="cr-field">
                  <span>分组</span>
                  <select
                    id="cr-group"
                    className="f"
                    value={draft.app}
                    onChange={event => act.setApp(event.target.value)}
                  >
                    {world.apps.map(app => (
                      <option value={app.id} key={app.id}>
                        {app.label}
                      </option>
                    ))}
                    <option value={NEW_APP}>＋ 新建分组…</option>
                  </select>
                </label>
                {draft.app === NEW_APP && (
                  <label className="cr-field">
                    <span>分组名称</span>
                    <input
                      className="f"
                      aria-label="分组名称"
                      value={draft.newAppLabel}
                      autoFocus
                      placeholder="给分组起个名字"
                      onChange={event => act.setNewAppLabel(event.target.value)}
                    />
                  </label>
                )}
                <label className="cr-field">
                  <span>链名称</span>
                  <input
                    id="cr-name"
                    className="f"
                    value={d.name}
                    placeholder="给这条链起个名字"
                    onChange={event => act.setName(event.target.value)}
                  />
                </label>
              </div>
              <div className="cr-users-head">
                <b>授权用户</b>
                <span>{d.granted.length} 已选</span>
                <span className="sp" />
                <button
                  type="button"
                  className="cr-text-btn"
                  onClick={() => act.setUsers([...new Set([...draft.users, ...selectable.map(user => user.key)])])}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="cr-text-btn"
                  disabled={!draft.users.length}
                  onClick={() => act.setUsers([])}
                >
                  清空
                </button>
                <button
                  type="button"
                  className="cr-text-btn"
                  aria-expanded={newUser}
                  onClick={() => setNewUser(value => !value)}
                >
                  <Icon of="plus" size={11} />
                  新增用户
                </button>
              </div>
              <label className="cr-user-search">
                <Icon of="search" size={12} />
                <input
                  type="search"
                  aria-label="搜索可用用户"
                  placeholder="搜索用户"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              </label>
              {newUser && (
                <div
                  className="cr-new-user"
                  role="group"
                  aria-label="新增用户"
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      setNewUser(false);
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.stopPropagation();
                      addUser();
                    }
                  }}
                >
                  <input
                    className="f mono"
                    aria-label="新用户 ID"
                    placeholder="用户 ID"
                    value={newId}
                    autoFocus
                    onChange={event => setNewId(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!newTenant || !userIdValid || duplicateUser}
                    onClick={addUser}
                  >
                    新增并选中
                  </button>
                  {duplicateUser ? (
                    <small role="alert">这个用户已存在</small>
                  ) : newId.trim() && !userIdValid ? (
                    <small role="alert">使用 1–32 位小写字母、数字、点、下划线或连字符</small>
                  ) : null}
                </div>
              )}
              <div className="cr-user-list">
                <div className="cr-user-grid">
                  {visibleUsers.map(user => (
                    <button
                      key={user.key}
                      type="button"
                      className={`cr-user${d.picked.has(user.key) ? ' selected' : ''}`}
                      aria-pressed={d.picked.has(user.key)}
                      disabled={!!user.blocked && !d.picked.has(user.key)}
                      title={`${user.id}${user.blocked ? ` · ${user.blocked}` : ''}`}
                      onClick={() => act.toggleUser(user.key)}
                    >
                      <span className="cr-user-avatar" aria-hidden="true">
                        <GeneratedUserAvatar id={user.id} variant="cell" />
                        {d.picked.has(user.key) && (
                          <span className="cr-user-check">
                            <Icon of="check" size={9} />
                          </span>
                        )}
                      </span>
                      <span className="cr-user-copy">
                        <span className="cr-user-name">{user.id}</span>
                        {user.blocked && <small>{user.blocked}</small>}
                      </span>
                    </button>
                  ))}
                </div>
                {!visibleUsers.length && <p className="cr-no-users">没有匹配的用户</p>}
              </div>
            </WizardCard>
            <WizardCard
              title="接入协议"
              icon="ingress"
              className="cr-protocols"
              hint={<>{d.protocolCount} 种 · 端口自动避让</>}
            >
              <div id="cr-protocols">
                <RefinedIngressPanel d={d} act={act} />
              </div>
            </WizardCard>
          </div>
          <WizardCard
            title="路径"
            icon="chains"
            className="cr-path"
            hint={
              d.head
                ? `${d.spine.length} 台 · ${d.spine.length === 1 ? '直出' : `${d.spine.length - 1} 跳`}`
                : '待选入口'
            }
          >
            <div id="cr-path" className="cr-path-body">
              <WizardPathEditor
                root={draft.root}
                tables={draft.tables}
                fixedHead={!!entry.node}
                onRootChange={root =>
                  root ? act.pickEntry(root) : setDraft(current => ({ ...current, root: null, tables: {} }))
                }
                onTablesChange={tables =>
                  setDraft(current => ({ ...current, tables: reachableWizardTables(current.root, tables) }))
                }
                nodes={world.nodes}
                apps={world.apps}
                app={world.apps.find(app => app.id === draft.app) ?? null}
                chainId="mock-new-chain"
                tenant={d.tenant}
                outbounds={d.outboundsFor}
                onOutboundCreated={outbound =>
                  setWorld(current => ({
                    ...current,
                    outbounds: [...current.outbounds.filter(item => item.id !== outbound.id), outbound],
                  }))
                }
                taken={taken}
                hopBase={world.settings.ports.hop_base}
                portOf={d.portOf}
                wireOf={d.wireOf}
                onPortChange={(host, port) => act.setPort(host, port)}
                onWireChange={act.setWire}
                portIssueOf={host => {
                  const edge = d.edges.find(edge => edge.listener === host);
                  return edge ? (d.edgeIssues[d.edgeKey(edge.source, edge.target)]?.[0] ?? null) : null;
                }}
                egressAllowed={d.egressAllowed}
                globalRealityReady={d.globalRealityReady}
                realitySite={{ dest: d.realitySite.dest, names: d.realitySite.server_names }}
                entryProtocolCount={d.protocolCount}
                dnsPolicies={[]}
                dnsChanges={dnsChanges}
                onDnsChange={(node, selector, resolution) =>
                  setDnsChanges(current => [
                    ...current.filter(
                      change => change.node !== node || JSON.stringify(change.selector) !== JSON.stringify(selector),
                    ),
                    { node, selector, resolution },
                  ])
                }
              />
            </div>
          </WizardCard>
          {preview && (
            <WizardCard title="配置预览" icon="artifacts" className="cr-preview">
              <pre>{JSON.stringify(summarize(), null, 2)}</pre>
            </WizardCard>
          )}
        </fieldset>
        <footer className="pv-foot cr-foot">
          <div className={`cr-submit-state ${save}`} role="status">
            <i aria-hidden="true" />
            {save === 'saved' ? (
              '已加入示例草稿'
            ) : save === 'saving' ? (
              '加入草稿中…'
            ) : ready ? (
              '配置完整'
            ) : (
              <button type="button" className="cr-blocker" onClick={() => issueGo(blockers[0].go)}>
                {blockers[0].text}
                {blockers.length > 1 && <small>另 {blockers.length - 1} 项</small>}
              </button>
            )}
          </div>
          <button
            type="button"
            className="cr-text-btn cr-preview-toggle"
            aria-expanded={preview}
            onClick={() => setPreview(value => !value)}
          >
            <Icon of="artifacts" size={12} />
            配置预览
          </button>
          <button type="button" className="btn" disabled={save === 'saving'} onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" type="submit" disabled={!ready || save !== 'idle'}>
            {save === 'saving' ? '加入中…' : save === 'saved' ? '已加入草稿' : '加入草稿'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function App() {
  const [scene, setScene] = useState<SceneKey>(pick(params.get('scene'), Object.keys(SCENES) as SceneKey[], 'relay'));
  const [view, setView] = useState<View>(pick<View>(params.get('view'), ['refined', 'current', 'claude'], 'refined'));
  const [width, setWidth] = useState(Number(params.get('w')) || 1180);
  const [mode, setMode] = useState(pick(params.get('theme'), ['light', 'dark'], 'light'));
  const [round, setRound] = useState(0);
  const [canceled, setCanceled] = useState(false);
  const world = useMemo(() => makeWorld(scene), [scene]);
  const initial = useMemo(() => initialDraft(scene, world), [scene, world]);
  const client = useMemo(() => seed(world), [world]);
  const entry: Entry = scene === 'node' ? { node: 'hk-bgp' } : {};
  useEffect(() => {
    if (theme.snapshot() !== mode) theme.toggle();
  }, [mode]);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries({ scene, view, w: String(width), theme: mode })) query.set(key, value);
    history.replaceState(null, '', `?${query}`);
  }, [scene, view, width, mode]);
  const reset = () => {
    setCanceled(false);
    setRound(current => current + 1);
  };
  return (
    <QueryClientProvider client={client}>
      <SessionProvider
        value={{
          who: {
            operator_id: 'admin',
            role: 'system-admin',
            tenant_scope: 'platform',
            token_prefix: null,
            masked_assets: false,
          },
          initial: { node_count: 12, chain_group_count: [] },
        }}
        onIdentityChange={() => undefined}
      >
        {params.get('nav') !== '0' && (
          <div className="cr-review">
            <div className="cr-review-row">
              <b>
                创建链 · 细节打磨<small>MOCKUP</small>
              </b>
              <span className="sp" />
              <SegmentedControl
                ariaLabel="预览版本"
                value={view}
                options={[
                  { value: 'refined', label: '保留原布局' },
                  { value: 'current', label: '现有界面' },
                  { value: 'claude', label: 'Claude 原方案' },
                ]}
                onChange={value => {
                  setView(value);
                  setCanceled(false);
                }}
              />
              <label>
                场景
                <select
                  aria-label="预览场景"
                  value={scene}
                  onChange={event => {
                    setScene(event.target.value as SceneKey);
                    setCanceled(false);
                  }}
                >
                  {Object.entries(SCENES).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <SegmentedControl
                ariaLabel="预览宽度"
                value={width}
                options={[1180, 900, 620, 390].map(value => ({ value, label: String(value) }))}
                onChange={setWidth}
              />
              <SegmentedControl
                ariaLabel="预览主题"
                value={mode}
                options={[
                  { value: 'light', label: '亮' },
                  { value: 'dark', label: '暗' },
                ]}
                onChange={setMode}
              />
              <button type="button" className="btn" onClick={reset}>
                重置
              </button>
            </div>
            <p>
              基本信息与协议在上，路径在下。复用 Claude Code 原 mockup
              的控件、留白与状态语言；本页操作仅作用于示例数据。
            </p>
          </div>
        )}
        <main className={`cr-stage${view === 'refined' ? ' cr-refined' : ''}`}>
          <div className="cr-frame" style={{ width: `min(100%, ${width}px)` }}>
            <Fragment key={`${scene}/${view}/${round}`}>
              {canceled ? (
                <div className="cr-canceled">
                  <Icon of="chains" size={24} />
                  <b>已取消新建链</b>
                  <button type="button" className="btn" onClick={reset}>
                    重新打开
                  </button>
                </div>
              ) : view === 'refined' ? (
                <RefinedWizard
                  initialWorld={world}
                  entry={entry}
                  initial={initial}
                  onCancel={() => setCanceled(true)}
                />
              ) : view === 'claude' ? (
                <ChainWizardMockup world={world} entry={entry} initial={initial} />
              ) : (
                <div
                  onSubmitCapture={event => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <ChainWizard
                    node={entry.node ? world.nodes.find(node => node.node_id === entry.node) : undefined}
                    defaultApp={{ id: APPS[0].id, label: APPS[0].label }}
                    onDone={() => setCanceled(true)}
                  />
                </div>
              )}
            </Fragment>
          </div>
        </main>
      </SessionProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
