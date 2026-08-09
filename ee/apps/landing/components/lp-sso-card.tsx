"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const signInUrl = "app.openworklabs.com/sso/acme";

export function LpSsoCard() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`https://${signInUrl}`);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-[24px] bg-[var(--lp-tonal)] p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-[14px] font-semibold text-[var(--lp-ink)]">Current connection</h3>
        <button type="button" className="lp-pill-secondary lp-pill-sm">Edit connection</button>
      </div>

      <div className="mt-5 grid items-stretch gap-3 sm:grid-cols-2">
        <div className="rounded-[10px] bg-white p-4">
          <div className="text-[10px] font-bold tracking-[0.1em] text-[var(--lp-faint)]">PROVIDER</div>
          <div className="mt-2 text-[14px] font-semibold text-[var(--lp-ink)]">okta · SAML</div>
          <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--lp-muted)]">
            <span className="h-2 w-2 rounded-full bg-[#10B981]" />
            Domain verified: acme.dev
          </div>
        </div>
        <div className="rounded-[10px] bg-white p-4">
          <div className="text-[10px] font-bold tracking-[0.1em] text-[var(--lp-faint)]">STATUS</div>
          <div className="mt-2 flex items-center gap-2 text-[14px] font-semibold text-[#059669]">
            <span className="h-2 w-2 rounded-full bg-[#10B981]" /> Active
          </div>
          <div className="mt-2 text-[12px] text-[var(--lp-muted)]">Last tested: 2 days ago</div>
        </div>
      </div>

      <div className="mt-2.5 flex flex-col gap-2.5">
        <div className="flex flex-col gap-3 rounded-[10px] bg-white px-4 py-3 sm:flex-row sm:items-center">
          <span className="w-24 shrink-0 text-[10px] font-bold tracking-[0.1em] text-[var(--lp-faint)]">SIGN-IN URL</span>
          <code className="mono min-w-0 flex-1 overflow-x-auto text-[12px] text-[var(--lp-ink)]">{signInUrl}</code>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[var(--lp-tonal)] px-3 text-[12px] text-[var(--lp-ink)] active:scale-[0.97]"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="flex flex-col gap-2 rounded-[10px] bg-white px-4 py-3 sm:flex-row sm:items-center">
          <span className="w-24 shrink-0 text-[10px] font-bold tracking-[0.1em] text-[var(--lp-faint)]">SCIM</span>
          <span className="flex-1 text-[12px] text-[var(--lp-body)]">143 seats synced from Okta · hourly</span>
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-[#059669]">
            <span className="h-2 w-2 rounded-full bg-[#10B981]" /> Healthy
          </span>
        </div>
      </div>
    </div>
  );
}
