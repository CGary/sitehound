/** Levenshtein distance. */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/**
 * The allowed value closest to `value` (case-insensitive): a prefix relation either way ("interactive" ->
 * "interact") or a small edit distance. Undefined when nothing is close: never guess a default.
 */
export function nearest(value: string, allowed: readonly string[]): string | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  const prefix = allowed.filter((a) => a.length >= 2 && v.length >= 2 && (v.startsWith(a.toLowerCase()) || a.toLowerCase().startsWith(v)));
  if (prefix.length) return prefix.sort((a, b) => Math.abs(a.length - v.length) - Math.abs(b.length - v.length))[0];
  let best: { a: string; d: number } | undefined;
  for (const a of allowed) {
    const d = distance(v, a.toLowerCase());
    if (!best || d < best.d) best = { a, d };
  }
  const limit = Math.min(2, Math.floor(v.length / 3));
  return best && best.d <= limit ? best.a : undefined;
}
