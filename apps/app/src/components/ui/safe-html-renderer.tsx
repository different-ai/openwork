/** @jsxImportSource react */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

export type SafeHtmlRendererProps = {
  content: string;
  className?: string;
};

declare global {
  interface Window {
    __OPENWORK_DOMPURIFY_LINK_HOOK_REGISTERED__?: boolean;
  }
}

if (typeof window !== "undefined" && !window.__OPENWORK_DOMPURIFY_LINK_HOOK_REGISTERED__) {
  window.__OPENWORK_DOMPURIFY_LINK_HOOK_REGISTERED__ = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLAnchorElement && node.target) {
      const existingRel = node.rel || "";
      const relParts = existingRel
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => t.toLowerCase() !== "opener");
      if (!relParts.includes("noopener")) {
        relParts.push("noopener");
      }
      if (!relParts.includes("noreferrer")) {
        relParts.push("noreferrer");
      }
      node.rel = relParts.join(" ");
    }
  });
}
      if (!relParts.includes("noreferrer")) {
        relParts.push("noreferrer");
      }
      node.rel = relParts.join(" ");
    }
  });
}

export function SafeHtmlRenderer({ content, className }: SafeHtmlRendererProps) {
  const sanitizedHtml = useMemo(() => {
    if (!content) return "";
    // Parse to html if it is markdown
    const rawHtml = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["target", "rel"],
    });
  }, [content]);

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
