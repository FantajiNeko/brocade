import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SiteUsageChart from '../src/site-usage-chart';

const mock = vi.hoisted(() => ({
  pixelsPerBucket: 10,
  resized: () => {},
  chart: {
    setOption: vi.fn(),
    convertToPixel: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    dispatchAction: vi.fn(),
  },
}));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: () => mock.chart }));
vi.mock('../src/ui/echarts-motion', () => ({
  useEchartsViewportEntry: () => true,
  echartsEntranceAnimation: () => ({ animation: false }),
}));

const props = {
  period: 'day' as const,
  startUnixSecs: 1_792_166_400,
  bucketSecs: 3600,
  nowUnixSecs: 1_792_166_400 + 6 * 3600,
  observedSinceUnixSecs: 1_792_166_400 + 2 * 3600,
  series: [{ key: 'youtube', name: 'YouTube', color: { token: '--observe-1' }, values: [0, 0, 1024, 0] }],
  focusKey: null,
};
beforeEach(() => {
  mock.pixelsPerBucket = 10;
  mock.chart.setOption.mockClear();
  mock.chart.convertToPixel.mockImplementation((_axis: unknown, value: number) => value * mock.pixelsPerBucket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        mock.resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('fits the observation label to actual plot width on initial layout and both resize directions', () => {
  render(<SiteUsageChart {...props} />);
  expect(mock.chart.setOption.mock.calls[0][0].series[0].markArea.label.show).toBe(false);
  expect(mock.chart.setOption).toHaveBeenCalledTimes(1);
  mock.pixelsPerBucket = 30;
  act(() => mock.resized());
  expect(mock.chart.setOption).toHaveBeenLastCalledWith({
    series: [{ id: 'youtube', markArea: { label: { show: true } } }],
  });
  act(() => mock.resized());
  expect(mock.chart.setOption).toHaveBeenCalledTimes(2);
  mock.pixelsPerBucket = 10;
  act(() => mock.resized());
  expect(mock.chart.setOption).toHaveBeenLastCalledWith({
    series: [{ id: 'youtube', markArea: { label: { show: false } } }],
  });
});

it('distinguishes unobserved buckets, observed zeroes and future buckets in the tooltip', () => {
  render(<SiteUsageChart {...props} />);
  const formatter = mock.chart.setOption.mock.calls[0][0].tooltip.formatter;
  expect(formatter([{ seriesIndex: 0, value: [0.5, 0] }])).toContain('未观测');
  expect(formatter([{ seriesIndex: 0, value: [3.5, 0] }])).toContain('无流量');
  expect(formatter([{ seriesIndex: 0, value: [7.5, null] }])).toBe('');
});

it('lists forwarding first in the tooltip and keeps the other categories in stack order', () => {
  render(
    <SiteUsageChart
      {...props}
      series={[
        { key: 'forwarding', name: '端口转发', color: { token: '--observe-2' }, values: [10, 0, 0, 0] },
        ...props.series,
        { key: 'github', name: 'GitHub', color: { token: '--observe-6' }, values: [100, 0, 0, 0] },
      ]}
    />,
  );
  const formatter = mock.chart.setOption.mock.calls[0][0].tooltip.formatter;
  const text: string = formatter([
    { seriesIndex: 0, value: [0.5, 10] },
    { seriesIndex: 1, value: [0.5, 1000] },
    { seriesIndex: 2, value: [0.5, 100] },
  ]);
  for (const name of ['端口转发', 'GitHub', 'YouTube']) expect(text).toContain(name);
  expect(text.indexOf('端口转发')).toBeLessThan(text.indexOf('GitHub'));
  expect(text.indexOf('GitHub')).toBeLessThan(text.indexOf('YouTube'));
});
