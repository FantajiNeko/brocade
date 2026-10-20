import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createOperator, type AdminRole, type Whoami } from '../src/api';
import { OperatorsPane } from '../src/panes/operators';
import { SessionProvider } from '../src/session';

vi.mock('../src/api', async original => ({
  ...(await original<typeof import('../src/api')>()),
  createOperator: vi.fn(async () => ({})),
  fetchOperators: vi.fn(async () => ({ operators: [] })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(owners = ['private-owner'], scope: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['tenants'], { tenants: owners.map(id => ({ id, name: '隐藏的归属名称' })) });
  client.setQueryData(['operators'], {
    operators: [
      {
        id: 'manager',
        display_name: '管理员账号',
        role: 'tenant-admin',
        tenant_scope: owners[0],
        passwordless: false,
        token_prefix: null,
        token_revoked_at: null,
      },
    ],
  });
  const who: Whoami = {
    operator_id: 'admin',
    role: 'system-admin',
    tenant_scope: scope,
    token_prefix: null,
    masked_assets: false,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider value={{ who, initial: { node_count: 0, chain_group_count: [] } }}>
        <OperatorsPane />
      </SessionProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByRole('button', { name: '＋ 建操作者' }));
  fireEvent.change(view.getByRole('textbox', { name: '操作者 ID' }), { target: { value: 'new-reader' } });
  fireEvent.change(view.getByPlaceholderText('登录密码（至少 8 位）'), { target: { value: 'a-test-password' } });
  return view;
}

it.each<AdminRole>(['readonly', 'editor', 'publisher', 'tenant-admin', 'system-admin'])(
  'hides ownership and submits the original %s authorization role',
  async role => {
    const view = mount();
    const select = view.getByRole('combobox', { name: '操作者角色' });
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent),
    ).toEqual(['只读', '编辑', '发布', '管理员', '系统管理员']);
    expect(view.getAllByRole('combobox')).toHaveLength(1);
    expect(view.container.textContent).not.toMatch(/租户|private-owner|隐藏的归属名称|tenant-admin|scope/);
    fireEvent.change(select, { target: { value: role } });
    fireEvent.click(view.getByRole('button', { name: '建操作者' }));
    await waitFor(() =>
      expect(createOperator).toHaveBeenCalledWith({
        id: 'new-reader',
        display_name: 'new-reader',
        role,
        tenant_scope: role === 'system-admin' ? null : 'private-owner',
        password: 'a-test-password',
      }),
    );
  },
);

it('refuses an ambiguous implicit owner rather than silently choosing the first record', () => {
  const view = mount(['private-owner-a', 'private-owner-b']);
  expect(view.getByRole('alert').textContent).toBe('当前账户配置不可用，无法创建该角色的操作者。');
  const submit = view.getByRole('button', { name: '建操作者' });
  expect(submit.hasAttribute('disabled')).toBe(true);
  fireEvent.submit(submit.closest('form')!);
  expect(createOperator).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toMatch(/private-owner|隐藏的归属名称|租户/);
});

it('uses the current account context automatically when it is authoritative', async () => {
  const view = mount(['private-owner-a', 'private-owner-b'], 'private-owner-b');
  fireEvent.click(view.getByRole('button', { name: '建操作者' }));
  await waitFor(() =>
    expect(createOperator).toHaveBeenCalledWith(expect.objectContaining({ tenant_scope: 'private-owner-b' })),
  );
});
