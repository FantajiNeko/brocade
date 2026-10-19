const TIB_BYTES = 1024n ** 4n;

/** Render the exact byte quota as the TiB value used by both machine quota editors. */
export function machineQuotaTiB(value: string | null): string {
  if (!value) return '';
  try {
    const bytes = BigInt(value);
    const hundredths = (bytes * 100n + TIB_BYTES / 2n) / TIB_BYTES;
    return hundredths % 100n === 0n
      ? (hundredths / 100n).toString()
      : `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '')}`;
  } catch {
    return '';
  }
}

/** Parse a TiB quota to an exact byte string. Empty means unlimited; undefined means invalid. */
export function machineQuotaBytes(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return undefined;
  const [whole, fraction = ''] = trimmed.split('.');
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (hundredths <= 0n) return undefined;
  return ((hundredths * TIB_BYTES + 50n) / 100n).toString();
}
