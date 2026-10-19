import { useState, type ReactNode } from 'react';
import type { RealityFallbackMode } from '../../src/api';
import { MTPROTO_DESCRIPTION } from '../../src/mtproto-capability';
import { REALITY_FINGERPRINT_OPTIONS } from '../../src/reality';
import { SegmentedControl } from '../../src/ui/bits';
import { Icon, type IconName } from '../../src/ui/icons';
import { actionsFor, derive, PortInput } from './chain-wizard-mockup-ui';

type Derived = ReturnType<typeof derive>;
type Actions = ReturnType<typeof actionsFor>;
type Protocol = 'vless' | 'encryption' | 'anytls' | 'hy2' | 'mtproto';

function ProtocolCard({
  id,
  name,
  icon,
  description,
  enabled,
  onToggle,
  transport,
  ports,
  errors,
  requirement,
  open,
  onExpand,
  children,
}: {
  id: Protocol;
  name: string;
  icon: IconName;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  transport: 'TCP' | 'UDP';
  ports: ReactNode;
  errors: (string | null | undefined | false)[];
  requirement?: string;
  open: boolean;
  onExpand: () => void;
  children?: ReactNode;
}) {
  const issues = [...new Set(errors.filter((error): error is string => Boolean(error)))];
  const descriptionId = `cr-${id}-description`;
  return (
    <li
      className={`protocol-choice cr-ingress-card${enabled ? ' on' : ''}${open && enabled ? ' expanded' : ''}`}
      data-protocol={id}
    >
      <input
        type="checkbox"
        id={`cr-${id}-enabled`}
        aria-label={name}
        aria-describedby={descriptionId}
        checked={enabled}
        onChange={event => onToggle(event.target.checked)}
      />
      <label className="protocol-choice-copy" htmlFor={`cr-${id}-enabled`}>
        <b>
          <Icon of={icon} size={14} className="protocol-choice-icon" />
          {name}
        </b>
        <span className="note cr-ingress-description" id={descriptionId}>
          {description}
        </span>
      </label>
      <div className="cr-ingress-controls">
        <div className="cr-ingress-ports" role="group" aria-label={`${name} 端口设置`}>
          <span className="cr-ingress-transport">{transport}</span>
          {ports}
        </div>
        {children && (
          <button
            type="button"
            className="cr-ingress-expand"
            disabled={!enabled}
            aria-label={`${name} 参数`}
            aria-expanded={open && enabled}
            aria-controls={`cr-${id}-params`}
            onClick={onExpand}
          >
            {open && enabled ? '收起参数' : '参数'}
          </button>
        )}
      </div>
      {requirement && <p className="cr-ingress-requirement">{requirement}</p>}
      {issues.length > 0 && (
        <ul className="cr-ingress-errors" role="alert">
          {issues.map(issue => (
            <li key={issue}>
              <Icon of="warn" size={12} />
              {issue}
            </li>
          ))}
        </ul>
      )}
      {children && open && enabled && (
        <div className="cr-ingress-params" id={`cr-${id}-params`} role="region" aria-label={`${name} 参数设置`}>
          {children}
        </div>
      )}
    </li>
  );
}

function CertificateSource({ d }: { d: Derived }) {
  return (
    <div className={`cr-ingress-certificate${d.needsCert ? ' missing' : ''}`}>
      <Icon of="certificate" size={12} />
      {!d.head ? (
        '选择入口后读取证书'
      ) : d.headCert ? (
        <>
          <span>{d.certLabel}</span>
          <code>{d.headCert}</code>
        </>
      ) : (
        <span>
          {d.head.name} 尚未分配{d.certLabel}
        </span>
      )}
    </div>
  );
}

export function RefinedIngressPanel({ d, act }: { d: Derived; act: Actions }) {
  const [open, setOpen] = useState<Protocol | null>(() => (d.draft.proto.vless && !d.realityReady ? 'vless' : null));
  const p = d.draft.proto;
  const expand = (id: Protocol) => () => setOpen(current => (current === id ? null : id));
  const certIssue = d.needsCert ? `入口尚未分配${d.certLabel}` : null;
  const span = Number(d.ports.hy2EndText) - Number(d.ports.hy2StartText) + 1;
  return (
    <div className="cr-ingress">
      <ul className="cr-ingress-list" aria-label="接入协议">
        <ProtocolCard
          id="vless"
          name="VLESS · REALITY"
          icon="xray"
          description="TCP / XHTTP 入站；使用 REALITY 保护传输。"
          enabled={p.vless}
          onToggle={vless => {
            act.setProto({ vless });
            if (vless && !d.realityReady) setOpen('vless');
          }}
          transport="TCP"
          open={open === 'vless'}
          onExpand={expand('vless')}
          errors={
            p.vless
              ? [
                  d.portIssue.vless,
                  ...(d.realityTarget === 'custom-site'
                    ? Object.values(d.customRealityIssues)
                    : [!d.realityReady && '补全 REALITY 伪装目标']),
                ]
              : []
          }
          ports={
            <PortInput
              label="VLESS 监听端口"
              value={d.ports.vlessPortText}
              auto={p.vlessPort === null}
              invalid={Boolean(d.portIssue.vless)}
              disabled={!p.vless}
              onChange={vlessPort => act.setProto({ vlessPort })}
            />
          }
        >
          <div className="cr-ingress-parameter">
            <span className="cr-ingress-label">伪装目标</span>
            <SegmentedControl
              ariaLabel="REALITY 伪装目标"
              value={d.realityTarget || 'node-certificate'}
              options={[
                { value: 'node-certificate', label: d.certLabel, disabled: !d.headCert },
                { value: 'global-site', label: '全局站点', disabled: !d.globalRealityReady },
                { value: 'custom-site', label: '自定义' },
              ]}
              onChange={reality => act.setProto({ reality: reality as RealityFallbackMode })}
            />
          </div>
          {d.realityTarget === 'custom-site' ? (
            <div className="cr-ingress-custom">
              <label>
                <span>目标地址</span>
                <input
                  className="f mono"
                  placeholder="example.com:443"
                  aria-label="自定义 REALITY 目标"
                  aria-invalid={Boolean(d.customRealityIssues.dest) || undefined}
                  value={p.realityDest}
                  onChange={event => act.setProto({ realityDest: event.target.value })}
                />
              </label>
              <label>
                <span>服务名称 · SNI</span>
                <input
                  className="f mono"
                  placeholder="example.com"
                  aria-label="自定义 REALITY SNI"
                  aria-invalid={Boolean(d.customRealityIssues.names) || undefined}
                  value={p.realityNames}
                  onChange={event => act.setProto({ realityNames: event.target.value })}
                />
              </label>
              <label>
                <span>客户端指纹</span>
                <select
                  className="f"
                  aria-label="自定义 REALITY 指纹"
                  value={p.realityFingerprint}
                  onChange={event => act.setProto({ realityFingerprint: event.target.value })}
                >
                  {REALITY_FINGERPRINT_OPTIONS.map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : d.realityTarget === 'global-site' ? (
            <dl className="cr-ingress-facts">
              <dt>目标地址</dt>
              <dd>{d.realitySite.dest}</dd>
              <dt>SNI</dt>
              <dd>{d.realitySite.server_names.join(' · ')}</dd>
            </dl>
          ) : (
            <CertificateSource d={d} />
          )}
        </ProtocolCard>
        <ProtocolCard
          id="encryption"
          name="VLESS · Encryption"
          icon="xray"
          description="TCP 入站；使用 VLESS 原生加密，不叠加 TLS 或 REALITY。"
          enabled={p.encryption}
          onToggle={encryption => act.setProto({ encryption })}
          transport="TCP"
          open={open === 'encryption'}
          onExpand={expand('encryption')}
          errors={p.encryption ? [d.portIssue.encryption] : []}
          ports={
            <PortInput
              label="VLESS Encryption 监听端口"
              value={d.ports.encryptionPortText}
              auto={p.encryptionPort === null}
              invalid={Boolean(d.portIssue.encryption)}
              disabled={!p.encryption}
              onChange={encryptionPort => act.setProto({ encryptionPort })}
            />
          }
        >
          <div className="cr-ingress-parameter">
            <span className="cr-ingress-label">握手档位</span>
            <SegmentedControl
              ariaLabel="握手档位"
              value={p.encryptionProfile}
              options={[
                { value: 'default', label: '默认 · random' },
                { value: 'native', label: 'native' },
              ]}
              onChange={encryptionProfile => act.setProto({ encryptionProfile })}
            />
          </div>
          <p className="cr-ingress-hint">
            会话票据有效期 <code>600s</code>
          </p>
        </ProtocolCard>
        <ProtocolCard
          id="anytls"
          name="AnyTLS"
          icon="bolt"
          description="TCP 入站；支持 TLS / REALITY、Padding 与连接复用。"
          enabled={p.anytls}
          onToggle={anytls => act.setProto({ anytls })}
          transport="TCP"
          open={open === 'anytls'}
          onExpand={expand('anytls')}
          errors={
            p.anytls
              ? [
                  d.portIssue.anytls,
                  certIssue,
                  p.padding === 'custom' && !p.paddingText.trim() && '填写自定义 Padding 规则',
                ]
              : []
          }
          ports={
            <PortInput
              label="AnyTLS 监听端口"
              value={d.ports.anytlsPortText}
              auto={p.anytlsPort === null}
              invalid={Boolean(d.portIssue.anytls)}
              disabled={!p.anytls}
              onChange={anytlsPort => act.setProto({ anytlsPort })}
            />
          }
        >
          <div className="cr-ingress-parameter">
            <span className="cr-ingress-label">Padding</span>
            <SegmentedControl
              ariaLabel="AnyTLS Padding"
              value={p.padding}
              options={[
                { value: 'default', label: '默认方案' },
                { value: 'custom', label: '自定义' },
              ]}
              onChange={padding => act.setProto({ padding })}
            />
          </div>
          {p.padding === 'custom' && (
            <label className="cr-ingress-textarea">
              <span>Padding 规则</span>
              <textarea
                className="f mono"
                aria-label="AnyTLS 自定义 Padding"
                placeholder="每行一条 Padding 规则"
                value={p.paddingText}
                onChange={event => act.setProto({ paddingText: event.target.value })}
              />
            </label>
          )}
          <CertificateSource d={d} />
        </ProtocolCard>
        <ProtocolCard
          id="hy2"
          name="Hysteria 2"
          icon="hysteria"
          description="QUIC / UDP 入站；面向高延迟、丢包链路，要求 UDP 可达。"
          enabled={p.hy2}
          onToggle={hy2 => act.setProto({ hy2 })}
          transport="UDP"
          open={open === 'hy2'}
          onExpand={expand('hy2')}
          errors={
            p.hy2
              ? [
                  d.portIssue.hy2,
                  certIssue,
                  Boolean(p.hy2Up.trim()) !== Boolean(p.hy2Down.trim()) && '上下行带宽需同时填写',
                ]
              : []
          }
          ports={
            <>
              <PortInput
                label="Hysteria 2 起始端口"
                value={d.ports.hy2StartText}
                auto={p.hy2Start === null}
                invalid={Boolean(d.portIssue.hy2)}
                disabled={!p.hy2}
                onChange={hy2Start => act.setProto({ hy2Start })}
              />
              <span className="cr-ingress-range-dash">–</span>
              <PortInput
                label="Hysteria 2 结束端口"
                value={d.ports.hy2EndText}
                auto={p.hy2End === null}
                invalid={Boolean(d.portIssue.hy2)}
                disabled={!p.hy2}
                onChange={hy2End => act.setProto({ hy2End })}
              />
            </>
          }
        >
          <div className="cr-ingress-parameter cr-ingress-range">
            <span className="cr-ingress-label">端口跳跃</span>
            <span className="cr-ingress-range-value">
              <code>
                {d.ports.hy2StartText}–{d.ports.hy2EndText}
              </code>
              {!d.portIssue.hy2 && <small>{span} 个端口</small>}
            </span>
            <button
              type="button"
              className="cr-text-btn"
              onClick={() => act.setProto({ hy2Start: null, hy2End: null })}
            >
              恢复自动范围
            </button>
          </div>
          <div className="cr-ingress-bandwidth">
            <label>
              <span>上行带宽</span>
              <input
                className="f mono"
                aria-label="Hysteria 2 上行带宽"
                placeholder="留空用 BBR"
                value={p.hy2Up}
                onChange={event => act.setProto({ hy2Up: event.target.value })}
              />
            </label>
            <label>
              <span>下行带宽</span>
              <input
                className="f mono"
                aria-label="Hysteria 2 下行带宽"
                placeholder="留空用 BBR"
                value={p.hy2Down}
                onChange={event => act.setProto({ hy2Down: event.target.value })}
              />
            </label>
          </div>
          <p className="cr-ingress-hint">
            留空使用 BBR；固定带宽需成对填写，如 <code>200 mbps</code>。
          </p>
          <CertificateSource d={d} />
        </ProtocolCard>
        <ProtocolCard
          id="mtproto"
          name="MTProxy"
          icon="telegram"
          description={MTPROTO_DESCRIPTION}
          enabled={p.mtproto}
          onToggle={mtproto => act.setProto({ mtproto })}
          transport="TCP"
          open={false}
          onExpand={() => undefined}
          requirement="入口需有直接配置在网卡上的公网 IPv4。"
          errors={p.mtproto ? [d.portIssue.mtproto, d.mtprotoUnavailable] : []}
          ports={
            <PortInput
              label="MTProxy 监听端口"
              value={d.ports.mtprotoPortText}
              auto={p.mtprotoPort === null}
              invalid={Boolean(d.portIssue.mtproto)}
              disabled={!p.mtproto}
              onChange={mtprotoPort => act.setProto({ mtprotoPort })}
            />
          }
        />
      </ul>
      {d.protocolCount === 0 && (
        <p className="cr-ingress-empty" role="alert">
          <Icon of="warn" size={12} />
          至少开启一个接入协议。
        </p>
      )}
      <p className="cr-ingress-defaults">其余参数使用默认值，建成后可在线路详情调整。</p>
    </div>
  );
}
