import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchSniffingFailedPolicy, saveSniffingFailedPolicy } from '../src/api';
import { SniffingFailedSettingsSection } from '../src/other-domain-settings';

vi.mock('../src/api', async original => ({
  ...(await original<typeof import('../src/api')>()),
  fetchSniffingFailedPolicy: vi.fn(),
  saveSniffingFailedPolicy: vi.fn(),
}));
const policy = {
  enabled: false,
  top_n: 128,
  max_targets_per_user: 1024,
  node_capacity: 4096,
  report_interval_secs: 30,
};
const wrap = (child: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => (
  <QueryClientProvider client={client}>{child}</QueryClientProvider>
);
beforeEach(() => {
  vi.mocked(fetchSniffingFailedPolicy).mockReset().mockResolvedValue(policy);
  vi.mocked(saveSniffingFailedPolicy)
    .mockReset()
    .mockImplementation(async value => value);
});
afterEach(cleanup);

it('saves independent target budgets only after explicit confirmation', async () => {
  render(wrap(<SniffingFailedSettingsSection editable />));
  expect(((await screen.findByLabelText('每用户目标容量')) as HTMLInputElement).value).toBe('1024');
  expect(screen.getByRole('button', { name: '关闭' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '开启' }));
  fireEvent.change(screen.getByLabelText('每用户 Top N'), { target: { value: '64' } });
  expect(saveSniffingFailedPolicy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存嗅探失败目标设置' }));
  await screen.findByText('已保存，待节点同步。');
  expect(saveSniffingFailedPolicy).toHaveBeenCalledExactlyOnceWith({ ...policy, enabled: true, top_n: 64 });
});
it('forbids edits for non-system administrators', async () => {
  render(wrap(<SniffingFailedSettingsSection editable={false} />));
  const field = await screen.findByLabelText('每用户目标容量');
  expect(field.matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: '保存嗅探失败目标设置' })).toBeNull();
});
