/** @jsxImportSource react */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

export type SafeHtmlRendererProps = {
  content: string;
  className?: string;
};

export function SafeHtmlRenderer({ content, className }: SafeHtmlRendererProps) {
  const sanitizedHtml = useMemo(() => {
    if (!content) return "";
    // Parse to html if it is markdown
    const rawHtml = marked.parse(content) as string;
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["target", "rel", "class"],
    });
  }, [content]);

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
