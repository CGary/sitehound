/**
 * Line diff of two aria snapshots for `page snapshot --diff`, in a compact unified form: `@@ -a,b +c,d @@` hunk headers, then
 * lines prefixed with `-` (only in the old snapshot), `+` (only in the new one) or a space (context). Lines keep their `[ref=...]`
 * and indentation. A line that only gained or lost the focus marker `[active]` counts as unchanged. Pure and dependency-free.
 */

export interface SnapshotDiff {
  /** The diff text; "" when nothing changed. */
  text: string;
  added: number;
  removed: number;
}

type Op = { t: " " | "-" | "+"; line: string };

/** Largest middle block (old lines x new lines) aligned with a full LCS; bigger ones fall back to a per-line comparison. */
const LCS_MAX_CELLS = 4_000_000;

/** Focus moves around as the agent acts; a line that only gained or lost `[active]` is not a change. */
const key = (line: string): string => line.replace(" [active]", "");

/** Aligns two blocks of lines (compared by `key`); unchanged lines are shown as they are in `b`. */
function align(la: readonly string[], lb: readonly string[]): Op[] {
  const a = la.map(key);
  const b = lb.map(key);
  const n = a.length;
  const m = b.length;
  if (n === 0) return lb.map((line) => ({ t: "+", line }));
  if (m === 0) return la.map((line) => ({ t: "-", line }));
  if (n * m > LCS_MAX_CELLS) {
    // Too big to align line by line: a line present on both sides (counting repeats) is unchanged; the order of the rest is lost.
    const count = new Map<string, number>();
    for (const l of b) count.set(l, (count.get(l) ?? 0) + 1);
    const removed: Op[] = [];
    for (let i = 0; i < n; i++) {
      const c = count.get(a[i]!) ?? 0;
      if (c > 0) count.set(a[i]!, c - 1);
      else removed.push({ t: "-", line: la[i]! });
    }
    const have = new Map<string, number>();
    for (const l of a) have.set(l, (have.get(l) ?? 0) + 1);
    const added: Op[] = [];
    for (let j = 0; j < m; j++) {
      const c = have.get(b[j]!) ?? 0;
      if (c > 0) have.set(b[j]!, c - 1);
      else added.push({ t: "+", line: lb[j]! });
    }
    return [...removed, ...added];
  }
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: lb[j]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) ops.push({ t: "-", line: la[i++]! });
    else ops.push({ t: "+", line: lb[j++]! });
  }
  while (i < n) ops.push({ t: "-", line: la[i++]! });
  while (j < m) ops.push({ t: "+", line: lb[j++]! });
  return ops;
}

/** Diff of `before` to `after` with `context` unchanged lines around every change. */
export function diffSnapshots(before: string, after: string, context = 1): SnapshotDiff {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && key(a[head]!) === key(b[head]!)) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && key(a[a.length - 1 - tail]!) === key(b[b.length - 1 - tail]!)) tail++;
  const ops: Op[] = [
    ...b.slice(0, head).map((line): Op => ({ t: " ", line })),
    ...align(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...b.slice(b.length - tail).map((line): Op => ({ t: " ", line })),
  ];
  const removed = ops.filter((o) => o.t === "-").length;
  const added = ops.filter((o) => o.t === "+").length;
  if (added === 0 && removed === 0) return { text: "", added: 0, removed: 0 };

  // Mark the ops to show: every change and `context` lines around it; then cut the marked runs into hunks.
  const show = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) show[x] = true;
  });
  const out: string[] = [];
  let oldNo = 1;
  let newNo = 1;
  let k = 0;
  while (k < ops.length) {
    if (!show[k]) {
      if (ops[k]!.t !== "+") oldNo++;
      if (ops[k]!.t !== "-") newNo++;
      k++;
      continue;
    }
    const startOld = oldNo;
    const startNew = newNo;
    const body: string[] = [];
    let oldLen = 0;
    let newLen = 0;
    for (; k < ops.length && show[k]; k++) {
      const o = ops[k]!;
      body.push(`${o.t}${o.line}`);
      if (o.t !== "+") {
        oldNo++;
        oldLen++;
      }
      if (o.t !== "-") {
        newNo++;
        newLen++;
      }
    }
    out.push(`@@ -${startOld},${oldLen} +${startNew},${newLen} @@`, ...body);
  }
  return { text: out.join("\n"), added, removed };
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The block of a full snapshot that belongs to `ref` (the line carrying `[ref=<ref>]` and every deeper line after it), dedented
 * so the element is at column 0. `depth` (1+) keeps only that many levels below the element (property lines like `- /url:`
 * ride with their parent); a parent left without children loses its trailing colon. Undefined when no line carries the ref.
 */
export function snapshotSubtree(snapshot: string, ref: string, depth?: number): string | undefined {
  const lines = snapshot.split("\n");
  const tag = `[ref=${ref}]`;
  const start = lines.findIndex((l) => l.includes(tag));
  if (start === -1) return undefined;
  const base = indentOf(lines[start]!);
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || indentOf(lines[end]!) > base)) end++;
  let block = lines.slice(start, end).filter((l) => l.trim() !== "").map((l) => l.slice(base));
  if (depth !== undefined && depth > 0) {
    let parentShown = true;
    const shown = block.filter((l) => {
      if (l.trimStart().startsWith("- /")) return parentShown; // a property line (`- /url: ...`) goes with its parent
      parentShown = indentOf(l) / 2 <= depth;
      return parentShown;
    });
    block = shown.map((l, i) => (l.endsWith(":") && !(i + 1 < shown.length && indentOf(shown[i + 1]!) > indentOf(l)) ? l.slice(0, -1) : l));
  }
  return block.join("\n");
}
