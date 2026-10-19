// Visual acceptance fixture: production dialog with synthetic plan and share links only.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GrantProbeJob, GrantProbePlan, GrantProbePlanItem } from '../../src/api';
import { SubscriptionViewer } from '../../src/panes/subscription';
import { GeneratedUserAvatar } from '../../src/ui/user-avatar';
import { theme } from '../../src/forge/theme';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
// regular：尚未拨测；running：一轮进行中；unavailable：本机没有拨测组件；empty：没有节点。
const scene = params.get('scene') ?? 'regular';
if (theme.snapshot() !== (params.get('theme') === 'dark' ? 'dark' : 'light')) theme.toggle();
document.documentElement.dataset.palette = 'dailan';
const regions = ['🇭🇰香港', '🇲🇴澳门', '🇯🇵日本', '🇹🇼台湾', '🇺🇸美国', '🇫🇷法国'];
const protocols: GrantProbePlanItem['protocol'][] = ['vless', 'vless-encryption', 'anytls', 'hysteria2'];
const items: GrantProbePlanItem[] = [];
const uris: string[] = [];
for (let i = 0; i < 6; i++) {
  const chain = `${regions[i]} ${String(i + 1).padStart(2, '0')} @ ${i < 2 ? 'CN2' : 'Demo'}`;
  for (const protocol of protocols) {
    if (protocol === 'vless-encryption' && i % 3 !== 2) continue;
    for (const family of ['ipv4', 'ipv6'] as const) {
      if (i % 5 === 4 && family === 'ipv6') continue;
      const suffix = protocol === 'vless-encryption' ? ' | VLESS Encryption' : protocol === 'anytls' ? ' | AnyTLS' : '';
      const name = `${chain}${protocol === 'hysteria2' ? ' | QUIC' : suffix}${family === 'ipv6' ? ' | v6' : ''}`;
      const host = family === 'ipv6' ? `[2001:db8:abcd:1234:5678::${i + 1}]` : `192.0.2.${i + 1}`;
      items.push({
        id: `${i}/${protocol}/${family}`,
        name,
        protocol,
        family,
        app_id: `app${i % 2}`,
        app_name: i % 2 ? 'APAC Standard' : 'APAC Premium',
        chain_id: `chain${i}`,
        ingress_id: `ingress${i}`,
      });
      const port = protocol === 'hysteria2' ? '18000-18099' : protocol === 'anytls' ? '16000' : '8448';
      const query =
        protocol === 'vless-encryption'
          ? 'encryption=mlkem768x25519plus.native.0rtt.K&type=tcp&security=none'
          : protocol === 'vless'
            ? 'encryption=none&type=tcp&security=reality&sni=node.example'
            : `sni=node.example${i === 2 && protocol === 'hysteria2' ? '&insecure=1' : ''}`;
      const scheme = protocol === 'hysteria2' ? 'hysteria2' : protocol === 'anytls' ? 'anytls' : 'vless';
      uris.push(`${scheme}://preview@${host}:${port}?${query}#${encodeURIComponent(name)}`);
    }
  }
  // 第一条链另有 MTProxy：不是拨测项，地址前留空位。
  if (i === 0) {
    uris.push(`# @brocade-name=${encodeURIComponent(`${chain} | MTProxy`)}`);
    uris.push('tg://proxy?server=192.0.2.1&port=28800&secret=dd00112233445566778899aabbccddeeff');
  }
}
const plan: GrantProbePlan = { serving_revision: 1832, serving_generation: 1, items: scene === 'empty' ? [] : items };
const job = (status: GrantProbeJob['status'], ids: string[]): GrantProbeJob => {
  const selected = plan.items.filter(item => !ids.length || ids.includes(item.id));
  return {
    id: 'preview',
    tenant_id: 'preview',
    user_id: 'demo',
    serving_revision: plan.serving_revision,
    serving_generation: plan.serving_generation,
    status,
    message: null,
    created_at_unix_secs: 1,
    finished_at_unix_secs: status === 'running' ? null : 2,
    items: selected.map((item, index) => ({
      ...item,
      status:
        status === 'running'
          ? index < 6
            ? index === 3
              ? 'failed'
              : 'passed'
            : index < 9
              ? 'running'
              : 'waiting'
          : index % 7 === 3
            ? 'failed'
            : 'passed',
      ttfb_ms: null,
      detail: index % 7 === 3 ? '握手超时 5 秒' : null,
    })),
  };
};
let lastJob: GrantProbeJob | null = null;
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (path === '/revisions?limit=50') return Response.json({ current_revision: 1832, revisions: [] });
  if (path === '/grant-probes/capability')
    return Response.json(
      scene === 'unavailable'
        ? { available: false, version: null, reason: 'Console 未安装或无法执行拨测 Xray', concurrency: 30 }
        : { available: true, version: 'preview', reason: null, concurrency: 30 },
    );
  if (path.includes('/artifacts/content/'))
    return Response.json({
      revision: 1832,
      content: scene === 'empty' ? '# （这个用户没有能用纯 URI 表达的接入面）\n' : `${uris.join('\n')}\n`,
      state: 'present',
    });
  if (path === '/users/preview/demo/clash-subscription') {
    const url = 'https://sub.example/sub/v1/00000000-0000-4000-8000-000000000000/clash.yaml';
    const urls = { both: url, v4: `${url}?family=v4`, v6: `${url}?family=v6` };
    return Response.json({
      url,
      urls,
      template: 'SubBoost 标准版',
      haitun: { template: 'koipy 测速', status: 'active', urls, created_at: null, revoked_at: null },
      remaining_bytes: 490_000_000_000,
      reset_at: '2026-11-01T00:00:00+08:00',
      usage_has_gap: false,
    });
  }
  if (path === '/grant-probes/preview') return Response.json(lastJob);
  if (path === '/users/preview/demo/grant-probes') {
    if (init?.method === 'POST') {
      const ids = (JSON.parse(String(init.body)) as { item_ids: string[] }).item_ids;
      lastJob = job(scene === 'running' ? 'running' : 'completed', ids);
      return Response.json({ job: lastJob, reused: false });
    }
    return Response.json(plan);
  }
  throw new Error(`Unexpected fixture request: ${path}`);
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SubscriptionViewer
      tenant="preview"
      user="demo"
      kind="uri"
      identity={<GeneratedUserAvatar id="demo" variant="mini" />}
      onClose={() => undefined}
    />
  </QueryClientProvider>,
);
