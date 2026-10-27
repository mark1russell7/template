/** A line diff (the algorithm of Myers) and its text in the unified format of `diff -u` and git. */

/** An operation of a line diff: a kept line, a removed line or an added line. */
export interface DiffLine {
  readonly kind: " " | "-" | "+";
  readonly text: string;
}

/** Above this number of changes, the diff replaces the whole changed part, so the memory stays small. */
const MAX_EDITS = 2000;

/** This function gives the shortest edit script that changes the lines `before` into the lines `after`. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  // The common start and end need no search
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  const kept = (lines: readonly string[]): DiffLine[] => lines.map((text) => ({ kind: " ", text }));
  return [...kept(before.slice(0, start)), ...middle(a, b), ...kept(before.slice(before.length - end))];
}

/** This function gives the edit script of two lists that have different first lines and different last lines. */
function middle(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const replace = (): DiffLine[] => [...a.map((text): DiffLine => ({ kind: "-", text })), ...b.map((text): DiffLine => ({ kind: "+", text }))];
  if (n === 0 || m === 0) return replace();
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d..d] before the step d
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace);
    }
  }
  return replace();
}

/** This function follows the trace of the search back from the end, and gives the operations in order. */
function backtrack(a: readonly string[], b: readonly string[], trace: readonly Int32Array[]): DiffLine[] {
  const result: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] ?? new Int32Array(0);
    const at = (k: number): number => v[k + d] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = d === 0 ? 0 : previousX - previousK;
    while (x > previousX && y > previousY) {
      result.push({ kind: " ", text: a[x - 1] ?? "" });
      x--;
      y--;
    }
    if (d === 0) break;
    if (down) result.push({ kind: "+", text: b[y - 1] ?? "" });
    else result.push({ kind: "-", text: a[x - 1] ?? "" });
    x = previousX;
    y = previousY;
  }
  return result.reverse();
}

/** The options of a unified diff. */
export interface UnifiedDiffOptions {
  /** The number of kept lines around each change. The default is 3. */
  readonly context?: number;
  /** The name of the file before the change, after `---`. */
  readonly from?: string;
  /** The name of the file after the change, after `+++`. */
  readonly to?: string;
}

/**
 * This function gives the change from the text `before` to the text `after` in the unified format.
 * The result is an empty string when the texts are the same.
 */
export function unifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string {
  const split = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const ops = diffLines(split(before), split(after));
  const context = options.context ?? 3;
  // The position of each operation in the two texts
  const positions: { a: number; b: number }[] = [];
  let a = 0;
  let b = 0;
  for (const op of ops) {
    positions.push({ a, b });
    if (op.kind !== "+") a++;
    if (op.kind !== "-") b++;
  }
  const changes = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changes.length === 0) return "";
  const lines = [`--- ${options.from ?? "before"}`, `+++ ${options.to ?? "after"}`];
  let index = 0;
  while (index < changes.length) {
    const first = changes[index] ?? 0;
    let last = first;
    while (index + 1 < changes.length && (changes[index + 1] ?? 0) - last <= 2 * context) last = changes[++index] ?? last;
    index++;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const hunk = ops.slice(from, to + 1);
    const start = positions[from] ?? { a: 0, b: 0 };
    const countA = hunk.filter((op) => op.kind !== "+").length;
    const countB = hunk.filter((op) => op.kind !== "-").length;
    // As in diff -u, an empty side starts at the line before the hunk
    const range = (line: number, count: number): string => `${count === 0 ? line : line + 1}${count === 1 ? "" : `,${count}`}`;
    lines.push(`@@ -${range(start.a, countA)} +${range(start.b, countB)} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.text}`);
  }
  return `${lines.join("\n")}\n`;
}
