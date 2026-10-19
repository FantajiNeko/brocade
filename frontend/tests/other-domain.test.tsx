import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchOtherDomainPolicy, saveOtherDomainPolicy } from '../src/api';
import { OtherDomainSettingsSection } from '../src/other-domain-settings';

vi.mock('../src/api', async original => ({
  ...(await original<typeof import('../src/api')>()),
  fetchOtherDomainPolicy: vi.fn(),
  saveOtherDomainPolicy: vi.fn(),
}));
const policy = {
  enabled: false,
  top_n: 128,
  max_domains_per_user: 1024,
  node_capacity: 4096,
  report_interval_secs: 30,
};
const wrap = (child: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {child}
  </QueryClientProvider>
);
beforeEach(() => {
  vi.mocked(fetchOtherDomainPolicy).mockReset().mockResolvedValue(policy);
  vi.mocked(saveOtherDomainPolicy)
    .mockReset()
    .mockImplementation(async value => value);
});
afterEach(cleanup);

it('keeps default-off policy and configurable per-user budgets behind an explicit save', async () => {
  render(wrap(<OtherDomainSettingsSection editable />));
  const input = await screen.findByLabelText('每用户 Top N');
  expect((input as HTMLInputElement).value).toBe('128');
  expect((screen.getByLabelText('每用户域名容量') as HTMLInputElement).value).toBe('1024');
  expect(screen.getByRole('button', { name: '关闭' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '开启' }));
  fireEvent.change(input, { target: { value: '64' } });
  expect(saveOtherDomainPolicy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存未分类域名设置' }));
  await screen.findByText('已保存，待节点同步。');
  expect(saveOtherDomainPolicy).toHaveBeenCalledExactlyOnceWith({ ...policy, enabled: true, top_n: 64 });
});
it('rejects invalid budgets and blocks non-system-admin edits', async () => {
  const view = render(wrap(<OtherDomainSettingsSection editable />));
  fireEvent.change(await screen.findByLabelText('每用户 Top N'), { target: { value: '513' } });
  expect(screen.getByRole('button', { name: '保存未分类域名设置' }).hasAttribute('disabled')).toBe(true);
  view.unmount();
  render(wrap(<OtherDomainSettingsSection editable={false} />));
  await screen.findByLabelText('每用户 Top N');
  expect((screen.getByLabelText('每用户 Top N') as HTMLInputElement).matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: '保存未分类域名设置' })).toBeNull();
});
