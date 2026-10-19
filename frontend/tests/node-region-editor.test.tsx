import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRegionEditor } from '../src/panes/node-region-editor';
import { CUSTOM_REGION_CODE, REGION_GROUPS } from '../src/ui/region-groups';
import { SUBSCRIPTION_COUNTRY_CODES } from '../src/ui/subscription-country';

afterEach(cleanup);

function renderEditor({
  countryCode = 'JP',
  detectedCountryCode = 'JP',
  overrideCountryCode = null,
  onSave = vi.fn<(countryCode: string | null) => Promise<unknown>>().mockResolvedValue({}),
}: {
  countryCode?: string | null;
  detectedCountryCode?: string | null;
  overrideCountryCode?: string | null;
  onSave?: (countryCode: string | null) => Promise<unknown>;
} = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <NodeRegionEditor
        nodeName="东京一号"
        countryCode={countryCode}
        detectedCountryCode={detectedCountryCode}
        overrideCountryCode={overrideCountryCode}
        lampTone="ok"
        lampWhy="运行正常"
        editable
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return { ...view, onSave };
}

describe('NodeRegionEditor', () => {
  it('opens from the flag, shows every flag, and saves a manual correction', async () => {
    const { onSave } = renderEditor();
    const trigger = screen.getByRole('button', { name: /更换 东京一号 的地区/ });

    fireEvent.click(trigger);
    const choices = screen.getByRole('group', { name: '机器地区' });
    const flags = choices.querySelectorAll<HTMLButtonElement>('.node-region-grid > button');
    expect(flags).toHaveLength(SUBSCRIPTION_COUNTRY_CODES.length);
    expect(document.activeElement).toBe(within(choices).getByRole('button', { name: /自动判断/ }));
    expect(screen.getByText(/IP 库判断：JP · 日本/)).toBeTruthy();
    expect(screen.getByRole('group', { name: '亚洲地区' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '大洋洲地区' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择 XX · 自定义旗帜位' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '选择 TW · 台湾' }));
    fireEvent.click(screen.getByRole('button', { name: '保存地区' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('TW'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('can clear an existing override and return to the detected country', async () => {
    const onSave = vi.fn<(countryCode: string | null) => Promise<unknown>>().mockResolvedValue({});
    renderEditor({ countryCode: 'TW', detectedCountryCode: 'JP', overrideCountryCode: 'TW', onSave });

    fireEvent.click(screen.getByRole('button', { name: /当前 TW/ }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择 TW · 台湾' }));
    fireEvent.click(screen.getByRole('button', { name: /自动判断/ }));
    expect(screen.getByText('将恢复自动判断：JP · 日本')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复自动判断' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it('persists the reserved custom flag slot as XX', async () => {
    const { onSave } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /更换 东京一号 的地区/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择 XX · 自定义旗帜位' }));
    expect(screen.getByText('将固定为 XX · 自定义旗帜位')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存地区' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(CUSTOM_REGION_CODE));
  });

  it('assigns every available flag to exactly one continent or special group', () => {
    const grouped = REGION_GROUPS.flatMap(group => group.codes);

    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...SUBSCRIPTION_COUNTRY_CODES].sort());
    expect(REGION_GROUPS.find(group => group.id === 'special')?.codes[0]).toBe(CUSTOM_REGION_CODE);
  });
});
