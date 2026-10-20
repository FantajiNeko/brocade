// The redesigned 建链向导 for the mockup. Local state only; never imported by the app.
//
// The page is the chain itself: a vertical route line 用户 → 接入 → 入口 → 中转… → 出口 → 出网 on the
// left, and one editor on the right for whatever is selected on the line. Below 760px the editor
// opens inline under the selected row. Route/port/rule semantics reuse the production helpers so the
// defaults, auto ports and validation shown here are the ones the real wizard computes.
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type {
  CertificateTrack,
  DestMatch,
  ExternalOutbound,
  NodeAgentStateItem,
  RealityFallbackMode,
  Rule,
  SnapshotApp,
  UserListItem,
} from '../../src/api';
import { nodeCertificateLabel } from '../../src/certificate';
import { mtprotoNodeEligibility } from '../../src/mtproto-capability';
import { INGRESS_PROTOCOL_DESCRIPTIONS } from '../../src/ingress-protocols';
import { realityFingerprintIsValid, realityServerNameIsValid } from '../../src/reality';
import {
  reachableWizardTables,
  wizardDefaultListenerWire,
  wizardEgressRule,
  wizardForwardEdges,
  wizardMembers,
  wizardSpine,
  type WizardRuleTables,
} from '../../src/panes/chain-wizard-graph';
import { freePortAcross, freeSpanAcross, occupiedPorts, portClash, spanClash } from '../../src/panes/ports';
import {
  buildMatch,
  defaultHopDial,
  dialKindOf,
  dialUnavailable,
  DIAL_ORDER,
  externalProtocolBadge,
  forwardAction,
  formatHostPort,
  hopDialOf,
  hostOf,
  isPinnedTerminalRule,
  MATCH_KINDS,
  matchValues,
  pinTerminalRules,
  under,
  type DialKind,
} from '../../src/panes/rules';
import { SegmentedControl } from '../../src/ui/bits';
import { HOP_WIRE_OPTIONS, hopWireLabel, type HopWireKind } from '../../src/ui/format';
import { Icon, type IconName } from '../../src/ui/icons';
import { RegionFlag } from '../../src/ui/region-flag';

/* ══ World and draft ══ */

export interface World {
  nodes: NodeAgentStateItem[];
  apps: SnapshotApp[];
  snapNodes: {
    id: string;
    certificate_name: string | null;
    certificate_track: CertificateTrack | null;
    egress_allowed: boolean;
  }[];
  outbounds: ExternalOutbound[];
  users: UserListItem[];
  tenants: { id: string; name: string }[];
  settings: {
    ports: Record<
      'ingress_base' | 'vless_encryption_base' | 'anytls_base' | 'hy2_base' | 'mtproto_base' | 'hop_base',
      number
    >;
    reality_site: { dest: string; server_names: string[] };
  };
  system: unknown;
}

export interface Entry {
  /** Entered from a group page: select that group by default. */
  defaultApp?: { id: string; label: string };
  /** Entered from a machine page: the entry machine is decided. */
  node?: string;
}

export type Sel =
  | { t: 'users' }
  | { t: 'ingress' }
  | { t: 'choose'; purpose: 'entry' | 'append' }
  | { t: 'node'; id: string }
  | { t: 'edge'; source: string; target: string };

export interface Proto {
  vless: boolean;
  encryption: boolean;
  anytls: boolean;
  hy2: boolean;
  mtproto: boolean;
  vlessPort: string | null;
  encryptionPort: string | null;
  anytlsPort: string | null;
  mtprotoPort: string | null;
  hy2Start: string | null;
  hy2End: string | null;
  hy2Up: string;
  hy2Down: string;
  padding: 'default' | 'custom';
  paddingText: string;
  reality: RealityFallbackMode | null;
  realityDest: string;
  realityNames: string;
  realityFingerprint: string;
  encryptionProfile: 'default' | 'native';
}

export interface Draft {
  /** null leaves the name blank until the operator types one. */
  name: string | null;
  app: string;
  newAppLabel: string;
  root: string | null;
  tables: WizardRuleTables;
  ports: Record<string, string>;
  wires: Record<string, HopWireKind>;
  proto: Proto;
  users: string[];
  sel: Sel;
}

export const NEW_APP = ' :new-app:';

export const DEFAULT_PROTO: Proto = {
  vless: true,
  encryption: false,
  anytls: true,
  hy2: true,
  mtproto: false,
  vlessPort: null,
  encryptionPort: null,
  anytlsPort: null,
  mtprotoPort: null,
  hy2Start: null,
  hy2End: null,
  hy2Up: '',
  hy2Down: '',
  padding: 'default',
  paddingText: '',
  reality: null,
  realityDest: '',
  realityNames: '',
  realityFingerprint: 'chrome',
  encryptionProfile: 'default',
};

const HY2_SPAN = 100;

const DIAL_SHORT: Record<DialKind, string> = {
  public_ipv4: '公网 IPv4',
  public_ipv6: '公网 IPv6',
  reverse_v4: '反向 IPv4',
  reverse_v6: '反向 IPv6',
  overlay: 'WireGuard',
  custom: '自定义',
};

type Issue = { text: string; go: Sel | 'name' | 'group' };

/* ══ Derivation: everything the page shows is computed here, once per render ══ */

export function derive(world: World, entry: Entry, draft: Draft) {
  const { nodes, apps, settings } = world;
  const nodeOf = (id: string) => nodes.find(node => node.node_id === id) ?? null;
  const nameOf = (id: string) => nodeOf(id)?.name || id;
  const snapOf = (id: string) => world.snapNodes.find(node => node.id === id) ?? null;
  const egressAllowed = (id: string) => snapOf(id)?.egress_allowed !== false;
  const head = draft.root ? nodeOf(draft.root) : null;
  const headId = head?.node_id ?? '';
  const tenant = head?.tenant_id ?? '';
  const headCert = head ? (snapOf(head.node_id)?.certificate_name ?? null) : null;
  const certLabel = nodeCertificateLabel(head ? snapOf(head.node_id)?.certificate_track : null);
  const realitySite = settings.reality_site;
  const globalRealityReady = realitySite.dest.trim() !== '' && realitySite.server_names.length > 0;

  const taken = occupiedPorts(apps, nodes, world.system);
  const udpTaken = occupiedPorts(apps, nodes, world.system, undefined, 'udp');
  const p = draft.proto;

  const vlessPortText = p.vlessPort ?? String(freePortAcross(taken, [headId], settings.ports.ingress_base));
  const vlessPort = Number(vlessPortText);
  let anytlsAuto = freePortAcross(taken, [headId], settings.ports.anytls_base);
  while (anytlsAuto === vlessPort && anytlsAuto < 65536) anytlsAuto += 1;
  const anytlsPortText = p.anytlsPort ?? String(anytlsAuto);
  const anytlsPort = Number(anytlsPortText);
  const hy2StartText = p.hy2Start ?? String(freeSpanAcross(udpTaken, [headId], settings.ports.hy2_base, HY2_SPAN));
  const hy2Start = Number(hy2StartText);
  const hy2EndText = p.hy2End ?? String(hy2Start + HY2_SPAN - 1);
  const hy2End = Number(hy2EndText);
  let encryptionAuto = freePortAcross(taken, [headId], settings.ports.vless_encryption_base);
  while (
    encryptionAuto < 65536 &&
    ((p.vless && encryptionAuto === vlessPort) ||
      (p.anytls && encryptionAuto === anytlsPort) ||
      taken.get(headId)?.has(encryptionAuto))
  )
    encryptionAuto += 1;
  const encryptionPortText = p.encryptionPort ?? String(encryptionAuto);
  const encryptionPort = Number(encryptionPortText);
  let mtprotoAuto = freePortAcross(taken, [headId], settings.ports.mtproto_base);
  while (
    mtprotoAuto < 65536 &&
    ((p.vless && mtprotoAuto === vlessPort) ||
      (p.encryption && mtprotoAuto === encryptionPort) ||
      (p.anytls && mtprotoAuto === anytlsPort) ||
      taken.get(headId)?.has(mtprotoAuto))
  )
    mtprotoAuto += 1;
  const mtprotoPortText = p.mtprotoPort ?? String(mtprotoAuto);
  const mtprotoPort = Number(mtprotoPortText);

  const realityTarget: RealityFallbackMode | '' =
    p.reality ?? (headCert ? 'node-certificate' : globalRealityReady ? 'global-site' : '');
  const customNames = p.realityNames
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const customRealityIssues = {
    dest: !p.realityDest.trim()
      ? '填写目标地址与端口，如 example.com:443'
      : !/^\S+:[1-9]\d*$/.test(p.realityDest.trim()) || Number(p.realityDest.trim().split(':').at(-1)) > 65535
        ? '目标地址须包含 1–65535 范围内的端口'
        : null,
    names:
      customNames.length === 0
        ? '填写服务名称（SNI）'
        : !customNames.every(realityServerNameIsValid)
          ? 'SNI 使用域名，不包含通配符或端口'
          : null,
    fingerprint: !realityFingerprintIsValid(p.realityFingerprint) ? '选择有效的客户端指纹' : null,
  };
  const realityReady =
    !p.vless ||
    (realityTarget === 'node-certificate' && !!headCert) ||
    (realityTarget === 'global-site' && globalRealityReady) ||
    (realityTarget === 'custom-site' && Object.values(customRealityIssues).every(issue => issue === null));

  const tcp: { key: string; label: string; port: number }[] = [];
  if (p.vless) tcp.push({ key: 'vless', label: 'REALITY', port: vlessPort });
  if (p.encryption) tcp.push({ key: 'encryption', label: 'Encryption', port: encryptionPort });
  if (p.anytls) tcp.push({ key: 'anytls', label: 'AnyTLS', port: anytlsPort });
  if (p.mtproto) tcp.push({ key: 'mtproto', label: 'MTProxy', port: mtprotoPort });
  const portIssue: Record<string, string> = {};
  for (const listener of tcp) {
    if (!Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) {
      portIssue[listener.key] = '端口须为 1–65535';
      continue;
    }
    const twin = tcp.find(other => other !== listener && other.port === listener.port);
    if (twin) {
      portIssue[listener.key] = `与 ${twin.label} 同端口`;
      continue;
    }
    if (head && portClash(taken, [headId], listener.port)) portIssue[listener.key] = `${listener.port} 已被占用`;
  }
  if (p.hy2) {
    if (!Number.isInteger(hy2Start) || !Number.isInteger(hy2End) || hy2Start < 1 || hy2End > 65535 || hy2End < hy2Start)
      portIssue.hy2 = '端口范围无效';
    else if (head && spanClash(udpTaken, [headId], hy2Start, hy2End)) portIssue.hy2 = '范围内有端口已被占用';
  }
  const protocolCount = [p.vless, p.encryption, p.anytls, p.hy2, p.mtproto].filter(Boolean).length;
  const mtprotoUnavailable = head ? mtprotoNodeEligibility(head).reason : null;
  const needsCert = Boolean(head) && !headCert;

  const spine = wizardSpine(draft.root, draft.tables);
  const members = wizardMembers(draft.root, draft.tables);
  const edges = wizardForwardEdges(draft.root, draft.tables);
  const listeners = [...new Set(edges.map(edge => edge.listener))];
  const hopBase = settings.ports.hop_base;
  const autoPort = (host: string) => freePortAcross(taken, [host], hopBase);
  const portOf = (host: string) => draft.ports[host] ?? String(autoPort(host));
  const wireOf = (host: string): HopWireKind => draft.wires[host] ?? wizardDefaultListenerWire(edges, host);
  const fallback = (id: string): Rule =>
    egressAllowed(id) ? wizardEgressRule() : { m: { t: 'any' }, a: { t: 'block' } };
  const tail = spine.at(-1) ?? null;
  const exitCountry = (tail ? nodeOf(tail) : null)?.public_ipv4_country?.trim().toUpperCase() || null;
  const outboundsFor = world.outbounds.filter(
    outbound => tenant === outbound.tenant || (outbound.protocol.t !== 'warp' && under(tenant, outbound.tenant)),
  );

  /* ── Users ── */
  const userRows = [...world.users]
    .sort((a, b) => a.tenant_id.localeCompare(b.tenant_id) || a.id.localeCompare(b.id))
    .map(user => ({
      ...user,
      key: `${user.tenant_id}/${user.id}`,
      blocked: user.status !== 'active' ? '已停用' : !head || under(user.tenant_id, tenant) ? null : '不可授权',
    }));
  const picked = new Set(draft.users);
  const granted = userRows.filter(user => picked.has(user.key) && !user.blocked);

  /* ── Group and name ── */
  const appMode = draft.app === NEW_APP ? 'new' : 'existing';
  const name = draft.name ?? '';

  /* ── Blocking issues, each pointing at the row that fixes it ── */
  const issues: Issue[] = [];
  const nodeIssues: Record<string, string[]> = {};
  const edgeIssues: Record<string, string[]> = {};
  const edgeKey = (source: string, target: string) => `${source}>${target}`;
  if (!head) issues.push({ text: '选择入口机器', go: { t: 'choose', purpose: 'entry' } });
  if (appMode === 'new' && !draft.newAppLabel.trim()) issues.push({ text: '填写分组名称', go: 'group' });
  if (head && !name.trim()) issues.push({ text: '填写链名称', go: 'name' });
  const ingressIssues: string[] = [];
  if (protocolCount === 0) ingressIssues.push('至少开启一个接入协议');
  if (p.mtproto && mtprotoUnavailable) ingressIssues.push('MTProxy 在这台机器上不可用');
  if (needsCert && (p.anytls || p.hy2)) ingressIssues.push(`${head?.name} 没有证书`);
  if (!realityReady) ingressIssues.push('补全 REALITY 伪装目标');
  if (p.anytls && p.padding === 'custom' && !p.paddingText.trim()) ingressIssues.push('填写 Padding 规则');
  if (p.hy2 && Boolean(p.hy2Up.trim()) !== Boolean(p.hy2Down.trim())) ingressIssues.push('上下行带宽需同时填写');
  if (Object.keys(portIssue).length) ingressIssues.push('接入端口冲突');
  for (const text of ingressIssues) issues.push({ text, go: { t: 'ingress' } });
  for (const id of members) {
    for (const rule of draft.tables[id] ?? []) {
      const text =
        'v' in rule.m && Array.isArray(rule.m.v) && rule.m.v.length === 0
          ? '例外规则缺少匹配值'
          : rule.a.t === 'egress' && !egressAllowed(id)
            ? '不允许出网'
            : null;
      if (text && !nodeIssues[id]?.includes(text)) {
        (nodeIssues[id] ??= []).push(text);
        issues.push({ text: `${nameOf(id)}：${text}`, go: { t: 'node', id } });
      }
    }
  }
  for (const edge of edges) {
    if (dialKindOf(edge.dial, nodeOf(edge.target)) !== 'custom' || hostOf(edge.dial).trim()) continue;
    (edgeIssues[edgeKey(edge.source, edge.target)] ??= []).push('填写地址');
    issues.push({
      text: `${nameOf(edge.target)}：填写地址`,
      go: { t: 'edge', source: edge.source, target: edge.target },
    });
  }
  for (const host of listeners) {
    const raw = portOf(host);
    const port = Number(raw);
    const text =
      !/^\d+$/.test(raw) || port < 1 || port > 65535
        ? '端口须为 1–65535'
        : portClash(taken, [host], port)
          ? `${port} 已被占用`
          : host === headId && tcp.some(listener => listener.port === port)
            ? '与接入端口相同'
            : null;
    if (!text) continue;
    const edge = edges.find(candidate => candidate.listener === host)!;
    (edgeIssues[edgeKey(edge.source, edge.target)] ??= []).push(text);
    issues.push({ text: `${nameOf(host)} 监听：${text}`, go: { t: 'edge', source: edge.source, target: edge.target } });
  }

  return {
    world,
    entry,
    draft,
    nodeOf,
    nameOf,
    snapOf,
    egressAllowed,
    head,
    headId,
    tenant,
    headCert,
    certLabel,
    needsCert,
    realitySite,
    globalRealityReady,
    ports: { vlessPortText, anytlsPortText, encryptionPortText, mtprotoPortText, hy2StartText, hy2EndText },
    portIssue,
    realityTarget,
    realityReady,
    customRealityIssues,
    protocolCount,
    mtprotoUnavailable,
    spine,
    members,
    edges,
    portOf,
    wireOf,
    autoPort,
    fallback,
    tail,
    exitCountry,
    outboundsFor,
    userRows,
    picked,
    granted,
    appMode,
    name,
    issues,
    ingressIssues,
    nodeIssues,
    edgeIssues,
    edgeKey,
  };
}

type Derived = ReturnType<typeof derive>;

/* ══ Text helpers ══ */

function matchText(match: DestMatch): { kind: string; value: string } {
  if (match.t === 'network') return { kind: '传输层', value: match.v.toUpperCase() };
  if (match.t === 'any') return { kind: '其余', value: '' };
  if (match.t === 'sniffing_failed') return { kind: '嗅探失败', value: '' };
  return { kind: MATCH_KINDS.find(candidate => candidate.t === match.t)?.label ?? match.t, value: matchValues(match) };
}

function protocolChips(d: Derived) {
  const p = d.draft.proto;
  return [
    p.vless && { key: 'vless', label: 'REALITY', port: d.ports.vlessPortText },
    p.encryption && { key: 'encryption', label: 'Encryption', port: d.ports.encryptionPortText },
    p.anytls && { key: 'anytls', label: 'AnyTLS', port: d.ports.anytlsPortText },
    p.hy2 && { key: 'hy2', label: 'HY2', port: `${d.ports.hy2StartText}–${d.ports.hy2EndText}` },
    p.mtproto && { key: 'mtproto', label: 'MTProxy', port: d.ports.mtprotoPortText },
  ].filter((chip): chip is { key: string; label: string; port: string } => Boolean(chip));
}

/* ══ Actions ══ */

export function actionsFor(d: Derived, setDraft: (update: (draft: Draft) => Draft) => void) {
  const { draft } = d;
  const commit = (tables: WizardRuleTables, sel?: Sel) =>
    setDraft(current => ({ ...current, tables: reachableWizardTables(current.root, tables), sel: sel ?? current.sel }));
  const defaultForward = (source: string, target: string) => {
    const port = Number(d.portOf(target)) || d.autoPort(target);
    return forwardAction(target, defaultHopDial({ peer: d.nodeOf(target), self: d.nodeOf(source), port }));
  };
  const mapForward = (
    source: string,
    target: string,
    map: (action: Extract<Rule['a'], { t: 'forward' }>) => Rule['a'],
  ) =>
    commit({
      ...draft.tables,
      [source]: (draft.tables[source] ?? []).map(rule =>
        rule.a.t === 'forward' && rule.a.to === target ? { ...rule, a: map(rule.a) } : rule,
      ),
    });
  return {
    select: (sel: Sel) => setDraft(current => ({ ...current, sel })),
    setProto: (patch: Partial<Proto>) => setDraft(current => ({ ...current, proto: { ...current.proto, ...patch } })),
    setName: (name: string) => setDraft(current => ({ ...current, name })),
    setApp: (app: string) => setDraft(current => ({ ...current, app })),
    setNewAppLabel: (newAppLabel: string) => setDraft(current => ({ ...current, newAppLabel })),
    toggleUser: (key: string) =>
      setDraft(current => ({
        ...current,
        users: current.users.includes(key) ? current.users.filter(item => item !== key) : [...current.users, key],
      })),
    setUsers: (users: string[]) => setDraft(current => ({ ...current, users })),
    pickEntry: (id: string) =>
      setDraft(current => {
        // Changing the entry keeps the rest of the route: the old entry's table moves to the new one.
        const oldRoot = current.root;
        if (!oldRoot) return { ...current, root: id, tables: { [id]: [d.fallback(id)] }, sel: { t: 'node', id } };
        const tables: WizardRuleTables = { ...current.tables, [id]: current.tables[oldRoot] ?? [d.fallback(id)] };
        delete tables[oldRoot];
        return { ...current, root: id, tables: reachableWizardTables(id, tables), sel: { t: 'node', id } };
      }),
    append: (target: string) => {
      const source = d.spine.at(-1);
      if (!source) return;
      const rows = draft.tables[source] ?? [d.fallback(source)];
      commit(
        {
          ...draft.tables,
          [source]: rows.map(rule => (rule.m.t === 'any' ? { ...rule, a: defaultForward(source, target) } : rule)),
          [target]: draft.tables[target] ?? [d.fallback(target)],
        },
        { t: 'node', id: target },
      );
    },
    remove: (target: string) => {
      const next: WizardRuleTables = {};
      for (const [source, rows] of Object.entries(draft.tables)) {
        next[source] = rows.flatMap(rule => {
          if (rule.a.t !== 'forward' || rule.a.to !== target) return [rule];
          return rule.m.t === 'any' ? [{ ...rule, a: d.fallback(source).a }] : [];
        });
      }
      commit(next, { t: 'node', id: d.spine[d.spine.indexOf(target) - 1] ?? d.headId });
    },
    patchRule: (source: string, index: number, rule: Rule) => {
      const next = {
        ...draft.tables,
        [source]: pinTerminalRules((draft.tables[source] ?? []).map((row, i) => (i === index ? rule : row))),
      };
      if (rule.a.t === 'forward' && rule.a.to && !next[rule.a.to]) next[rule.a.to] = [d.fallback(rule.a.to)];
      commit(next);
    },
    setRuleAction: (source: string, index: number, kind: 'forward' | 'proxy' | 'egress' | 'block', target?: string) => {
      const rule = draft.tables[source]?.[index];
      if (!rule) return;
      let a: Rule['a'];
      if (kind === 'egress') a = { t: 'egress', send_through: null };
      else if (kind === 'block') a = { t: 'block' };
      else if (kind === 'proxy') a = { t: 'proxy', outbound: target ?? d.outboundsFor[0]?.id ?? '' };
      else {
        const to =
          target ??
          d.world.nodes.find(
            node =>
              node.node_id !== source &&
              node.node_id !== d.headId &&
              !node.retired_at &&
              under(d.tenant, node.tenant_id) &&
              !d.spine.includes(node.node_id),
          )?.node_id ??
          '';
        const same = draft.tables[source]?.find(candidate => candidate.a.t === 'forward' && candidate.a.to === to);
        a = same?.a.t === 'forward' ? same.a : defaultForward(source, to);
      }
      const next = {
        ...draft.tables,
        [source]: pinTerminalRules((draft.tables[source] ?? []).map((row, i) => (i === index ? { ...rule, a } : row))),
      };
      if (a.t === 'forward' && a.to && !next[a.to]) next[a.to] = [d.fallback(a.to)];
      commit(next);
    },
    addException: (source: string) => {
      const rows = [...(draft.tables[source] ?? [d.fallback(source)])];
      const terminal = rows.findIndex(isPinnedTerminalRule);
      rows.splice(terminal < 0 ? rows.length : terminal, 0, {
        m: { t: 'geosite', v: [] },
        a: d.egressAllowed(source) ? { t: 'egress', send_through: null } : { t: 'block' },
      });
      commit({ ...draft.tables, [source]: pinTerminalRules(rows) });
    },
    moveRule: (source: string, index: number, delta: number) => {
      const rows = [...(draft.tables[source] ?? [])];
      const next = index + delta;
      if (next < 0 || next >= rows.length || isPinnedTerminalRule(rows[index]) || isPinnedTerminalRule(rows[next]))
        return;
      [rows[index], rows[next]] = [rows[next], rows[index]];
      commit({ ...draft.tables, [source]: rows });
    },
    removeRule: (source: string, index: number) =>
      commit({ ...draft.tables, [source]: (draft.tables[source] ?? []).filter((_, i) => i !== index) }),
    setDial: (source: string, target: string, kind: DialKind) =>
      mapForward(source, target, action =>
        forwardAction(
          target,
          hopDialOf(kind, d.nodeOf(target), Number(d.portOf(target)) || d.autoPort(target)),
          action.pool,
        ),
      ),
    setCustomHost: (source: string, target: string, host: string) =>
      mapForward(source, target, action =>
        forwardAction(
          target,
          { t: 'addr', v: formatHostPort(host, Number(d.portOf(target)) || d.autoPort(target)) },
          action.pool,
        ),
      ),
    setPool: (source: string, target: string, mux: boolean) =>
      mapForward(source, target, action => forwardAction(target, action.dial, mux ? { t: 'mux' } : { t: 'none' })),
    setPort: (host: string, port: string | null) =>
      setDraft(current => {
        const ports = { ...current.ports };
        if (port === null) delete ports[host];
        else ports[host] = port;
        return { ...current, ports };
      }),
    setWire: (host: string, wire: HopWireKind) =>
      setDraft(current => ({ ...current, wires: { ...current.wires, [host]: wire } })),
  };
}

type Actions = ReturnType<typeof actionsFor>;

/* ══ Page ══ */

export function ChainWizardMockup({ world, entry, initial }: { world: World; entry: Entry; initial: Draft }) {
  const [draft, setDraft] = useState(() => ({
    ...initial,
    app: world.apps.find(app => app.id === entry.defaultApp?.id)?.id ?? initial.app,
  }));
  const d = derive(world, entry, draft);
  const act = actionsFor(d, setDraft);
  const paper = useRef<HTMLFormElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = paper.current;
    if (!element) return;
    const observer = new ResizeObserver(([item]) => setNarrow(item.contentRect.width < 760));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const go = (target: Issue['go']) => {
    if (target === 'name') document.getElementById('cw-name')?.focus();
    else if (target === 'group') document.getElementById('cw-group')?.focus();
    else act.select(target);
  };
  const ready = d.issues.length === 0;
  const inspector = <Inspector d={d} act={act} />;

  return (
    <div className="nd-sheet nd-page pv-page cw-page">
      <form
        ref={paper}
        className={`fg-sheet nd-paper cw-paper${narrow ? ' narrow' : ''}`}
        noValidate
        onSubmit={event => event.preventDefault()}
      >
        <Header d={d} act={act} />
        <div className="cw-route">
          <RouteLine d={d} act={act} inline={narrow ? inspector : null} />
          {!narrow && <section className="cw-inspector">{inspector}</section>}
        </div>
        <footer className="pv-foot cw-foot">
          <div className="cw-foot-state" aria-live="polite">
            {!ready && (
              <>
                <span className="cw-foot-count">还差 {d.issues.length} 项</span>
                {d.issues.slice(0, 3).map((issue, index) => (
                  <button type="button" key={index} className="cw-issue" onClick={() => go(issue.go)}>
                    {issue.text}
                  </button>
                ))}
              </>
            )}
          </div>
          <button type="button" className="btn">
            取消
          </button>
          <button className="btn primary" disabled={!ready} type="submit">
            加入草稿
          </button>
        </footer>
      </form>
    </div>
  );
}

/* ══ Header: the chain's identity as the detail page will show it ══ */

function Header({ d, act }: { d: Derived; act: Actions }) {
  return (
    <header className="nd-page-head cw-head">
      <div className="nd-page-identity cw-identity">
        <span className={`nd-idplate${d.exitCountry ? '' : ' empty'}`} aria-hidden="true">
          <span className="nd-idplate-clip">
            {d.exitCountry ? <RegionFlag code={d.exitCountry} square /> : <Icon of="chains" size={15} />}
          </span>
        </span>
        <span className="cw-ident">
          <span className="cw-eyebrow">新建链</span>
          <input
            id="cw-name"
            className="cw-name"
            aria-label="链名称"
            value={d.name}
            placeholder="未命名"
            onChange={event => act.setName(event.target.value)}
            aria-invalid={Boolean(d.head) && !d.name.trim()}
          />
        </span>
      </div>
      <div className="cw-facts">
        <label className="cw-fact">
          <span>分组</span>
          <select
            id="cw-group"
            className="cw-bare-select"
            value={d.draft.app}
            onChange={event => act.setApp(event.target.value)}
          >
            {d.world.apps.map(app => (
              <option key={app.id} value={app.id}>
                {app.label || app.id}
              </option>
            ))}
            <option value={NEW_APP}>＋ 新建分组…</option>
          </select>
          {d.appMode === 'new' && (
            <input
              className="f cw-new-group"
              aria-label="新分组名称"
              placeholder="分组名称"
              value={d.draft.newAppLabel}
              aria-invalid={!d.draft.newAppLabel.trim()}
              onChange={event => act.setNewAppLabel(event.target.value)}
            />
          )}
        </label>
        <span className="cw-fact">
          <span>出口地区</span>
          <b>
            {d.exitCountry ? (
              <>
                <RegionFlag code={d.exitCountry} />
                {d.exitCountry}
              </>
            ) : (
              '—'
            )}
          </b>
        </span>
      </div>
    </header>
  );
}

/* ══ Route line ══ */

function Rail({ icon, role, issue }: { icon?: IconName; role?: string; issue?: boolean }) {
  return (
    <span className={`cw-node${icon ? ' icon' : ''}`} data-role={role} aria-hidden="true">
      {icon && <Icon of={icon} size={12} />}
      {issue && <i className="cw-node-issue" />}
    </span>
  );
}

function RouteLine({ d, act, inline }: { d: Derived; act: Actions; inline: ReactNode }) {
  const sel = d.draft.sel;
  const rows: ReactNode[] = [];
  const add = (key: string, row: ReactNode, selected: boolean) => {
    rows.push(<Fragment key={key}>{row}</Fragment>);
    if (inline && selected)
      rows.push(
        <li key={`${key}:inspector`} className="cw-inline">
          {inline}
        </li>,
      );
  };
  const chips = protocolChips(d);

  const usersSel = sel.t === 'users';
  add(
    'users',
    <li className="cw-row cw-stub first" data-selected={usersSel || undefined}>
      <Rail icon="users" />
      <button type="button" className="cw-hit" aria-pressed={usersSel} onClick={() => act.select({ t: 'users' })}>
        <span className="cw-title">
          用户<small>{d.granted.length || ''}</small>
        </span>
        <span className="cw-sub">
          {d.granted.length
            ? d.granted
                .slice(0, 4)
                .map(user => user.id)
                .join('、') + (d.granted.length > 4 ? ` 等` : '')
            : '未选择'}
        </span>
      </button>
    </li>,
    usersSel,
  );

  const ingressSel = sel.t === 'ingress';
  add(
    'ingress',
    <li className="cw-row cw-stub" data-selected={ingressSel || undefined}>
      <Rail icon="ingress" issue={d.ingressIssues.length > 0} />
      <button type="button" className="cw-hit" aria-pressed={ingressSel} onClick={() => act.select({ t: 'ingress' })}>
        <span className="cw-title">接入</span>
        <span className="cw-chips">
          {chips.map(chip => (
            <span className={`cw-chip${d.portIssue[chip.key] ? ' bad' : ''}`} key={chip.key}>
              {chip.label}
              {d.head && <b>{chip.port}</b>}
            </span>
          ))}
          {chips.length === 0 && <span className="cw-sub bad">未开启</span>}
        </span>
      </button>
    </li>,
    ingressSel,
  );

  if (!d.head) {
    const choosing = sel.t === 'choose' && sel.purpose === 'entry';
    add(
      'pick',
      <li className="cw-row cw-station placeholder" data-selected={choosing || undefined}>
        <Rail role="pending" />
        <button
          type="button"
          className="cw-hit"
          aria-pressed={choosing}
          onClick={() => act.select({ t: 'choose', purpose: 'entry' })}
        >
          <span className="cw-title">选择入口机器</span>
        </button>
      </li>,
      choosing,
    );
  }

  d.spine.forEach((id, index) => {
    const node = d.nodeOf(id);
    const last = index === d.spine.length - 1;
    const role = index === 0 ? 'entry' : last ? 'exit' : 'relay';
    const selected = sel.t === 'node' && sel.id === id;
    add(
      `station:${id}`,
      <li className="cw-row cw-station" data-role={role} data-selected={selected || undefined}>
        <Rail role={role} issue={Boolean(d.nodeIssues[id]?.length)} />
        <button type="button" className="cw-hit" aria-pressed={selected} onClick={() => act.select({ t: 'node', id })}>
          <span className="cw-title">
            <RegionFlag code={node?.public_ipv4_country} />
            <span className="cw-station-name">{node?.name ?? id}</span>
            <span className="cw-role">
              {role === 'entry' ? (d.spine.length === 1 ? '入口 · 出口' : '入口') : role === 'exit' ? '出口' : '中转'}
            </span>
          </span>
          <span className="cw-sub mono">{node?.public_ipv4 ?? node?.public_ipv6 ?? '—'}</span>
        </button>
      </li>,
      selected,
    );
    (d.draft.tables[id] ?? []).forEach((rule, ruleIndex) => {
      // An editor opened inline under this station already lists these rules.
      if (rule.m.t === 'any' || (inline && selected)) return;
      const match = matchText(rule.m);
      const target = rule.a.t === 'forward' ? d.nodeOf(rule.a.to) : null;
      const outboundId = rule.a.t === 'proxy' ? rule.a.outbound : null;
      const outbound = outboundId ? d.world.outbounds.find(item => item.id === outboundId) : null;
      const branchSel = Boolean(target) && sel.t === 'node' && sel.id === target?.node_id;
      add(
        `branch:${id}:${ruleIndex}`,
        <li className="cw-row cw-branch" data-selected={branchSel || undefined}>
          <span className="cw-twig" aria-hidden="true" />
          <button
            type="button"
            className="cw-hit"
            aria-pressed={branchSel}
            onClick={() => act.select({ t: 'node', id: target ? target.node_id : id })}
          >
            <span className="cw-match">
              {match.kind}
              {match.value ? <b className="mono">{match.value}</b> : 'v' in rule.m && <b className="cw-missing">?</b>}
            </span>
            <i className="cw-arrow" aria-hidden="true" />
            <span className={`cw-target ${rule.a.t}`}>
              {target ? (
                <>
                  <RegionFlag code={target.public_ipv4_country} />
                  {target.name}
                </>
              ) : outbound ? (
                <>
                  <Icon of="outbound" size={12} />
                  {outbound.name}
                </>
              ) : rule.a.t === 'egress' ? (
                '本机出网'
              ) : rule.a.t === 'block' ? (
                '拒绝'
              ) : (
                '—'
              )}
            </span>
          </button>
        </li>,
        branchSel,
      );
    });
    if (last) return;
    const next = d.spine[index + 1];
    const rule = (d.draft.tables[id] ?? []).find(candidate => candidate.m.t === 'any');
    if (rule?.a.t !== 'forward') return;
    const host = rule.a.dial.t === 'reverse' ? id : next;
    const edgeSel = sel.t === 'edge' && sel.source === id && sel.target === next;
    add(
      `edge:${id}`,
      <li className="cw-row cw-edge" data-selected={edgeSel || undefined}>
        <span className="cw-flow" aria-hidden="true" />
        <button
          type="button"
          className={`cw-hit cw-pill${d.edgeIssues[d.edgeKey(id, next)]?.length ? ' bad' : ''}`}
          aria-pressed={edgeSel}
          aria-label={`${d.nameOf(id)} 到 ${d.nameOf(next)} 的连接`}
          onClick={() => act.select({ t: 'edge', source: id, target: next })}
        >
          <span>{DIAL_SHORT[dialKindOf(rule.a.dial, d.nodeOf(next))]}</span>
          <span className="mono">{d.portOf(host)}</span>
          <span className="mono">{hopWireLabel(d.wireOf(host))}</span>
          {rule.a.pool.t === 'mux' && <span>Mux</span>}
        </button>
      </li>,
      edgeSel,
    );
  });

  if (d.head) {
    const appending = sel.t === 'choose' && sel.purpose === 'append';
    add(
      'append',
      <li className="cw-row cw-append" data-selected={appending || undefined}>
        <span className="cw-node add" aria-hidden="true">
          <Icon of="plus" size={10} />
        </span>
        <button
          type="button"
          className="cw-hit"
          aria-pressed={appending}
          onClick={() => act.select({ t: 'choose', purpose: 'append' })}
        >
          加一跳
        </button>
      </li>,
      appending,
    );
  }

  const terminal = d.tail ? (d.draft.tables[d.tail] ?? []).find(rule => rule.m.t === 'any') : null;
  const outboundId = terminal?.a.t === 'proxy' ? terminal.a.outbound : null;
  const outbound = outboundId ? d.world.outbounds.find(item => item.id === outboundId) : null;
  rows.push(
    <li key="terminal" className={`cw-row cw-terminal${d.tail ? '' : ' pending'}`}>
      <Rail role={terminal?.a.t === 'block' ? 'blocked' : 'internet'} />
      <button
        type="button"
        className="cw-hit"
        disabled={!d.tail}
        onClick={() => d.tail && act.select({ t: 'node', id: d.tail })}
      >
        <span className="cw-title">
          {terminal?.a.t === 'block' ? '拒绝' : '出网'}
          {terminal?.a.t === 'proxy' && (
            <small>
              <span className="cw-badge">{outbound ? externalProtocolBadge(outbound.protocol.t) : '—'}</span>
              {outbound?.name}
            </small>
          )}
        </span>
      </button>
    </li>,
  );

  return (
    <ol className="cw-line" aria-label="路线">
      {rows}
    </ol>
  );
}

/* ══ Inspector ══ */

function Inspector({ d, act }: { d: Derived; act: Actions }) {
  const sel = d.draft.sel;
  if (sel.t === 'users') return <UsersPanel d={d} act={act} />;
  if (sel.t === 'ingress') return <IngressPanel d={d} act={act} />;
  if (sel.t === 'choose') return <ChooserPanel d={d} act={act} purpose={sel.purpose} />;
  if (sel.t === 'edge') return <EdgePanel d={d} act={act} source={sel.source} target={sel.target} />;
  if (sel.t === 'node' && d.members.includes(sel.id)) return <StationPanel d={d} act={act} id={sel.id} />;
  return null;
}

function PanelHead({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return (
    <header className="cw-panel-head">
      <h3>{title}</h3>
      {aside && <div className="cw-panel-aside">{aside}</div>}
    </header>
  );
}

function Errors({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <p className="cw-errors" role="alert">
      {items.join('；')}
    </p>
  );
}

/* ── Users ── */

function UsersPanel({ d, act }: { d: Derived; act: Actions }) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const q = query.trim().toLowerCase();
  const visible = d.userRows.filter(user => !q || user.id.toLowerCase().includes(q));
  const selectable = d.userRows.filter(user => !user.blocked);
  return (
    <div className="cw-panel">
      <PanelHead
        title="用户"
        aside={
          <span className="cw-count">
            {d.granted.length} / {selectable.length}
          </span>
        }
      />
      <div className="cw-toolbar">
        {d.userRows.length > 12 && (
          <label className="cw-search">
            <Icon of="search" size={12} />
            <input
              className="f"
              aria-label="搜索用户"
              placeholder="搜索"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          className="btn sm"
          disabled={selectable.every(user => d.picked.has(user.key))}
          onClick={() => act.setUsers([...new Set([...d.draft.users, ...selectable.map(user => user.key)])])}
        >
          全选
        </button>
        <button type="button" className="btn sm" disabled={d.draft.users.length === 0} onClick={() => act.setUsers([])}>
          清空
        </button>
        <span className="sp" />
        <button type="button" className="btn sm" aria-expanded={creating} onClick={() => setCreating(value => !value)}>
          <Icon of="plus" size={11} />
          新增用户
        </button>
      </div>
      {creating && (
        <div className="cw-new-user" role="group" aria-label="新增用户">
          <input className="f mono" autoFocus placeholder="用户 ID" aria-label="新用户 ID" />
          <button type="button" className="btn sm primary">
            新增并选中
          </button>
        </div>
      )}
      <div className="cw-user-list">
        <div className="cw-user-chips" role="group" aria-label="选择可用用户">
          {visible.map(user => {
            const on = d.picked.has(user.key);
            return (
              <button
                type="button"
                key={user.key}
                className={`cw-user${on ? ' on' : ''}${user.blocked ? ' blocked' : ''}`}
                aria-pressed={on}
                disabled={Boolean(user.blocked) && !on}
                title={user.blocked ?? undefined}
                onClick={() => act.toggleUser(user.key)}
              >
                <span className="cw-user-mark" aria-hidden="true">
                  {on && <Icon of="check" size={10} />}
                </span>
                {user.id}
                {user.status !== 'active' && <small>停用</small>}
              </button>
            );
          })}
        </div>
        {visible.length === 0 && <p className="cw-empty">没有匹配的用户</p>}
      </div>
    </div>
  );
}

/* ── Ingress ── */

export function PortInput({
  label,
  value,
  auto,
  onChange,
  invalid,
  disabled = false,
}: {
  label: string;
  value: string;
  auto: boolean;
  onChange: (value: string | null) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  return (
    <span className="cw-port">
      <input
        className="f mono"
        inputMode="numeric"
        aria-label={label}
        value={value}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
      {!auto && !disabled && (
        <button type="button" className="cw-reset" aria-label={`${label}恢复自动分配`} onClick={() => onChange(null)}>
          ↺
        </button>
      )}
    </span>
  );
}

function ProtocolRow({
  name,
  icon,
  note,
  enabled,
  onToggle,
  ports,
  params,
  issue,
}: {
  name: string;
  icon: IconName;
  note: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  ports: ReactNode;
  params?: ReactNode;
  issue?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`cw-proto${enabled ? ' on' : ''}`}>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={name}
          checked={enabled}
          onChange={event => onToggle(event.target.checked)}
        />
        <span className="switch-ui" aria-hidden="true">
          <span />
        </span>
      </label>
      <span className="cw-proto-name">
        <b>
          <Icon of={icon} size={13} />
          {name}
        </b>
        <small>{note}</small>
      </span>
      <span className="cw-proto-ports">{enabled && ports}</span>
      <span className="cw-proto-more">
        {enabled && params && (
          <button
            type="button"
            className="cw-more"
            aria-expanded={open}
            aria-label={`${name} 参数`}
            onClick={() => setOpen(value => !value)}
          >
            <Icon of="more" size={13} />
          </button>
        )}
      </span>
      {issue && <span className="cw-proto-issue">{issue}</span>}
      {enabled && open && params && <div className="cw-proto-params">{params}</div>}
    </li>
  );
}

export function IngressPanel({ d, act }: { d: Derived; act: Actions }) {
  const p = d.draft.proto;
  const certIssue = d.needsCert ? '入口没有证书' : null;
  return (
    <div className="cw-panel">
      <PanelHead title="接入协议" aside={d.head && <span className="cw-count">{d.head.name}</span>} />
      <ul className="cw-protos">
        <ProtocolRow
          name="VLESS · TLS/REALITY"
          icon="xray"
          note={INGRESS_PROTOCOL_DESCRIPTIONS.vless}
          enabled={p.vless}
          onToggle={vless => act.setProto({ vless })}
          issue={p.vless ? (d.portIssue.vless ?? (!d.realityReady ? '补全伪装目标' : null)) : null}
          ports={
            <PortInput
              label="VLESS 监听端口"
              value={d.ports.vlessPortText}
              auto={p.vlessPort === null}
              invalid={Boolean(d.portIssue.vless)}
              onChange={vlessPort => act.setProto({ vlessPort })}
            />
          }
          params={
            <div className="cw-params">
              <span className="cw-param-label">伪装目标</span>
              <SegmentedControl
                ariaLabel="REALITY 伪装目标"
                value={d.realityTarget || 'node-certificate'}
                options={[
                  { value: 'node-certificate', label: d.certLabel, disabled: !d.headCert },
                  { value: 'global-site', label: '全局站点', disabled: !d.globalRealityReady },
                  { value: 'custom-site', label: '自定义' },
                ]}
                onChange={reality => act.setProto({ reality: reality as RealityFallbackMode })}
              />
              {d.realityTarget === 'custom-site' && (
                <span className="cw-param-row">
                  <input
                    className="f mono"
                    placeholder="example.com:443"
                    aria-label="自定义 REALITY 目标"
                    value={p.realityDest}
                    onChange={event => act.setProto({ realityDest: event.target.value })}
                  />
                  <input
                    className="f mono"
                    placeholder="SNI"
                    aria-label="自定义 REALITY SNI"
                    value={p.realityNames}
                    onChange={event => act.setProto({ realityNames: event.target.value })}
                  />
                </span>
              )}
            </div>
          }
        />
        <ProtocolRow
          name="AnyTLS"
          icon="bolt"
          note={INGRESS_PROTOCOL_DESCRIPTIONS.anytls}
          enabled={p.anytls}
          onToggle={anytls => act.setProto({ anytls })}
          issue={p.anytls ? (d.portIssue.anytls ?? certIssue) : null}
          ports={
            <PortInput
              label="AnyTLS 监听端口"
              value={d.ports.anytlsPortText}
              auto={p.anytlsPort === null}
              invalid={Boolean(d.portIssue.anytls)}
              onChange={anytlsPort => act.setProto({ anytlsPort })}
            />
          }
          params={
            <div className="cw-params">
              <span className="cw-param-label">Padding</span>
              <SegmentedControl
                ariaLabel="AnyTLS Padding"
                value={p.padding}
                options={[
                  { value: 'default', label: '默认' },
                  { value: 'custom', label: '自定义' },
                ]}
                onChange={padding => act.setProto({ padding })}
              />
              {p.padding === 'custom' && (
                <textarea
                  className="f mono"
                  aria-label="AnyTLS 自定义 Padding"
                  value={p.paddingText}
                  onChange={event => act.setProto({ paddingText: event.target.value })}
                />
              )}
            </div>
          }
        />
        <ProtocolRow
          name="Hysteria 2"
          icon="hysteria"
          note={INGRESS_PROTOCOL_DESCRIPTIONS.hy2}
          enabled={p.hy2}
          onToggle={hy2 => act.setProto({ hy2 })}
          issue={p.hy2 ? (d.portIssue.hy2 ?? certIssue) : null}
          ports={
            <>
              <PortInput
                label="Hysteria 2 起始端口"
                value={d.ports.hy2StartText}
                auto={p.hy2Start === null}
                invalid={Boolean(d.portIssue.hy2)}
                onChange={hy2Start => act.setProto({ hy2Start })}
              />
              <span className="cw-proto-dash">–</span>
              <PortInput
                label="Hysteria 2 结束端口"
                value={d.ports.hy2EndText}
                auto={p.hy2End === null}
                invalid={Boolean(d.portIssue.hy2)}
                onChange={hy2End => act.setProto({ hy2End })}
              />
            </>
          }
          params={
            <div className="cw-params">
              <span className="cw-param-label">带宽</span>
              <span className="cw-param-row">
                <input
                  className="f mono"
                  aria-label="Hysteria 2 上行带宽"
                  placeholder="上行 自动"
                  value={p.hy2Up}
                  onChange={event => act.setProto({ hy2Up: event.target.value })}
                />
                <input
                  className="f mono"
                  aria-label="Hysteria 2 下行带宽"
                  placeholder="下行 自动"
                  value={p.hy2Down}
                  onChange={event => act.setProto({ hy2Down: event.target.value })}
                />
              </span>
            </div>
          }
        />
        <ProtocolRow
          name="VLESS · Encryption"
          icon="xray"
          note={INGRESS_PROTOCOL_DESCRIPTIONS.encryption}
          enabled={p.encryption}
          onToggle={encryption => act.setProto({ encryption })}
          issue={p.encryption ? d.portIssue.encryption : null}
          ports={
            <PortInput
              label="VLESS Encryption 监听端口"
              value={d.ports.encryptionPortText}
              auto={p.encryptionPort === null}
              invalid={Boolean(d.portIssue.encryption)}
              onChange={encryptionPort => act.setProto({ encryptionPort })}
            />
          }
          params={
            <div className="cw-params">
              <span className="cw-param-label">握手</span>
              <SegmentedControl
                ariaLabel="握手档位"
                value={p.encryptionProfile}
                options={[
                  { value: 'default', label: 'random' },
                  { value: 'native', label: 'native' },
                ]}
                onChange={encryptionProfile => act.setProto({ encryptionProfile })}
              />
            </div>
          }
        />
        <ProtocolRow
          name="MTProxy"
          icon="telegram"
          note={INGRESS_PROTOCOL_DESCRIPTIONS.mtproto}
          enabled={p.mtproto}
          onToggle={mtproto => act.setProto({ mtproto })}
          issue={d.mtprotoUnavailable ? '需要非 NAT 的公网 IPv4' : p.mtproto ? d.portIssue.mtproto : null}
          ports={
            <PortInput
              label="MTProxy 监听端口"
              value={d.ports.mtprotoPortText}
              auto={p.mtprotoPort === null}
              invalid={Boolean(d.portIssue.mtproto)}
              onChange={mtprotoPort => act.setProto({ mtprotoPort })}
            />
          }
        />
      </ul>
      {d.protocolCount === 0 && <Errors items={['至少开启一个接入协议']} />}
    </div>
  );
}

/* ── Machine chooser (entry, append, replace entry) ── */

function ChooserPanel({ d, act, purpose }: { d: Derived; act: Actions; purpose: 'entry' | 'append' }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const candidates = d.world.nodes
    .filter(node => !node.retired_at)
    .map(node => {
      const snap = d.snapOf(node.node_id);
      let blocked: string | null = null;
      if (purpose === 'append' && d.members.includes(node.node_id)) blocked = '已在路线上';
      else if (purpose === 'append' && !under(d.tenant, node.tenant_id)) blocked = '不可用';
      else if (purpose === 'entry' && d.head?.node_id === node.node_id) blocked = '当前入口';
      const tags: string[] = [];
      if (purpose === 'entry' && !snap?.certificate_name) tags.push('无证书');
      if (node.public_ipv4_nat) tags.push('NAT');
      if (purpose === 'append' && snap?.egress_allowed === false) tags.push('禁止出网');
      return { node, blocked, tags };
    });
  const visible = candidates.filter(
    ({ node }) =>
      !q ||
      `${node.name} ${node.node_id} ${node.public_ipv4 ?? ''} ${node.public_ipv4_country ?? ''}`
        .toLowerCase()
        .includes(q),
  );
  const countries = [...new Set(visible.map(({ node }) => node.public_ipv4_country ?? '—'))];
  return (
    <div className="cw-panel">
      <PanelHead title={purpose === 'entry' ? (d.head ? '更换入口' : '入口机器') : `${d.nameOf(d.tail ?? '')} 之后`} />
      <label className="cw-search wide">
        <Icon of="search" size={12} />
        <input
          className="f"
          aria-label="搜索机器"
          placeholder="搜索"
          value={query}
          autoFocus
          onChange={event => setQuery(event.target.value)}
        />
      </label>
      <div className="cw-machines">
        {countries.map(country => (
          <section key={country} className="cw-machine-group">
            <h4>
              <RegionFlag code={country} />
              {country}
            </h4>
            {visible
              .filter(({ node }) => (node.public_ipv4_country ?? '—') === country)
              .map(({ node, blocked, tags }) => (
                <button
                  type="button"
                  key={node.node_id}
                  className="cw-machine"
                  disabled={Boolean(blocked)}
                  onClick={() => (purpose === 'entry' ? act.pickEntry(node.node_id) : act.append(node.node_id))}
                >
                  <b>{node.name}</b>
                  <span className="mono">{node.public_ipv4 ?? node.public_ipv6 ?? '—'}</span>
                  <span className="cw-machine-tags">
                    {blocked ? <small>{blocked}</small> : tags.map(tag => <small key={tag}>{tag}</small>)}
                  </span>
                </button>
              ))}
          </section>
        ))}
        {visible.length === 0 && <p className="cw-empty">没有匹配的机器</p>}
      </div>
    </div>
  );
}

/* ── Station: one machine's rules ── */

function StationPanel({ d, act, id }: { d: Derived; act: Actions; id: string }) {
  const node = d.nodeOf(id);
  const rows = d.draft.tables[id] ?? [];
  const index = d.spine.indexOf(id);
  const role =
    d.spine.length === 1 && index === 0
      ? '入口 · 出口'
      : index === 0
        ? '入口'
        : index === d.spine.length - 1
          ? '出口'
          : index > 0
            ? '中转'
            : '支路';
  const peers = d.world.nodes.filter(
    candidate =>
      candidate.node_id !== id &&
      candidate.node_id !== d.headId &&
      !candidate.retired_at &&
      under(d.tenant, candidate.tenant_id),
  );
  return (
    <div className="cw-panel">
      <PanelHead
        title={
          <>
            <RegionFlag code={node?.public_ipv4_country} />
            {node?.name ?? id}
            <span className="cw-role">{role}</span>
          </>
        }
        aside={
          index === 0 ? (
            !d.entry.node && (
              <button type="button" className="btn sm" onClick={() => act.select({ t: 'choose', purpose: 'entry' })}>
                更换
              </button>
            )
          ) : (
            <button type="button" className="btn sm" onClick={() => act.remove(id)}>
              移出
            </button>
          )
        }
      />
      <ol className="cw-rules" aria-label={`${node?.name ?? id} 的规则`}>
        {rows.map((rule, ruleIndex) => {
          if (rule.m.t === 'any') return null;
          const kind = MATCH_KINDS.find(candidate => candidate.t === rule.m.t);
          const action = rule.a.t === 'reuse_listener' ? 'forward' : rule.a.t;
          const forward = rule.a.t === 'forward' ? rule.a : null;
          const empty = 'v' in rule.m && Array.isArray(rule.m.v) && rule.m.v.length === 0;
          return (
            <li key={ruleIndex} className="cw-rule">
              <span className="cw-rule-when">
                <select
                  className="f"
                  aria-label={`第 ${ruleIndex + 1} 条匹配条件`}
                  value={rule.m.t}
                  onChange={event =>
                    act.patchRule(id, ruleIndex, { ...rule, m: buildMatch(event.target.value as Rule['m']['t'], '') })
                  }
                >
                  {MATCH_KINDS.filter(candidate => candidate.t !== 'any').map(candidate => (
                    <option key={candidate.t} value={candidate.t}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
                {kind?.list && (
                  <input
                    className="f mono"
                    aria-label={`第 ${ruleIndex + 1} 条匹配取值`}
                    placeholder={kind.hint.replace(/^如 /, '').split('（')[0]}
                    value={matchValues(rule.m)}
                    aria-invalid={empty || undefined}
                    onChange={event =>
                      act.patchRule(id, ruleIndex, { ...rule, m: buildMatch(rule.m.t, event.target.value) })
                    }
                  />
                )}
              </span>
              <i className="cw-arrow" aria-hidden="true" />
              <span className="cw-rule-then">
                <select
                  className="f"
                  aria-label={`第 ${ruleIndex + 1} 条动作`}
                  value={action}
                  onChange={event =>
                    act.setRuleAction(id, ruleIndex, event.target.value as 'forward' | 'proxy' | 'egress' | 'block')
                  }
                >
                  <option value="forward">转发</option>
                  <option value="proxy" disabled={d.outboundsFor.length === 0}>
                    代理出站
                  </option>
                  <option value="egress" disabled={!d.egressAllowed(id)}>
                    本机出网
                  </option>
                  <option value="block">拒绝</option>
                </select>
                {forward && (
                  <select
                    className="f"
                    aria-label={`第 ${ruleIndex + 1} 条转发目标`}
                    value={forward.to}
                    onChange={event => act.setRuleAction(id, ruleIndex, 'forward', event.target.value)}
                  >
                    {peers.map(candidate => (
                      <option key={candidate.node_id} value={candidate.node_id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                )}
                {rule.a.t === 'proxy' && (
                  <select
                    className="f"
                    aria-label={`第 ${ruleIndex + 1} 条代理出站`}
                    value={rule.a.outbound}
                    onChange={event => act.setRuleAction(id, ruleIndex, 'proxy', event.target.value)}
                  >
                    {d.outboundsFor.map(outbound => (
                      <option key={outbound.id} value={outbound.id}>
                        {outbound.name}
                      </option>
                    ))}
                  </select>
                )}
              </span>
              <span className="cw-rule-tools">
                <button
                  type="button"
                  aria-label="上移"
                  disabled={ruleIndex === 0}
                  onClick={() => act.moveRule(id, ruleIndex, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="下移"
                  disabled={isPinnedTerminalRule(rows[ruleIndex + 1])}
                  onClick={() => act.moveRule(id, ruleIndex, 1)}
                >
                  ↓
                </button>
                <button type="button" aria-label="删除" onClick={() => act.removeRule(id, ruleIndex)}>
                  <Icon of="close" size={11} />
                </button>
              </span>
              {forward?.to && (
                <button
                  type="button"
                  className="cw-pill cw-rule-edge"
                  aria-label={`${d.nameOf(id)} 到 ${d.nameOf(forward.to)} 的连接`}
                  onClick={() => act.select({ t: 'edge', source: id, target: forward.to })}
                >
                  <span>{DIAL_SHORT[dialKindOf(forward.dial, d.nodeOf(forward.to))]}</span>
                  <span className="mono">{d.portOf(forward.dial.t === 'reverse' ? id : forward.to)}</span>
                  <span className="mono">{hopWireLabel(d.wireOf(forward.dial.t === 'reverse' ? id : forward.to))}</span>
                </button>
              )}
            </li>
          );
        })}
        <TerminalRule d={d} act={act} id={id} />
      </ol>
      <div className="cw-toolbar">
        <button type="button" className="btn sm" onClick={() => act.addException(id)}>
          <Icon of="plus" size={11} />
          例外
        </button>
      </div>
      <Errors items={d.nodeIssues[id] ?? []} />
    </div>
  );
}

function TerminalRule({ d, act, id }: { d: Derived; act: Actions; id: string }) {
  const rows = d.draft.tables[id] ?? [];
  const index = rows.findIndex(rule => rule.m.t === 'any');
  const rule = rows[index];
  if (!rule) return null;
  // Mid-route stations hand the rest to the next station; the route line is where that changes.
  if (rule.a.t === 'forward') {
    return (
      <li className="cw-rule terminal">
        <span className="cw-rule-when">其余流量</span>
        <i className="cw-arrow" aria-hidden="true" />
        <span className="cw-rule-then">
          <RegionFlag code={d.nodeOf(rule.a.to)?.public_ipv4_country} />
          {d.nameOf(rule.a.to)}
        </span>
      </li>
    );
  }
  return (
    <li className="cw-rule terminal">
      <span className="cw-rule-when">其余流量</span>
      <i className="cw-arrow" aria-hidden="true" />
      <span className="cw-rule-then">
        <SegmentedControl
          ariaLabel="其余流量"
          value={rule.a.t === 'proxy' ? 'proxy' : rule.a.t === 'block' ? 'block' : 'egress'}
          options={[
            { value: 'egress', label: '本机出网', disabled: !d.egressAllowed(id) },
            { value: 'proxy', label: '代理出站', disabled: d.outboundsFor.length === 0 },
            { value: 'block', label: '拒绝' },
          ]}
          onChange={next => act.setRuleAction(id, index, next)}
        />
        {rule.a.t === 'proxy' && (
          <select
            className="f"
            aria-label="其余流量的代理出站"
            value={rule.a.outbound}
            onChange={event => act.setRuleAction(id, index, 'proxy', event.target.value)}
          >
            {d.outboundsFor.map(outbound => (
              <option key={outbound.id} value={outbound.id}>
                {outbound.name}
              </option>
            ))}
          </select>
        )}
      </span>
    </li>
  );
}

/* ── Edge: how one hop connects ── */

function EdgePanel({ d, act, source, target }: { d: Derived; act: Actions; source: string; target: string }) {
  const rule = (d.draft.tables[source] ?? []).find(
    candidate => candidate.a.t === 'forward' && candidate.a.to === target,
  );
  if (rule?.a.t !== 'forward') return null;
  const action = rule.a;
  const peer = d.nodeOf(target);
  const self = d.nodeOf(source);
  const kind = dialKindOf(action.dial, peer);
  const reverse = action.dial.t === 'reverse';
  const host = reverse ? source : target;
  const wire = d.wireOf(host);
  const address = (candidate: DialKind): string => {
    if (candidate === 'public_ipv4') return peer?.public_ipv4 ?? '—';
    if (candidate === 'public_ipv6') return peer?.public_ipv6 ?? '—';
    if (candidate === 'reverse_v4') return self?.public_ipv4 ?? '—';
    if (candidate === 'reverse_v6') return self?.public_ipv6 ?? '—';
    return '';
  };
  return (
    <div className="cw-panel">
      <PanelHead
        title={
          <>
            <RegionFlag code={self?.public_ipv4_country} />
            {d.nameOf(source)}
            <i className="cw-arrow" aria-hidden="true" />
            <RegionFlag code={peer?.public_ipv4_country} />
            {d.nameOf(target)}
          </>
        }
      />
      <div className="cw-field">
        <span className="cw-param-label">连接</span>
        <div className="cw-dials" role="radiogroup" aria-label="连接方式">
          {DIAL_ORDER.map(candidate => {
            const on = kind === candidate;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={on}
                key={candidate}
                className={`cw-dial${on ? ' on' : ''}`}
                disabled={dialUnavailable(candidate, peer, self)}
                onClick={() => act.setDial(source, target, candidate)}
              >
                <b>{DIAL_SHORT[candidate]}</b>
                <small className="mono">{address(candidate)}</small>
              </button>
            );
          })}
        </div>
        {kind === 'custom' && (
          <input
            className="f mono cw-custom-host"
            aria-label={`到 ${d.nameOf(target)} 的主机地址`}
            placeholder="主机地址"
            value={hostOf(action.dial)}
            aria-invalid={!hostOf(action.dial).trim() || undefined}
            onChange={event => act.setCustomHost(source, target, event.target.value)}
          />
        )}
      </div>
      <div className="cw-field-grid">
        <div className="cw-field">
          <span className="cw-param-label">{d.nameOf(host)} 监听</span>
          <PortInput
            label={`${d.nameOf(host)} 的中转监听端口`}
            value={d.portOf(host)}
            auto={d.draft.ports[host] === undefined}
            invalid={Boolean(d.edgeIssues[d.edgeKey(source, target)]?.length)}
            onChange={value => act.setPort(host, value)}
          />
        </div>
        <div className="cw-field">
          <span className="cw-param-label">承载</span>
          <SegmentedControl
            ariaLabel="承载协议"
            value={wire}
            options={HOP_WIRE_OPTIONS.map(option => ({
              value: option.kind,
              label: option.short,
              disabled: (reverse && !option.reverseOk) || (option.kind === 'reality' && !d.globalRealityReady),
            }))}
            onChange={value => act.setWire(host, value)}
          />
        </div>
        <div className="cw-field">
          <span className="cw-param-label">复用</span>
          <SegmentedControl
            ariaLabel="连接复用"
            value={action.pool.t === 'mux' ? 'mux' : 'none'}
            disabled={reverse}
            options={[
              { value: 'none', label: '每次新建' },
              { value: 'mux', label: 'Mux' },
            ]}
            onChange={value => act.setPool(source, target, value === 'mux')}
          />
        </div>
      </div>
      <Errors items={d.edgeIssues[d.edgeKey(source, target)] ?? []} />
    </div>
  );
}

/* ══ Scene helpers ══ */

/** A straight route with production defaults; scenes add exceptions on top. */
export function routeTables(world: World, spine: string[]): WizardRuleTables {
  const tables: WizardRuleTables = {};
  spine.forEach((id, index) => {
    const next = spine[index + 1];
    const allowed = world.snapNodes.find(node => node.id === id)?.egress_allowed !== false;
    tables[id] = [
      next
        ? { m: { t: 'any' }, a: hopTo(world, id, next) }
        : allowed
          ? wizardEgressRule()
          : { m: { t: 'any' }, a: { t: 'block' } },
    ];
  });
  return tables;
}

export function withException(world: World, tables: WizardRuleTables, node: string, rule: Rule): WizardRuleTables {
  const rows = [...(tables[node] ?? [])];
  rows.splice(Math.max(0, rows.length - 1), 0, rule);
  const next = { ...tables, [node]: rows };
  if (rule.a.t === 'forward' && !next[rule.a.to]) next[rule.a.to] = routeTables(world, [rule.a.to])[rule.a.to];
  return next;
}

export function hopTo(world: World, source: string, target: string) {
  const taken = occupiedPorts(world.apps, world.nodes, world.system);
  const nodeOf = (id: string) => world.nodes.find(node => node.node_id === id) ?? null;
  return forwardAction(
    target,
    defaultHopDial({
      peer: nodeOf(target),
      self: nodeOf(source),
      port: freePortAcross(taken, [target], world.settings.ports.hop_base),
    }),
  );
}
