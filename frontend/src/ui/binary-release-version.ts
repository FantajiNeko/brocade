import type { BinaryComponent, BinaryReleaseView } from '../api';

/** Compact display only; APIs and the release ledger retain the complete source revision. */
export function binaryReleaseVersion(component: BinaryComponent, value: string) {
  const dirty = value.endsWith('-dirty');
  const revision = dirty ? value.slice(0, -'-dirty'.length) : value;
  if ((component === 'agent' || component === 'xray') && /^[0-9a-f]{40,64}$/.test(revision))
    return `${revision.slice(0, 12)}${dirty ? ' · dirty' : ''}`;
  if (component === 'xray') return 'commit 未知';
  const version = value.match(/(?:^|\b)v?(\d+(?:\.\d+){1,3})(?:\b|$)/i)?.[1];
  return version ? `v${version}` : value;
}

/** Runtime banners contain an upstream build label, not the Brocade source revision. */
export function xrayRunningCommit(view: BinaryReleaseView, runningSha: string | null | undefined) {
  if (!runningSha) return null;
  const revision = view.available.artifacts.some(artifact => artifact.sha256 === runningSha)
    ? view.available.version
    : view.current?.targets.some(target => target.desired_sha256 === runningSha)
      ? view.current.version
      : '';
  return binaryReleaseVersion('xray', revision);
}
