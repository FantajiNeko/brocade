/** Area and line paths for a compact trend drawn in a `0 0 (values.length - 1) height` viewBox
 * with `preserveAspectRatio="none"`. Each value sits at its index; `null` marks a missing point
 * and ends the current segment, so a collection gap is never drawn as data (see
 * `standards/frontend.md`). Values are clamped to `scale`; the area closes on the bottom edge. */
export function sparklinePaths(
  values: readonly (number | null)[],
  scale: number,
  height: number,
  pad = 2,
): { areas: string[]; lines: string[] } {
  const span = height - pad * 2;
  const safeScale = scale > 0 ? scale : 1;
  const y = (value: number) => (height - pad - Math.min(1, Math.max(0, value) / safeScale) * span).toFixed(2);
  const segments: Array<Array<[number, string]>> = [];
  let current: Array<[number, string]> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push([index, y(value)]);
  });
  if (current.length > 0) segments.push(current);
  const lines = segments.map(points => points.map(([x, py], index) => `${index ? 'L' : 'M'}${x} ${py}`).join(''));
  const areas = segments.map(
    (points, index) => `${lines[index]}L${points[points.length - 1][0]} ${height}L${points[0][0]} ${height}Z`,
  );
  return { areas, lines };
}
