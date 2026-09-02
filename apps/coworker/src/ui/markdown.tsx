import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo, type MouseEvent } from "react";
import { coworkerBridge } from "@/lib/bridge";

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
