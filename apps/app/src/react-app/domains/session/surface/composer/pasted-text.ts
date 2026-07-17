export const PASTE_CHIP_CHAR_THRESHOLD = 50;
export const FILE_URL_RE = /^file:\/\//i;
export const HTTP_URL_RE = /^https?:\/\//i;
export const PASTED_TEXT_INLINE_STYLE = "background-color: rgba(229, 231, 235, 0.6); border-radius: 4px; box-decoration-break: clone; -webkit-box-decoration-break: clone; padding: 1px 2px;";

export type PastedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "line-break" }
  | { kind: "tab" };

const WHITESPACE_RE = /\s/;

export function isStandaloneHttpUrl(text: string) {
  return HTTP_URL_RE.test(text) && !WHITESPACE_RE.test(text);
}

export function shouldCollapsePastedText(text: string) {
  return text.length > PASTE_CHIP_CHAR_THRESHOLD && !isStandaloneHttpUrl(text);
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
