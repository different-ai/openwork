"use client";

/**
 * Hero agent-install prompt with copied feedback states.
 */

import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { capturePosthogEvent } from "../lib/posthog-client";
import { LandingAgentGlyphs } from "./landing-agent-glyphs";

const PROMPT_VARIANT = "hero";
export const AGENT_START_PROMPT = `Install OpenWork on my computer, set up my first workspace, and open it ready to use. Follow the steps in https://openworklabs.com/start.md?v=${PROMPT_VARIANT}`;

type CopyMethod = "clipboard" | "execCommand" | "none";

type Props = {
  className?: string;
  compact?: boolean;
  /** Another prompt for another page; defaults to the setup prompt. */
  prompt?: string;
  heading?: string;
  description?: string;
  /** Analytics variant and placement for this card. */
  variant?: string;
  placement?: string;
  /** Show the prompt text in the card, so people see what they paste. */
  showPrompt?: boolean;
};

export function LandingHeroPrompt({
  className,
  compact = false,
  prompt = AGENT_START_PROMPT,
  heading = "Already use an AI agent?",
  description = "Paste one prompt. It installs and sets up OpenWork for you.",
  variant = PROMPT_VARIANT,
  placement = "hero",
  showPrompt = false
}: Props) {
  const [feedback, setFeedback] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const onClick = async () => {
    let copied = false;
    let method: CopyMethod = "none";
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
      method = "clipboard";
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:absolute;left:-9999px;top:-9999px;";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        copied = document.execCommand("copy");
        if (copied) method = "execCommand";
      } catch {}
      textarea.remove();
    }
    setCopyError(!copied);
    setFeedback(true);
    capturePosthogEvent("landing_copy_prompt_clicked", {
      copied,
      method,
      variant,
      placement
    });
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setFeedback(false);
      resetTimer.current = null;
    }, 2500);
  };

  const copyButton = (
    <button
      type="button"
      aria-label={prompt === AGENT_START_PROMPT ? "Copy the agent setup prompt" : "Copy the prompt"}
      title={prompt}
      onClick={(event) => {
        event.stopPropagation();
        void onClick();
      }}
      className={
        compact
          ? "lp-pill-secondary lp-pill-sm"
          : "inline-flex min-w-[110px] items-center justify-center gap-1.5 rounded-lg bg-[var(--lp-ink)] px-4 py-2 text-xs font-medium text-white shadow-[0_1px_2px_rgba(1,22,39,0.12)] transition-colors hover:bg-black"
      }
    >
      {feedback ? (
        copyError ? (
          "Couldn't copy"
        ) : (
          <>
            <Check className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            Copied
          </>
        )
      ) : (
        "Copy prompt"
      )}
    </button>
  );

  if (compact) {
    return (
      <div
        className={className}
        data-feedback={feedback ? "true" : "false"}
        data-copy-error={copyError ? "true" : "false"}
      >
        {copyButton}
        <span aria-live="polite" className="sr-only">
          {feedback ? (copyError ? "Couldn't copy the prompt" : "Prompt copied to clipboard") : ""}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`group/copy relative ${className ?? ""}`}
      data-feedback={feedback ? "true" : "false"}
      data-copy-error={copyError ? "true" : "false"}
    >
      <div
        onClick={() => {
          void onClick();
        }}
        className="group cursor-pointer rounded-2xl bg-white p-5 shadow-[0_8px_24px_rgba(1,22,39,0.05)] transition-shadow hover:shadow-[0_10px_28px_rgba(1,22,39,0.08)]"
      >
        <div className="text-[15px] leading-snug text-[#011627]">
          {heading}
        </div>
        <div className="mt-1 text-[13px] leading-relaxed text-[var(--lp-muted)]">
          {description}
        </div>
        {showPrompt ? (
          <p className="mt-4 rounded-xl bg-[var(--lp-tonal)] px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-[var(--lp-ink)]">
            {prompt}
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[var(--lp-faint)]">
            <LandingAgentGlyphs />
            <span className="hidden text-xs text-[var(--lp-faint)] sm:inline">
              Claude Code, Cursor, Codex, or any agent
            </span>
          </div>
          {copyButton}
        </div>
      </div>
      <span aria-live="polite" className="sr-only">
        {feedback ? (copyError ? "Couldn't copy the prompt" : "Prompt copied to clipboard") : ""}
      </span>
    </div>
  );
}
