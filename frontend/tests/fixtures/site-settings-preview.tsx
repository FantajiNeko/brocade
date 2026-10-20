// Local visual fixture. All policy reads and writes stay in memory.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SiteUsageSettingsCard } from '../../src/site-usage-settings';
import { HostNetworkTuningSection } from '../../src/panes/settings';
import { useNarrow } from '../../src/ui/viewport';
import '../../src/styles.css';

const options = new URLSearchParams(location.search);
const budget = { enabled: true, top_n: 128, node_capacity: 4096, report_interval_secs: 30 };
const policies: Record<string, object> = {
  '/site-usage/settings': { enabled: true },
  '/other-domain/settings': { ...budget, max_domains_per_user: 1024 },
  '/sniffing-failed/settings': { ...budget, max_targets_per_user: 1024 },
  '/host-network-tuning': { gro_flush_timeout_ns: 20_000, napi_defer_hard_irqs: 2 },
};
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (!(path in policies)) return Response.json({ error: '示例不提供此接口' }, { status: 404 });
  if (options.get('failure') === 'read' && path === '/other-domain/settings') {
    return Response.json({ error: '未分类域名策略读取失败' }, { status: 503 });
  }
  if (init?.method === 'PUT') {
    if (options.get('failure') === 'save') return Response.json({ error: '策略保存失败' }, { status: 503 });
    policies[path] = JSON.parse(String(init.body));
  }
  return Response.json(policies[path]);
};
function Preview() {
  const narrow = useNarrow();
  const editable = options.get('role') !== 'readonly';
  return (
    <div className={`forge${narrow ? ' narrow' : ''}`}>
      <div className="fg-left">
        <main className="fg-desk">
          <div className="fg-view">
            <div className="cardpage" style={{ maxWidth: 640 }}>
              <p className="note">本地示例 · 不读取或修改线上设置</p>
              <div className="duo settings-layout">
                <div className="col">
                  <fieldset className="settings-column-fields" disabled={!editable}>
                    <SiteUsageSettingsCard editable={editable} />
                    <HostNetworkTuningSection
                      editable={editable}
                      data={{ gro_flush_timeout_ns: 20_000, napi_defer_hard_irqs: 2 }}
                    />
                  </fieldset>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Preview />
  </QueryClientProvider>,
);
