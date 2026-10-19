import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../src/forge/route', () => route);

import { OnboardingGuide, openOnboardingGuide } from '../src/panes/onboarding';
import { SessionProvider } from '../src/session';

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

function renderGuide(status: 'active' | 'complete' | 'not-applicable') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider value={{ who, initial: { node_count: 0, chain_group_count: [], onboarding: status } }}>
        <main aria-label="机器页面">真实业务页面</main>
        <OnboardingGuide />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  route.navigate.mockReset();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('first-run onboarding overlay', () => {
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
