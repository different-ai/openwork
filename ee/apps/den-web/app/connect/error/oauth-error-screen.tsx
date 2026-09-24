"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { DenStatusScreen } from "../../../components/den-status-screen";
import { describeOAuthError, type OAuthErrorPageState } from "./describe-oauth-error";

export function OAuthErrorContent({ state }: { state: OAuthErrorPageState }) {
  return (
    <DenStatusScreen title={state.title} description={state.description} error={state.detail ?? "The app can't finish signing in."}>
      <div className="mt-8">
        <h2 className="text-[14px] font-semibold">What to do next</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[14px] leading-5 text-[var(--dls-text-secondary)]">
          {state.advice.map((advice) => <li key={advice}>{advice}</li>)}
        </ul>
      </div>

      <details className="mt-8 rounded-xl border border-[var(--dls-border)]">
        <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold">Technical details</summary>
        <dl className="border-t border-[var(--dls-border)] px-4 py-2">
          <div className="grid gap-1 border-b border-[var(--dls-border)] py-3 last:border-b-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
            <dt className="text-[12px] text-[var(--dls-text-secondary)]">Error code</dt>
            <dd className="m-0 break-all font-mono text-[12px] leading-5 select-all">{state.code}</dd>
          </div>
          {state.detail ? (
            <div className="grid gap-1 border-b border-[var(--dls-border)] py-3 last:border-b-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-[12px] text-[var(--dls-text-secondary)]">Description</dt>
              <dd className="m-0 break-all font-mono text-[12px] leading-5 select-all">{state.detail}</dd>
            </div>
          ) : null}
        </dl>
      </details>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--dls-border)] pt-6 text-[13px] text-[var(--dls-text-secondary)]">
        <span>You can close this tab.</span>
        <Link href="/" className="font-medium text-[var(--dls-text-primary)] underline underline-offset-4">
          Back to OpenWork
        </Link>
      </div>
    </DenStatusScreen>
  );
}

function OAuthErrorFromQuery() {
  const searchParams = useSearchParams();
  const state = useMemo(() => describeOAuthError(new URLSearchParams(searchParams.toString())), [searchParams]);
  return <OAuthErrorContent state={state} />;
}

export function OAuthErrorScreen() {
  return (
    <Suspense fallback={<OAuthErrorContent state={describeOAuthError(new URLSearchParams())} />}>
      <OAuthErrorFromQuery />
    </Suspense>
  );
}
