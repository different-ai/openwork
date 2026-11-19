"use client";

/**
 * The tab that opens while someone signs in to a connector.
 * It is usually on screen for under a second before the provider's page replaces it,
 * so it carries one focal line (DESIGN P7), reports state rather than explaining
 * itself (P1), offers a way back if the hand-off stalls (C6), and keeps diagnostics
 * behind "Technical details" (P3).
 */

import { Check, ChevronRight, Copy, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { DenButton } from "../../(den)/_components/ui/button";
import { ConnectorLogo } from "../../(den)/dashboard/_components/item-logo";
import {
  describeMcpAuthorizationFailure,
  type McpAuthorizationDebugDetails,
} from "../../(den)/dashboard/_components/mcp-authorization-url";
import { detailRows, fallbackCopy } from "./oauth-details";

const CONNECTIONS_HREF = "/dashboard/your-connections";
/** A provider page normally replaces this tab within a few seconds. */
const SLOW_AFTER_MS = 12_000;

/** "Linear (live)" is the admin's label; the logo belongs to "Linear". */
function brandName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-gray-50 px-5 pb-16 pt-[18vh] text-[var(--dls-text-primary)] sm:items-center sm:pt-16">
      <div className="w-full max-w-[420px]" data-testid="connect-handoff-screen">{children}</div>
    </main>
  );
}

function Handoff({ connectionName, state }: { connectionName: string; state: "pending" | "failed" }) {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="flex size-10 items-center justify-center rounded-xl border border-gray-200 bg-white">
        <img src="/openwork-mark.svg" alt="" width={20} height={20} />
      </span>
      {state === "pending" ? (
        <span className="flex items-center gap-1.5 text-gray-900">
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="ow-handoff-dot size-1 rounded-full bg-current" style={{ animationDelay: `${dot * 160}ms` }} />
          ))}
        </span>
      ) : (
        <span className="flex size-5 items-center justify-center rounded-full bg-red-50 text-red-600">
          <X className="size-3" strokeWidth={2.25} />
        </span>
      )}
      <ConnectorLogo name={brandName(connectionName)} size="lg" />
    </div>
  );
}

export function ConnectPending({ connectionName }: { connectionName: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    document.title = `Signing in to ${connectionName} — OpenWork`;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [connectionName]);

  return (
    <Shell>
      <Handoff connectionName={connectionName} state="pending" />
      <h1 className="mt-6 text-[20px] font-semibold leading-7 tracking-[-0.3px]">Opening {connectionName}</h1>
      <p role="status" aria-live="polite" className="mt-1 text-[14px] leading-5 text-[var(--dls-text-secondary)]">
        {slow ? `${connectionName} is taking longer than usual.` : "Keep this tab open to finish signing in."}
      </p>
      {slow ? (
        <div className="mt-6 flex flex-wrap gap-2">
          <DenButton size="sm" variant="secondary" href={CONNECTIONS_HREF}>Back to your connections</DenButton>
        </div>
      ) : null}
    </Shell>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      else if (!fallbackCopy(value)) throw new Error("copy");
      setState("copied");
    } catch {
      setState(fallbackCopy(value) ? "copied" : "failed");
    }
  }
  return (
    <div className="flex items-center gap-3 border-t border-gray-100 py-3">
      <span className="w-20 shrink-0 text-[13px] text-[var(--dls-text-secondary)]">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-gray-800 select-all" title={value}>{value}</code>
      <DenButton size="xs" variant="ghost" icon={state === "copied" ? Check : Copy} onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
      </DenButton>
    </div>
  );
}

export function ConnectFailure({ connectionName, message, details }: {
  connectionName: string;
  message: string;
  details?: McpAuthorizationDebugDetails;
}) {
  const failure = describeMcpAuthorizationFailure({ connectionName, message, details });
  useEffect(() => {
    document.title = `Couldn't sign in to ${connectionName} — OpenWork`;
  }, [connectionName]);
  const rows = [
    ...(failure.description === message ? [] : [{ label: "Message", value: message }]),
    ...(details ? detailRows(details) : []),
  ];

  return (
    <Shell>
      <Handoff connectionName={connectionName} state="failed" />
      <h1 className="mt-6 text-[20px] font-semibold leading-7 tracking-[-0.3px]" role="alert">{failure.title}</h1>
      <p className="mt-1.5 text-[14px] leading-[1.6] text-[var(--dls-text-secondary)]">{failure.description}</p>

      {failure.advice.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-[13px] font-semibold text-gray-900">What to do next</h2>
          {failure.advice.length === 1 ? (
            <p className="mt-1.5 text-[14px] leading-[1.55] text-gray-700">{failure.advice[0]}</p>
          ) : (
          <ol className="mt-2 flex flex-col gap-1.5 text-[14px] leading-[1.55] text-gray-700">
            {failure.advice.map((advice, index) => (
              <li key={advice} className="flex gap-2.5">
                <span className="mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-medium text-gray-500">{index + 1}</span>
                <span className="min-w-0 break-words">{advice}</span>
              </li>
            ))}
          </ol>
          )}
        </section>
      ) : null}

      {failure.copyable.length > 0 ? (
        <div className="mt-6 border-b border-gray-100">
          {failure.copyable.map((item) => <CopyValue key={item.label} label={item.label} value={item.value} />)}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <details className="group mt-4">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded py-1.5 text-[13px] text-[var(--dls-text-secondary)] outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-300 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-150 ease-out group-open:rotate-90" aria-hidden="true" />
            Technical details
          </summary>
          <dl className="mt-2 rounded-xl border border-gray-100 bg-white px-4">
            {rows.map((row) => (
              <div key={row.label} className="grid gap-0.5 border-b border-gray-100 py-2.5 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
                <dt className="text-[12px] text-[var(--dls-text-secondary)]">{row.label}</dt>
                <dd className="m-0 break-all font-mono text-[12px] leading-5 select-all">{row.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-2">
        <DenButton size="sm" href={CONNECTIONS_HREF}>Back to your connections</DenButton>
        <DenButton size="sm" variant="ghost" onClick={() => window.close()}>Close tab</DenButton>
      </div>
    </Shell>
  );
}
