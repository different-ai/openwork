"use client";

import { Check, CircleAlert, Copy, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import type { DiagnosticsAttention, OrgDiagnostics } from "@openwork/types/den/diagnostics";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenNotice } from "../../app/(den)/_components/ui/notice";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import { DIAGNOSTICS_COPY, SECTION_TITLES, attentionCopy, attentionCountLabel, checkedAgoLabel } from "./diagnostics-copy";
import { diagnosticsRowId, formatAgo, latestCheckedAt, orderAttention, overallStatus, type OverallStatus } from "./diagnostics-data";
import { DiagnosticsSkeletonRow } from "./diagnostics-row";
import { ConnectorsSection, DesktopSection, InstallationSection, NetworkSection, ProvidersSection } from "./diagnostics-sections";
import type { DiagnosticsFailure } from "./diagnostics-transport";

export type DiagnosticsViewProps = {
  report: OrgDiagnostics | null;
  loading: boolean;
  /** Why the latest read failed; the last report stays on screen when there is one. */
  loadFailure: DiagnosticsFailure | null;
  checkFailed: boolean;
  checking: boolean;
  /** Seconds until Check now is admitted again after a rate limit. */
  cooldownSeconds: number | null;
  copied: boolean;
  now: number;
  orgSlug: string | null;
  onCheckNow: () => void;
  onCopyReport: () => void;
  onRetry: () => void;
  /** Advanced › Network check content, mounted only when its row is opened. */
  renderNetworkCheck: (canRun: boolean) => ReactNode;
};

const DOT_CLASSES: Record<OverallStatus["kind"] | "error", string> = {
  attention: "bg-amber-600",
  error: "bg-red-600",
  working: "bg-emerald-600",
  not_checked: "bg-gray-300",
};

/** Opens the target row and brings it into view; without script the anchor still jumps. */
function openRow(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!(target instanceof HTMLDetailsElement)) return;
  event.preventDefault();
  target.open = true;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  target.querySelector("summary")?.focus({ preventScroll: true });
}

function AttentionList({ items }: { items: readonly DiagnosticsAttention[] }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={DIAGNOSTICS_COPY.attentionList} data-testid="diagnostics-attention" className="mt-2.5 grid gap-1.5">
      {orderAttention(items).map((item) => {
        const copy = attentionCopy(item);
        const id = diagnosticsRowId(item.section, item.targetId);
        const AttentionIcon = item.severity === "error" ? CircleAlert : TriangleAlert;
        return (
          <li
            key={`${item.section}-${item.targetId}-${item.code}`}
            data-severity={item.severity}
            className={`flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px] text-[var(--dls-text-primary)] ${item.severity === "error" ? "bg-red-50" : "bg-amber-50"}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <AttentionIcon size={16} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 ${item.severity === "error" ? "text-red-600" : "text-amber-700"}`} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{copy.text}</span>
            </span>
            <a
              href={`#${id}`}
              onClick={(event) => openRow(event, id)}
              className="shrink-0 rounded font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-primary)]"
            >
              {copy.action}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function StatusLine({ report, checking, now }: { report: OrgDiagnostics; checking: boolean; now: number }) {
  const status = overallStatus(report);
  const ago = formatAgo(latestCheckedAt(report), now);
  const label = status.kind === "attention" ? attentionCountLabel(status.count)
    : status.kind === "working" ? DIAGNOSTICS_COPY.everythingWorking
    : DIAGNOSTICS_COPY.notCheckedYet;
  const dot = status.kind === "attention" && status.severity === "error" ? DOT_CLASSES.error : DOT_CLASSES[status.kind];
  // Desktop reports arrive on their own; only show a check time when a live check has run.
  const meta = checking ? DIAGNOSTICS_COPY.checking : status.kind === "not_checked" || !ago ? null : checkedAgoLabel(ago);
  return (
    <p role="status" data-testid="diagnostics-status" className="mt-[18px] flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <span className="inline-flex items-center gap-2 text-[15px] font-semibold text-[var(--dls-text-primary)]">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
        {label}
      </span>
      {meta ? <span className="text-[var(--dls-text-secondary)]">{meta}</span> : null}
    </p>
  );
}

function DiagnosticsSkeleton() {
  return (
    <div data-testid="diagnostics-loading" aria-busy="true">
      <DenSkeleton className="mt-[22px] h-4 w-48" />
      {[SECTION_TITLES.desktop, SECTION_TITLES.providers, SECTION_TITLES.installation].map((title, index) => (
        <div key={title} className="mt-[30px]">
          <DenSkeleton className="mb-2 h-3 w-24" />
          <ul className="border-t border-[var(--dls-border)]">
            {Array.from({ length: index === 1 ? 3 : 2 }, (_, row) => <DiagnosticsSkeletonRow key={row} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function FailureNotice({ failure, onRetry }: { failure: DiagnosticsFailure; onRetry: () => void }) {
  if (failure === "forbidden") return <DenNotice tone="neutral" icon={Lock} message={DIAGNOSTICS_COPY.forbidden} />;
  if (failure === "signed_out") return <DenNotice tone="neutral" icon={null} message={DIAGNOSTICS_COPY.signedOut} />;
  if (failure === "unsupported") return <DenNotice tone="neutral" icon={null} message={DIAGNOSTICS_COPY.unsupported} />;
  return (
    <DenNotice
      tone="error"
      message={DIAGNOSTICS_COPY.loadError}
      action={<DenButton variant="secondary" size="sm" onClick={onRetry}>{DIAGNOSTICS_COPY.retry}</DenButton>}
    />
  );
}

export function DiagnosticsView(props: DiagnosticsViewProps) {
  const { report, loading, loadFailure, checkFailed, checking, cooldownSeconds, copied, now, orgSlug } = props;
  const actions = (
    <div className="flex items-center gap-2">
      <DenButton data-testid="diagnostics-copy-report" variant="secondary" size="sm" icon={copied ? Check : Copy} disabled={!report} onClick={props.onCopyReport}>
        {copied ? DIAGNOSTICS_COPY.copied : DIAGNOSTICS_COPY.copyReport}
      </DenButton>
      <DenButton
        data-testid="diagnostics-check-now"
        size="sm"
        icon={RefreshCw}
        loading={checking}
        disabled={!report || cooldownSeconds !== null}
        title={cooldownSeconds !== null ? DIAGNOSTICS_COPY.cooldown(cooldownSeconds) : undefined}
        onClick={props.onCheckNow}
      >
        {DIAGNOSTICS_COPY.checkNow}
      </DenButton>
    </div>
  );

  return (
    <div data-testid="diagnostics-page" className="mx-auto w-full min-w-0 max-w-[880px] p-4 text-[13px] leading-[1.5] text-[var(--dls-text-primary)] sm:p-6 md:p-8">
      {/* The title keeps its width and the actions wrap below it on narrow screens. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">{DIAGNOSTICS_COPY.title}</h1>
        {actions}
      </div>
      {report ? (
        <>
          <StatusLine report={report} checking={checking} now={now} />
          <AttentionList items={report.attention} />
          {loadFailure ? <div className="mt-4"><FailureNotice failure={loadFailure} onRetry={props.onRetry} /></div> : null}
          {checkFailed ? <div className="mt-4"><DenNotice tone="error" message={DIAGNOSTICS_COPY.checkError} /></div> : null}
          <DesktopSection report={report} now={now} orgSlug={orgSlug} />
          <ProvidersSection report={report} now={now} orgSlug={orgSlug} />
          <ConnectorsSection report={report} now={now} orgSlug={orgSlug} />
          <InstallationSection report={report} now={now} orgSlug={orgSlug} />
          <NetworkSection report={report} renderNetworkCheck={props.renderNetworkCheck} />
        </>
      ) : loadFailure && !loading ? (
        <div className="mt-6"><FailureNotice failure={loadFailure} onRetry={props.onRetry} /></div>
      ) : (
        <DiagnosticsSkeleton />
      )}
    </div>
  );
}
