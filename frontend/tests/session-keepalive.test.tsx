import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { announceSessionChange, SESSION_KEEPALIVE_INTERVAL_MS, SessionProvider } from '../src/session';

const rootSession = {
  who: {
    operator_id: 'root',
    role: 'system-admin' as const,
    tenant_scope: null,
    token_prefix: null,
    masked_assets: false,
  },
  initial: { node_count: 0, chain_group_count: [] },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps an open authenticated console session active and stops after unmount', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          operator_id: 'root',
          role: 'system-admin',
          tenant_scope: null,
          token_prefix: null,
          masked_assets: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);

  const view = render(
    <SessionProvider value={rootSession}>
      <div>console</div>
    </SessionProvider>,
  );

  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SESSION_KEEPALIVE_INTERVAL_MS);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/whoami');
  expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');

  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SESSION_KEEPALIVE_INTERVAL_MS);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('reloads an open tab when the shared session cookie belongs to another account', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      operator_id: 'platform/alice',
      role: 'user',
      tenant_scope: 'platform',
      token_prefix: null,
      masked_assets: true,
      self_user: { tenant_id: 'platform', user_id: 'alice' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onIdentityChange = vi.fn();

  render(
    <SessionProvider value={rootSession} onIdentityChange={onIdentityChange}>
      <div>console</div>
    </SessionProvider>,
  );

  window.dispatchEvent(new Event('focus'));
  await waitFor(() => expect(onIdentityChange).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledOnce();

  window.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  expect(onIdentityChange).toHaveBeenCalledOnce();
});

it('keeps the page when focus confirms the same account', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(rootSession.who));
  vi.stubGlobal('fetch', fetchMock);
  const onIdentityChange = vi.fn();

  render(
    <SessionProvider value={rootSession} onIdentityChange={onIdentityChange}>
      <div>console</div>
    </SessionProvider>,
  );

  window.dispatchEvent(new Event('focus'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(onIdentityChange).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');
});

it('does not block a successful login when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', {
    setItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
  });

  expect(() => announceSessionChange()).not.toThrow();
});
