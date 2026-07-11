/**
 * Tiny LCS line-diff. No dependencies. O(n*m) time + space — fine for
 * spec-sized documents (hundreds of lines).
 */
export type DiffLineType = "context" | "added" | "removed";

export type DiffLine = {
  type: DiffLineType;
  text: string;
};

/**
 * Line diff of `oldText` -> `newText`. Identical lines are `context`, lines
 * only in `newText` are `added`, lines only in `oldText` are `removed`.
 * Empty input yields zero lines (not a single empty line), so an empty side
 * diffs cleanly against a non-empty one.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of LCS of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "removed", text: a[i] });
      i++;
    } else {
      out.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: "removed", text: a[i] });
    i++;
  }
  while (j < n) {
    out.push({ type: "added", text: b[j] });
    j++;
  }
  return out;
}
