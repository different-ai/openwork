"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type LpCopyBarProps = {
  value: string;
};

export function LpCopyBar({ value }: LpCopyBarProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-[12px] bg-[var(--lp-terminal)] px-5 py-[18px] sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <code className="mono overflow-x-auto text-[14px] text-[#e2e8f0]">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
        className="lp-copy-button inline-flex h-9 min-w-[92px] shrink-0 items-center justify-center rounded-lg bg-white/10 px-3 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-white/15 active:scale-[0.97]"
        aria-label={`Copy ${value}`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? "copied" : "copy"}
            initial={reduceMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="inline-flex items-center gap-1.5"
          >
            {copied ? (
              <>
                <motion.svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <motion.path
                    d="m3 8 3 3 7-7"
                    initial={reduceMotion ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: reduceMotion ? 0 : 0.2 }}
                  />
                </motion.svg>
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                Copy
              </>
            )}
          </motion.span>
        </AnimatePresence>
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </div>
  );
}
