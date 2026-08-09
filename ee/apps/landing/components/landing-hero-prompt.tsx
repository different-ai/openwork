"use client";

/**
 * Hero agent-install prompt with copied feedback states.
 */

import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { capturePosthogEvent } from "../lib/posthog-client";
import { LandingAgentGlyphs } from "./landing-agent-glyphs";

const PROMPT_VARIANT = "hero";
export const AGENT_START_PROMPT = `Install OpenWork on my computer, set up my first workspace, and open it ready to use. Follow the steps in https://openworklabs.com/start.md?v=${PROMPT_VARIANT}`;

type CopyMethod = "clipboard" | "execCommand" | "none";

type Props = {
  className?: string;
  compact?: boolean;
};

const steps = ["Installs OpenWork", "Creates your workspace", "Opens ready to run"];

export function LandingHeroPrompt({ className, compact = false }: Props) {
  const [feedback, setFeedback] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revealed, setRevealed] = useState(false);
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
      await navigator.clipboard.writeText(AGENT_START_PROMPT);
      copied = true;
      method = "clipboard";
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = AGENT_START_PROMPT;
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
    if (copied) setRevealed(true);
    capturePosthogEvent("landing_copy_prompt_clicked", {
      copied,
      method,
      variant: PROMPT_VARIANT,
      placement: "hero"
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
      aria-label="Copy the agent setup prompt"
      title={AGENT_START_PROMPT}
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
        <div className="mb-2 text-[13px] text-[var(--lp-muted)]">
          Already use an AI agent? Paste this prompt — it installs OpenWork for you.
        </div>
        <p className="text-[15px] leading-relaxed text-[#011627]">
          Install OpenWork on my computer, set up my first workspace, and open it
          ready to use. Follow the steps in{" "}
          <span className="text-[var(--lp-muted)]">
            https://openworklabs.com/start.md?v={PROMPT_VARIANT}
          </span>
          <span
            className="hero-prompt-caret ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-[#011627]"
            aria-hidden="true"
          />
        </p>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[var(--lp-faint)]">
            <LandingAgentGlyphs />
            <span className="hidden text-xs text-[var(--lp-faint)] sm:inline">
              Works with Claude Code, Cursor, Codex — any agent
            </span>
          </div>
          {copyButton}
        </div>
        <AnimatePresence initial={false}>
          {revealed ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <div className="mt-3 border-t border-[#F1F5F9] pt-3">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[#011627]">
                  <Check
                    className="h-5 w-5 shrink-0 text-green-600"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  Copied — now paste it into Claude Code, Cursor, or ChatGPT:
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
                  {steps.map((label, index) => (
                    <div key={label} className="flex items-center gap-2">
                      {index > 0 ? <ChevronRight size={12} className="text-[var(--lp-faint)]" /> : null}
                      <span className="step-circle">{index + 1}</span>
                      <span className="text-[13px] text-[var(--lp-body)]">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <span aria-live="polite" className="sr-only">
        {feedback ? (copyError ? "Couldn't copy the prompt" : "Prompt copied to clipboard") : ""}
      </span>
    </div>
  );
}
