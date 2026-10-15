import { describe, expect, it } from 'vitest';
import { ingressPortMigrationConfirmation, planIngressPortMigration } from '../src/panes/ingress-port-migration';

const taken = (node: string, entries: [number, string][]) => new Map([[node, new Map(entries)]]);

const base = {
  port: 443,
  wires: {
    vless: { kind: 'vless-reality' as const },
    vless_encryption: { port: 445 },
    anytls: { port: 446, security: 'tls' as const, masquerade: { kind: 'not-found' as const } },
    mtproto: { port: 447 },
    hysteria2: {
      port: 50002,
      hop: { start: 50000, end: 50009 },
      bandwidth: {},
      congestion: 'bbr' as const,
      masquerade: { kind: 'not-found' as const },
    },
  },
};

describe('入站机器迁移端口规划', () => {
  it('目标机器没有冲突时保留全部端口', () => {
    const plan = planIngressPortMigration(base, 'target', new Map(), new Map());
    expect(plan.port).toBe(443);
    expect(plan.wires.vless_encryption?.port).toBe(445);
    expect(plan.wires.anytls?.port).toBe(446);
    expect(plan.wires.mtproto?.port).toBe(447);
    expect(plan.wires.hysteria2?.hop).toEqual({ start: 50000, end: 50009 });
    expect(plan.wires.hysteria2?.port).toBe(50002);
    expect(plan.rotations).toEqual([]);
  });

  it('冲突时向上轮转，并保留其他协议原本空闲的端口', () => {
    const tcp = taken('target', [
      [443, '另一条链'],
      [444, '系统服务'],
    ]);
    const udp = taken('target', [
      [50005, 'WireGuard'],
      [50015, '另一段端口跳跃'],
    ]);
    const plan = planIngressPortMigration(base, 'target', tcp, udp);

    // 445–447 由本接入面的其他协议原样保留，VLESS 越过它们后使用 448，避免连锁改端口。
    expect(plan.port).toBe(448);
    expect(plan.wires.vless_encryption?.port).toBe(445);
    expect(plan.wires.anytls?.port).toBe(446);
    expect(plan.wires.mtproto?.port).toBe(447);
    // 整段从冲突端口之后重新找连续区间，监听端口仍保持在区间内偏移 2 的位置。
    expect(plan.wires.hysteria2?.hop).toEqual({ start: 50016, end: 50025 });
    expect(plan.wires.hysteria2?.port).toBe(50018);
    expect(plan.rotations.map(rotation => [rotation.label, rotation.from, rotation.to])).toEqual([
      ['VLESS · TLS / REALITY', '443', '448'],
      ['Hysteria 2', '50000–50009', '50016–50025'],
    ]);

    const prompt = ingressPortMigrationConfirmation('目标机', plan.rotations);
    expect(prompt).toMatch(/目标机器「目标机」存在端口冲突/);
    expect(prompt).toMatch(/VLESS · TLS \/ REALITY：TCP 443 冲突（target 的 443 已经被另一条链占着），改用 448/);
    expect(prompt).toMatch(/Hysteria 2：UDP 50000–50009 冲突（target 的 50005 已经被WireGuard占着）/);
    expect(prompt).toMatch(/确认后将按以上空闲端口迁移/);
  });

  it('未启用 VLESS 时只轮转 Hysteria 2 的独立 UDP 端口', () => {
    const ingress = {
      port: 13443,
      wires: {
        hysteria2: {
          port: 32000,
          hop: null,
          bandwidth: {},
          congestion: 'bbr' as const,
          masquerade: { kind: 'not-found' as const },
        },
      },
    };
    const plan = planIngressPortMigration(
      ingress,
      'target',
      taken('target', [[13443, 'TCP 服务']]),
      taken('target', [[32000, 'UDP 服务']]),
    );
    expect(plan.port).toBe(13443);
    expect(plan.wires.hysteria2?.port).toBe(32001);
    expect(plan.rotations.map(rotation => rotation.transport)).toEqual(['UDP']);
  });
});
