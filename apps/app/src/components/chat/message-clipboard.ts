import { joinAssistantProseClipboard, serializeAssistantProseRange } from "../markdown/assistant-prose-clipboard";
import type { AssistantProseClipboard } from "../markdown/assistant-prose-clipboard";

/** Elements and source come only from React refs, not attributes inside untrusted rendered HTML. */
export type RenderedMessageProse = { element: HTMLElement; source: string };
export type MessageCopyRequest = {
  markdown: string;
  enabled: boolean;
  /** Exact concatenated text parts, before the legacy Markdown-copy trimming/separators. */
  source: string;
  getProse?: () => readonly RenderedMessageProse[];
};

export function serializeRenderedMessage(prose: readonly RenderedMessageProse[], source: string): AssistantProseClipboard | null {
  if (!prose.length || prose.some(({ element }) => !element.isConnected)) return null;
  const ordered = [...prose].sort((a, b) => a.element === b.element ? 0 : a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  // A virtualized/collapsed/missing text group must not turn a whole-reply action into a partial copy.
  if (ordered.map(part => part.source).join("").trim() !== source.trim()) return null;
  const pieces: AssistantProseClipboard[] = [];
  for (const { element } of ordered) {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const data = serializeAssistantProseRange(element, range);
    if (!data) return null;
    pieces.push(data);
  }
  return joinAssistantProseClipboard(pieces);
}

/** Rich copy is opportunistic. Every failure returns to the exact legacy Markdown write. */
export async function copyMessage(request: MessageCopyRequest): Promise<"rich" | "markdown"> {
  if (request.enabled) {
    try {
      if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
        const data = serializeRenderedMessage(request.getProse?.() ?? [], request.source);
        if (data) {
          const item = new ClipboardItem({
            "text/html": new Blob([data.html], { type: "text/html" }),
            "text/plain": new Blob([data.text], { type: "text/plain" }),
          });
          await navigator.clipboard.write([item]);
          return "rich";
        }
      }
    } catch {
      // Includes unavailable APIs, stale/unmounted DOM and permission/format rejection.
    }
  }
  await navigator.clipboard.writeText(request.markdown);
  return "markdown";
}
