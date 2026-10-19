import { useMutationState } from '@tanstack/react-query';
import type { GrantWrite } from './api';

/* 授权开关（用户页「接入授权」卡）的写入共用一个 mutation key。写入先改 Head，Serving 稍后才跟上：
   用户页的快照与订阅弹窗里的拨测计划都按这些写入的提交时间，在有限窗口内轮询，窗口过后停止，
   即使有节点离线或发布单停住也不会一直请求。 */
export const GRANT_MUTATION_KEY = ['grant'] as const;
export const GRANT_REFRESH_MS = 3_000;
export const GRANT_REFRESH_WINDOW_MS = 60_000;

function grantWrite(value: unknown): GrantWrite | null {
  if (!value || typeof value !== 'object') return null;
  if (
    !('app_id' in value) ||
    typeof value.app_id !== 'string' ||
    !('tenant_id' in value) ||
    typeof value.tenant_id !== 'string' ||
    !('user_id' in value) ||
    typeof value.user_id !== 'string' ||
    !('ingress_id' in value) ||
    typeof value.ingress_id !== 'string' ||
    !('enabled' in value) ||
    typeof value.enabled !== 'boolean'
  )
    return null;
  return {
    app_id: value.app_id,
    tenant_id: value.tenant_id,
    user_id: value.user_id,
    ingress_id: value.ingress_id,
    enabled: value.enabled,
  };
}

function grantRevision(value: unknown): number | null {
  return value &&
    typeof value === 'object' &&
    'revision_id' in value &&
    typeof value.revision_id === 'number' &&
    Number.isSafeInteger(value.revision_id)
    ? value.revision_id
    : null;
}

export function useGrantEdits() {
  return useMutationState({
    filters: { mutationKey: GRANT_MUTATION_KEY, exact: true },
    select: mutation => ({
      write: grantWrite(mutation.state.variables),
      revision: grantRevision(mutation.state.data),
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      error: mutation.state.error,
    }),
  });
}
