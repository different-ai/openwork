/** @jsxImportSource react */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { desktopBridge } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/lib/runtime-env";
import { useOpenTargets } from "@/lib/target-provider";
import { useSessionReferencesMaybe } from "@/components/chat/session-reference-context";
import { useUntrustedMarkdown } from "./untrusted-markdown";
import { contextualizeFileTarget, precedingDirectory } from "@/react-app/domains/session/artifacts/path-reference-context";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { openTargetForHref, openTargetFromLocalPath, planFileOpen, resolveCollectibleOpenTarget } from "@/react-app/domains/session/artifacts/resolve-open-target";

import { applyBlockDirection, textDirectionOf } from "@/lib/text-direction";
import { applyTextHighlights } from "./text-highlights";
import {
  createStreamingMarkdownRenderer,
  hasFencedCodeBlock,
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
  setCopyButtonState,
  setCodeWrapButtonState,
  syncMarkdownImagePreviews,
  type MarkdownBlockHtml,
} from "./markdown-primitive";
import { LinkActionMenu } from "./link-action-menu";
import { decorateGitHubReferences } from "./github-references";
import { useMermaidEnhancer } from "./mermaid";
import { MermaidZoomPortals } from "./mermaid-zoom-viewport";
import { useSelectionStableValue } from "./selection-stability";
import { enhanceNearViewport } from "./near-viewport";

export { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "./markdown-primitive";

const CODE_COPY_RESET_DELAY_MS = 2000;

type MarkdownBlockInnerProps = {
  className?: string;
  text: string;
  streaming?: boolean;
  /** Opt in only for conversation prose, never tool output or artifact previews. */
  sessionReferences?: boolean;
  highlightQuery?: string;
  /** Text-first rail: GitHub pull request and issue links show their mark. */
  githubReferences?: boolean;
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
  githubReferences = false,
  ...props
}: MarkdownBlockInnerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoCleanups = useRef(new Map<HTMLVideoElement, () => void>());
  const localImageUrls = useRef(new Map<string, Promise<string | null>>());
  const codeCopyResetTimers = useRef(new Map<HTMLButtonElement, number>());
  const codeWrapStates = useRef(new Map<number, boolean>());
  const { openTargets, sessionFileEvidence, onOpenTarget, client, workspaceId, workspaceRoot, sessionId } = useOpenTargets();
  const targetAt = useCallback((value: string, node: Element, decode = true) => {
    const literal = openTargetFromLocalPath(value, { decode });
    const root = rootRef.current;
    const contextual = literal && root ? contextualizeFileTarget(literal, precedingDirectory(root, node)) : literal;
    // Context belongs to this occurrence, not another same-named link or artifact.
    if (contextual?.pathHints?.length || !decode) return contextual;
    return openTargetForHref(value, openTargets, workspaceRoot);
  }, [openTargets, workspaceRoot]);
  useEffect(() => () => {
    videoCleanups.current.forEach((cleanup) => cleanup());
    videoCleanups.current.clear();
    for (const pending of localImageUrls.current.values()) void pending.then((url) => { if (url) URL.revokeObjectURL(url); });
    localImageUrls.current.clear();
  }, [client, workspaceId, workspaceRoot, sessionId]);
  const [linkMenu, setLinkMenu] = useState<{ target: OpenTarget; anchor: HTMLElement } | null>(null);
  useEffect(() => setLinkMenu(null), [client, workspaceId, workspaceRoot]);
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const references = useSessionReferencesMaybe();
  const untrusted = useUntrustedMarkdown();
  const presentation = untrusted ? "remote" : "chat";
  const resolveReference = sessionReferences && !untrusted ? references?.resolve : undefined;
  const streamingRenderer = useMemo(() => createStreamingMarkdownRenderer(presentation, resolveReference), [presentation, resolveReference]);
  const streamedBlocks = useMemo(
    () => (streaming ? streamingRenderer.render(text) : null),
    [streaming, streamingRenderer, text],
  );
  useEffect(() => {
    if (!streaming) streamingRenderer.reset();
  }, [streaming, streamingRenderer]);
  const syncHtml = useMemo(
    () => (streamedBlocks ? "" : renderMarkdownHtml(text, presentation, resolveReference)),
    [streamedBlocks, text, presentation, resolveReference],
  );
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string; resolveReference: typeof resolveReference } | null>(null);

  const handleCopy = useCallback(async (button: HTMLButtonElement, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }

    const previousTimer = codeCopyResetTimers.current.get(button);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }

    setCopyButtonState(button, true);

    const resetTimer = window.setTimeout(() => {
      setCopyButtonState(button, false);
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
      void renderHighlightedMarkdownHtml(text, presentation, resolveReference).then((html) => {
        if (!cancelled && html.trim()) setHighlightedHtml({ text, html, resolveReference });
      }).catch(() => {
        if (!cancelled) setHighlightedHtml(null);
      });
    });
    return () => {
      cancelled = true;
      stopObserving();
    };
  }, [isEmpty, rendered.kind, streaming, text, presentation, resolveReference]);

  const mermaidDiagrams = useMermaidEnhancer(rootRef, rendered, !streaming);

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
      applyBlockDirection(root, text);
      syncCodeWrapStates();
    });
  }, [highlightQuery, rendered, text]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !githubReferences) return;
    decorateGitHubReferences(root);
  }, [githubReferences, rendered]);

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
      // A video that cannot load reads as its plain inline reference instead
      // of an empty player in the middle of the sentence.
      const showError = () => {
        const box = video.closest("[data-openwork-video]");
        const fallback = box?.querySelector(":scope > [data-openwork-video-fallback]");
        if (!box || !(fallback instanceof HTMLElement)) return;
        box.replaceWith(...Array.from(fallback.childNodes));
      };
      video.addEventListener("error", showError);
      videoCleanups.current.set(video, () => {
        cancelled = true;
        video.removeEventListener("error", showError);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });
      if (/^https?:/i.test(href)) continue;
      // Streaming and clicking use the same candidate resolution. Streaming
      // never probes the desktop or downloads outside the owning workspace.
      const target = targetAt(href, video, video.dataset.openworkPathDecode === "true");
      if (!client || !workspaceId || !target) {
        showError();
        continue;
      }
      void (async () => {
        const plan = await planFileOpen(target, {
          origin: "remote", workspaceRoot, canOpenLocally: false, sessionTargets: sessionFileEvidence,
          findInWorkspace: (lookup, options) => resolveCollectibleOpenTarget(client, workspaceId, lookup, sessionId, options),
        });
        if (cancelled) return;
        if (plan.kind !== "workspace") { showError(); return; }
        const path = plan.target.value;
        const result = await client.downloadWorkspaceFile(workspaceId, path, { sessionId, fileScope: plan.target.fileScope });
        if (cancelled) return;
        const extension = path.split(".").pop()?.toLowerCase();
        const fallbackType = extension === "webm" ? "video/webm" : extension === "ogv" ? "video/ogg" : extension === "mov" ? "video/quicktime" : "video/mp4";
        const contentType = result.contentType && result.contentType !== "application/octet-stream" ? result.contentType : fallbackType;
        const url = URL.createObjectURL(new Blob([result.data], { type: contentType }));
        objectUrl = url;
        video.src = url;
      })().catch(() => { if (!cancelled) showError(); });
    }
  }, [client, workspaceId, workspaceRoot, sessionId, sessionFileEvidence, targetAt, rendered]);

  // A local image in a reply: one this chat's computer use saved on this Mac, or a
  // workspace file. Until it loads (or when it cannot) the reply shows its file reference.
  const loadLocalImage = useCallback(async (href: string, node: Element, decode: boolean) => {
    const literal = openTargetFromLocalPath(href, { decode })?.value;
    if (literal && sessionId && isElectronRuntime()) {
      const saved = await desktopBridge.computerChatImage({ sessionId, path: literal }).catch(() => null);
      if (saved) return URL.createObjectURL(new Blob([saved.data], { type: saved.contentType }));
    }
    const target = targetAt(href, node, decode);
    if (!client || !workspaceId || !target) return null;
    const plan = await planFileOpen(target, {
      origin: "remote", workspaceRoot, canOpenLocally: false, sessionTargets: sessionFileEvidence,
      findInWorkspace: (lookup, options) => resolveCollectibleOpenTarget(client, workspaceId, lookup, sessionId, options),
    });
    if (plan.kind !== "workspace") return null;
    const result = await client.downloadWorkspaceFile(workspaceId, plan.target.value, { sessionId, fileScope: plan.target.fileScope });
    const type = result.contentType && result.contentType !== "application/octet-stream" ? result.contentType : "";
    return URL.createObjectURL(new Blob([result.data], { type }));
  }, [client, workspaceId, workspaceRoot, sessionId, sessionFileEvidence, targetAt]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const image of root.querySelectorAll("img[data-openwork-image-path]")) {
      if (!(image instanceof HTMLImageElement) || image.dataset.openworkImageState) continue;
      image.dataset.openworkImageState = "loading";
      const href = image.dataset.openworkImagePath ?? "";
      const decode = image.dataset.openworkPathDecode === "true";
      const key = `${decode}:${href}`;
      let pending = localImageUrls.current.get(key);
      if (!pending) {
        pending = loadLocalImage(href, image, decode).catch(() => null);
        localImageUrls.current.set(key, pending);
      }
      const cache = localImageUrls.current;
      void pending.then((url) => {
        // A file that is not there yet (still saving) is tried again on the next render.
        if (!url) { if (cache.get(key) === pending) cache.delete(key); return; }
        if (!image.isConnected) return;
        image.addEventListener("load", () => {
          const box = image.closest("[data-openwork-image]");
          const preview = image.closest("[data-openwork-image-preview]");
          if (box && preview) box.replaceWith(preview);
        }, { once: true });
        image.src = url;
      });
    }
  }, [loadLocalImage, rendered]);

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
        void handleCopy(copyButton, code?.textContent ?? "");
        return;
      }

      const quoteCopyButton = event.target.closest("[data-openwork-quote-copy]");
      if (quoteCopyButton instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();
        void handleCopy(quoteCopyButton, quoteCopyButton.dataset.openworkQuoteCopy ?? "");
        return;
      }

      const inlineCodePath = event.target.closest("[data-openwork-inline-code-path]");
      if (inlineCodePath instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const target = targetAt(inlineCodePath.dataset.openworkInlineCodePath ?? "", inlineCodePath, inlineCodePath.dataset.openworkPathDecode === "true");
        if (target) onOpenTarget?.(target);
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
        const target = targetAt(href, chevron);
        if (target) {
          setLinkMenu({ target, anchor: chevron });
        }
        return;
      }

      const link = event.target.closest("a[data-openwork-link-href]");
      if (link instanceof HTMLAnchorElement) {
        const href = link.dataset.openworkLinkHref ?? link.getAttribute("href") ?? "";
        const target = targetAt(href, link);

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
      const target = targetAt(href, link);
      if (target?.kind !== "file") return;
      event.preventDefault();
      event.stopPropagation();
      setLinkMenu({ target, anchor: link });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-openwork-inline-code-path]")) return;

      event.preventDefault();
      event.stopPropagation();
      const target = targetAt(event.target.dataset.openworkInlineCodePath ?? "", event.target, event.target.dataset.openworkPathDecode === "true");
      if (target) onOpenTarget?.(target);
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
  }, [handleCopy, onOpenTarget, targetAt, rendered, references, resolveReference, sessionReferences]);

  if (isEmpty) {
    return null;
  }

  const rootClassName = cn("markdown-content max-w-none select-text text-foreground", className);
  const rootDirection = textDirectionOf(text) ?? "ltr";

  return (
    <>
      {rendered.kind === "blocks" ? (
        // Keyed by kind so the switch to the settled document remounts the root
        // instead of mixing children with dangerouslySetInnerHTML.
        <div key="blocks" ref={rootRef} className={rootClassName} dir={rootDirection} {...props}>
          {rendered.blocks.map((block, index) => (
            block.__html ? <div key={index} dangerouslySetInnerHTML={block} /> : null
          ))}
        </div>
      ) : (
        <div
          key="document"
          ref={rootRef}
          className={rootClassName}
          dir={rootDirection}
          dangerouslySetInnerHTML={stableInnerHtml}
          {...props}
        />
      )}
      {linkMenu && onOpenTarget ? (
        <LinkActionMenu
          key={linkMenu.target.value}
          target={linkMenu.target}
          anchor={linkMenu.anchor}
          onOpenTarget={onOpenTarget}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}
      <MermaidZoomPortals diagrams={mermaidDiagrams} />
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
