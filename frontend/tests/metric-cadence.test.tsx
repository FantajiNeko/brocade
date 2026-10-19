import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetricQuery, useMetricValue } from '../src/ui/metric-cadence';
import { useNow } from '../src/ui/clock';

beforeEach(() => vi.useFakeTimers({ now: 10_250 }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
function Reading({ value, id = 'one', fact = '' }: { value: number | null; id?: string; fact?: string }) {
  const displayed = useMetricValue(value, id, fact);
  const now = useNow();
  return (
    <output aria-label={id}>
      {displayed ?? 'gap'}@{now}
    </output>
  );
}

describe('shared metric cadence', () => {
  it('coalesces bursts from staggered mounts on one second boundary and ignores unrelated renders', async () => {
    const first = render(<Reading value={1} />);
    await advance(200);
    const second = render(<Reading id="two" value={10} />);
    first.rerender(<Reading value={2} />);
    await advance(200);
    first.rerender(<Reading value={3} />);
    second.rerender(<Reading id="two" value={20} />);
    expect(screen.getByLabelText('one').textContent).toBe('1@10250');
    expect(screen.getByLabelText('two').textContent).toBe('10@10250');
    await advance(350);
    expect(screen.getByLabelText('one').textContent).toBe('3@11000');
    expect(screen.getByLabelText('two').textContent).toBe('20@11000');
    first.unmount();
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows facts, missing data and identity changes immediately without resurrecting queued readings', async () => {
    const view = render(<Reading value={1} />);
    view.rerender(<Reading value={2} />);
    view.rerender(<Reading value={null} fact="offline" />);
    expect(screen.getByLabelText('one').textContent).toContain('gap');
    await advance(750);
    expect(screen.getByLabelText('one').textContent).toContain('gap');
    view.rerender(<Reading value={7} id="other" />);
    expect(screen.getByLabelText('other').textContent).toContain('7@');
    view.rerender(<Reading value={8} id="other" fact="failed" />);
    expect(screen.getByLabelText('other').textContent).toContain('8@');
  });

  it('publishes only the latest reading after a stalled timer and refreshes the clock after idle', async () => {
    const view = render(<Reading value={1} />);
    view.rerender(<Reading value={9} />);
    vi.setSystemTime(90_250);
    await advance(750);
    expect(screen.getByLabelText('one').textContent).toBe('9@91000');
    view.unmount();
    vi.setSystemTime(200_250);
    render(<Reading value={4} />);
    expect(screen.getByLabelText('one').textContent).toBe('4@200250');
  });

  it('immediately replaces a range placeholder when the first real response arrives', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['metric', 'one'], 1);
    function QueryReading({ id }: { id: string }) {
      const query = useMetricQuery({
        queryKey: ['metric', id],
        queryFn: () => new Promise<number>(() => {}),
        placeholderData: previous => previous,
      });
      return (
        <output aria-label="query">
          {query.data}:{String(query.isPlaceholderData)}
        </output>
      );
    }
    const panel = (id: string) => (
      <QueryClientProvider client={client}>
        <QueryReading id={id} />
      </QueryClientProvider>
    );
    const view = render(panel('one'));
    view.rerender(panel('two'));
    expect(screen.getByLabelText('query').textContent).toBe('1:true');
    act(() => {
      client.setQueryData(['metric', 'two'], 7);
    });
    await advance(5);
    expect(screen.getByLabelText('query').textContent).toBe('7:false');
    view.unmount();
    client.clear();
  });

  it('keeps query data and its timestamp together, but surfaces errors immediately', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['metric', 'one'], 1);
    function QueryReading({ id }: { id: string }) {
      const query = useMetricQuery({ queryKey: ['metric', id], queryFn: async () => 3 });
      return (
        <output aria-label="query">
          {query.data}@{query.dataUpdatedAt}:{query.error?.message}
        </output>
      );
    }
    const view = render(
      <QueryClientProvider client={client}>
        <QueryReading id="one" />
      </QueryClientProvider>,
    );
    await advance(200);
    act(() => {
      client.setQueryData(['metric', 'one'], 2);
    });
    await advance(5);
    expect(screen.getByLabelText('query').textContent).toBe('1@10250:');
    act(() => {
      client
        .getQueryCache()
        .find({ queryKey: ['metric', 'one'] })!
        .setState({ error: new Error('offline'), status: 'error' });
    });
    await advance(5);
    expect(screen.getByLabelText('query').textContent).toBe('1@10250:offline');
    await advance(540);
    expect(screen.getByLabelText('query').textContent).toBe('2@10450:offline');
    client.setQueryData(['metric', 'two'], 7);
    view.rerender(
      <QueryClientProvider client={client}>
        <QueryReading id="two" />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('query').textContent).toBe('7@11000:');
    view.unmount();
    client.clear();
  });
});
