/** @jsxImportSource react */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useOpenTargets } from "@/lib/target-provider";
import { useOpenArtifactPath } from "@/lib/artifacts";
import { attachVideoSource } from "@/lib/video-source";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

import { applyTextHighlights } from "./text-highlights";
import {
  createStreamingMarkdownRenderer,
  hasFencedCodeBlock,
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
  setCodeCopyButtonState,
  setCodeWrapButtonState,
  syncMarkdownImagePreviews,
  type MarkdownBlockHtml,
} from "./markdown-primitive";
import { LinkActionMenu } from "./link-action-menu";
import { useMermaidEnhancer } from "./mermaid";
import { useSelectionStableValue } from "./selection-stability";

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
  React.ComponentProps<"div">,
  "ref" | "className" | "children" | "dangerouslySetInnerHTML"
>;

/**
 * A streaming answer renders one payload per top-level block so a new token
 * only re-parses and repaints the block it lands in; a settled answer renders
 * the whole document at once, exactly as history does.
 */
type RenderedMarkdown =
  | { kind: "document"; html: string }
  | { kind: "blocks"; blocks: MarkdownBlockHtml[] };

function MarkdownBlockInner({
  className,
  text,
  streaming,
  highlightQuery,
  ...props
}: MarkdownBlockInnerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoCleanups = useRef(new Map<HTMLVideoElement, () => void>());
  const codeCopyResetTimers = useRef(new Map<HTMLButtonElement, number>());
  const codeWrapStates = useRef(new Map<number, boolean>());
  const { openTargets, onOpenTarget, client, workspaceId, workspaceRoot } = useOpenTargets();
  const openArtifactPath = useOpenArtifactPath();
  useEffect(() => () => {
    videoCleanups.current.forEach((cleanup) => cleanup());
    videoCleanups.current.clear();
  }, [client, workspaceId, workspaceRoot]);
  const [linkMenu, setLinkMenu] = useState<{ target: OpenTarget; rect: DOMRect } | null>(null);
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const [streamingRenderer] = useState(() => createStreamingMarkdownRenderer("chat"));
  const streamedBlocks = useMemo(
    () => (streaming ? streamingRenderer.render(text) : null),
    [streaming, streamingRenderer, text],
  );
  useEffect(() => {
    if (!streaming) streamingRenderer.reset();
  }, [streaming, streamingRenderer]);
  const syncHtml = useMemo(
    () => (streamedBlocks ? "" : renderMarkdownHtml(text)),
    [streamedBlocks, text],
  );
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

  const syncCodeWrapStates = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    for (const [index, codeBlock] of root.querySelectorAll("[data-openwork-code-block]").entries()) {
      const button = codeBlock.querySelector("[data-openwork-code-wrap]");
      if (button instanceof HTMLButtonElement) {
        setCodeWrapButtonState(button, codeWrapStates.current.get(index) ?? false);
      }
    }
  }, []);

  useEffect(() => {
    codeWrapStates.current.clear();
  }, [text]);

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

  const candidate = useMemo<RenderedMarkdown>(() => {
    if (!streaming && highlightedHtml?.text === text) return { kind: "document", html: highlightedHtml.html };
    if (streamedBlocks) return { kind: "blocks", blocks: streamedBlocks };
    return { kind: "document", html: syncHtml };
  }, [highlightedHtml, streamedBlocks, streaming, syncHtml, text]);
  const rendered = useSelectionStableValue(rootRef, candidate);
  // Keep the innerHTML prop referentially stable too: a fresh wrapper object
  // can make an unrelated React render replace selected text nodes even when
  // the HTML string itself is unchanged.
  const stableInnerHtml = useMemo(
    () => ({ __html: rendered.kind === "document" ? rendered.html : "" }),
    [rendered],
  );
  const isEmpty = rendered.kind === "document"
    ? !rendered.html
    : rendered.blocks.every((block) => !block.__html);
  useMermaidEnhancer(rootRef, rendered, !streaming);

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
      syncCodeWrapStates();
    });
  }, [highlightQuery, rendered]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const [video, cleanup] of videoCleanups.current) {
      if (!root.contains(video)) {
        cleanup();
        videoCleanups.current.delete(video);
      }
    }
    for (const video of root.querySelectorAll("video[data-openwork-video-path]")) {
      if (!(video instanceof HTMLVideoElement)) continue;
      if (videoCleanups.current.has(video)) continue;
      const href = video.dataset.openworkVideoPath ?? "";
      const notice = video.parentElement?.querySelector("[data-openwork-video-error]");
      if (!(notice instanceof HTMLElement)) continue;
      videoCleanups.current.set(video, attachVideoSource(video, notice, { href, client, workspaceId, workspaceRoot }));
    }
  }, [client, workspaceId, workspaceRoot, rendered]);

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

      const inlineCodePath = event.target.closest("[data-openwork-inline-code-path]");
      if (inlineCodePath instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        openArtifactPath(inlineCodePath.dataset.openworkInlineCodePath ?? "");
        return;
      }

      const wrapButton = event.target.closest("[data-openwork-code-wrap]");
      if (wrapButton instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();

        const codeBlock = wrapButton.closest("[data-openwork-code-block]");
        const codeBlocks = Array.from(root.querySelectorAll("[data-openwork-code-block]"));
        const index = codeBlock ? codeBlocks.indexOf(codeBlock) : -1;
        if (index >= 0) {
          const wrapped = !(codeWrapStates.current.get(index) ?? false);
          codeWrapStates.current.set(index, wrapped);
          setCodeWrapButtonState(wrapButton, wrapped);
        }
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
          onOpenTarget(target);
          return;
        }
      }

      const preview = event.target.closest("[data-openwork-image-preview]");
      if (!(preview instanceof HTMLElement)) return;

      event.preventDefault();
      event.stopPropagation();
      const image = preview.querySelector("img");
      if (!(image instanceof HTMLImageElement) || !image.src) return;
      setImagePreview({ src: image.src, alt: image.alt || "Image" });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-openwork-inline-code-path]")) return;

      event.preventDefault();
      event.stopPropagation();
      openArtifactPath(event.target.dataset.openworkInlineCodePath ?? "");
    };

    root.addEventListener("load", handleLoad, true);
    root.addEventListener("click", handleClick);
    root.addEventListener("keydown", handleKeyDown);

    if (globalThis.ResizeObserver === undefined) {
      return () => {
        root.removeEventListener("load", handleLoad, true);
        root.removeEventListener("click", handleClick);
        root.removeEventListener("keydown", handleKeyDown);
      };
    }

    const observer = new ResizeObserver(sync);
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("load", handleLoad, true);
      root.removeEventListener("click", handleClick);
      root.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleCodeBlockCopy, onOpenTarget, openArtifactPath, openTargets, rendered]);

  if (isEmpty) {
    return null;
  }

  const rootClassName = cn("markdown-content max-w-none select-text text-foreground", className);

  return (
    <>
      {rendered.kind === "blocks" ? (
        // Keyed by kind so the switch to the settled document remounts the root
        // instead of mixing children with dangerouslySetInnerHTML.
        <div key="blocks" ref={rootRef} className={rootClassName} {...props}>
          {rendered.blocks.map((block, index) => (
            block.__html ? <div key={index} dangerouslySetInnerHTML={block} /> : null
          ))}
        </div>
      ) : (
        <div
          key="document"
          ref={rootRef}
          className={rootClassName}
          dangerouslySetInnerHTML={stableInnerHtml}
          {...props}
        />
      )}
      {linkMenu && onOpenTarget ? (
        <LinkActionMenu
          target={linkMenu.target}
          anchorRect={linkMenu.rect}
          onOpenTarget={onOpenTarget}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}
      <Dialog
        open={imagePreview !== null}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
      >
        <DialogContent className="max-h-[95vh] w-auto max-w-[95vw] overflow-hidden border-none bg-transparent p-0 shadow-none ring-0 lg:w-max lg:max-w-[95vw]">
          <DialogTitle className="sr-only">{imagePreview?.alt ?? "Image"}</DialogTitle>
          {imagePreview ? (
            <img
              src={imagePreview.src}
              alt={imagePreview.alt}
              className="max-h-[92vh] w-auto max-w-full rounded-xl object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
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
