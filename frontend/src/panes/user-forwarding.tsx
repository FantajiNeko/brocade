import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createForwardingRule,
  deleteForwardingEntitlement,
  deleteForwardingRule,
  fetchForwardingOverview,
  fetchNodes,
  fetchUsageMonthly,
  setForwardingEntitlement,
  updateForwardingRule,
  type ForwardingEntitlement,
  type ForwardingEntitlementWrite,
  type ForwardingOverview,
  type ForwardingProtocol,
  type ForwardingRule,
  type ForwardingRuleWrite,
  type UserListItem,
} from '../api';
import { Confirm, EmptyState, ErrorBox, SegmentedControl } from '../ui/bits';
import { CopyButton, copyStateIcon } from '../ui/copy-button';
import { DialogClose, DialogLayer } from '../ui/dialog';
import { bytes, shareOf } from '../ui/format';
import { endpointText, parseTarget, submittedHost, type ParsedTarget } from '../ui/forwarding-target';
import { Icon, PanelTitle, type IconName } from '../ui/icons';
import { FieldLoading } from '../ui/loading';
import { observeBpsReading } from '../ui/observe-chart';
import { RegionFlag } from '../ui/region-flag';
import { forwardingRuleRates, useUserTrafficSource } from '../user-traffic-source';

/* 用户详情 ·「转发入口」。
 *
 * 一张卡分两栏，写法同「用量与额度」：
 * - 左侧读数栏：本月转发（月度汇总里这位用户的转发行，含已删除规则）、下行 / 上行占比、
 *   当前速率（只有能看实时的身份才有），以及入口机器——点机器筛选右侧清单。
 * - 右侧规则清单：可搜索、排序；一条规则一行，点行展开详情，就地编辑。
 * 常态（已监听 / 已就绪）不写状态，只有同步中、收敛失败、已停用出字。
 * 删除规则、撤销与移除授权都先确认；授权与修改授权在对话框里一次填完策略。 */

export interface ForwardingNodeOption {
  id: string;
  name?: string;
  public_ipv4?: string | null;
  public_ipv6?: string | null;
  api_port?: number | null;
}

type RuleSort = 'port' | 'month' | 'created';
type Traffic = { down: number; up: number };

interface RuleDraft {
  nodeId: string;
  target: string;
  port: string;
  protocol: ForwardingProtocol;
  name: string;
}

type RuleEditor = { mode: 'new'; draft: RuleDraft } | { mode: 'edit'; ruleId: number; draft: RuleDraft };

interface PolicyDraft {
  nodeId: string;
  tcp: boolean;
  udp: boolean;
  start: string;
  end: string;
  max: string;
  allowPrivate: boolean;
}

type PolicyDialog = { mode: 'grant'; draft: PolicyDraft } | { mode: 'edit'; draft: PolicyDraft };
type OpenMenu = { kind: 'rule'; id: number } | { kind: 'node'; id: string } | null;

const PROTOCOL_LABEL: Record<ForwardingProtocol, string> = { tcp: 'TCP', udp: 'UDP', tcp_udp: 'TCP + UDP' };

const SORT_OPTIONS = [
  { value: 'port', label: '入口端口' },
  { value: 'month', label: '本月流量' },
  { value: 'created', label: '创建时间' },
] as const;

// 新授权的默认策略：同时开放 TCP 与 UDP，使用完整的转发端口段，并允许内部目标。
const GRANT_DEFAULTS = { start: 30_000, end: 59_999, max: 100, allowPrivate: true } as const;

const entitlementWrite = (entry: ForwardingEntitlement, enabled = entry.enabled): ForwardingEntitlementWrite => ({
  enabled,
  tcp_allowed: entry.tcp_allowed,
  udp_allowed: entry.udp_allowed,
  listen_port_start: entry.listen_port_start,
  listen_port_end: entry.listen_port_end,
  max_rules: entry.max_rules,
  allow_private_targets: entry.allow_private_targets,
});

const defaultProtocol = (entry: ForwardingEntitlement): ForwardingProtocol =>
  entry.tcp_allowed && entry.udp_allowed ? 'tcp_udp' : entry.tcp_allowed ? 'tcp' : 'udp';

const usesTcp = (protocol: ForwardingProtocol) => protocol !== 'udp';
const usesUdp = (protocol: ForwardingProtocol) => protocol !== 'tcp';
const protocolsOverlap = (left: ForwardingProtocol, right: ForwardingProtocol) =>
  (usesTcp(left) && usesTcp(right)) || (usesUdp(left) && usesUdp(right));
const protocolAllowed = (entry: ForwardingEntitlement, protocol: ForwardingProtocol) =>
  (!usesTcp(protocol) || entry.tcp_allowed) && (!usesUdp(protocol) || entry.udp_allowed);
const allowedText = (entry: { tcp_allowed: boolean; udp_allowed: boolean }) =>
  [entry.tcp_allowed && 'TCP', entry.udp_allowed && 'UDP'].filter(Boolean).join(' + ');

/** 同一台机器上已启用、协议有交集的规则占用该端口；停用的规则不占端口。 */
const occupantOf = (
  rules: ForwardingRule[],
  nodeId: string,
  protocol: ForwardingProtocol,
  port: number,
  excludeRuleId?: number,
) =>
  rules.find(
    rule =>
      rule.id !== excludeRuleId &&
      rule.node_id === nodeId &&
      rule.enabled &&
      rule.listen_port === port &&
      protocolsOverlap(rule.protocol, protocol),
  );

const nextFreePort = (
  entry: ForwardingEntitlement,
  rules: ForwardingRule[],
  protocol: ForwardingProtocol,
  excludeRuleId?: number,
) => {
  for (let port = entry.listen_port_start; port <= entry.listen_port_end; port += 1) {
    if (!occupantOf(rules, entry.node_id, protocol, port, excludeRuleId)) return port;
  }
  return null;
};

const entryState = (entry: ForwardingEntitlement) =>
  !entry.enabled
    ? { tone: 'off', text: '已撤销' }
    : entry.reconcile_status === 'error'
      ? { tone: 'bad', text: '收敛失败' }
      : entry.applied_generation !== entry.desired_generation
        ? { tone: 'warn', text: '同步中' }
        : { tone: 'ok', text: '已就绪' };

const RULE_STATUS: Record<ForwardingRule['runtime_status'], { tone: string; text: string } | null> = {
  active: null,
  pending: { tone: 'warn', text: '同步中' },
  error: { tone: 'bad', text: '收敛失败' },
  disabled: { tone: 'off', text: '已停用' },
};

/** 规则名默认就是目标地址；只有自定义过的名称才单独显示。 */
const customName = (rule: ForwardingRule) =>
  rule.name.trim() !== endpointText(rule.target_host, rule.target_port) ? rule.name : null;

// 服务端时间形如 `2026-10-14 07:03:09.915561+00`，先整理成浏览器都能解析的 ISO 形式。
const parseTimestamp = (text: string) =>
  Date.parse(
    text
      .trim()
      .replace(' ', 'T')
      .replace(/(\.\d{3})\d+/, '$1')
      .replace(/([+-]\d{2})$/, '$1:00'),
  );

const clockText = (text: string) => {
  const at = parseTimestamp(text);
  if (Number.isNaN(at)) return text;
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const rateText = (bytesPerSec: number) => observeBpsReading(bytesPerSec * 8);

const entryAddress = (entry: ForwardingEntitlement, port: number, family: 'v4' | 'v6') => {
  const host = family === 'v4' ? entry.public_ipv4 : entry.public_ipv6;
  return host ? endpointText(host, port) : null;
};

interface RuleCheck {
  target: ParsedTarget | null;
  targetBad: boolean;
  portBad: boolean;
  problems: string[];
  ok: boolean;
}

function checkRule(
  draft: RuleDraft,
  entry: ForwardingEntitlement | undefined,
  rules: ForwardingRule[],
  editingId: number | undefined,
): RuleCheck {
  const parsed = parseTarget(draft.target);
  const target = 'error' in parsed ? null : parsed;
  const problems: string[] = [];
  let targetBad = false;
  let portBad = false;
  if (!entry) return { target, targetBad, portBad, problems: ['选择入口机器'], ok: false };
  if ('error' in parsed) {
    if (draft.target.trim()) {
      problems.push(parsed.error);
      targetBad = true;
    }
  } else if (parsed.blocked && !entry.allow_private_targets) {
    problems.push(`${entry.node_name} 未允许转发到私网、环回或保留地址`);
    targetBad = true;
  }
  const port = Number(draft.port);
  if (!/^\d+$/.test(draft.port.trim())) {
    problems.push('入口端口填数字');
    portBad = true;
  } else if (port < entry.listen_port_start || port > entry.listen_port_end) {
    problems.push(`入口端口超出授权范围 ${entry.listen_port_start}–${entry.listen_port_end}`);
    portBad = true;
  } else {
    const occupant = occupantOf(rules, entry.node_id, draft.protocol, port, editingId);
    if (occupant) {
      const free = nextFreePort(entry, rules, draft.protocol, editingId);
      problems.push(
        `入口端口 ${port} 已被「${occupant.name}」占用（${PROTOCOL_LABEL[occupant.protocol]}）${
          free === null ? '，授权范围内已无空闲端口' : `，下一个空闲端口 ${free}`
        }`,
      );
      portBad = true;
    }
  }
  if (!protocolAllowed(entry, draft.protocol)) problems.push(`${entry.node_name} 只授权了 ${allowedText(entry)}`);
  if (editingId === undefined && rules.filter(rule => rule.node_id === entry.node_id).length >= entry.max_rules) {
    problems.push(`${entry.node_name} 已达上限 ${entry.max_rules} 条`);
  }
  return { target, targetBad, portBad, problems, ok: !!target && problems.length === 0 };
}

interface PolicyCheck {
  rangeText: string;
  rangeBad: boolean;
  maxText: string;
  maxBad: boolean;
  problem: string | null;
  ok: boolean;
}

function checkPolicy(dialog: PolicyDialog, rules: ForwardingRule[]): PolicyCheck {
  const { draft } = dialog;
  const ownRules = dialog.mode === 'edit' ? rules.filter(rule => rule.node_id === draft.nodeId) : [];
  const enabledRules = ownRules.filter(rule => rule.enabled);
  const start = Number(draft.start);
  const end = Number(draft.end);
  const max = Number(draft.max);
  let rangeText: string;
  let rangeBad = true;
  if (!/^\d+$/.test(draft.start.trim()) || !/^\d+$/.test(draft.end.trim())) rangeText = '填数字端口';
  else if (start < 1024 || end > 65_535 || end < start) rangeText = '范围在 1024–65535 内，结束不小于起始';
  else {
    const outside = enabledRules.filter(rule => rule.listen_port < start || rule.listen_port > end);
    rangeBad = outside.length > 0;
    rangeText = rangeBad
      ? `${outside.length} 条启用中的规则不在新范围内（${outside.map(rule => rule.listen_port).join('、')}）`
      : `共 ${end - start + 1} 个端口`;
  }
  let maxText = '1–256 条';
  let maxBad = true;
  if (/^\d+$/.test(draft.max.trim()) && max >= 1 && max <= 256) {
    maxBad = max < ownRules.length;
    maxText = maxBad
      ? `已有 ${ownRules.length} 条规则，上限不能低于 ${ownRules.length}`
      : dialog.mode === 'edit'
        ? `已建 ${ownRules.length} 条`
        : maxText;
  }
  let problem: string | null = null;
  if (!draft.tcp && !draft.udp) problem = '至少允许一种协议';
  else {
    const blocked = enabledRules.filter(
      rule => (usesTcp(rule.protocol) && !draft.tcp) || (usesUdp(rule.protocol) && !draft.udp),
    );
    if (blocked.length > 0) problem = `${blocked.length} 条启用中的规则使用了要关闭的协议，先停用或修改这些规则`;
  }
  if (dialog.mode === 'grant' && !draft.nodeId) problem = problem ?? '选择要授权的机器';
  return { rangeText, rangeBad, maxText, maxBad, problem, ok: !rangeBad && !maxBad && !problem };
}

export function UserForwardingCard({
  user,
  nodes,
  canAuthorize,
  canManageRules,
  canViewRealtime = false,
}: {
  user: UserListItem;
  nodes: ForwardingNodeOption[];
  canAuthorize: boolean;
  canManageRules: boolean;
  /** 当前速率来自用户实时订阅，只有能看实时流量的身份才订阅。 */
  canViewRealtime?: boolean;
}) {
  const qc = useQueryClient();
  const key = ['forwarding', user.tenant_id, user.id] as const;
  const overview = useQuery({
    queryKey: key,
    queryFn: () => fetchForwardingOverview(user.tenant_id, user.id),
    refetchInterval: query =>
      query.state.data?.rules.some(rule => rule.runtime_status === 'pending') ||
      query.state.data?.entitlements.some(
        entry => entry.enabled && entry.desired_generation !== entry.applied_generation,
      )
        ? 5_000
        : false,
  });
  // 本月用量与用户页「用量与额度」共用同一份月度汇总
  const monthly = useQuery({ queryKey: ['usage-monthly'], queryFn: () => fetchUsageMonthly() });
  // 地区旗取机器列表；取不到时不画旗，不影响其余内容
  const fleet = useQuery({ queryKey: ['nodes'], queryFn: () => fetchNodes(), retry: false });
  const realtime = useUserTrafficSource(user.tenant_id, user.id, canViewRealtime);

  const [filterNode, setFilterNode] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<RuleSort>('port');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [editor, setEditor] = useState<RuleEditor | null>(null);
  const [menu, setMenu] = useState<OpenMenu>(null);
  const [policy, setPolicy] = useState<PolicyDialog | null>(null);
  const [deleting, setDeleting] = useState<ForwardingRule | null>(null);
  const [revoking, setRevoking] = useState<ForwardingEntitlement | null>(null);
  const [removing, setRemoving] = useState<ForwardingEntitlement | null>(null);

  const storeResult = (value: ForwardingOverview) => qc.setQueryData(key, value);
  const saveEntitlement = useMutation({
    mutationFn: (value: { nodeId: string; body: ForwardingEntitlementWrite }) =>
      setForwardingEntitlement(user.tenant_id, user.id, value.nodeId, value.body),
    onSuccess: value => {
      storeResult(value);
      setPolicy(null);
      setRevoking(null);
    },
  });
  const dropEntitlement = useMutation({
    mutationFn: (nodeId: string) => deleteForwardingEntitlement(user.tenant_id, user.id, nodeId),
    onSuccess: (value, nodeId) => {
      storeResult(value);
      setRemoving(null);
      setFilterNode(current => (current === nodeId ? null : current));
    },
  });
  const createRule = useMutation({
    mutationFn: (body: ForwardingRuleWrite) => createForwardingRule(user.tenant_id, user.id, body),
    onSuccess: value => {
      storeResult(value);
      setEditor(null);
    },
  });
  const updateRule = useMutation({
    mutationFn: (value: { ruleId: number; body: ForwardingRuleWrite; fromEditor: boolean }) =>
      updateForwardingRule(user.tenant_id, user.id, value.ruleId, value.body),
    onSuccess: (value, variables) => {
      storeResult(value);
      if (variables.fromEditor) setEditor(null);
    },
  });
  const removeRule = useMutation({
    mutationFn: (ruleId: number) => deleteForwardingRule(user.tenant_id, user.id, ruleId),
    onSuccess: (value, ruleId) => {
      storeResult(value);
      setDeleting(null);
      setExpanded(current => {
        const next = new Set(current);
        next.delete(ruleId);
        return next;
      });
    },
  });

  const entries = useMemo(() => overview.data?.entitlements ?? [], [overview.data]);
  const rules = useMemo(() => overview.data?.rules ?? [], [overview.data]);
  const entryOf = (nodeId: string) => entries.find(entry => entry.node_id === nodeId);
  const activeEntries = entries.filter(entry => entry.enabled);
  const granted = new Set(entries.map(entry => entry.node_id));
  const availableNodes = nodes.filter(node => !granted.has(node.id) && node.api_port != null);
  const countryOf = useMemo(() => {
    const map = new Map((fleet.data?.nodes ?? []).map(node => [node.node_id, node.public_ipv4_country ?? null]));
    return (nodeId: string) => map.get(nodeId) ?? null;
  }, [fleet.data]);
  const loadFailed = !!overview.error && !overview.data;

  // 本月：月度汇总里这位用户的转发行；已删除的规则只计入合计
  const month = useMemo(() => {
    if (!monthly.data) return null;
    const rows = (monthly.data.forwarding ?? []).filter(
      row => row.tenant_id === user.tenant_id && row.user_id === user.id,
    );
    const byRule = new Map<number, Traffic>();
    for (const row of rows) {
      const current = byRule.get(row.rule_id) ?? { down: 0, up: 0 };
      byRule.set(row.rule_id, { down: current.down + row.downlink_bytes, up: current.up + row.uplink_bytes });
    }
    const live = new Set(rules.map(rule => rule.id));
    const down = rows.reduce((sum, row) => sum + row.downlink_bytes, 0);
    const up = rows.reduce((sum, row) => sum + row.uplink_bytes, 0);
    const deleted = rows
      .filter(row => !live.has(row.rule_id))
      .reduce((sum, row) => sum + row.downlink_bytes + row.uplink_bytes, 0);
    return { byRule, down, up, deleted, start: monthly.data.month_start, end: monthly.data.month_end };
  }, [monthly.data, rules, user.tenant_id, user.id]);
  const monthOf = (rule: ForwardingRule): Traffic | null =>
    month ? (month.byRule.get(rule.id) ?? { down: 0, up: 0 }) : null;

  // 当前：只认新鲜、就绪的报告；覆盖不到的机器上的规则读作「—」，不是 0
  const live = useMemo(
    () => (canViewRealtime ? forwardingRuleRates(realtime.payload, user.tenant_id, user.id, realtime.now) : null),
    [canViewRealtime, realtime.payload, realtime.now, user.tenant_id, user.id],
  );
  const liveOf = (rule: ForwardingRule): Traffic | null =>
    live && rule.runtime_status === 'active'
      ? (live.rates.get(rule.id) ?? (live.covered.has(rule.node_id) ? { down: 0, up: 0 } : null))
      : null;
  const liveSum = useMemo(() => {
    if (!live || (live.covered.size === 0 && live.rates.size === 0)) return null;
    let total = 0;
    let active = 0;
    for (const rate of live.rates.values()) {
      total += rate.down + rate.up;
      if (rate.down + rate.up > 0) active += 1;
    }
    return { total, active };
  }, [live]);

  const maxMonth = Math.max(
    1,
    ...rules.map(rule => (month?.byRule.get(rule.id)?.down ?? 0) + (month?.byRule.get(rule.id)?.up ?? 0)),
  );
  const multi = entries.length > 1 && !filterNode;
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = rules.filter(
      rule =>
        (!filterNode || rule.node_id === filterNode) &&
        (!query ||
          `:${rule.listen_port} ${rule.name} ${endpointText(rule.target_host, rule.target_port)}`
            .toLowerCase()
            .includes(query)),
    );
    const totalOf = (rule: ForwardingRule) => {
      const value = month?.byRule.get(rule.id);
      return value ? value.down + value.up : 0;
    };
    const by: Record<RuleSort, (a: ForwardingRule, b: ForwardingRule) => number> = {
      port: (a, b) => a.listen_port - b.listen_port,
      month: (a, b) => totalOf(b) - totalOf(a),
      created: (a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at),
    };
    return [...filtered].sort((a, b) => by[sort](a, b) || a.id - b.id);
  }, [rules, filterNode, search, sort, month]);

  const creatableEntries = activeEntries.filter(
    entry => rules.filter(rule => rule.node_id === entry.node_id).length < entry.max_rules,
  );

  const draftFor = (entry: ForwardingEntitlement): RuleDraft => {
    const protocol = defaultProtocol(entry);
    return {
      nodeId: entry.node_id,
      target: '',
      port: String(nextFreePort(entry, rules, protocol) ?? ''),
      protocol,
      name: '',
    };
  };
  const beginCreate = () => {
    const entry = creatableEntries.find(item => item.node_id === filterNode) ?? creatableEntries[0];
    if (!entry) return;
    createRule.reset();
    setEditor({ mode: 'new', draft: draftFor(entry) });
  };
  const beginEdit = (rule: ForwardingRule) => {
    updateRule.reset();
    setMenu(null);
    setEditor({
      mode: 'edit',
      ruleId: rule.id,
      draft: {
        nodeId: rule.node_id,
        target: endpointText(rule.target_host, rule.target_port),
        port: String(rule.listen_port),
        protocol: rule.protocol,
        name: customName(rule) ?? '',
      },
    });
  };
  const toggleRule = (rule: ForwardingRule) =>
    updateRule.mutate({
      ruleId: rule.id,
      fromEditor: false,
      body: {
        node_id: rule.node_id,
        name: rule.name,
        protocol: rule.protocol,
        listen_port: rule.listen_port,
        target_host: rule.target_host,
        target_port: rule.target_port,
        enabled: !rule.enabled,
      },
    });
  const openGrant = () => {
    saveEntitlement.reset();
    setPolicy({
      mode: 'grant',
      draft: {
        nodeId: '',
        tcp: true,
        udp: true,
        start: String(GRANT_DEFAULTS.start),
        end: String(GRANT_DEFAULTS.end),
        max: String(GRANT_DEFAULTS.max),
        allowPrivate: GRANT_DEFAULTS.allowPrivate,
      },
    });
  };
  const openPolicy = (entry: ForwardingEntitlement) => {
    saveEntitlement.reset();
    setPolicy({
      mode: 'edit',
      draft: {
        nodeId: entry.node_id,
        tcp: entry.tcp_allowed,
        udp: entry.udp_allowed,
        start: String(entry.listen_port_start),
        end: String(entry.listen_port_end),
        max: String(entry.max_rules),
        allowPrivate: entry.allow_private_targets,
      },
    });
  };
  const toggleExpanded = (ruleId: number) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  // 行内操作（停用 / 启用、恢复授权）没有自己的表单，失败写在清单上方
  const actionError = (!editor && updateRule.error) || (!policy && !revoking && saveEntitlement.error) || null;

  const ruleForm = (draftEditor: RuleEditor) => {
    const editing = draftEditor.mode === 'edit' ? rules.find(rule => rule.id === draftEditor.ruleId) : undefined;
    const entry = entryOf(draftEditor.draft.nodeId);
    const pending = draftEditor.mode === 'new' ? createRule.isPending : updateRule.isPending;
    const error = draftEditor.mode === 'new' ? createRule.error : updateRule.error;
    return (
      <RuleForm
        key={draftEditor.mode === 'new' ? 'new' : `edit-${draftEditor.ruleId}`}
        editor={draftEditor}
        entry={entry}
        entries={activeEntries}
        rules={rules}
        pending={pending}
        error={error}
        onChange={draft => setEditor({ ...draftEditor, draft })}
        onCancel={() => setEditor(null)}
        onSubmit={(target, draft) => {
          const body: ForwardingRuleWrite = {
            node_id: draft.nodeId,
            name: draft.name.trim() || endpointText(target.host, target.port),
            protocol: draft.protocol,
            listen_port: Number(draft.port),
            target_host: submittedHost(target),
            target_port: target.port,
            enabled: editing ? editing.enabled : true,
          };
          if (draftEditor.mode === 'new') createRule.mutate(body);
          else updateRule.mutate({ ruleId: draftEditor.ruleId, body, fromEditor: true });
        }}
      />
    );
  };

  const sortedEntries = [...entries].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.node_name.localeCompare(b.node_name, 'zh-CN'),
  );
  const [figure, unit] = month ? bytes(month.down + month.up).split(' ') : ['', ''];
  const deletionSummary = (rule: ForwardingRule) => {
    const entry = entryOf(rule.node_id);
    const usage = monthOf(rule);
    const address = entry
      ? (entryAddress(entry, rule.listen_port, 'v4') ?? entryAddress(entry, rule.listen_port, 'v6'))
      : null;
    return {
      entry: address ?? `:${rule.listen_port}`,
      node: entry?.node_name ?? '入口机器',
      month: usage ? usage.down + usage.up : null,
    };
  };
  const deletingView = deleting ? deletionSummary(deleting) : null;
  const monthNumber = (text: string) => Number(text.slice(5, 7));

  return (
    <>
      <section className="panel config-panel user-dcard user-forwarding-card">
        <header>
          <PanelTitle of="chains">转发入口</PanelTitle>
          {entries.length > 0 && (
            <span className="rt">
              <b>{activeEntries.length}</b> 台机器 · <b>{rules.length}</b> 条规则
            </span>
          )}
        </header>
        <div className="user-dcard-body fwd-body">
          {overview.isPending ? (
            <FieldLoading label="读取转发授权" />
          ) : loadFailed ? (
            <ErrorBox error={overview.error} />
          ) : entries.length === 0 ? (
            <EmptyState
              icon="chains"
              title="尚未授权转发入口"
              action={
                canAuthorize && availableNodes.length > 0 ? (
                  <button type="button" className="btn primary fwd-empty-action" onClick={openGrant}>
                    <Icon of="plus" size={13} />
                    授权机器
                  </button>
                ) : undefined
              }
            >
              {canAuthorize
                ? `授权一台机器后，${user.id} 可以在这台机器的端口范围内自建 TCP / UDP 端口转发。`
                : '管理员授权机器后，用户才可以创建端口转发规则。'}
            </EmptyState>
          ) : (
            <div className="fwd-cockpit">
              <aside className="fwd-ledger user-usage-ledger" aria-label="本月转发">
                <div className="user-usage-hero">
                  <span className="user-usage-hero-label">本月转发</span>
                  {month ? (
                    <strong className="user-usage-hero-value">
                      {figure} <small>{unit}</small>
                    </strong>
                  ) : (
                    <strong className="user-usage-hero-value none">{monthly.isPending ? '读取中' : '—'}</strong>
                  )}
                  {month && (
                    <span className="user-usage-reset">
                      {monthNumber(month.start)} 月 1 日起
                      <span className="usage-dot">·</span>
                      {monthNumber(month.end)} 月 1 日重置
                    </span>
                  )}
                  {month && month.down + month.up > 0 && (
                    <div className="usage-split" aria-hidden="true">
                      <i className="down" style={{ flexGrow: month.down }} />
                      <i className="up" style={{ flexGrow: month.up }} />
                    </div>
                  )}
                  {month && (
                    <dl className="usage-io">
                      <div className="down">
                        <dt>
                          <i aria-hidden="true" />
                          下行
                        </dt>
                        <dd>{bytes(month.down)}</dd>
                        <dd className="usage-share">{shareOf(month.down, month.down + month.up)}</dd>
                      </div>
                      <div className="up">
                        <dt>
                          <i aria-hidden="true" />
                          上行
                        </dt>
                        <dd>{bytes(month.up)}</dd>
                        <dd className="usage-share">{shareOf(month.up, month.down + month.up)}</dd>
                      </div>
                    </dl>
                  )}
                  {month && month.deleted > 0 && (
                    <span className="fwd-deleted">其中 {bytes(month.deleted)} 来自已删除的规则</span>
                  )}
                </div>
                {canViewRealtime && (
                  <div className="fwd-live">
                    <span>当前</span>
                    <b>{liveSum ? rateText(liveSum.total) : '—'}</b>
                    {liveSum && <small>{liveSum.active} 条在转发</small>}
                  </div>
                )}
                <div className="fwd-machines">
                  <div className="fwd-mhead">
                    <span>入口机器</span>
                    {filterNode && (
                      <button type="button" className="fwd-link" onClick={() => setFilterNode(null)}>
                        全部
                      </button>
                    )}
                  </div>
                  {sortedEntries.map(entry => {
                    const state = entryState(entry);
                    const count = rules.filter(rule => rule.node_id === entry.node_id).length;
                    const picked = filterNode === entry.node_id;
                    const ruleCount = rules.filter(rule => rule.node_id === entry.node_id && rule.enabled).length;
                    return (
                      <div key={entry.node_id} className={`fwd-mitem tone-${state.tone}${picked ? ' picked' : ''}`}>
                        <button
                          type="button"
                          className="fwd-mpick"
                          aria-pressed={picked}
                          title={picked ? '显示全部机器的规则' : `只看 ${entry.node_name} 的规则`}
                          onClick={() => setFilterNode(picked ? null : entry.node_id)}
                        >
                          <span className="fwd-mname">
                            <RegionFlag code={countryOf(entry.node_id)} />
                            <b>{entry.node_name || entry.node_id}</b>
                          </span>
                          <span className={`fwd-mcount${count >= entry.max_rules ? ' full' : ''}`}>
                            <b>{count}</b>/{entry.max_rules}
                          </span>
                          <span className="fwd-msub">
                            {state.tone === 'ok' ? (
                              `${allowedText(entry)} · ${entry.listen_port_start}–${entry.listen_port_end}`
                            ) : (
                              <span className={`fwd-st ${state.tone}`}>{state.text}</span>
                            )}
                          </span>
                          <span className="fwd-capbar" aria-hidden="true">
                            <i style={{ width: `${Math.min(100, (count / entry.max_rules) * 100)}%` }} />
                          </span>
                        </button>
                        {canAuthorize && (
                          <MoreMenu
                            label={`${entry.node_name} 的授权操作`}
                            open={menu?.kind === 'node' && menu.id === entry.node_id}
                            onOpenChange={open => setMenu(open ? { kind: 'node', id: entry.node_id } : null)}
                          >
                            {entry.enabled ? (
                              <>
                                <MenuItem
                                  icon="pencil"
                                  title="修改授权"
                                  note="协议、端口范围、规则上限、私网目标"
                                  onSelect={() => openPolicy(entry)}
                                />
                                <MenuItem
                                  icon="pause"
                                  title="撤销授权"
                                  note={`${ruleCount} 条规则停止转发，可以恢复`}
                                  danger
                                  onSelect={() => {
                                    saveEntitlement.reset();
                                    setRevoking(entry);
                                  }}
                                />
                              </>
                            ) : (
                              <>
                                <MenuItem
                                  icon="play"
                                  title="恢复授权"
                                  note={`${ruleCount} 条规则重新监听`}
                                  disabled={saveEntitlement.isPending}
                                  onSelect={() =>
                                    saveEntitlement.mutate({
                                      nodeId: entry.node_id,
                                      body: entitlementWrite(entry, true),
                                    })
                                  }
                                />
                                <MenuItem
                                  icon="trash"
                                  title="移除授权"
                                  note={`连同 ${count} 条规则一起删除，流量记录保留`}
                                  danger
                                  onSelect={() => {
                                    dropEntitlement.reset();
                                    setRemoving(entry);
                                  }}
                                />
                              </>
                            )}
                          </MoreMenu>
                        )}
                        {state.tone === 'bad' && entry.last_error && (
                          <p className="fwd-merr">
                            <Icon of="warn" size={12} />
                            {entry.last_error}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {canAuthorize && availableNodes.length > 0 && (
                    <button type="button" className="fwd-add" onClick={openGrant}>
                      <Icon of="plus" size={13} />
                      <b>授权机器</b>
                    </button>
                  )}
                </div>
              </aside>

              <div className="fwd-main">
                <div className="fwd-tools">
                  <span className="user-list-search fwd-search">
                    <Icon of="search" size={13} className="user-list-search-icon" />
                    <input
                      type="search"
                      value={search}
                      aria-label="搜索规则"
                      placeholder="搜索端口、目标或名称"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => setSearch(event.target.value)}
                    />
                  </span>
                  <SegmentedControl value={sort} options={SORT_OPTIONS} onChange={setSort} ariaLabel="排序" />
                  {canManageRules && (
                    <button
                      type="button"
                      className="btn fwd-new"
                      disabled={creatableEntries.length === 0 || editor?.mode === 'new'}
                      title={creatableEntries.length === 0 ? '已授权的机器都已达规则上限或已撤销' : undefined}
                      onClick={beginCreate}
                    >
                      <Icon of="plus" size={13} />
                      新建规则
                    </button>
                  )}
                </div>
                {actionError && <ErrorBox error={actionError} />}
                {editor?.mode === 'new' && ruleForm(editor)}
                {rules.length > 0 && (
                  <div className={`fwd-cap${canViewRealtime ? '' : ' no-live'}`} aria-hidden="true">
                    <span>入口</span>
                    <span>目标</span>
                    <span>协议</span>
                    <span>本月</span>
                    <span>{canViewRealtime ? '当前' : '状态'}</span>
                  </div>
                )}
                <div className="fwd-rows" role="list" aria-label="转发规则">
                  {visible.map(rule => {
                    if (editor?.mode === 'edit' && editor.ruleId === rule.id) {
                      return (
                        <div key={rule.id} role="listitem" className="fwd-item editing">
                          {ruleForm(editor)}
                        </div>
                      );
                    }
                    const entry = entryOf(rule.node_id);
                    return (
                      <RuleItem
                        key={rule.id}
                        rule={rule}
                        entry={entry}
                        country={countryOf(rule.node_id)}
                        month={monthOf(rule)}
                        live={liveOf(rule)}
                        showLive={canViewRealtime}
                        maxMonth={maxMonth}
                        showNode={multi}
                        open={expanded.has(rule.id)}
                        canManage={canManageRules && !!entry?.enabled}
                        busy={updateRule.isPending}
                        menuOpen={menu?.kind === 'rule' && menu.id === rule.id}
                        onMenu={open => setMenu(open ? { kind: 'rule', id: rule.id } : null)}
                        onToggleOpen={() => toggleExpanded(rule.id)}
                        onEdit={() => beginEdit(rule)}
                        onToggleEnabled={() => toggleRule(rule)}
                        onDelete={() => {
                          removeRule.reset();
                          setDeleting(rule);
                        }}
                      />
                    );
                  })}
                </div>
                {rules.length === 0 ? (
                  <p className="fwd-none">还没有转发规则</p>
                ) : visible.length === 0 ? (
                  <p className="fwd-none">没有匹配的规则</p>
                ) : null}
              </div>
            </div>
          )}
        </div>
        {!loadFailed && !overview.isPending && (
          <footer className="user-dcard-foot fwd-foot">
            <span>转发流量单独统计，不占用线路额度；规则保存后由入口机器自动生效，不需要变更单。</span>
          </footer>
        )}
      </section>

      {policy && (
        <PolicyDialogView
          dialog={policy}
          rules={rules}
          nodes={availableNodes}
          countryOf={countryOf}
          entry={policy.mode === 'edit' ? entryOf(policy.draft.nodeId) : undefined}
          pending={saveEntitlement.isPending}
          error={saveEntitlement.error}
          onChange={draft => setPolicy({ ...policy, draft })}
          onClose={() => setPolicy(null)}
          onSubmit={() => {
            const { draft } = policy;
            const current = policy.mode === 'edit' ? entryOf(draft.nodeId) : undefined;
            saveEntitlement.mutate({
              nodeId: draft.nodeId,
              body: {
                enabled: current ? current.enabled : true,
                tcp_allowed: draft.tcp,
                udp_allowed: draft.udp,
                listen_port_start: Number(draft.start),
                listen_port_end: Number(draft.end),
                max_rules: Number(draft.max),
                allow_private_targets: draft.allowPrivate,
              },
            });
          }}
        />
      )}
      {deleting && deletingView && (
        <Confirm
          title="删除转发规则"
          body={
            <>
              <p className="fwd-cpath">
                <code>{deletingView.entry}</code>
                <i>→</i>
                <code>{endpointText(deleting.target_host, deleting.target_port)}</code>
              </p>
              <p>
                {deleting.enabled
                  ? `${deletingView.node} 立即停止监听 ${deleting.listen_port}，正在经过它的连接会断开。`
                  : `规则已停用，删除后入口端口 ${deleting.listen_port} 不再保留给它。`}
                {deletingView.month !== null && `本月已转发 ${bytes(deletingView.month)}，仍计入用量。`}
              </p>
              {removeRule.error && <ErrorBox error={removeRule.error} />}
            </>
          }
          confirmLabel={removeRule.isPending ? '删除中…' : '删除规则'}
          confirmDisabled={removeRule.isPending}
          onConfirm={() => removeRule.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {revoking && (
        <Confirm
          title={`撤销 ${revoking.node_name} 的转发授权`}
          body={
            <>
              <p>
                {rules.filter(rule => rule.node_id === revoking.node_id && rule.enabled).length}
                条规则立即停止转发，入口端口不再监听，正在经过的连接会断开。规则与流量记录保留，恢复授权后按原样生效。
              </p>
              {saveEntitlement.error && <ErrorBox error={saveEntitlement.error} />}
            </>
          }
          confirmLabel={saveEntitlement.isPending ? '撤销中…' : '撤销授权'}
          confirmDisabled={saveEntitlement.isPending}
          onConfirm={() =>
            saveEntitlement.mutate({ nodeId: revoking.node_id, body: entitlementWrite(revoking, false) })
          }
          onCancel={() => setRevoking(null)}
        />
      )}
      {removing && (
        <Confirm
          title="移除已撤销的转发入口"
          body={
            <>
              <p>
                将从 {user.id} 移除「{removing.node_name || removing.node_id}」的转发授权
                {removing.rule_count > 0 ? `，并移除其下 ${removing.rule_count} 条规则` : ''}
                ，入口端口释放。本月流量仍计入用量。
              </p>
              {dropEntitlement.error && <ErrorBox error={dropEntitlement.error} />}
            </>
          }
          confirmLabel={dropEntitlement.isPending ? '移除中…' : '确认移除'}
          confirmDisabled={dropEntitlement.isPending}
          onConfirm={() => dropEntitlement.mutate(removing.node_id)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}

/* ── 规则行 ── */

function RuleItem({
  rule,
  entry,
  country,
  month,
  live,
  showLive,
  maxMonth,
  showNode,
  open,
  canManage,
  busy,
  menuOpen,
  onMenu,
  onToggleOpen,
  onEdit,
  onToggleEnabled,
  onDelete,
}: {
  rule: ForwardingRule;
  entry: ForwardingEntitlement | undefined;
  country: string | null;
  month: Traffic | null;
  live: Traffic | null;
  showLive: boolean;
  maxMonth: number;
  showNode: boolean;
  open: boolean;
  canManage: boolean;
  busy: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onToggleOpen: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const name = customName(rule);
  const target = endpointText(rule.target_host, rule.target_port);
  const v4 = entry ? entryAddress(entry, rule.listen_port, 'v4') : null;
  const v6 = entry ? entryAddress(entry, rule.listen_port, 'v6') : null;
  const status = RULE_STATUS[rule.runtime_status];
  const monthTotal = month ? month.down + month.up : null;
  const nowCell = status ? (
    <span className={`fwd-st ${status.tone}`}>{status.text}</span>
  ) : !showLive ? null : live === null ? (
    <span className="fwd-idle">—</span>
  ) : live.down + live.up > 0 ? (
    <span className="fwd-rate" title={`下行 ${rateText(live.down)} · 上行 ${rateText(live.up)}`}>
      <i aria-hidden="true" />
      {rateText(live.down + live.up)}
    </span>
  ) : (
    <span className="fwd-idle">空闲</span>
  );
  const hasMenu = canManage || !!v6;
  return (
    <div role="listitem" className={`fwd-item st-${rule.runtime_status}${open ? ' open' : ''}`}>
      <div className="fwd-row">
        <button
          type="button"
          className={`fwd-rmain${showLive ? '' : ' no-live'}`}
          aria-expanded={open}
          aria-label={`${name ? `${name}，` : ''}入口 ${rule.listen_port} 转发到 ${target}`}
          onClick={onToggleOpen}
        >
          <span className="fwd-port">
            <Icon of="chevronDown" size={10} className="fwd-chev" />:{rule.listen_port}
            {showNode && entry && (
              <small>
                <RegionFlag code={country} />
                {entry.node_name}
              </small>
            )}
          </span>
          <span className={`fwd-target${name ? '' : ' plain'}`} title={target}>
            {name && <b>{name}</b>}
            <code>
              <i>→</i>
              {target}
            </code>
          </span>
          <span className="fwd-proto">{PROTOCOL_LABEL[rule.protocol]}</span>
          <span
            className="fwd-month"
            title={month ? `本月 下行 ${bytes(month.down)} · 上行 ${bytes(month.up)}` : '本月用量暂不可用'}
          >
            <b>{monthTotal === null ? '—' : bytes(monthTotal)}</b>
            <span className="fwd-bar" aria-hidden="true">
              <i
                style={{
                  width: `${monthTotal ? Math.max(2, (monthTotal / maxMonth) * 100) : 0}%`,
                }}
              />
            </span>
          </span>
          <span className="fwd-now">{nowCell}</span>
        </button>
        <span className="fwd-acts">
          {v4 && <AddressCopy text={v4} label={`复制入口 ${v4}`} className="fwd-ib" />}
          {canManage && (
            <button
              type="button"
              className="fwd-ib"
              aria-label={`编辑 :${rule.listen_port}`}
              title="编辑"
              onClick={onEdit}
            >
              <Icon of="pencil" size={13} />
            </button>
          )}
          {hasMenu && (
            <MoreMenu label={`:${rule.listen_port} 的更多操作`} open={menuOpen} onOpenChange={onMenu}>
              {canManage && (
                <MenuItem icon="pencil" title="编辑规则" note="目标、入口端口、协议、名称" onSelect={onEdit} />
              )}
              {canManage && (
                <MenuItem
                  icon={rule.enabled ? 'pause' : 'play'}
                  title={rule.enabled ? '停用' : '启用'}
                  note={
                    rule.enabled ? `入口 ${rule.listen_port} 停止监听，规则保留` : `重新监听入口 ${rule.listen_port}`
                  }
                  disabled={busy}
                  onSelect={onToggleEnabled}
                />
              )}
              {v6 && (
                <CopyButton text={v6} role="menuitem" label="复制 IPv6 入口">
                  {(state, stateLabel) => (
                    <>
                      <Icon of={copyStateIcon(state)} size={14} className="action-menu-icon" />
                      <span>
                        {stateLabel}
                        <small className="mono">{v6}</small>
                      </span>
                    </>
                  )}
                </CopyButton>
              )}
              {canManage && (
                <MenuItem
                  icon="trash"
                  title="删除规则"
                  note={rule.enabled ? `入口 ${rule.listen_port} 立即停止，端口释放` : '规则与端口一起释放'}
                  danger
                  onSelect={onDelete}
                />
              )}
            </MoreMenu>
          )}
        </span>
      </div>
      {open && (
        <div className="fwd-detail">
          <dl className="fwd-kv">
            <div className="wide">
              <dt>入口</dt>
              <dd>
                {v4 && (
                  <span className="fwd-addr">
                    {v4}
                    <AddressCopy text={v4} label="复制 IPv4 入口" />
                  </span>
                )}
                {v6 && (
                  <span className="fwd-addr">
                    {v6}
                    <AddressCopy text={v6} label="复制 IPv6 入口" />
                  </span>
                )}
                {!v4 && !v6 && <span className="fwd-dim">入口机器暂无公网地址</span>}
              </dd>
            </div>
            <div className="wide">
              <dt>目标</dt>
              <dd>
                <code>{target}</code>
                <span className="fwd-dim"> · {PROTOCOL_LABEL[rule.protocol]}</span>
              </dd>
            </div>
            <div>
              <dt>本月</dt>
              <dd>{month ? <TrafficPair value={month} format={bytes} /> : '—'}</dd>
            </div>
            <div>
              <dt>累计</dt>
              <dd>
                <TrafficPair value={{ down: rule.downlink_bytes, up: rule.uplink_bytes }} format={bytes} />
              </dd>
            </div>
            {showLive && (
              <div>
                <dt>当前</dt>
                <dd>{live ? <TrafficPair value={live} format={rateText} /> : <span className="fwd-dim">—</span>}</dd>
              </div>
            )}
            <div>
              <dt>创建</dt>
              <dd>
                {clockText(rule.created_at)}
                <span className="fwd-dim"> · 修改 {clockText(rule.updated_at)}</span>
              </dd>
            </div>
            <div className="wide">
              <dt>状态</dt>
              <dd>
                <RuleStateLine rule={rule} entry={entry} />
              </dd>
            </div>
          </dl>
          {canManage && (
            <div className="fwd-dfoot">
              <button type="button" className="btn" onClick={onEdit}>
                <Icon of="pencil" size={13} />
                编辑
              </button>
              <button type="button" className="btn" disabled={busy} onClick={onToggleEnabled}>
                <Icon of={rule.enabled ? 'pause' : 'play'} size={13} />
                {rule.enabled ? '停用' : '启用'}
              </button>
              <span className="sp" />
              <button type="button" className="btn danger" onClick={onDelete}>
                <Icon of="trash" size={13} />
                删除规则
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuleStateLine({ rule, entry }: { rule: ForwardingRule; entry: ForwardingEntitlement | undefined }) {
  const node = entry?.node_name ?? '入口机器';
  switch (rule.runtime_status) {
    case 'active':
      return <>已监听 · {node} 已应用这条规则</>;
    case 'pending':
      return (
        <>
          <span className="fwd-st warn">同步中</span> · 等待 {node} 应用这次改动
        </>
      );
    case 'error':
      return (
        <>
          <span className="fwd-st bad">收敛失败</span> · {entry?.last_error ?? '机器未能应用转发配置'}
        </>
      );
    case 'disabled':
      return <>{entry?.enabled === false ? '机器授权已撤销' : '已停用'} · 入口端口不监听，规则保留</>;
  }
}

function TrafficPair({ value, format }: { value: Traffic; format: (value: number) => string }) {
  return (
    <span className="fwd-pair">
      <Icon of="rx" size={11} className="fwd-dir" />
      {format(value.down)}
      <Icon of="tx" size={11} className="fwd-dir up" />
      {format(value.up)}
    </span>
  );
}

function AddressCopy({ text, label, className }: { text: string; label: string; className?: string }) {
  return (
    <CopyButton text={text} label={label} iconOnly className={`fwd-copy${className ? ` ${className}` : ''}`}>
      {state => <Icon of={copyStateIcon(state)} size={12} />}
    </CopyButton>
  );
}

/* ── 规则表单：新建在清单顶部、编辑替换原行 ── */

function RuleForm({
  editor,
  entry,
  entries,
  rules,
  pending,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  editor: RuleEditor;
  entry: ForwardingEntitlement | undefined;
  entries: ForwardingEntitlement[];
  rules: ForwardingRule[];
  pending: boolean;
  error: unknown;
  onChange: (draft: RuleDraft) => void;
  onCancel: () => void;
  onSubmit: (target: ParsedTarget, draft: RuleDraft) => void;
}) {
  const { draft } = editor;
  const creating = editor.mode === 'new';
  const editingId = editor.mode === 'edit' ? editor.ruleId : undefined;
  const id = useId();
  const check = checkRule(draft, entry, rules, editingId);
  const preview =
    check.target && entry && !check.portBad ? (
      <>
        <Icon of="chains" size={12} />
        <code>{endpointText(entry.public_ipv4 ?? entry.public_ipv6 ?? '入口', Number(draft.port))}</code>
        <i>→</i>
        <code>{endpointText(check.target.host, check.target.port)}</code>
        <span className="fwd-dim">{PROTOCOL_LABEL[draft.protocol]}</span>
      </>
    ) : (
      <span className="fwd-dim">粘贴「主机:端口」即可，协议头和路径会自动去掉</span>
    );
  const protocolOptions = (['tcp', 'udp', 'tcp_udp'] as const).map(protocol => ({
    value: protocol,
    label: PROTOCOL_LABEL[protocol],
    disabled: !entry || !protocolAllowed(entry, protocol),
  }));
  // 新建时可换机器：只列还有余量的机器（当前选中的总在列表里）
  const choosable = creating
    ? entries.filter(
        item =>
          item.node_id === draft.nodeId || rules.filter(rule => rule.node_id === item.node_id).length < item.max_rules,
      )
    : [];
  return (
    <form
      className="fwd-edit"
      aria-label={creating ? '新建转发规则' : `编辑入口 ${draft.port} 的规则`}
      onKeyDown={event => {
        if (event.key === 'Escape') onCancel();
      }}
      onSubmit={event => {
        event.preventDefault();
        if (check.ok && check.target) onSubmit(check.target, draft);
      }}
    >
      <div className="fwd-ehead">
        <b>{creating ? '新建规则' : `编辑 :${rules.find(rule => rule.id === editingId)?.listen_port ?? draft.port}`}</b>
        {entry && (
          <span>
            {entry.node_name}
            {entry.public_ipv4 ? ` · ${entry.public_ipv4}` : ''}
            {entry.public_ipv6 ? ` · ${entry.public_ipv6}` : ''}
          </span>
        )}
      </div>
      <div className="fwd-fields">
        {creating && choosable.length > 1 && (
          <label className="fwd-f node">
            <span>入口机器</span>
            <select
              className="f"
              value={draft.nodeId}
              onChange={event => {
                const next = entries.find(item => item.node_id === event.target.value);
                if (!next) return;
                const protocol = defaultProtocol(next);
                onChange({
                  ...draft,
                  nodeId: next.node_id,
                  protocol,
                  port: String(nextFreePort(next, rules, protocol) ?? ''),
                });
              }}
            >
              {choosable.map(item => (
                <option key={item.node_id} value={item.node_id}>
                  {item.node_name} · {rules.filter(rule => rule.node_id === item.node_id).length}/{item.max_rules} 条
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="fwd-f target">
          <label htmlFor={`${id}-target`}>目标地址</label>
          <input
            id={`${id}-target`}
            className="f mono"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="example.com:443 或 [2001:db8::1]:443"
            value={draft.target}
            aria-invalid={check.targetBad}
            aria-describedby={`${id}-target-hint`}
            onChange={event => onChange({ ...draft, target: event.target.value })}
          />
          <small id={`${id}-target-hint`}>
            {check.target
              ? check.target.kind === '域名'
                ? '域名，在入口机器上解析'
                : `${check.target.kind} · 端口 ${check.target.port}`
              : '主机:端口'}
          </small>
        </div>
        <div className="fwd-f port">
          <label htmlFor={`${id}-port`}>入口端口</label>
          <input
            id={`${id}-port`}
            className="f mono"
            inputMode="numeric"
            autoComplete="off"
            value={draft.port}
            aria-invalid={check.portBad}
            aria-describedby={`${id}-port-hint`}
            onChange={event => onChange({ ...draft, port: event.target.value })}
          />
          <small id={`${id}-port-hint`}>
            {entry ? `授权范围 ${entry.listen_port_start}–${entry.listen_port_end}` : ''}
          </small>
        </div>
        <div className="fwd-f proto">
          <span>协议</span>
          <SegmentedControl
            value={draft.protocol}
            options={protocolOptions}
            ariaLabel="协议"
            onChange={protocol => onChange({ ...draft, protocol })}
          />
          <small>
            {entry && !(entry.tcp_allowed && entry.udp_allowed) ? `这台机器只授权了 ${allowedText(entry)}` : ''}
          </small>
        </div>
        <div className="fwd-f name">
          <label htmlFor={`${id}-name`}>名称</label>
          <input
            id={`${id}-name`}
            className="f"
            autoComplete="off"
            maxLength={80}
            placeholder={
              check.target ? `留空：${endpointText(check.target.host, check.target.port)}` : '可选，留空用目标地址'
            }
            value={draft.name}
            onChange={event => onChange({ ...draft, name: event.target.value })}
          />
          <small />
        </div>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <footer>
        <span className="fwd-msg" role={check.problems.length ? 'alert' : undefined}>
          {check.problems.length ? (
            <span className="bad">
              <Icon of="warn" size={13} />
              {check.problems[0]}
            </span>
          ) : (
            preview
          )}
        </span>
        <span className="sp" />
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={!check.ok || pending}>
          {pending ? '保存中…' : creating ? '创建规则' : '保存规则'}
        </button>
      </footer>
    </form>
  );
}

/* ── 授权 / 修改授权 ── */

function PolicyDialogView({
  dialog,
  rules,
  nodes,
  countryOf,
  entry,
  pending,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  dialog: PolicyDialog;
  rules: ForwardingRule[];
  nodes: ForwardingNodeOption[];
  countryOf: (nodeId: string) => string | null;
  entry: ForwardingEntitlement | undefined;
  pending: boolean;
  error: unknown;
  onChange: (draft: PolicyDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { draft } = dialog;
  const grant = dialog.mode === 'grant';
  const id = useId();
  const title = grant ? '授权转发入口' : `修改 ${entry?.node_name ?? draft.nodeId} 的授权`;
  const check = checkPolicy(dialog, rules);
  const protocolChoice = draft.tcp && draft.udp ? 'both' : draft.tcp ? 'tcp' : 'udp';
  return (
    <DialogLayer label={title} onClose={onClose}>
      <form
        className="dialog-surface fwd-dsurface"
        onSubmit={event => {
          event.preventDefault();
          if (check.ok) onSubmit();
        }}
      >
        <header className="fwd-dtitle">
          <b>{title}</b>
          <DialogClose className="fwd-ib" aria-label="关闭">
            <Icon of="close" size={13} />
          </DialogClose>
        </header>
        <div className="fwd-dbody">
          {grant && (
            <fieldset className="fwd-f fwd-pickset">
              <legend>机器</legend>
              <div className="fwd-npick" role="radiogroup" aria-label="选择机器">
                {nodes.map(node => (
                  <button
                    key={node.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.nodeId === node.id}
                    onClick={() => onChange({ ...draft, nodeId: node.id })}
                  >
                    <RegionFlag code={countryOf(node.id)} />
                    <span>{node.name || node.id}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="fwd-pfields">
            <div className="fwd-f">
              <span>协议</span>
              <SegmentedControl
                value={protocolChoice}
                ariaLabel="允许的协议"
                options={[
                  { value: 'tcp', label: '只 TCP' },
                  { value: 'udp', label: '只 UDP' },
                  { value: 'both', label: 'TCP + UDP' },
                ]}
                onChange={choice => onChange({ ...draft, tcp: choice !== 'udp', udp: choice !== 'tcp' })}
              />
            </div>
            <div className="fwd-f">
              <span>端口范围</span>
              <span className="fwd-range">
                <input
                  className="f mono"
                  inputMode="numeric"
                  aria-label="端口起始"
                  value={draft.start}
                  aria-invalid={check.rangeBad}
                  onChange={event => onChange({ ...draft, start: event.target.value })}
                />
                <i>–</i>
                <input
                  className="f mono"
                  inputMode="numeric"
                  aria-label="端口结束"
                  value={draft.end}
                  aria-invalid={check.rangeBad}
                  onChange={event => onChange({ ...draft, end: event.target.value })}
                />
              </span>
              <small className={check.rangeBad ? 'bad' : undefined}>{check.rangeText}</small>
            </div>
            <div className="fwd-f">
              <label htmlFor={`${id}-max`}>规则上限</label>
              <input
                id={`${id}-max`}
                className="f mono"
                inputMode="numeric"
                value={draft.max}
                aria-invalid={check.maxBad}
                aria-describedby={`${id}-max-hint`}
                onChange={event => onChange({ ...draft, max: event.target.value })}
              />
              <small id={`${id}-max-hint`} className={check.maxBad ? 'bad' : undefined}>
                {check.maxText}
              </small>
            </div>
            <label className="fwd-check">
              <input
                type="checkbox"
                checked={draft.allowPrivate}
                onChange={event => onChange({ ...draft, allowPrivate: event.target.checked })}
              />
              <span>
                允许转发到私网与本机地址
                <small>
                  {draft.allowPrivate
                    ? '目标可以是 10.0.0.0/8、192.168.0.0/16、127.0.0.1 等内部地址'
                    : '目标是私网、环回、链路本地或保留地址时拒绝保存'}
                </small>
              </span>
            </label>
          </div>
          {check.problem && (
            <p className="fwd-msg">
              <span className="bad">
                <Icon of="warn" size={13} />
                {check.problem}
              </span>
            </p>
          )}
          {error ? <ErrorBox error={error} /> : null}
        </div>
        <footer className="fwd-dfooter">
          <DialogClose className="btn">取消</DialogClose>
          <button type="submit" className="btn primary" disabled={!check.ok || pending}>
            {pending ? '保存中…' : grant ? '授权' : '保存授权'}
          </button>
        </footer>
      </form>
    </DialogLayer>
  );
}

/* ── 「⋯」菜单：生产 .fg-menu.action-menu，点外面或按 Esc 关闭 ── */

function MoreMenu({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onOpenChange]);
  return (
    <span className="fwd-menuwrap" ref={ref}>
      <button
        type="button"
        className="fwd-ib"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => onOpenChange(!open)}
      >
        <Icon of="more" size={14} />
      </button>
      {open && (
        <div
          className="fg-menu action-menu fwd-menu"
          role="menu"
          // 复制项留在菜单里显示「已复制」，其余项点完即关
          onClick={event => {
            if (!(event.target as HTMLElement).closest('.copy-button')) onOpenChange(false);
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

function MenuItem({
  icon,
  title,
  note,
  danger = false,
  disabled = false,
  onSelect,
}: {
  icon: IconName;
  title: string;
  note: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="menuitem" className={danger ? 'dg' : undefined} disabled={disabled} onClick={onSelect}>
      <Icon of={icon} size={14} className="action-menu-icon" />
      <span>
        {title}
        <small>{note}</small>
      </span>
    </button>
  );
}
