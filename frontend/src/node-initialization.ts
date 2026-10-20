import type { NodeInitialization } from './api';

/** The server owns execution; installing pages only present its durable result. */
export function nodeInitializationView(initialization: NodeInitialization | null | undefined) {
  const state = initialization?.state;
  const deploymentId = initialization?.deployment_id ?? null;
  switch (state) {
    case 'succeeded':
      return {
        title: '初始化完成，可创建线路',
        description: '这台机器的初始配置已收敛。线路与用户配置仍通过正常发布流程生效。',
        action: 'details' as const,
        actionLabel: '查看机器',
        tone: 'ok' as const,
      };
    case 'manual':
      return {
        title: '需要人工发布',
        description: initialization?.reason || '已有配置变更需要确认，请查看发布计划。',
        action: 'plan' as const,
        actionLabel: '查看发布计划',
        tone: 'warn' as const,
      };
    case 'failed':
      return {
        title: '初始化需要处理',
        description: initialization?.reason || '初始化未完成，请检查发布结果。',
        action: deploymentId == null ? ('plan' as const) : ('deployment' as const),
        actionLabel: deploymentId == null ? '查看发布计划' : '查看失败发布单',
        tone: 'warn' as const,
      };
    case 'running':
      return {
        title: 'Agent 已上线，初始化中',
        description: '服务端正在自动发布这台机器的初始配置。离开本页后仍会继续。',
        action: 'deployment' as const,
        actionLabel: '查看初始化发布单',
        tone: 'busy' as const,
      };
    case 'queued':
    case 'waiting-agent':
      return {
        title: '等待自动初始化',
        description: initialization?.reason || 'Agent 上线后，服务端会复核条件并自动初始化这台机器。',
        action: 'waiting' as const,
        actionLabel: '等待自动初始化…',
        tone: 'busy' as const,
      };
    default:
      // Machines registered before this automation have no bootstrap intent. They retain an
      // explicit manual route; opening their install page cannot create a new initialization.
      return {
        title: 'Agent 已上线',
        description: '这台机器没有自动初始化任务，可查看机器或检查待发布配置。',
        action: 'plan' as const,
        actionLabel: '查看发布计划',
        tone: 'ok' as const,
      };
  }
}
