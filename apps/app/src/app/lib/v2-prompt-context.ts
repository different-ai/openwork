/**
 * An OpenCode v2 prompt is one string, while a user turn is several parts: the
 * person's words, pasted text, and hidden context OpenWork adds for the model
 * (attachment paths, pill instructions). This module owns that encoding in
 * both directions so the sent message renders the way v1 renders its parts.
 *
 * - Pasted text is wrapped in `<pasted-text>` where it was pasted.
 * - Hidden context follows the words in one `<openwork-context>` block.
 */

export type PromptAttachment = {
  filename: string;
  mime: string;
  url: string;
  bytes?: number;
};

const CONTEXT_OPEN = "<openwork-context>";
const CONTEXT_CLOSE = "</openwork-context>";
const PASTED_OPEN = "<pasted-text>";
const PASTED_CLOSE = "</pasted-text>";

const NOTE_HEADER = "Attached files were copied into this worker workspace for tool access:";
const NOTE_FOOTER = "Use these paths with Read/Bash/MCP/Docling when a tool needs the file bytes.";
const NOTE_RE = /Attached files were copied into this worker workspace for tool access:\n((?:- [^\n]*\n)*)Use these paths with Read\/Bash\/MCP\/Docling when a tool needs the file bytes\./;
const NOTE_LINE_RE = /^- ([^:\n]+?)(?: \((\d+(?:\.\d+)? (?:B|KB|MB|GB))\))?: .+ \((file:\/\/[^\n]*)\)$/;
const CONTEXT_RE = /(?:^|\n\n)<openwork-context>\n([\s\S]*)\n<\/openwork-context>$/;
const PASTED_RE = /<pasted-text>\n([\s\S]*?)\n<\/pasted-text>/g;

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** "18.4 MB": one decimal, trailing ".0" dropped. */
export function formatAttachmentBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : Number(value.toFixed(1))} ${BYTE_UNITS[unit]}`;
}

function parseAttachmentBytes(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+(?:\.\d+)?) (B|KB|MB|GB)$/);
  if (!match?.[1] || !match[2]) return undefined;
  const unit = BYTE_UNITS.findIndex((item) => item === match[2]);
  return Math.round(Number(match[1]) * 1024 ** unit);
}

/** The model-facing list of copied attachment paths. */
export function attachmentNoteText(items: ReadonlyArray<{ filename: string; workspacePath: string; url: string; bytes?: number }>): string {
  return [
    NOTE_HEADER,
    ...items.map((item) => `- ${item.filename}${item.bytes === undefined ? "" : ` (${formatAttachmentBytes(item.bytes)})`}: ${item.workspacePath} (${item.url})`),
    NOTE_FOOTER,
  ].join("\n");
}

/** Attachments listed in a note. The note carries no mime; callers infer it from the name. */
function parseAttachmentNote(note: string): PromptAttachment[] {
  return note.split("\n").flatMap((line) => {
    const match = line.match(NOTE_LINE_RE);
    if (!match?.[1] || !match[3]) return [];
    const bytes = parseAttachmentBytes(match[2]);
    return [{ filename: match[1], mime: "application/octet-stream", url: match[3], ...(bytes === undefined ? {} : { bytes }) }];
  });
}

export function wrapPastedText(text: string): string {
  return `${PASTED_OPEN}\n${text}\n${PASTED_CLOSE}`;
}

/** One prompt string: the person's words, then hidden context in one block. */
export function composeV2Prompt(words: string, context: readonly string[]): string {
  const blocks = context.filter((block) => block.trim());
  if (blocks.length === 0) return words;
  const block = `${CONTEXT_OPEN}\n${blocks.join("\n\n")}\n${CONTEXT_CLOSE}`;
  return words.trim() ? `${words}\n\n${block}` : block;
}

export type V2PromptSegment = { kind: "text"; text: string } | { kind: "pasted"; text: string };

export type SplitV2Prompt = {
  /** What the person typed and pasted, in order. */
  segments: V2PromptSegment[];
  /** Hidden context for the model, or null when the turn had none. */
  context: string | null;
  /** Attachments named by the context's path note. */
  attachments: PromptAttachment[];
};

/**
 * Split a stored v2 prompt back into what the person sent and what OpenWork
 * added. Turns sent before the context block existed kept the attachment note
 * inline, glued to the words; that note is recognized and removed too.
 */
export function splitV2Prompt(text: string): SplitV2Prompt {
  let words = text;
  let context: string | null = null;
  const block = text.match(CONTEXT_RE);
  if (block && block.index !== undefined && block[1] !== undefined) {
    words = text.slice(0, block.index);
    context = block[1];
  } else {
    const note = text.match(NOTE_RE);
    if (note && note.index !== undefined) {
      words = `${text.slice(0, note.index)}${text.slice(note.index + note[0].length)}`;
      context = note[0];
    }
  }
  const note = context?.match(NOTE_RE);
  const segments: V2PromptSegment[] = [];
  let cursor = 0;
  for (const match of words.matchAll(PASTED_RE)) {
    if (match.index > cursor) segments.push({ kind: "text", text: words.slice(cursor, match.index) });
    segments.push({ kind: "pasted", text: match[1] ?? "" });
    cursor = match.index + match[0].length;
  }
  if (cursor < words.length) segments.push({ kind: "text", text: words.slice(cursor) });
  return { segments, context, attachments: note ? parseAttachmentNote(note[0]) : [] };
}
