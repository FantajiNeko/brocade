import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchOtherDomainPolicy,
  saveOtherDomainPolicy,
  fetchSniffingFailedPolicy,
  saveSniffingFailedPolicy,
  type OtherDomainPolicy,
} from './api';
import { ErrorBox, SegmentedControl } from './ui/bits';

export function SniffingFailedSettingsSection({ editable }: { editable: boolean }) {
  return <OtherDomainSettingsSection editable={editable} failedTargets />;
}

export function OtherDomainSettingsSection({
  editable,
  failedTargets = false,
}: {
  editable: boolean;
  failedTargets?: boolean;
}) {
  const client = useQueryClient();
  const noun = failedTargets ? '目标' : '域名';
  const queryKey = [failedTargets ? 'sniffing-failed-policy' : 'other-domain-policy'];
  const title = failedTargets ? '嗅探失败目标' : '未分类域名';
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!failedTargets) return fetchOtherDomainPolicy();
      const { max_targets_per_user, ...policy } = await fetchSniffingFailedPolicy();
      return { ...policy, max_domains_per_user: max_targets_per_user };
    },
  });
  const [draft, setDraft] = useState<OtherDomainPolicy>();
  const value = draft ?? query.data;
  const save = useMutation({
    mutationFn: async (value: OtherDomainPolicy) => {
      if (!failedTargets) return saveOtherDomainPolicy(value);
      const { max_domains_per_user, ...policy } = value;
      const { max_targets_per_user, ...saved } = await saveSniffingFailedPolicy({
        ...policy,
        max_targets_per_user: max_domains_per_user,
      });
      return { ...saved, max_domains_per_user: max_targets_per_user };
    },
    onSuccess: async policy => {
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, policy);
      setDraft(undefined);
      await client.invalidateQueries({
        queryKey: [failedTargets ? 'user-sniffing-failed-targets' : 'user-other-domains'],
      });
    },
  });
  const valid =
    value &&
    Number.isInteger(value.top_n) &&
    value.top_n >= 1 &&
    value.top_n <= 512 &&
    Number.isInteger(value.max_domains_per_user) &&
    value.max_domains_per_user >= value.top_n &&
    value.max_domains_per_user <= 4096 &&
    Number.isInteger(value.node_capacity) &&
    value.node_capacity >= value.max_domains_per_user &&
    value.node_capacity <= 4096 &&
    Number.isInteger(value.report_interval_secs) &&
    value.report_interval_secs >= 15 &&
    value.report_interval_secs <= 300;
  const fields = [
    ['top_n', '每用户 Top N', 1, 512],
    ['max_domains_per_user', `每用户${noun}容量`, 1, 4096],
    ['node_capacity', '节点总容量', 1, 4096],
    ['report_interval_secs', '上报间隔（秒）', 15, 300],
  ] as const;
  return (
    <section
      className="site-statistics-section"
      id={failedTargets ? 'set-sniffing-failed' : 'set-other-domain'}
      aria-label={title}
    >
      <div className="site-statistics-heading">
        <h5>{title}</h5>
        <SegmentedControl
          ariaLabel={`${title}采集`}
          value={value?.enabled ?? false}
          options={[
            { value: false, label: '关闭' },
            { value: true, label: '开启' },
          ]}
          disabled={!editable || !value || query.isError || save.isPending}
          onChange={enabled => value && setDraft({ ...value, enabled })}
        />
      </div>
      <p className="settings-block-note">
        {failedTargets ? '记录嗅探未取得域名的目标 IP、端口及传输协议。' : '记录未命中站点分类的域名及流量。'}
      </p>
      {query.error && <ErrorBox error={query.error} />}
      {save.error && <ErrorBox error={save.error} />}
      {query.isPending && (
        <p className="settings-block-note" role="status">
          读取中…
        </p>
      )}
      {value && (
        <form
          onSubmit={event => {
            event.preventDefault();
            if (editable && !query.isError && !save.isPending && valid && draft) save.mutate(value);
          }}
        >
          <fieldset
            className="other-domain-settings"
            aria-label={`${title}采集参数`}
            disabled={!editable || query.isError || save.isPending}
          >
            {fields.map(([key, label, min, max]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  className="f mono"
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  required
                  value={Number.isNaN(value[key]) ? '' : value[key]}
                  onChange={event => setDraft({ ...value, [key]: event.target.valueAsNumber })}
                />
              </label>
            ))}
          </fieldset>
          <p className="settings-block-note">Top N ≤ 用户容量 ≤ 节点容量；容量按节点独立计算。</p>
          {!valid && (
            <p className="settings-block-note settings-validation-error" role="alert">
              Top N 范围为 1–512，容量不超过 4096，上报间隔为 15–300 秒。
            </p>
          )}
          {editable && (
            <div className="site-statistics-actions">
              <button
                type="submit"
                className="btn"
                aria-label={`保存${title}设置`}
                disabled={!valid || !draft || save.isPending || query.isError}
              >
                {save.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          )}
          {save.isSuccess && !draft && (
            <p className="settings-block-note" role="status">
              已保存，待节点同步。
            </p>
          )}
        </form>
      )}
    </section>
  );
}
