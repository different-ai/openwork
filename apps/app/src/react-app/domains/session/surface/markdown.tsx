/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { browserMarkdownRenderingKernel } from "@/components/markdown/browser-rendering-kernel";

import { applyTextHighlights } from "./text-highlights";

function MarkdownBlockInner(props: {
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const syncHtml = useMemo(
    () => browserMarkdownRenderingKernel.renderSync(props.text, "document-preview"),
    [props.text],
  );
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string } | null>(null);

  useEffect(() => {
    if (props.streaming || !browserMarkdownRenderingKernel.hasFencedCodeBlock(props.text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void browserMarkdownRenderingKernel.renderHighlighted(props.text, "document-preview").then((html) => {
      if (!cancelled && html.trim()) {
        setHighlightedHtml({ text: props.text, html });
      }
    }).catch(() => {
      if (!cancelled) setHighlightedHtml(null);
    });
    return () => {
      cancelled = true;
    };
  }, [props.streaming, props.text]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) return;
      applyTextHighlights(root, props.highlightQuery ?? "");
    });
  }, [props.highlightQuery, props.streaming, props.text]);

  const html = highlightedHtml?.text === props.text ? highlightedHtml.html : syncHtml;

  if (!html) return null;

  return (
    <div
      ref={rootRef}
      className="markdown-content max-w-none text-foreground"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Memoize so a message block that has already been rendered — the usual
 * case for every assistant bubble above the currently-streaming one —
 * doesn't re-parse its markdown on every token. Only re-renders when its
 * own text / streaming / highlightQuery props change.
 */
export const MarkdownBlock = memo(MarkdownBlockInner);
MarkdownBlock.displayName = "MarkdownBlock";
