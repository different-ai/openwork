/** @jsxImportSource react */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useOpenTargets } from "@/lib/target-provider";
import { useSessionReferencesMaybe } from "@/components/chat/session-reference-context";
import { useOpenArtifactPath } from "@/lib/artifacts";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { openTargetForHref } from "@/react-app/domains/session/artifacts/resolve-open-target";

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
import { enhanceNearViewport } from "./near-viewport";

export { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "./markdown-primitive";

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

type MarkdownBlockInnerProps = {
  className?: string;
  text: string;
  streaming?: boolean;
  /** Opt in only for conversation prose, never tool output or artifact previews. */
  sessionReferences?: boolean;
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
  sessionReferences = false,
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
  useEffect(() => setLinkMenu(null), [client, workspaceId, workspaceRoot]);
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const references = useSessionReferencesMaybe();
  const resolveReference = sessionReferences ? references?.resolve : undefined;
  const streamingRenderer = useMemo(() => createStreamingMarkdownRenderer("chat", resolveReference), [resolveReference]);
  const streamedBlocks = useMemo(
    () => (streaming ? streamingRenderer.render(text) : null),
    [streaming, streamingRenderer, text],
  );
  useEffect(() => {
    if (!streaming) streamingRenderer.reset();
  }, [streaming, streamingRenderer]);
  const syncHtml = useMemo(
    () => (streamedBlocks ? "" : renderMarkdownHtml(text, "chat", resolveReference)),
    [streamedBlocks, text, resolveReference],
  );
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string; resolveReference: typeof resolveReference } | null>(null);

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

  const candidate = useMemo<RenderedMarkdown>(() => {
    if (!streaming && highlightedHtml?.text === text && highlightedHtml.resolveReference === resolveReference) return { kind: "document", html: highlightedHtml.html };
    if (streamedBlocks) return { kind: "blocks", blocks: streamedBlocks };
    return { kind: "document", html: syncHtml };
  }, [highlightedHtml, streamedBlocks, streaming, syncHtml, text, resolveReference]);
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

  useEffect(() => {
    if (streaming || !hasFencedCodeBlock(text)) {
      setHighlightedHtml(null);
      return;
    }
    // Selection stability commits the settled document on a later render. Wait
    // for that keyed root, not the streaming root that is about to be removed.
    const root = rootRef.current;
    if (!root || isEmpty || rendered.kind !== "document") return;
    let cancelled = false;
    const stopObserving = enhanceNearViewport([root], () => {
      void renderHighlightedMarkdownHtml(text, "chat", resolveReference).then((html) => {
        if (!cancelled && html.trim()) setHighlightedHtml({ text, html, resolveReference });
      }).catch(() => {
        if (!cancelled) setHighlightedHtml(null);
      });
    });
    return () => {
      cancelled = true;
      stopObserving();
    };
  }, [isEmpty, rendered.kind, streaming, text, resolveReference]);

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
      let cancelled = false;
      let objectUrl: string | null = null;
      const href = video.dataset.openworkVideoPath ?? "";
      const showError = () => {
        const notice = video.parentElement?.querySelector("[data-openwork-video-error]");
        if (notice instanceof HTMLElement) notice.hidden = false;
      };
      video.addEventListener("error", showError);
      videoCleanups.current.set(video, () => {
        cancelled = true;
        video.removeEventListener("error", showError);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });
      if (/^https?:/i.test(href)) continue;
      let path = localPathFromHref(href);
      try { if (!/^file:/i.test(href)) path = decodeURIComponent(path); } catch { /* Keep literal percent signs in filenames. */ }
      const rootPath = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
      path = path.replace(/\\/g, "/");
      if (rootPath && path.startsWith(`${rootPath}/`)) path = path.slice(rootPath.length + 1);
      if (!client || !workspaceId || !path) {
        showError();
        continue;
      }
      const target = openTargetForHref(href, openTargets, workspaceRoot);
      void client.downloadWorkspaceFile(workspaceId, target?.exists === true ? target.value : path).then((result) => {
        if (cancelled) return;
        const extension = path.split(".").pop()?.toLowerCase();
        const fallbackType = extension === "webm" ? "video/webm" : extension === "ogv" ? "video/ogg" : extension === "mov" ? "video/quicktime" : "video/mp4";
        const contentType = result.contentType && result.contentType !== "application/octet-stream" ? result.contentType : fallbackType;
        const url = URL.createObjectURL(new Blob([result.data], { type: contentType }));
        objectUrl = url;
        video.src = url;
      }).catch(() => { if (!cancelled) showError(); });
    }
  }, [client, workspaceId, workspaceRoot, openTargets, rendered]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const sync = () => syncMarkdownImagePreviews(root);

    sync();

    const handleLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) sync();
    };

    const handleSessionReference = (event: MouseEvent) => {
      if (!sessionReferences || !(event.target instanceof Element)) return false;
      const link = event.target.closest("a[data-openwork-session-reference]");
      if (!(link instanceof HTMLAnchorElement) || !root.contains(link)) return false;
      // Even a stale/selected reference must never reach a browser or a file
      // target. Resolve and authorize again at activation, using its stable pair.
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== "mousedown" && (event.button === 0 || event.button === 1)) {
        const destination = link.dataset.openworkSessionReference ?? "";
        const reference = resolveReference?.(destination);
        if (reference && link.getAttribute("href") === destination) references?.openReference(reference);
      }
      return true;
    };
    const handleAuxClick = (event: MouseEvent) => { handleSessionReference(event); };
    const handleMouseDown = (event: MouseEvent) => { if (event.button === 1) handleSessionReference(event); };
    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || handleSessionReference(event)) return;

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
        const target = openTargetForHref(href, openTargets, workspaceRoot);
        if (target) {
          setLinkMenu({ target, rect: chevron.getBoundingClientRect() });
        }
        return;
      }

      const link = event.target.closest("a[data-openwork-link-href]");
      if (link instanceof HTMLAnchorElement) {
        const href = link.dataset.openworkLinkHref ?? link.getAttribute("href") ?? "";
        const target = openTargetForHref(href, openTargets, workspaceRoot);

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

    const handleContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !onOpenTarget) return;
      const link = event.target.closest("[data-openwork-link-href], [data-openwork-link-chevron]");
      if (!(link instanceof HTMLElement)) return;
      const href = link.dataset.openworkLinkHref ?? link.dataset.openworkLinkChevron ?? "";
      const target = openTargetForHref(href, openTargets, workspaceRoot);
      if (target?.kind !== "file") return;
      event.preventDefault();
      event.stopPropagation();
      setLinkMenu({ target, rect: link.getBoundingClientRect() });
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
    root.addEventListener("auxclick", handleAuxClick);
    root.addEventListener("mousedown", handleMouseDown);
    root.addEventListener("contextmenu", handleContextMenu);
    root.addEventListener("keydown", handleKeyDown);

    if (globalThis.ResizeObserver === undefined) {
      return () => {
        root.removeEventListener("load", handleLoad, true);
        root.removeEventListener("click", handleClick);
        root.removeEventListener("auxclick", handleAuxClick);
        root.removeEventListener("mousedown", handleMouseDown);
        root.removeEventListener("contextmenu", handleContextMenu);
        root.removeEventListener("keydown", handleKeyDown);
      };
    }

    const observer = new ResizeObserver(sync);
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("load", handleLoad, true);
      root.removeEventListener("click", handleClick);
      root.removeEventListener("auxclick", handleAuxClick);
      root.removeEventListener("mousedown", handleMouseDown);
      root.removeEventListener("contextmenu", handleContextMenu);
      root.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleCodeBlockCopy, onOpenTarget, openArtifactPath, openTargets, workspaceRoot, rendered, references, resolveReference, sessionReferences]);

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
          key={linkMenu.target.value}
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
