/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { applyTextHighlights } from "@/components/markdown/text-highlights";
import {
  hasFencedCodeBlock,
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
} from "@/components/markdown/markdown-primitive";
import { useSelectionStableValue } from "@/components/markdown/selection-stability";
import { useMermaidEnhancer } from "@/components/markdown/mermaid";

function MarkdownBlockInner(props: {
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const syncHtml = useMemo(() => {
    return renderMarkdownHtml(props.text, "surface");
  }, [props.text]);
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string } | null>(null);

  useEffect(() => {
    if (props.streaming || !hasFencedCodeBlock(props.text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void renderHighlightedMarkdownHtml(props.text, "surface").then((html) => {
      if (!cancelled && html.trim()) setHighlightedHtml({ text: props.text, html });
    }).catch(() => {
      if (!cancelled) setHighlightedHtml(null);
    });
    return () => {
      cancelled = true;
    };
  }, [props.streaming, props.text]);

  const candidateHtml = !props.streaming && highlightedHtml?.text === props.text ? highlightedHtml.html : syncHtml;
  const html = useSelectionStableValue(rootRef, candidateHtml);
  const stableInnerHtml = useMemo(() => ({ __html: html }), [html]);
  useMermaidEnhancer(rootRef, html, !props.streaming);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) return;
      applyTextHighlights(root, props.highlightQuery ?? "");
    });
  }, [html, props.highlightQuery]);

  if (!html) return null;

  return (
    <div
      ref={rootRef}
      className="markdown-content max-w-none select-text text-foreground"
      dangerouslySetInnerHTML={stableInnerHtml}
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
