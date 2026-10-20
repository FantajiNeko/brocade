import { describe, expect, it } from 'vitest';
import { binaryReleaseVersion, xrayRunningCommit } from '../src/ui/binary-release-version';
import type { BinaryReleaseView } from '../src/api';

describe('二进制发布版本', () => {
  it('Agent 显示源码提交而不是二进制摘要，并保留 dirty 状态', () => {
    const revision = '7fd6c7d6e37773422426b119e300e961c1099840';
    expect(binaryReleaseVersion('agent', revision)).toBe('7fd6c7d6e377');
    expect(binaryReleaseVersion('agent', `${revision}-dirty`)).toBe('7fd6c7d6e377 · dirty');
  });

  it('Xray 使用相同的源码提交显示规则', () => {
    const revision = '77ae5216cf2132fcf300fac1a6a4998ea54378ba';
    expect(binaryReleaseVersion('xray', revision)).toBe('77ae5216cf21');
    expect(binaryReleaseVersion('xray', `${revision}-dirty`)).toBe('77ae5216cf21 · dirty');
  });

  it('旧 Agent 版本保留兼容，Xray 不把版本号或上游横幅当成源码 commit', () => {
    expect(binaryReleaseVersion('agent', '0.2.0')).toBe('v0.2.0');
    expect(binaryReleaseVersion('xray', 'Xray 26.9.1')).toBe('commit 未知');
    expect(
      binaryReleaseVersion('xray', 'Xray 26.4.25 (Xray, Penetrates Everything.) b4f0898 (go1.26.9 linux/amd64)'),
    ).toBe('commit 未知');
    expect(binaryReleaseVersion('xray', 'unknown')).toBe('commit 未知');
  });

  it('只按实际运行摘要匹配可发构建或发布记录，没有记录时不猜 commit', () => {
    const view = {
      available: {
        version: '77ae5216cf2132fcf300fac1a6a4998ea54378ba-dirty',
        artifacts: [{ sha256: 'a'.repeat(64) }],
      },
      current: {
        version: '7fd6c7d6e37773422426b119e300e961c1099840',
        targets: [{ desired_sha256: 'b'.repeat(64) }],
      },
    } as BinaryReleaseView;
    expect(xrayRunningCommit(view, 'a'.repeat(64))).toBe('77ae5216cf21 · dirty');
    expect(xrayRunningCommit(view, 'b'.repeat(64))).toBe('7fd6c7d6e377');
    expect(xrayRunningCommit(view, 'c'.repeat(64))).toBe('commit 未知');
    expect(xrayRunningCommit(view, null)).toBeNull();
  });
});
