import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactIndexEntry, DeploymentPlan, DeploymentTargetDetail } from '../src/api';
import type { Win } from '../src/wm/store';

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { ArtifactChanges, DeployPane, PlanTargets } = await import('../src/panes/deploy');
const { SessionProvider } = await import('../src/session');

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const rules = (generation: string, outbounds: string[]) =>
  `${JSON.stringify(
    {
      routing: {
        rules: outbounds.map((outboundTag, index) => ({
          ruleTag: `r:${generation}:${String(index).padStart(3, '0')}`,
          outboundTag,
        })),
      },
    },
    null,
    2,
  )}\n`;

const CONTENT: Record<string, { content: string; redacted: boolean }> = {
  'n1/xray?revision=21': { content: rules('bbbbbbbb', ['direct', 'proxy-b']), redacted: false },
  'n1/xray?revision=20': { content: rules('aaaaaaaa', ['direct', 'proxy-a']), redacted: false },
  'n2/wireguard?revision=21': { content: '[Interface]\nPrivateKey = <redacted>\nListenPort = 51821\n', redacted: true },
  'n2/wireguard?revision=20': { content: '[Interface]\nPrivateKey = <redacted>\nListenPort = 51820\n', redacted: true },
};

const artifactTarget = (node: string, kind: string, before: unknown, after: unknown): DeploymentTargetDetail => ({
  node_id: node,
  status: 'pending',
  wave: 1,
  disruptive: true,
  error: null,
  observed_before: { [kind]: before },
  desired_structure: { [kind]: after },
  observed_after: null,
  verdict: null,
  dispatched_at: null,
});
const previewTargets = () => [
  artifactTarget(
    'n1',
    'xray',
    { state: 'present', sha256: 'actual-old', content: CONTENT['n1/xray?revision=20'].content },
    { state: 'present', sha256: 'planned-new', content: CONTENT['n1/xray?revision=21'].content },
  ),
  artifactTarget(
    'n2',
    'wireguard',
    { state: 'present', sha256: 'wg-old', content: CONTENT['n2/wireguard?revision=20'].content },
    { state: 'present', sha256: 'wg-new', content: CONTENT['n2/wireguard?revision=21'].content },
  ),
];
const session = {
  initial: { node_count: 2, chain_group_count: [] },
  who: {
    operator_id: 'reviewer',
    role: 'system-admin' as const,
    tenant_scope: null,
    token_prefix: null,
    masked_assets: false,
  },
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const content = path.match(/^\/artifacts\/content\/node\/(.+)$/);
    if (content && CONTENT[content[1]]) return json(CONTENT[content[1]]);
    throw new Error(`未预期的请求：${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const contentRequests = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/artifacts/content'));

const entry = (target_id: string, artifact_kind: string, sha256: string): ArtifactIndexEntry => ({
  target_kind: 'node',
  target_id,
  artifact_kind,
  state: 'present',
  sha256,
  byte_len: 64,
});

function queryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['nodes'], {
    nodes: [
      { node_id: 'n1', name: '台北一号' },
      { node_id: 'n2', name: '东京二号' },
    ],
  });
  client.setQueryData(['plan-artifacts', 21, true], { revision: 21, targets: previewTargets() });
  client.setQueryData(['artifact-index', 21], {
    revision: 21,
    artifacts: [entry('n1', 'xray', 'x21'), entry('n2', 'wireguard', 'w21')],
  });
  client.setQueryData(['artifact-index', 20], {
    revision: 20,
    artifacts: [entry('n1', 'xray', 'x20'), entry('n2', 'wireguard', 'w20')],
  });
  return client;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('创建变更单的产物差异', () => {
  it('一台一行；使用实际已应用的内容计算增删，不重新读取历史修订文件', async () => {
    stubFetch();
    const view = render(
      <QueryClientProvider client={queryClient()}>
        <SessionProvider value={session}>
          <ArtifactChanges revision={21} base={20} targets={[{ node_id: 'n1' }, { node_id: 'n2' }]} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    const xray = await view.findByRole('button', { name: /xray\.json/ });
    const wireguard = view.getByRole('button', { name: /wg0\.conf/ });
    await waitFor(() => expect(xray.textContent).toBe('xray.json+1−1'));
    await waitFor(() => expect(wireguard.textContent).toBe('wg0.conf+1−1'));
    expect(xray.getAttribute('aria-pressed')).toBe('true');
    expect(wireguard.getAttribute('aria-pressed')).toBe('false');
    // 规则表重算的 ruleTag 重新编号与变更单详情一样默认折叠
    expect(view.getByText(/ruleTag 重新编号 2 处，已折叠/)).toBeTruthy();
    expect(view.queryByText('私钥原文仅 system-admin 可见。')).toBeNull();

    fireEvent.click(wireguard);
    const second = wireguard.closest('.cga-node')!;
    expect(second.querySelector('tr.add')?.textContent).toContain('ListenPort = 51821');
    expect(second.querySelector('tr.del')?.textContent).toContain('ListenPort = 51820');
  });

  it('产物差异默认完整展示，面板没有折叠入口，也不额外请求历史机器原文', async () => {
    const fetchMock = stubFetch();
    const client = queryClient();
    const plan: DeploymentPlan = {
      revision: 21,
      base_revision_id: 20,
      warnings: [],
      summary: {
        total_targets: 2,
        changed_targets: 2,
        skipped_targets: 0,
        deferred_targets: 0,
        disruptive_targets: 1,
        max_wave: 1,
      },
      targets: [
        { node_id: 'n1', status: 'pending', wave: 1, disruptive: true, actions: ['apply-xray'] },
        { node_id: 'n2', status: 'pending', wave: 0, disruptive: false, actions: ['apply-wire-guard'] },
      ],
    };
    client.setQueryData(['plan', 21], plan);
    client.setQueryData(['deployment-settings'], { unattended: true });
    client.setQueryData(['revisions'], {
      current_revision: 21,
      revisions: [
        {
          id: 21,
          created_at: '2026-10-10T02:00:00Z',
          author: 'release-reviewer',
          note: '调整出口',
          status: 'committed',
          current: true,
          has_snapshot: true,
        },
      ],
    });
    client.setQueryData(['deployments'], { deployments: [{ id: 4, revision_id: 20, status: 'succeeded' }] });
    const win: Win = {
      id: 92,
      key: 'tab:deploy',
      title: '发布',
      x: 0,
      y: 0,
      w: 980,
      h: 720,
      z: 1,
      min: false,
      home: 'desk',
      data: { drill: { p: 'plan', revision: 21, key: 'review-key' } },
    };
    const view = render(
      <QueryClientProvider client={client}>
        <SessionProvider
          value={{
            initial: { node_count: 2, chain_group_count: [] },
            who: {
              operator_id: 'release-reviewer',
              role: 'system-admin',
              tenant_scope: null,
              token_prefix: null,
              masked_assets: false,
            },
          }}
        >
          <DeployPane win={win} />
        </SessionProvider>
      </QueryClientProvider>,
    );

    const panel = view.getByText('产物差异').closest('section')!;
    expect(panel).toBeTruthy();
    expect(view.getByText('产物差异').closest('details')).toBeNull();
    expect(await view.findByRole('button', { name: /xray\.json/ })).toBeTruthy();
    expect(contentRequests(fetchMock)).toHaveLength(0);
  });

  it('两个修订重编结果相同，仍显示与实际旧产物不同的保活配置', async () => {
    stubFetch();
    const client = queryClient();
    client.setQueryData(['artifact-index', 20], client.getQueryData(['artifact-index', 21]));
    const before = '{"inbounds":[]}\n';
    const after = '{"inbounds":[],"tcpKeepAliveIdle":300}\n';
    client.setQueryData(['plan-artifacts', 21, true], {
      revision: 21,
      targets: [
        artifactTarget(
          'n1',
          'xray',
          { state: 'present', sha256: 'old', content: before },
          { state: 'present', sha256: 'new', content: after },
        ),
      ],
    });
    const view = render(
      <QueryClientProvider client={client}>
        <SessionProvider value={session}>
          <ArtifactChanges revision={21} base={20} targets={[{ node_id: 'n1' }]} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    expect(await view.findByRole('button', { name: /xray\.json/ })).toBeTruthy();
    expect(view.container.querySelector('tr.add')?.textContent).toContain('tcpKeepAliveIdle');
    expect(view.queryByText(/产物没有变化/)).toBeNull();
  });

  it('新机器按空集比较，整份文件逐行标为新增而非不可比较', async () => {
    stubFetch();
    const client = queryClient();
    client.setQueryData(['plan-artifacts', 21, true], {
      revision: 21,
      targets: [
        artifactTarget(
          'n1',
          'xray',
          { state: 'absent' },
          { state: 'present', sha256: 'new', content: '{\n  "newMachine": true\n}\n' },
        ),
      ],
    });
    const view = render(
      <QueryClientProvider client={client}>
        <SessionProvider value={session}>
          <ArtifactChanges revision={21} base={null} targets={[{ node_id: 'n1' }]} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    const file = await view.findByRole('button', { name: /xray\.json/ });
    expect(file.textContent).toContain('新增');
    expect(view.container.querySelectorAll('tr.add')).toHaveLength(3);
    expect(view.queryByText('不可比较')).toBeNull();
  });

  it('全量阶段跨波次共显示四台，查看更多可展开且重新渲染不丢状态', () => {
    const client = queryClient();
    const targets = Array.from({ length: 8 }, (_, index) => ({
      node_id: `rollout-${index}`,
      status: 'pending' as const,
      wave: index === 0 ? 1 : index < 4 ? 2 : 3,
      disruptive: true,
      actions: ['apply-xray' as const],
    }));
    const content = () => (
      <QueryClientProvider client={client}>
        <PlanTargets targets={targets} unattended />
      </QueryClientProvider>
    );
    const view = render(content());
    const full = [...view.container.querySelectorAll('.cgr-group')].find(group =>
      group.textContent?.includes('查看更多'),
    )!;
    expect(full.querySelectorAll('.cgr-row')).toHaveLength(4);
    fireEvent.click(view.getByRole('button', { name: '查看更多（剩余 3 台）' }));
    expect(full.querySelectorAll('.cgr-row')).toHaveLength(7);
    view.rerender(content());
    expect(full.querySelectorAll('.cgr-row')).toHaveLength(7);
    fireEvent.click(view.getByRole('button', { name: '收起机器列表' }));
    expect(full.querySelectorAll('.cgr-row')).toHaveLength(4);
  });
});
