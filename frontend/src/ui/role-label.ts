import type { AdminRole } from '../api';

/** Product names are independent of the authorization role identifiers. */
export const ROLE_LABEL: Record<AdminRole, string> = {
  user: '用户',
  readonly: '只读',
  editor: '编辑',
  publisher: '发布',
  'tenant-admin': '管理员',
  'system-admin': '系统管理员',
};
