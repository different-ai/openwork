// Text selected in a reply, quoted into the draft of a side chat.

/** The longest selection carried into a draft; a longer one is cut with an ellipsis. */
export const SELECTION_QUOTE_MAX_CHARS = 4_000;

/** The selection as a Markdown quote, ready to type under. */
export function quoteForDraft(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const kept = trimmed.length > SELECTION_QUOTE_MAX_CHARS ? `${trimmed.slice(0, SELECTION_QUOTE_MAX_CHARS).trimEnd()}…` : trimmed;
  return `${kept.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`;
}

/** Add a quote under whatever the draft already says, so typed text is never replaced. */
export function appendQuoteToDraft(draft: string, text: string): string {
  const quote = quoteForDraft(text);
  if (!quote) return draft;
  const existing = draft.trimEnd();
  return existing ? `${existing}\n\n${quote}` : quote;
}

export function replySelection(selection: Selection | null, scope: Element): { text: string; range: Range } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const inReply = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    const reply = element?.closest('[data-message-role="assistant"]');
    return Boolean(reply && scope.contains(reply));
  };
  if (!inReply(range.startContainer) || !inReply(range.endContainer)) return null;
  const text = selection.toString().trim();
  return text ? { text, range } : null;
}
