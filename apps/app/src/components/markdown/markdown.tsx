/** @jsxImportSource react */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";
import { useOpenTargets } from "@/lib/target-provider";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

import { applyTextHighlights } from "./text-highlights";
import {
  hasFencedCodeBlock,
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
  setCodeCopyButtonState,
  syncMarkdownImagePreviews,
} from "./markdown-primitive";
import { LinkActionMenu } from "./link-action-menu";

export { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "./markdown-primitive";

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;
const CODE_COPY_RESET_DELAY_MS = 2000;

function localPathFromHref(href: string) {
  const trimmed = href.trim();

  if (!trimmed || trimmed.startsWith("#") || /^(?:https?|mailto):/i.test(trimmed)) {
    return "";
  }

  if (/^file:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = decodeURIComponent(parsed.hostname);
      const pathname = decodeURIComponent(parsed.pathname);
      const localPath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;

      if (host && host !== "localhost") {
        return `//${host}${localPath.startsWith("/") ? localPath : `/${localPath}`}`;
      }

      return localPath;
    } catch {
      return "";
    }
  }

  return trimmed.split(/[?#]/)[0] ?? trimmed;
}

function normalizeFilePathForMatch(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "")
    .replace(/[/]+$/, "")
    .toLowerCase();
}

function filePathMatchesTarget(path: string, targetValue: string) {
  const normalizedPath = normalizeFilePathForMatch(path);
  const normalizedTarget = normalizeFilePathForMatch(targetValue);

  return normalizedPath === normalizedTarget || normalizedPath.endsWith(`/${normalizedTarget}`);
}

function openTargetForHref(href: string, openTargets: OpenTarget[]) {
  const path = localPathFromHref(href);

  if (!path) {
    return null;
  }

  return openTargets.find((target) => target.kind === "file" && filePathMatchesTarget(path, target.value)) ?? null;
}

type MarkdownBlockInnerProps = {
  className?: string;
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
} & Omit<
  React.ComponentProps<typeof motion.div>,
  "ref" | "className" | "children" | "dangerouslySetInnerHTML"
>;

function MarkdownBlockInner({
  className,
  text,
  streaming,
  highlightQuery,
  ...props
}: MarkdownBlockInnerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const codeCopyResetTimers = useRef(new Map<HTMLButtonElement, number>());
  const { openTargets, onOpenTarget } = useOpenTargets();
  const [linkMenu, setLinkMenu] = useState<{ target: OpenTarget; rect: DOMRect } | null>(null);
  const syncHtml = useMemo(() => {
    return renderMarkdownHtml(text);
  }, [text]);
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string } | null>(null);

  const handleCodeBlockCopy = useCallback(async (button: HTMLButtonElement, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }

    const previousTimer = codeCopyResetTimers.current.get(button);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }

    setCodeCopyButtonState(button, true);

    const resetTimer = window.setTimeout(() => {
      setCodeCopyButtonState(button, false);
      codeCopyResetTimers.current.delete(button);
    }, CODE_COPY_RESET_DELAY_MS);
    codeCopyResetTimers.current.set(button, resetTimer);
  }, []);

  useEffect(() => {
    const timers = codeCopyResetTimers.current;

    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (streaming || !hasFencedCodeBlock(text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void renderHighlightedMarkdownHtml(text).then((html) => {
      if (!cancelled && html.trim()) {
        setHighlightedHtml({ text, html });
      }
    }).catch(() => {
      if (!cancelled) {
        setHighlightedHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [streaming, text]);

  const html = !streaming && highlightedHtml?.text === text ? highlightedHtml.html : syncHtml;

  // Re-apply search highlights after EVERY render (no dependency array on
  // purpose): motion.div re-sets dangerouslySetInnerHTML on unrelated
  // re-renders (e.g. open-target context updates), silently wiping the
  // <mark> nodes without `html`/`highlightQuery` changing. With no active
  // query this is a single querySelector fast path.
  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) {
        return;
      }

      applyTextHighlights(root, highlightQuery ?? "");
    });
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const sync = () => syncMarkdownImagePreviews(root);

    sync();

    const handleLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) sync();
    };

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const copyButton = event.target.closest("[data-openwork-code-copy]");
      if (copyButton instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();

        const codeBlock = copyButton.closest("[data-openwork-code-block]");
        const code = codeBlock?.querySelector("code");
        void handleCodeBlockCopy(copyButton, code?.textContent ?? "");
        return;
      }

      const chevron = event.target.closest("[data-openwork-link-chevron]");
      if (chevron instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const href = chevron.dataset.openworkLinkChevron ?? "";
        const target = openTargetForHref(href, openTargets);
        if (target) {
          setLinkMenu({ target, rect: chevron.getBoundingClientRect() });
        }
        return;
      }

      const link = event.target.closest("a[data-openwork-link-href]");
      if (link instanceof HTMLAnchorElement) {
        const href = link.dataset.openworkLinkHref ?? link.getAttribute("href") ?? "";
        const target = openTargetForHref(href, openTargets);

        if (target && onOpenTarget) {
          event.preventDefault();
          onOpenTarget(target, { external: true });
          return;
        }
      }

      const button = event.target.closest("[data-openwork-image-toggle]");
      if (!(button instanceof HTMLButtonElement)) return;

      const preview = button.closest("[data-openwork-image-preview]");
      if (!(preview instanceof HTMLElement)) return;

      preview.dataset.openworkImagePreview = preview.dataset.openworkImagePreview === "expanded"
        ? "collapsed"
        : "expanded";
      sync();
    };

    root.addEventListener("load", handleLoad, true);
    root.addEventListener("click", handleClick);

    if (globalThis.ResizeObserver === undefined) {
      return () => {
        root.removeEventListener("load", handleLoad, true);
        root.removeEventListener("click", handleClick);
      };
    }

    const observer = new ResizeObserver(sync);
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("load", handleLoad, true);
      root.removeEventListener("click", handleClick);
    };
  }, [handleCodeBlockCopy, html, onOpenTarget, openTargets]);

  if (!html) {
    return null;
  }

  return (
    <>
      <motion.div
        ref={rootRef}
        className={cn("markdown-content max-w-none text-foreground", className)}
        dangerouslySetInnerHTML={{ __html: html }}
        {...props}
      />
      {linkMenu && onOpenTarget ? (
        <LinkActionMenu
          target={linkMenu.target}
          anchorRect={linkMenu.rect}
          onOpenTarget={onOpenTarget}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}
    </>
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
