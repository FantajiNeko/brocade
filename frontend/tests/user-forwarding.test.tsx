import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ForwardingEntitlement,
  ForwardingOverview,
  ForwardingRule,
  UsageForwardingMonthlyRow,
  UsageMonthlySummary,
  UserListItem,
} from '../src/api';
import { UserForwardingCard } from '../src/panes/user-forwarding';

const MiB = 1024 ** 2;
const user = { tenant_id: 'platform.acme', id: 'alice' } as UserListItem;
const BASE = '/users/platform.acme/alice';

const entry = (over: Partial<ForwardingEntitlement> = {}): ForwardingEntitlement => ({
  node_id: 'n1',
  node_name: '东京入口',
  public_ipv4: '198.51.100.10',
  public_ipv6: '2001:4860:4860::8888',
  enabled: true,
  tcp_allowed: true,
  udp_allowed: true,
  listen_port_start: 20_000,
  listen_port_end: 20_100,
  max_rules: 4,
  allow_private_targets: false,
  rule_count: 1,
  desired_generation: 2,
  applied_generation: 2,
  reconcile_status: 'converged',
  last_error: null,
  ...over,
});

const rule = (over: Partial<ForwardingRule> = {}): ForwardingRule => ({
  id: 42,
  tenant_id: 'platform.acme',
  user_id: 'alice',
  node_id: 'n1',
  name: '现有规则',
  protocol: 'tcp',
  listen_port: 20_042,
  // 线上已有规则的 IPv6 目标带方括号存储
  target_host: '[2606:4700:4700::1111]',
  target_port: 443,
  enabled: true,
  runtime_status: 'active',
  uplink_bytes: 1024,
  downlink_bytes: 2048,
  created_at: '2026-10-13 00:00:00.123456+00',
  updated_at: '2026-10-13 00:00:00.123456+00',
  ...over,
});

const overview = (entitlements: ForwardingEntitlement[], rules: ForwardingRule[]): ForwardingOverview => ({
  tenant_id: 'platform.acme',
  user_id: 'alice',
  entitlements,
  rules,
});

const usage = (ruleId: number, down: number, up: number, over: Partial<UsageForwardingMonthlyRow> = {}) => ({
  tenant_id: 'platform.acme',
  user_id: 'alice',
  node_id: 'n1',
  rule_id: ruleId,
  rule_name: `rule-${ruleId}`,
  uplink_bytes: up,
  downlink_bytes: down,
  has_gap: false,
  ...over,
});

const monthly = (rows: UsageForwardingMonthlyRow[]): UsageMonthlySummary => ({
  month_start: '2026-10-01 00:00:00',
  month_end: '2026-11-01 00:00:00',
  views: [],
  forwarding: rows,
});

type Route = (init?: RequestInit) => unknown;

/** 按「方法 路径」应答；未登记的请求返回 404，让查询进入错误态而不是挂起。 */
function serve(routes: Record<string, Route>) {
  const table: Record<string, Route> = {
    'GET /usage/monthly-summary': () => monthly([]),
    'GET /nodes/agent-state': () => ({
      nodes: [
        { node_id: 'n1', name: '东京入口', public_ipv4_country: 'JP' },
        { node_id: 'n2', name: '洛杉矶入口', public_ipv4_country: 'US' },
      ],
    }),
    ...routes,
  };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = table[`${init?.method ?? 'GET'} ${String(input)}`];
    if (!route) return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    const value = route(init);
    return value instanceof Response ? value : Response.json(value);
  });
  vi.stubGlobal('fetch', request);
  return request;
}

const writes = (request: ReturnType<typeof serve>) =>
  request.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([input, init]) => ({
      path: String(input),
      method: init?.method,
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    }));

function show(options: { canAuthorize?: boolean; canManageRules?: boolean; canViewRealtime?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UserForwardingCard
        user={user}
        nodes={[
          { id: 'n1', name: '东京入口', api_port: 10085, public_ipv4: '198.51.100.10' },
          { id: 'n2', name: '洛杉矶入口', api_port: 10085 },
        ]}
        canAuthorize={options.canAuthorize ?? false}
        canManageRules={options.canManageRules ?? true}
        canViewRealtime={options.canViewRealtime ?? false}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('用户转发入口', () => {
  it('接口尚未部署时只显示错误，不把失败误报成空授权', async () => {
    serve({ [`GET ${BASE}/forwarding`]: () => new Response('Not Found', { status: 404, statusText: 'Not Found' }) });
    const view = show({ canAuthorize: true });

    expect(await view.findByText('404 Not Found')).toBeTruthy();
    expect(view.queryByText('尚未授权转发入口')).toBeNull();
    expect(view.queryByRole('button', { name: /新建规则/ })).toBeNull();
  });

  it('管理员在对话框里选机器授权，使用完整的默认转发策略', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([], []),
      [`PUT ${BASE}/forwarding-nodes/n2`]: () =>
        overview([entry({ node_id: 'n2', node_name: '洛杉矶入口', rule_count: 0 })], []),
    });
    const view = show({ canAuthorize: true });

    await view.findByText('尚未授权转发入口');
    fireEvent.click(view.getByRole('button', { name: '授权机器' }));
    const dialog = view.getByRole('dialog', { name: '授权转发入口' });
    const submit = within(dialog).getByRole('button', { name: '授权' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /洛杉矶入口/ }));
    fireEvent.click(submit);

    await waitFor(() => expect(writes(request)).toHaveLength(1));
    expect(writes(request)[0]).toEqual({
      path: `${BASE}/forwarding-nodes/n2`,
      method: 'PUT',
      body: {
        enabled: true,
        tcp_allowed: true,
        udp_allowed: true,
        listen_port_start: 30_000,
        listen_port_end: 59_999,
        max_rules: 100,
        allow_private_targets: true,
      },
    });
    expect(await view.findByRole('button', { name: /洛杉矶入口/, pressed: false })).toBeTruthy();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('读数栏给出本月转发与已删除规则；IPv6 入口与目标不重复方括号', async () => {
    serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      'GET /usage/monthly-summary': () =>
        monthly([usage(42, 3 * MiB, 1 * MiB), usage(7, 1 * MiB, 0), usage(42, 9 * MiB, 9 * MiB, { user_id: 'bob' })]),
    });
    const view = show();

    await view.findByText('现有规则');
    await waitFor(() => expect(view.container.querySelector('.user-usage-hero-value')?.textContent).toBe('5.0 MiB'));
    expect(view.getByText('其中 1.0 MiB 来自已删除的规则')).toBeTruthy();
    expect(view.container.querySelector('.fwd-month b')?.textContent).toBe('4.0 MiB');

    fireEvent.click(view.getByRole('button', { name: /现有规则，入口 20042/ }));
    expect(view.getByText('198.51.100.10:20042')).toBeTruthy();
    expect(view.getByText('[2001:4860:4860::8888]:20042')).toBeTruthy();
    expect(view.getAllByText('[2606:4700:4700::1111]:443').length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain('[[');
  });

  it('新建规则只填一栏目标，入口端口取下一个空闲端口', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`POST ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
    });
    const view = show();

    await view.findByText('现有规则');
    fireEvent.click(view.getByRole('button', { name: /新建规则/ }));
    expect((view.getByLabelText('入口端口') as HTMLInputElement).value).toBe('20000');
    fireEvent.change(view.getByLabelText('目标地址'), { target: { value: 'https://example.com:8443/path' } });
    fireEvent.click(view.getByRole('button', { name: '创建规则' }));

    await waitFor(() => expect(writes(request)).toHaveLength(1));
    expect(writes(request)[0].body).toEqual({
      node_id: 'n1',
      name: 'example.com:8443',
      protocol: 'tcp_udp',
      listen_port: 20_000,
      target_host: 'example.com',
      target_port: 8443,
      enabled: true,
    });
  });

  it('提交前提示端口冲突与私网目标，IPv6 目标按方括号形式提交', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`POST ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
    });
    const view = show();

    await view.findByText('现有规则');
    fireEvent.click(view.getByRole('button', { name: /新建规则/ }));
    const submit = view.getByRole('button', { name: '创建规则' }) as HTMLButtonElement;
    fireEvent.change(view.getByLabelText('目标地址'), { target: { value: 'example.com:80' } });
    fireEvent.change(view.getByLabelText('入口端口'), { target: { value: '20042' } });
    expect(view.getByRole('alert').textContent).toContain('已被「现有规则」占用');
    expect(view.getByRole('alert').textContent).toContain('下一个空闲端口 20000');
    expect(submit.disabled).toBe(true);

    fireEvent.change(view.getByLabelText('入口端口'), { target: { value: '20001' } });
    fireEvent.change(view.getByLabelText('目标地址'), { target: { value: '192.168.1.10:22' } });
    expect(view.getByRole('alert').textContent).toContain('未允许转发到私网');
    expect(submit.disabled).toBe(true);

    fireEvent.change(view.getByLabelText('目标地址'), { target: { value: '[2001:4860::1]:443' } });
    expect(view.queryByRole('alert')).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(writes(request)).toHaveLength(1));
    expect(writes(request)[0].body).toMatchObject({
      listen_port: 20_001,
      target_host: '[2001:4860::1]',
      target_port: 443,
    });
  });

  it('就地修改已有规则的协议和端口', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`PUT ${BASE}/forwarding/42`]: () => overview([entry()], [rule()]),
    });
    const view = show();

    await view.findByText('现有规则');
    fireEvent.click(view.getByRole('button', { name: '编辑 :20042' }));
    const form = view.getByRole('form', { name: /编辑入口/ });
    fireEvent.click(within(form).getByRole('button', { name: 'UDP' }));
    fireEvent.change(within(form).getByLabelText('入口端口'), { target: { value: '20044' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存规则' }));

    await waitFor(() => expect(writes(request)).toHaveLength(1));
    expect(writes(request)[0]).toEqual({
      path: `${BASE}/forwarding/42`,
      method: 'PUT',
      body: {
        node_id: 'n1',
        name: '现有规则',
        protocol: 'udp',
        listen_port: 20_044,
        target_host: '[2606:4700:4700::1111]',
        target_port: 443,
        enabled: true,
      },
    });
  });

  it('删除规则先在对话框里确认，不用浏览器原生确认框', async () => {
    const native = vi.spyOn(window, 'confirm');
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`DELETE ${BASE}/forwarding/42`]: () => overview([entry({ rule_count: 0 })], []),
    });
    const view = show();

    await view.findByText('现有规则');
    fireEvent.click(view.getByRole('button', { name: ':20042 的更多操作' }));
    fireEvent.click(view.getByRole('menuitem', { name: /删除规则/ }));
    const dialog = view.getByRole('dialog', { name: '删除转发规则' });
    expect(within(dialog).getByText(/东京入口 立即停止监听 20042/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除规则' }));

    await waitFor(() =>
      expect(writes(request)).toEqual([{ path: `${BASE}/forwarding/42`, method: 'DELETE', body: undefined }]),
    );
    expect(await view.findByText('还没有转发规则')).toBeTruthy();
    expect(native).not.toHaveBeenCalled();
  });

  it('撤销授权需要确认，确认后提交 enabled=false', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`PUT ${BASE}/forwarding-nodes/n1`]: () =>
        overview([entry({ enabled: false })], [rule({ runtime_status: 'disabled' })]),
    });
    const view = show({ canAuthorize: true });

    await view.findByText('现有规则');
    fireEvent.click(view.getByRole('button', { name: '东京入口 的授权操作' }));
    fireEvent.click(view.getByRole('menuitem', { name: /撤销授权/ }));
    const dialog = view.getByRole('dialog', { name: '撤销 东京入口 的转发授权' });
    expect(writes(request)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销授权' }));

    await waitFor(() => expect(writes(request)).toHaveLength(1));
    expect(writes(request)[0].body).toEqual({
      enabled: false,
      tcp_allowed: true,
      udp_allowed: true,
      listen_port_start: 20_000,
      listen_port_end: 20_100,
      max_rules: 4,
      allow_private_targets: false,
    });
    expect(await view.findByText('已撤销')).toBeTruthy();
  });

  it('确认后移除已撤销的入口及其规则', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry({ enabled: false })], [rule({ runtime_status: 'disabled' })]),
      [`DELETE ${BASE}/forwarding-nodes/n1`]: () => overview([], []),
    });
    const view = show({ canAuthorize: true });

    expect(await view.findByText('已撤销')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '东京入口 的授权操作' }));
    expect(view.getByRole('menuitem', { name: /恢复授权/ })).toBeTruthy();
    fireEvent.click(view.getByRole('menuitem', { name: /移除授权/ }));
    const dialog = view.getByRole('dialog', { name: '移除已撤销的转发入口' });
    expect(within(dialog).getByText(/并移除其下 1 条规则/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认移除' }));

    await waitFor(() => expect(writes(request)[0]?.method).toBe('DELETE'));
    await view.findByText('尚未授权转发入口');
    expect(view.queryByText('已撤销')).toBeNull();
  });

  it('修改授权：范围会排除启用中的规则时先提示，合规后保存策略', async () => {
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`PUT ${BASE}/forwarding-nodes/n1`]: () => overview([entry()], [rule()]),
    });
    const view = show({ canAuthorize: true });

    await view.findByText('现有规则');
    fireEvent.click(view.getByRole('button', { name: '东京入口 的授权操作' }));
    fireEvent.click(view.getByRole('menuitem', { name: /修改授权/ }));
    const dialog = view.getByRole('dialog', { name: '修改 东京入口 的授权' });
    const save = within(dialog).getByRole('button', { name: '保存授权' }) as HTMLButtonElement;

    fireEvent.change(within(dialog).getByLabelText('端口起始'), { target: { value: '20050' } });
    expect(within(dialog).getByText(/1 条启用中的规则不在新范围内（20042）/)).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('端口起始'), { target: { value: '20000' } });
    fireEvent.change(within(dialog).getByLabelText('端口结束'), { target: { value: '20999' } });
    fireEvent.change(within(dialog).getByLabelText('规则上限'), { target: { value: '8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '只 TCP' }));
    fireEvent.click(save);

    await waitFor(() => expect(writes(request)).toHaveLength(1));
    expect(writes(request)[0].body).toEqual({
      enabled: true,
      tcp_allowed: true,
      udp_allowed: false,
      listen_port_start: 20_000,
      listen_port_end: 20_999,
      max_rules: 8,
      allow_private_targets: false,
    });
  });

  it('只读身份可以展开详情，看不到授权与改规则的操作', async () => {
    serve({ [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]) });
    const view = show({ canManageRules: false });

    await view.findByText('现有规则');
    expect(view.queryByRole('button', { name: /新建规则/ })).toBeNull();
    expect(view.queryByRole('button', { name: '编辑 :20042' })).toBeNull();
    expect(view.queryByRole('button', { name: '东京入口 的授权操作' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: /现有规则，入口 20042/ }));
    expect(view.getByText('198.51.100.10:20042')).toBeTruthy();
    expect(view.queryByRole('button', { name: /删除规则/ })).toBeNull();
  });

  it('按机器筛选、搜索，并可按本月流量排序', async () => {
    serve({
      [`GET ${BASE}/forwarding`]: () =>
        overview(
          [entry({ rule_count: 2 }), entry({ node_id: 'n2', node_name: '洛杉矶入口', rule_count: 1 })],
          [
            rule(),
            rule({
              id: 43,
              node_id: 'n2',
              name: '游戏',
              listen_port: 20_001,
              target_host: 'game.example.org',
              target_port: 7777,
            }),
            rule({
              id: 44,
              name: 'b.example.com:80',
              listen_port: 20_002,
              target_host: 'b.example.com',
              target_port: 80,
            }),
          ],
        ),
      'GET /usage/monthly-summary': () =>
        monthly([usage(42, 4 * MiB, 0), usage(43, 9 * MiB, 0, { node_id: 'n2' }), usage(44, 1 * MiB, 0)]),
    });
    const view = show();
    const ports = () =>
      [...view.container.querySelectorAll('.fwd-port')].map(port => /:(\d+)/.exec(port.textContent ?? '')?.[1]);

    await view.findByText('游戏');
    expect(ports()).toEqual(['20001', '20002', '20042']);
    await waitFor(() => expect(view.container.querySelector('.user-usage-hero-value')?.textContent).toBe('14.0 MiB'));

    fireEvent.click(view.getByRole('button', { name: '本月流量' }));
    expect(ports()).toEqual(['20001', '20042', '20002']);

    fireEvent.click(view.getByRole('button', { name: /洛杉矶入口/, pressed: false }));
    expect(ports()).toEqual(['20001']);
    fireEvent.click(view.getByRole('button', { name: /洛杉矶入口/, pressed: true }));
    expect(ports()).toHaveLength(3);

    fireEvent.change(view.getByLabelText('搜索规则'), { target: { value: 'example.org' } });
    expect(ports()).toEqual(['20001']);
  });

  it('能看实时的身份显示每条规则的当前速率；其他身份不订阅', async () => {
    const now = Date.now();
    const request = serve({
      [`GET ${BASE}/forwarding`]: () => overview([entry()], [rule()]),
      [`GET ${BASE}/realtime/snapshot`]: () => ({
        policy: { enabled: true },
        nodes: [
          {
            node_id: 'n1',
            connected: true,
            active: true,
            samples: [
              {
                node_id: 'n1',
                received_at_unix_millis: now,
                sample: {
                  sampled_at_unix_millis: now,
                  user_traffic: {
                    state: 'ready',
                    all_users: false,
                    forwarding_supported: true,
                    forwarding_expected: true,
                    users: [
                      {
                        tenant_id: 'platform.acme',
                        user_id: 'alice',
                        forwarding_rule_id: 42,
                        downlink_bytes_per_sec: 250_000,
                        uplink_bytes_per_sec: 12_500,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      }),
    });
    const view = show({ canViewRealtime: true });

    await view.findByText('1 条在转发');
    expect(view.getAllByText('2.10 Mbit/s').length).toBe(2);
    cleanup();

    request.mockClear();
    const plain = show();
    await plain.findByText('现有规则');
    expect(plain.queryByText('当前')).toBeNull();
    expect(request.mock.calls.some(([input]) => String(input).includes('/realtime/'))).toBe(false);
  });
});
