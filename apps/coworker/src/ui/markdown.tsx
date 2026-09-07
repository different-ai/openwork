import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { coworkerBridge } from "@/lib/bridge";
import { renderDocument, type DocumentBlock, type DocumentTocEntry } from "@/lib/document-markdown";

/**
 * Coworker replies are Markdown. They are rendered through `marked` (GFM,
 * soft line breaks) and sanitized with DOMPurify before they touch the DOM;
 * links written by the model are untrusted and open only after the native
 * confirmation, never inside the app.
 */
const parser = new Marked({ gfm: true, breaks: true, async: false });

export function renderMarkdown(text: string): string {
  const html = parser.parse(text, { async: false });
  return DOMPurify.sanitize(typeof html === "string" ? html : "", {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "img", "svg", "math", "iframe", "form", "input", "button"],
    FORBID_ATTR: ["style", "onerror", "onload"],
  });
}

function openLink(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target instanceof Element ? event.target.closest("a") : null;
  if (!target) return;
  event.preventDefault();
  const href = target.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) void coworkerBridge.openUntrustedExternal(href);
}

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={`coworker-markdown text-sm leading-relaxed text-snow ${className}`}
      onClick={openLink}
      // Sanitized above; DOMPurify's default profile keeps only safe HTML.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---------------------------------------------------------------------------
// Documents: the reading view. The pure rendering rules live in
// `lib/document-markdown.ts`; this adds sanitization, the table of contents,
// Copy on code blocks, and link handling.

/** An isolated sanitizer so document rules never leak into chat rendering. */
const documentPurifier = DOMPurify();

export function sanitizeDocumentHtml(html: string): string {
  return documentPurifier.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "svg", "math", "iframe", "form", "button", "script"],
    FORBID_ATTR: ["style", "onerror", "onload"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|doc:|file:|#)/i,
  });
}

function CodeBlock({ block }: { block: Extract<DocumentBlock, { kind: "code" }> }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(block.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    }).catch(() => undefined);
  }, [block.text]);
  return (
    <div className="doc-code group relative" data-testid="document-code">
      <div className="absolute right-2 top-2 flex items-center gap-2 text-[10px] text-mist">
        {block.lang ? <span className="font-mono opacity-70">{block.lang}</span> : null}
        <button
          type="button"
          className="rounded-md border border-white/10 bg-panel/80 px-1.5 py-0.5 text-[10px] font-medium text-mist opacity-0 transition-opacity hover:text-snow focus-visible:opacity-100 group-hover:opacity-100"
          onClick={copy}
          aria-label="Copy code"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Sanitized in renderDocument. */}
      <div dangerouslySetInnerHTML={{ __html: block.html }} />
    </div>
  );
}

/** The quiet table of contents above a document with three or more sections. */
function TableOfContents({ entries }: { entries: DocumentTocEntry[] }) {
  return (
    <nav aria-label="Contents" className="doc-toc mb-5 rounded-xl border border-line/60 bg-white/[0.02] px-4 py-3 text-xs" data-testid="document-toc">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-mist/80">Contents</p>
      <ol className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a href={`#${entry.id}`} className="text-mist hover:text-snow">{entry.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * A document rendered for reading: a 68ch measure, generous line height, our
 * palette, no nested cards. Internal `doc:` links open another document;
 * anchors scroll within the document; web links open after confirmation.
 */
export function DocumentMarkdown({
  text,
  coworkerPath = "",
  onOpenDocument,
  className = "",
  header,
}: {
  text: string;
  /** The coworker home, so images written as `workspace/…` resolve; anything outside it is refused. */
  coworkerPath?: string;
  onOpenDocument?: (id: string) => void;
  className?: string;
  /** Rendered above the table of contents, inside the reading measure. */
  header?: ReactNode;
}) {
  const rendered = useMemo(() => renderDocument(text, coworkerPath, sanitizeDocumentHtml), [coworkerPath, text]);
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const docId = anchor.getAttribute("data-doc");
    if (docId) {
      onOpenDocument?.(docId);
      return;
    }
    if (href.startsWith("#")) {
      const target = event.currentTarget.querySelector(`[id="${href.slice(1).replace(/"/g, "")}"]`);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (/^https?:\/\//i.test(href)) void coworkerBridge.openUntrustedExternal(href);
  }, [onOpenDocument]);
  return (
    <div className={`document-markdown coworker-markdown mx-auto max-w-[68ch] text-[15px] leading-[1.7] text-snow ${className}`} onClick={onClick} data-testid="document-body">
      {header}
      {rendered.toc.length > 0 ? <TableOfContents entries={rendered.toc} /> : null}
      {rendered.blocks.map((block, index) => (
        block.kind === "code"
          ? <CodeBlock key={index} block={block} />
          // Sanitized in renderDocument.
          : <div key={index} dangerouslySetInnerHTML={{ __html: block.html }} />
      ))}
    </div>
  );
}
