/**
 * A small line diff for a document's history: which lines an update added,
 * removed, or kept, so the two-pane view can show a revision beside the
 * current text without a dependency. Longest-common-subsequence over lines,
 * bounded so a very long document degrades to a plain replace instead of a
 * quadratic stall.
 */

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Above this many lines on either side, the diff is a plain replace. */
export const LINE_DIFF_LIMIT = 4_000;

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized === "" ? [] : normalized.split("\n");
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > LINE_DIFF_LIMIT || b.length > LINE_DIFF_LIMIT) {
    return [...a.map((text): DiffLine => ({ kind: "removed", text })), ...b.map((text): DiffLine => ({ kind: "added", text }))];
  }
  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = a[i] === b[j]
        ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? "";
    const right = b[j] ?? "";
    if (left === right) {
      lines.push({ kind: "same", text: left });
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      lines.push({ kind: "removed", text: left });
      i += 1;
    } else {
      lines.push({ kind: "added", text: right });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: "removed", text: a[i] ?? "" });
  for (; j < b.length; j += 1) lines.push({ kind: "added", text: b[j] ?? "" });
  return lines;
}

/** "+3 −1 lines", "No changes", or "+1 line". */
export function describeDiff(lines: ReadonlyArray<DiffLine>): string {
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;
  if (added === 0 && removed === 0) return "No changes";
  const parts = [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""].filter(Boolean);
  const total = added + removed;
  return `${parts.join(" ")} ${total === 1 ? "line" : "lines"}`;
}

/**
 * The two panes of a side-by-side view: rows aligned so a changed line sits
 * beside what replaced it, with blanks where one side has nothing.
 */
export function sideBySide(lines: ReadonlyArray<DiffLine>): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    if (line.kind === "same") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index]?.kind !== "same") {
      const current = lines[index];
      if (!current) break;
      (current.kind === "removed" ? removed : added).push(current);
      index += 1;
    }
    for (let row = 0; row < Math.max(removed.length, added.length); row += 1) {
      rows.push({ left: removed[row] ?? null, right: added[row] ?? null });
    }
  }
  return rows;
}
