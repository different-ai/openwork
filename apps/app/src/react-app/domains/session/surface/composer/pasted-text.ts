export const FILE_URL_RE = /^file:\/\//i;
export const HTTP_URL_RE = /^https?:\/\//i;

export type PastedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "line-break" }
  | { kind: "tab" };

export type PastedTextChip = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

const WHITESPACE_RE = /\s/;

export function isStandaloneHttpUrl(text: string) {
  return HTTP_URL_RE.test(text) && !WHITESPACE_RE.test(text);
}

export function shouldCollapsePastedText(text: string, wouldOverflowComposer: boolean) {
  return wouldOverflowComposer && !isStandaloneHttpUrl(text);
}

export function createPastedTextChip(text: string): PastedTextChip {
  const id = `paste-${Math.random().toString(36).slice(2)}`;
  const lines = text.split(/\r?\n/).length;
  return {
    id,
    label: `${id.slice(-4)} · ${lines} lines`,
    text,
    lines,
  };
}

export function resolvePastedTextPlaceholders(text: string, pastedText: readonly Pick<PastedTextChip, "label" | "text">[]) {
  let resolved = text;
  for (const part of pastedText) {
    resolved = resolved.replace(`[pasted text ${part.label}]`, part.text);
  }
  return resolved;
}

export function splitPastedText(text: string) {
  const segments: PastedTextSegment[] = [];
  for (const part of text.split(/(\r?\n|\t)/)) {
    if (part === "\n" || part === "\r\n") {
      segments.push({ kind: "line-break" });
    } else if (part === "\t") {
      segments.push({ kind: "tab" });
    } else if (part) {
      segments.push({ kind: "text", text: part });
    }
  }
  return segments;
}
