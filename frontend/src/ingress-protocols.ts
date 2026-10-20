/** Shared selection guidance for the creation wizard and ingress details. */
export const INGRESS_PROTOCOL_DESCRIPTIONS = {
  vless: '支持 TCP / XHTTP，以 TLS 加密或 REALITY 伪装保护连接，适用于通用代理接入。',
  encryption: 'VLESS 原生加密，适用于无证书加密接入。',
  anytls: '通过分包填充缓解嵌套 TLS 特征，以连接复用降低握手开销，适用于短连接密集场景。',
  hy2: '基于 QUIC / UDP，针对高延迟与丢包链路优化吞吐，适用于弱网场景。',
  mtproto: 'Telegram 原生支持的专用代理。',
} as const;
