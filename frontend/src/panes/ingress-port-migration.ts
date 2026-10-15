import type { Wires } from '../api';
import { freePortAcross, freeSpanAcross, spanClash, type PortOwners } from './ports';

export interface IngressPortRotation {
  label: string;
  transport: 'TCP' | 'UDP';
  from: string;
  to: string;
  conflict: string;
}

export interface IngressPortMigrationPlan {
  port: number;
  wires: Wires;
  rotations: IngressPortRotation[];
}

interface IngressPortConfig {
  port: number;
  wires: Wires;
}

/**
 * 为接入面迁移计算目标机器上的端口布局。
 *
 * 只移动发生冲突的端口；每次分配后立即把结果加入本次迁移的临时占用表，保证同一个
 * 接入面的多种协议不会被轮转到同一端口。Hysteria 2 的端口跳跃作为一个连续区间迁移，
 * 并保持监听端口在区间中的相对位置。
 */
export function planIngressPortMigration(
  ingress: IngressPortConfig,
  targetNode: string,
  tcpTaken: Map<string, PortOwners>,
  udpTaken: Map<string, PortOwners>,
): IngressPortMigrationPlan {
  const tcpPorts = new Map(tcpTaken.get(targetNode) ?? []);
  const udpPorts = new Map(udpTaken.get(targetNode) ?? []);
  const tcpPool = new Map([[targetNode, tcpPorts]]);
  const udpPool = new Map([[targetNode, udpPorts]]);
  const rotations: IngressPortRotation[] = [];
  let port = ingress.port;
  let wires: Wires = { ...ingress.wires };

  // 先替本接入面所有原本不冲突的 TCP 端口占位，再为冲突项找新端口。否则前面的冲突项
  // 可能抢走后一个协议本来可以原样保留的端口，造成没有必要的连锁轮转。
  const preservedTcp = new Set<string>();
  const preserveTcpPort = (label: string, requested: number) => {
    if (tcpPorts.has(requested)) return;
    tcpPorts.set(requested, `本次迁移的 ${label}`);
    preservedTcp.add(label);
  };
  if (wires.vless) preserveTcpPort('VLESS · TLS / REALITY', port);
  if (wires.vless_encryption) preserveTcpPort('VLESS · Encryption', wires.vless_encryption.port);
  if (wires.anytls) preserveTcpPort('AnyTLS', wires.anytls.port);
  if (wires.mtproto) preserveTcpPort('MTProxy', wires.mtproto.port);

  const reservePort = (
    label: string,
    transport: 'TCP' | 'UDP',
    requested: number,
    ports: PortOwners,
    pool: Map<string, PortOwners>,
  ) => {
    if (transport === 'TCP' && preservedTcp.has(label)) return requested;
    const conflictOwner = ports.get(requested);
    if (!conflictOwner) {
      ports.set(requested, `本次迁移的 ${label}`);
      return requested;
    }

    const next = freePortAcross(pool, [targetNode], requested);
    if (next > 65535) throw new Error(`目标机器没有可供 ${label} 使用的空闲 ${transport} 端口`);
    rotations.push({
      label,
      transport,
      from: String(requested),
      to: String(next),
      conflict: `${targetNode} 的 ${requested} 已经被${conflictOwner}占着`,
    });
    ports.set(next, `本次迁移的 ${label}`);
    return next;
  };

  if (wires.vless) port = reservePort('VLESS · TLS / REALITY', 'TCP', port, tcpPorts, tcpPool);
  if (wires.vless_encryption) {
    wires = {
      ...wires,
      vless_encryption: {
        ...wires.vless_encryption,
        port: reservePort('VLESS · Encryption', 'TCP', wires.vless_encryption.port, tcpPorts, tcpPool),
      },
    };
  }
  if (wires.anytls) {
    wires = {
      ...wires,
      anytls: {
        ...wires.anytls,
        port: reservePort('AnyTLS', 'TCP', wires.anytls.port, tcpPorts, tcpPool),
      },
    };
  }
  if (wires.mtproto) {
    wires = {
      ...wires,
      mtproto: {
        ...wires.mtproto,
        port: reservePort('MTProxy', 'TCP', wires.mtproto.port, tcpPorts, tcpPool),
      },
    };
  }

  const hysteria = wires.hysteria2;
  if (hysteria?.hop) {
    const { start, end } = hysteria.hop;
    const span = end - start + 1;
    const conflict = spanClash(udpPool, [targetNode], start, end);
    if (!conflict) {
      for (let current = start; current <= end; current += 1) {
        udpPorts.set(current, '本次迁移的 Hysteria 2');
      }
    } else {
      const nextStart = freeSpanAcross(udpPool, [targetNode], start, span);
      const nextEnd = nextStart + span - 1;
      if (nextEnd > 65535 || spanClash(udpPool, [targetNode], nextStart, nextEnd)) {
        throw new Error(`目标机器没有可容纳 Hysteria 2 ${span} 个端口的连续 UDP 区间`);
      }
      const listenOffset = hysteria.port - start;
      if (listenOffset < 0 || listenOffset >= span) {
        throw new Error('Hysteria 2 监听端口不在端口跳跃区间内');
      }
      rotations.push({
        label: 'Hysteria 2',
        transport: 'UDP',
        from: `${start}–${end}`,
        to: `${nextStart}–${nextEnd}`,
        conflict,
      });
      for (let current = nextStart; current <= nextEnd; current += 1) {
        udpPorts.set(current, '本次迁移的 Hysteria 2');
      }
      wires = {
        ...wires,
        hysteria2: {
          ...hysteria,
          port: nextStart + listenOffset,
          hop: { start: nextStart, end: nextEnd },
        },
      };
    }
  } else if (hysteria) {
    wires = {
      ...wires,
      hysteria2: {
        ...hysteria,
        port: reservePort('Hysteria 2', 'UDP', hysteria.port, udpPorts, udpPool),
      },
    };
  }

  return { port, wires, rotations };
}

export function ingressPortMigrationConfirmation(targetName: string, rotations: IngressPortRotation[]): string {
  return [
    `目标机器「${targetName}」存在端口冲突：`,
    '',
    ...rotations.map(
      rotation =>
        `${rotation.label}：${rotation.transport} ${rotation.from} 冲突（${rotation.conflict}），改用 ${rotation.to}`,
    ),
    '',
    '确认后将按以上空闲端口迁移。',
  ].join('\n');
}
