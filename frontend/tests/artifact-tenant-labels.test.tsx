import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchArtifactContent, fetchArtifactContentView } from '../src/api';
import { draft } from '../src/draft';
import { ArtifactRail } from '../src/forge/artifacts';
import { ArtifactPanel } from '../src/panes/artifact';
import { SessionProvider } from '../src/session';
import { artifactPanel } from '../src/ui/artifact-panel';

const fixture = vi.hoisted(() => {
  window.matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  return {
    artifacts: ['private-a:alice', 'private-b:alice'].map(target_id => ({
      target_kind: 'user',
      target_id,
      artifact_kind: 'uri',
      state: 'present',
      sha256: 'test',
      byte_len: 20,
    })),
  };
});
vi.mock('../src/api', async original => ({
  ...(await original<typeof import('../src/api')>()),
  fetchRevisions: vi.fn(async () => ({ current_revision: 7 })),
  fetchArtifactIndex: vi.fn(async () => fixture),
  fetchArtifactIndexView: vi.fn(async () => fixture),
  fetchArtifactContent: vi.fn(async () => ({ content: 'vless://example.test' })),
  fetchArtifactContentView: vi.fn(async () => ({ content: 'vless://example.test' })),
}));

beforeEach(() => {
  draft.init('artifact-label-test');
  draft.clear();
  artifactPanel.show({ targetKind: 'user', targetId: 'private-a:alice', artifactKind: 'uri' });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  artifactPanel.close();
  vi.clearAllMocks();
});

it.each(['rail', 'panel'])(
  'hides encoded ownership in the %s while keeping selection and requests distinct',
  async surface => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <SessionProvider
          value={{
            who: {
              operator_id: 'admin',
              role: 'system-admin',
              tenant_scope: null,
              token_prefix: null,
              masked_assets: false,
            },
            initial: { node_count: 0, chain_group_count: [] },
          }}
        >
          {surface === 'rail' ? (
            <ArtifactRail
              revision={7}
              prev={undefined}
              compareClean={false}
              apps={[]}
              onClose={() => {}}
              motionState="entered"
            />
          ) : (
            <ArtifactPanel />
          )}
        </SessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(view.container.textContent).toContain('vless://example.test'));
    const labels = [...view.container.querySelectorAll('.cfg-owner .who')].map(element => element.textContent);
    expect(labels).toEqual(['alice', 'alice']);
    expect(view.container.querySelector('.cfg-path')?.textContent).toContain('alice');
    expect(view.container.textContent).not.toMatch(/private-[ab]/);
    const load = surface === 'rail' ? fetchArtifactContentView : fetchArtifactContent;
    expect(vi.mocked(load).mock.calls.some(([, id]) => id === 'private-a:alice')).toBe(true);
    fireEvent.click(view.container.querySelectorAll<HTMLButtonElement>('.cfg-leaf')[1]);
    await waitFor(() => expect(vi.mocked(load).mock.calls.some(([, id]) => id === 'private-b:alice')).toBe(true));
    expect(view.container.textContent).not.toMatch(/private-[ab]/);
  },
);
