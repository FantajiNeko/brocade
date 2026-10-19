/* 实时用户流量的采集阶段与文案。机器详情、用户详情的「实时流量」卡和用量页的「机队实时流量」
 * 共用这一份映射：状态值留在各自的数据层，界面只从这里取字，同一阶段在各处读起来一样。 */

export type TrafficPhase =
  | 'pending'
  | 'recovering'
  | 'ready'
  | 'unavailable'
  | 'offline'
  | 'unsupported'
  | 'disabled'
  | 'empty'
  | 'forwarding-unsupported';

export const PHASE_TEXT: Record<TrafficPhase, string> = {
  pending: '正在建立速率基线',
  recovering: '采样恢复中 · 保留最近读数',
  ready: '实时 · 每秒更新',
  unavailable: 'Xray 用户统计暂不可用',
  offline: '实时通道未连接',
  unsupported: '当前 Agent 尚未支持用户速率',
  disabled: '实时观测已关闭',
  empty: '尚未授权接入线路或转发入口',
  'forwarding-unsupported': '转发实时待升级 Agent',
};

/** 报告已就绪但不完整（被截断、有缺口或未覆盖全部用户）：已上报的行照常显示，其余不能当作 0。 */
export const PARTIAL_TEXT = '部分数据待恢复';

/** 多台机器的最近速率相加时必须说明的口径。 */
export const RATE_SUM_NOTE =
  '各机独立采样，按最近有效速率汇总；不是同一采样窗口的流量累计。缺样与离线的保留值不计入当前合计。';
