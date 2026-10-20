import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../src/forge/route', () => route);

import { OnboardingGuide, openOnboardingGuide } from '../src/panes/onboarding';
import { ProvisionInstall, type Drill } from '../src/panes/nodes';
import { SessionProvider } from '../src/session';
import { forge } from '../src/forge/state';
import { wm } from '../src/wm/store';
import type { NodeInitialization, ProvisionNodeResult } from '../src/api';

const who = {
  operator_id: 'root',
  role: 'system-admin' as const,
  tenant_scope: null,
  token_prefix: null,
  masked_assets: false,
};

const response = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;

function state(status: 'active' | 'complete' | 'not-applicable') {
  return {
    status,
    root_tenant_id: status === 'not-applicable' ? null : 'platform',
    started_at: status === 'not-applicable' ? null : '2026-10-19T00:00:00Z',
    node_id: status === 'complete' ? 'hk-01' : null,
    app_id: status === 'complete' ? 'app-main' : null,
    chain_id: status === 'complete' ? 'chain-main' : null,
    ingress_id: status === 'complete' ? 'ingress-main' : null,
    user_tenant_id: status === 'complete' ? 'platform' : null,
    user_id: status === 'complete' ? 'alice' : null,
    target_revision_id: status === 'complete' ? 3 : null,
    deployment_id: status === 'complete' ? 1 : null,
    completed_at: status === 'complete' ? '2026-10-19T00:10:00Z' : null,
  };
}

const queryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });

function renderGuide(
  status: 'active' | 'complete' | 'not-applicable',
  client = queryClient(),
  result?: ProvisionNodeResult,
) {
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider value={{ who, initial: { node_count: 0, chain_group_count: [], onboarding: status } }}>
        <main aria-label="机器页面">真实业务页面</main>
        {result && <ProvisionInstall node="hk-01" result={result} go={vi.fn()} />}
        <OnboardingGuide />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

let setupId = 0;

function installation(client: QueryClient) {
  const result = {
    revision_id: 2,
    enrollment: { token: 'test-onboarding-token', install_command: 'test-install-command', token_prefix: 'test' },
  } as ProvisionNodeResult;
  const drill: Drill = { p: 'install', node: 'hk-01', step: 2, result };
  const win = wm.open('tab:nodes', '机器');
  wm.patchData(win.id, { drill });
  client.setQueryData(['nodes'], {
    nodes: [
      { node_id: 'hk-01', tenant_id: 'platform', name: '首台机器', token_last_used_at: null, last_poll_at: null },
    ],
  });
  client.setQueryData(['revisions'], { current_revision: 2, revisions: [] });
  client.setQueryData(['certs'], { domain: null, groups: [], nodes: [] });
  return drill;
}

function onlineMachine(client: QueryClient, initialization: NodeInitialization) {
  client.setQueryData(['nodes'], {
    nodes: [
      {
        node_id: 'hk-01',
        tenant_id: 'platform',
        token_last_used_at: new Date().toISOString(),
        last_poll_at: new Date().toISOString(),
        initialization,
      },
    ],
  });
}

beforeEach(() => {
  route.navigate.mockReset();
  wm.init(`onboarding-test-${++setupId}`);
  forge.setNav('nodes');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('brocade.first-run.model-receipt.root');
  vi.unstubAllGlobals();
});

describe('first-run onboarding overlay', () => {
  it('records the new machine without reopening the guide over its installation command', async () => {
    const client = queryClient();
    const drill = installation(client);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/onboarding' && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ step: 'node', node_id: 'hk-01' });
        return response({ ...state('active'), node_id: 'hk-01' });
      }
      if (String(input) === '/onboarding') return response(state('active'));
      throw new Error(`unexpected request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const view = renderGuide('active', client, drill.result);
    expect(view.getByLabelText('安装命令').textContent).toBe('test-install-command');
    await vi.waitFor(() => expect(client.getQueryData(['onboarding'])).toMatchObject({ node_id: 'hk-01' }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByLabelText('安装命令').textContent).toBe('test-install-command');
    expect(route.navigate).not.toHaveBeenCalled();
    expect(wm.snapshot().wins.find(win => win.key === 'tab:nodes')?.data.drill).toBe(drill);
  });

  it('does not interrupt the registration form when the guide is restored', async () => {
    const client = queryClient();
    const win = wm.open('tab:nodes', '机器');
    wm.patchData(win.id, { drill: { p: 'provision', step: 1 } });
    client.setQueryData(['nodes'], { nodes: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(state('active'))),
    );
    const view = renderGuide('active', client);
    await vi.waitFor(() => expect(client.getQueryData(['onboarding'])).toMatchObject({ status: 'active' }));
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('allows an explicit prompt on the current installation without navigating or losing its token', async () => {
    const client = queryClient();
    const drill = installation(client);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...state('active'), node_id: 'hk-01' })),
    );
    const view = renderGuide('active', client, drill.result);
    await vi.waitFor(() => expect(client.getQueryData(['onboarding'])).toMatchObject({ node_id: 'hk-01' }));
    act(() => openOnboardingGuide());
    expect(await view.findByRole('dialog', { name: '安装 Agent，等待机器上线' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '继续当前安装' }));
    expect(route.navigate).not.toHaveBeenCalled();
    expect(view.getByLabelText('安装命令').textContent).toBe('test-install-command');
    expect(wm.snapshot().wins.find(win => win.key === 'tab:nodes')?.data.drill).toBe(drill);
  });

  it('reuses the existing installation receipt when returning from another page', async () => {
    const client = queryClient();
    const drill = installation(client);
    forge.setNav('users');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...state('active'), node_id: 'hk-01' })),
    );
    const view = renderGuide('active', client);
    fireEvent.click(await view.findByRole('button', { name: '查看安装步骤' }));
    expect(route.navigate).toHaveBeenCalledWith('nodes', drill);
  });

  it('continues on liveness for legacy registrations without an initialization task', async () => {
    const client = queryClient();
    installation(client);
    client.setQueryData(['nodes'], {
      nodes: [
        {
          node_id: 'hk-01',
          tenant_id: 'platform',
          token_last_used_at: new Date().toISOString(),
          last_poll_at: new Date().toISOString(),
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...state('active'), node_id: 'hk-01' })),
    );
    const view = renderGuide('active', client);
    expect(await view.findByRole('dialog', { name: '机器在线，创建第一条线路' })).toBeTruthy();
  });

  it.each(['waiting-agent', 'queued', 'running', 'manual', 'failed'] as const)(
    'keeps the installation surface uninterrupted while initialization is %s',
    async initializationState => {
      const client = queryClient();
      const drill = installation(client);
      onlineMachine(client, {
        state: initializationState,
        revision_id: 2,
        deployment_id: initializationState === 'running' || initializationState === 'failed' ? 4 : null,
        reason: null,
      });
      client.setQueryData(['onboarding'], { ...state('active'), node_id: 'hk-01' });
      vi.stubGlobal('fetch', vi.fn());
      const view = renderGuide('active', client, drill.result);
      expect(view.queryByRole('dialog')).toBeNull();
      expect(view.queryByRole('button', { name: '下一步 · 创建线路' })).toBeNull();
      expect(wm.snapshot().wins.find(win => win.key === 'tab:nodes')?.data.drill).toBe(drill);
      expect(route.navigate).not.toHaveBeenCalled();
    },
  );

  it('prompts for the first chain only after the server reports initialization success', async () => {
    const client = queryClient();
    installation(client);
    onlineMachine(client, { state: 'running', revision_id: 2, deployment_id: 4, reason: null });
    client.setQueryData(['onboarding'], { ...state('active'), node_id: 'hk-01' });
    vi.stubGlobal('fetch', vi.fn());
    const view = renderGuide('active', client);
    expect(view.queryByRole('dialog')).toBeNull();

    act(() => {
      onlineMachine(client, { state: 'succeeded', revision_id: 2, deployment_id: 4, reason: null });
    });
    expect(await view.findByRole('dialog', { name: '机器初始化完成，创建第一条线路' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '下一步 · 创建线路' }));
    expect(route.navigate).toHaveBeenCalledWith('nodes', { p: 'chain', id: 'hk-01' });
  });

  it('returns to the existing installation receipt to follow initialization from another page', async () => {
    const client = queryClient();
    const drill = installation(client);
    onlineMachine(client, { state: 'running', revision_id: 2, deployment_id: 4, reason: null });
    client.setQueryData(['onboarding'], { ...state('active'), node_id: 'hk-01' });
    forge.setNav('users');
    vi.stubGlobal('fetch', vi.fn());
    const view = renderGuide('active', client);
    expect(await view.findByRole('dialog', { name: 'Agent 已上线，初始化中' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '查看初始化进度' }));
    expect(route.navigate).toHaveBeenCalledWith('nodes', drill);
  });

  it.each([
    ['manual', '需要人工发布', '已有其他机器的配置待发布，请人工处理'],
    ['failed', '初始化需要处理', '初始化发布未完成，请查看发布单并重试失败目标'],
  ] as const)(
    'shows the server reason for %s initialization and preserves the installation receipt',
    async (s, title, reason) => {
      const client = queryClient();
      const drill = installation(client);
      onlineMachine(client, { state: s, revision_id: 2, deployment_id: s === 'failed' ? 4 : null, reason });
      client.setQueryData(['onboarding'], { ...state('active'), node_id: 'hk-01' });
      vi.stubGlobal('fetch', vi.fn());
      const view = renderGuide('active', client);
      act(() => openOnboardingGuide());
      expect(await view.findByRole('dialog', { name: title })).toBeTruthy();
      expect(view.getByText(reason)).toBeTruthy();
      fireEvent.click(view.getByRole('button', { name: '查看初始化进度' }));
      expect(route.navigate).not.toHaveBeenCalled();
      expect(wm.snapshot().wins.find(win => win.key === 'tab:nodes')?.data.drill).toBe(drill);
    },
  );

  it('continues to the business release when its model was already committed during manual initialization', async () => {
    const client = queryClient();
    installation(client);
    onlineMachine(client, { state: 'manual', revision_id: 2, deployment_id: null, reason: '请人工发布' });
    client.setQueryData(['onboarding'], { ...state('active'), node_id: 'hk-01', target_revision_id: 3 });
    client.setQueryData(['deployments', 'config'], { deployments: [] });
    vi.stubGlobal('fetch', vi.fn());
    const view = renderGuide('active', client);
    fireEvent.click(await view.findByRole('button', { name: '下一步 · 前往发布' }));
    expect(route.navigate).toHaveBeenCalledWith('deploy', { p: 'plan', revision: 3 });
  });

  it('can recover the checkpoint of an already committed model during manual initialization', async () => {
    const client = queryClient();
    installation(client);
    onlineMachine(client, { state: 'manual', revision_id: 2, deployment_id: null, reason: '请人工发布' });
    client.setQueryData(['onboarding'], { ...state('active'), node_id: 'hk-01' });
    client.setQueryData(['deployments', 'config'], { deployments: [] });
    localStorage.setItem(
      'brocade.first-run.model-receipt.root',
      JSON.stringify({
        appId: 'app-main',
        chainId: 'chain-main',
        ingressId: 'ingress-main',
        tenantId: 'platform',
        userId: 'alice',
        revisionId: 3,
      }),
    );
    forge.setNav('users');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('/onboarding');
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(String(init?.body))).toMatchObject({ step: 'model', target_revision_id: 3 });
        return response({ ...state('active'), node_id: 'hk-01', target_revision_id: 3 });
      }),
    );
    const view = renderGuide('active', client);
    fireEvent.click(await view.findByRole('button', { name: '重试确认' }));
    await vi.waitFor(() => expect(client.getQueryData(['onboarding'])).toMatchObject({ target_revision_id: 3 }));
  });

  it('opens a modal over the real machine page and guides the first navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/onboarding') return response(state('active'));
        if (String(input) === '/nodes/agent-state') return response({ nodes: [] });
        throw new Error(`unexpected request ${String(input)}`);
      }),
    );
    const view = renderGuide('active');

    expect(await view.findByRole('dialog', { name: '先纳管第一台机器' })).toBeTruthy();
    expect(view.getByRole('main', { name: '机器页面' })).toBeTruthy();
    expect(view.getByRole('button', { name: '下一步 · 纳管机器' })).toBeTruthy();
    expect(view.getByRole('list', { name: '首次上线进度' }).children).toHaveLength(5);
    fireEvent.click(view.getByRole('button', { name: '下一步 · 纳管机器' }));
    expect(route.navigate).toHaveBeenCalledWith('nodes', { p: 'provision', step: 1 });
  });

  it('keeps a completed guide quiet on login but allows reopening it from the account menu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/onboarding') return response(state('complete'));
        throw new Error(`unexpected request ${String(input)}`);
      }),
    );
    const view = renderGuide('complete');
    await vi.waitFor(() => expect(view.queryByRole('dialog')).toBeNull());

    act(() => openOnboardingGuide());
    expect(await view.findByRole('dialog', { name: '第一条线路已经可用' })).toBeTruthy();
    expect(view.getAllByText('✓')).toHaveLength(5);
  });

  it('does not mount an onboarding surface for established installations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/onboarding') return response(state('not-applicable'));
        throw new Error(`unexpected request ${String(input)}`);
      }),
    );
    const view = renderGuide('not-applicable');
    await vi.waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    expect(view.queryByText('这套安装无需入门向导')).toBeNull();
  });
});
