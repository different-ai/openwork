"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      }, 1600);
    } catch {
      setCopied(false);
    }
  };

  return { copied, copy };
}

type LpCopyButtonProps = {
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: "primary" | "secondary";
  className?: string;
};

/** Pill button that copies `value`. "Copy URL" → "Copied" (DESIGN.md C2). */
export function LpCopyButton({
  value,
  label = "Copy URL",
  copiedLabel = "Copied",
  variant = "primary",
  className
}: LpCopyButtonProps) {
  const { copied, copy } = useCopy(value);
  return (
    <button
      type="button"
      onClick={() => {
        void copy();
      }}
      aria-label={copied ? copiedLabel : `${label}: ${value}`}
      className={`${variant === "primary" ? "lp-pill-primary" : "lp-pill-secondary"} lp-pill-sm shrink-0 ${className ?? ""}`}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : null}
      {copied ? copiedLabel : label}
    </button>
  );
}

type LpCopyIconProps = {
  value: string;
  label: string;
};

/** Icon-only copy control for commands inside a code well. */
export function LpCopyIcon({ value, label }: LpCopyIconProps) {
  const { copied, copy } = useCopy(value);
  return (
    <button
      type="button"
      onClick={() => {
        void copy();
      }}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--lp-muted)] transition-colors duration-150 hover:bg-white hover:text-[var(--lp-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--lp-ink)]"
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </button>
  );
}
