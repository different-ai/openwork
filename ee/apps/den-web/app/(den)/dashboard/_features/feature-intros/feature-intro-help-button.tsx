"use client";

import { Dialog } from "@base-ui/react/dialog";
import { CircleHelp, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { UnseenDot } from "../../../_components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../_components/ui/tooltip";
import { useFeatureIntroRuntime } from "./feature-intro-provider";
import { useFeatureIntroDot } from "./feature-intro-gate";
import { FeatureIntroContent } from "./feature-intro-views";
import { getFeatureIntro } from "./intros";
import { introKeyDepth, matchFeatureIntro, pickIntroCta } from "./model";
import type { FeatureIntro } from "./types";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The current page's intro: the most specific of the URL match and the intros mounted on the page. */
function useCurrentIntro(): FeatureIntro | null {
  const { enabled, intros, activeKeys } = useFeatureIntroRuntime();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useMemo(() => {
    if (!enabled) return null;
    const candidates: FeatureIntro[] = [];
    const fromUrl = matchFeatureIntro(intros, pathname, searchParams);
    if (fromUrl) candidates.push(fromUrl);
    for (const key of activeKeys) {
      const intro = getFeatureIntro(key);
      if (intro) candidates.push(intro);
    }
    return candidates.reduce<FeatureIntro | null>(
      (best, intro) => (!best || introKeyDepth(intro.key) > introKeyDepth(best.key) ? intro : best),
      null,
    );
  }, [enabled, intros, activeKeys, pathname, searchParams]);
}

/**
 * `?` in the top bar (DESIGN.md I8): reopens the current page's intro at any
 * time, even when set up. Shortcut `?` when not typing. Hidden with the flag
 * off or when no intro covers the page. Render inside <Suspense> (search params).
 */
export function FeatureIntroHelpButton() {
  const { record, contextFor } = useFeatureIntroRuntime();
  const intro = useCurrentIntro();
  const unseen = useFeatureIntroDot(intro?.key ?? null);
  const [open, setOpen] = useState(false);
  const introKey = intro?.key ?? null;

  const openIntro = useCallback((next: boolean) => {
    setOpen(next);
    if (next && introKey) record(introKey, "seen");
  }, [introKey, record]);

  useEffect(() => {
    if (!introKey) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      openIntro(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [introKey, openIntro]);

  if (!intro) return null;
  const ctx = contextFor(intro.key);
  const cta = ctx ? pickIntroCta(intro, ctx) : null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              onClick={() => openIntro(true)}
              aria-label={unseen ? "About this page, not viewed yet" : "About this page"}
              aria-keyshortcuts="?"
              data-testid="feature-intro-help"
              className="relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
            />
          )}
        >
          <CircleHelp className="h-4 w-4" aria-hidden />
          {unseen ? (
            <span className="absolute right-2 top-1 size-1.5 rounded-full bg-gray-500" aria-hidden data-testid="feature-intro-help-dot" />
          ) : null}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          About this page <kbd className="ml-1 rounded bg-white/15 px-1 font-mono text-[11px]">?</kbd>
        </TooltipContent>
      </Tooltip>

      <Dialog.Root open={open} onOpenChange={openIntro}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
          <Dialog.Popup
            data-testid="feature-intro-dialog"
            aria-labelledby={`feature-intro-${intro.key}-title`}
            className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-[960px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[16px] border border-gray-200 bg-white p-6 outline-none md:p-10"
          >
            <Dialog.Close
              aria-label="Close"
              className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="size-4" strokeWidth={1.5} aria-hidden />
            </Dialog.Close>
            <FeatureIntroContent
              intro={intro}
              cta={cta}
              note={cta && ctx ? cta.note?.(ctx) ?? null : null}
              onCtaClick={() => {
                record(intro.key, "cta_clicked");
                setOpen(false);
              }}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/** Neutral unseen dot for a sidebar entry whose section intro hasn't been viewed (I9). */
export function FeatureIntroNavDot({ href }: { href: string }) {
  const { enabled, intros } = useFeatureIntroRuntime();
  const intro = enabled ? matchFeatureIntro(intros.filter((entry) => !entry.parent), href, null) : null;
  const unseen = useFeatureIntroDot(intro?.key ?? null);
  if (!unseen) return null;
  return <UnseenDot />;
}
