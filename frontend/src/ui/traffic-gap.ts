/** 物理网卡账本缺口原因的文案。机器列表卡片的本月累计提示与流量预测页共用这一份映射。
 *  原因为空时缺口来自记账起点晚于本期起点。 */
export function trafficGapReason(reason: string | null): string {
  switch (reason) {
    case 'machine-reboot':
      return '机器重启';
    case 'interface-changed':
      return '默认网卡变化';
    case 'counter-regressed':
      return '网卡计数回退';
    case 'meter-replaced':
      return 'Agent 流量状态已更换';
    case 'agent-discontinuity':
      return 'Agent 检测到计数中断';
    case 'report-gap':
      return '控制面跨日失联';
    default:
      return '采集从本期中途开始';
  }
}
