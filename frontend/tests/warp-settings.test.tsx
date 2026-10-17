import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalOutbound } from '../src/api';
import { draft } from '../src/draft';
import { WarpBindingCard, WarpCreate, WarpEdit, warpReferenceStatus } from '../src/panes/tunnels';

type WarpProtocol = Extract<ExternalOutbound['protocol'], { t: 'warp' }>;

const protocol = (): WarpProtocol => ({
  t: 'warp',
  v: { http_version: 'h3', remote_dns: ['1.1.1.1', '1.0.0.1'] },
});

afterEach(() => {
  cleanup();
  draft.clear();
  vi.unstubAllGlobals();
});

describe('WARP exit stack settings', () => {
  it('does not label an unused tunnel as unreferenced', () => {
    expect(warpReferenceStatus(0, 0)).toBeNull();
    expect(warpReferenceStatus(2, 1)).toBe('待注册');
    expect(warpReferenceStatus(2, 0)).toBe('已引用');
  });

  it('keeps its random generated id hidden', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <WarpCreate tenantId="platform" existingIds={new Set()} onClose={() => undefined} onCreated={() => undefined} />
      </QueryClientProvider>,
    );

    expect(view.queryByText('资源 ID')).toBeNull();
    expect(view.queryByDisplayValue(/^warp-[0-9a-f]{4}-[0-9a-f]{4}$/)).toBeNull();
    const create = view.getByRole('button', { name: '创建隧道' }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(view.getByRole('textbox', { name: 'Endpoint 地址' })).toBeTruthy();
    expect(view.getByRole('spinbutton', { name: 'Endpoint 端口' })).toBeTruthy();
    fireEvent.click(create);
    await waitFor(() => expect(draft.ops()).toHaveLength(1));
    const operation = draft.ops()[0];
    expect(operation?.op).toBe('upsert_external_outbound');
    if (operation?.op !== 'upsert_external_outbound') throw new Error('expected a tunnel draft operation');
    expect(operation.outbound.id).toMatch(/^warp-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it('edits MASQUE HTTP version and tunnel DNS without exposing WG controls', async () => {
    const tunnel: ExternalOutbound = {
      id: 'warp-8f3a-2d71',
      tenant: 'platform',
      name: 'WARP',
      address: '162.159.198.2',
      port: 443,
      protocol: protocol(),
      security: { t: 'none' },
      bindings: [],
    };
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <WarpEdit tunnel={tunnel} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    const save = view.getByRole('button', { name: '保存到草稿' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(view.queryByText('Keepalive')).toBeNull();
    expect(view.queryByText('Workers')).toBeNull();
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'h2' } });
    fireEvent.change(view.getByRole('textbox', { name: /隧道内 DNS/ }), {
      target: { value: '9.9.9.9, 2606:4700:4700::1111' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(draft.ops()).toHaveLength(1));
    const operation = draft.ops()[0];
    if (operation.op !== 'upsert_external_outbound') throw new Error('expected tunnel draft');
    expect(operation.outbound.protocol).toEqual({
      t: 'warp',
      v: { http_version: 'h2', remote_dns: ['9.9.9.9', '2606:4700:4700::1111'] },
    });
  });

  it('sends every machine-level setting as an independent override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ revision_id: 2, binding: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <WarpBindingCard
          tenantId="platform"
          outboundId="warp-8f3a-2d71"
          binding={{
            node: 'hk',
            device_id: 'device-hk',
            account_id: 'account-hk',
            registered_at: '2026-08-28T00:00:00.000Z',
            peer_public_key: 'peer-key',
            local_addresses: ['172.16.0.2/32', '2606:4700::2/128'],
          }}
          nodeName="香港"
          defaultAddress="engage.cloudflareclient.com"
          defaultPort={2408}

          editable
        />
      </QueryClientProvider>,
    );
    const card = within(view.container);

    fireEvent.click(view.container.querySelector('.warp-binding-card') as HTMLElement);
    const save = card.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('没有修改');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(card.queryByText('Keepalive（秒）')).toBeNull();
    fireEvent.change(card.getByRole('textbox', { name: 'Endpoint 地址' }), { target: { value: '162.159.198.2' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ endpoint_address: '162.159.198.2', endpoint_port: null });
    vi.unstubAllGlobals();
  });

  it('requires an inline confirmation before unregistering and removing a machine identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ revision_id: 3, node_id: 'hk', device_id: 'device-hk', removed: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <WarpBindingCard
          tenantId="platform"
          outboundId="warp-8f3a-2d71"
          binding={{
            node: 'hk',
            device_id: 'device-hk',
            account_id: 'account-hk',
            registered_at: '2026-08-28T00:00:00.000Z',
            peer_public_key: 'peer-key',
            local_addresses: ['172.16.0.2/32', '2606:4700::2/128'],
          }}
          nodeName="香港"
          defaultAddress="engage.cloudflareclient.com"
          defaultPort={2408}

          editable
        />
      </QueryClientProvider>,
    );
    const card = within(view.container);

    fireEvent.click(view.container.querySelector('.warp-binding-card') as HTMLElement);
    fireEvent.click(card.getByRole('button', { name: '注销身份' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(card.getByText('注销这台机器的 Cloudflare 身份？')).toBeTruthy();
    expect(card.getByText(/历史修订也不能恢复这个身份/)).toBeTruthy();

    fireEvent.click(card.getByRole('button', { name: '确认注销并移除' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/tenants/platform/tunnels/warp-8f3a-2d71/warp-bindings/hk');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('explains why a referenced machine identity cannot be removed', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <WarpBindingCard
          tenantId="platform"
          outboundId="warp-8f3a-2d71"
          binding={{
            node: 'hk',
            device_id: 'device-hk',
            account_id: 'account-hk',
            registered_at: '2026-08-28T00:00:00.000Z',
            peer_public_key: 'peer-key',
            local_addresses: ['172.16.0.2/32'],
          }}
          nodeName="香港"
          defaultAddress="engage.cloudflareclient.com"
          defaultPort={2408}

          editable
          removalBlockedReason="这台机器仍被规则引用。请先解除引用并完成发布，再注销身份。"
        />
      </QueryClientProvider>,
    );
    const card = within(view.container);

    fireEvent.click(view.container.querySelector('.warp-binding-card') as HTMLElement);
    const remove = card.getByRole('button', { name: '注销身份' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(card.getByText(/请先解除引用并完成发布/)).toBeTruthy();
  });
});
