"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, Clock3, Loader2, Minus, ShieldCheck, X, XCircle } from "lucide-react";
import type {
  McpDiagnosticEvent,
  McpDiagnosticSnapshot,
  McpDiagnosticStreamMessage,
} from "@openwork/types/den/mcp-diagnostics";
import { DenButton } from "../../_components/ui/button";
import type { ExternalMcpConnection } from "./mcp-connections-data";
import {
  isSafeMcpAuthorizationUrl,
  MCP_DIAGNOSTIC_CATALOG_READY_SCOPE_BOUNDARY,
  selectMcpDiagnosticTimelineEvents,
  shouldShowMcpDiagnosticScopeBoundary,
  useMcpConnectionDiagnosticStream,
} from "./mcp-connections-data";

function phaseLabel(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function durationLabel(value: number | null): string {
  if (value === null) return "";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function timingLabel(event: McpDiagnosticEvent): string {
  return event.phaseDurationMs === null
    ? `T+${durationLabel(event.elapsedMs)}`
    : durationLabel(event.phaseDurationMs);
}

function EventStatus({ event }: { event: McpDiagnosticEvent }) {
  if (event.outcome === "running" || event.outcome === "waiting") {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" aria-hidden />;
  }
  if (event.outcome === "failed") {
    return <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />;
  }
  if (event.outcome === "skipped") {
    return <Minus className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />;
  }
  return <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />;
}

function Evidence({ event }: { event: McpDiagnosticEvent }) {
  const evidence = event.evidence;
  const values = [
    evidence.origin,
    evidence.path,
    typeof evidence.status === "number" ? `HTTP ${evidence.status}` : undefined,
    evidence.protocolVersion ? `MCP ${evidence.protocolVersion}` : undefined,
    typeof evidence.toolCount === "number" ? `${evidence.toolCount} tools` : undefined,
    typeof evidence.pageCount === "number" ? `${evidence.pageCount} pages` : undefined,
    evidence.errorCode,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length === 0) return null;
  return <p className="mt-1 break-all font-mono text-[10px] leading-4 text-gray-400">{values.join(" · ")}</p>;
}

export function McpConnectionDiagnosticsDialog({
  connection,
  onClose,
}: {
  connection: ExternalMcpConnection | null;
  onClose: () => void;
}) {
  const streamDiagnostic = useMcpConnectionDiagnosticStream();
  const abortController = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<McpDiagnosticSnapshot | null>(null);
  const [events, setEvents] = useState<McpDiagnosticEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);

  useEffect(() => {
    if (connection) return;
    abortController.current?.abort();
    abortController.current = null;
    setSnapshot(null);
    setEvents([]);
    setRunning(false);
    setError(null);
    setAuthorizationUrl(null);
  }, [connection]);

  useEffect(() => () => abortController.current?.abort(), []);

  const phases = useMemo(() => selectMcpDiagnosticTimelineEvents(events), [events]);

  function applyMessage(message: McpDiagnosticStreamMessage) {
    if (message.type === "authorization_required") {
      if (!isSafeMcpAuthorizationUrl(message.authorizeUrl)) {
        setError("The provider returned an unsafe authorization URL.");
        abortController.current?.abort();
        return;
      }
      setAuthorizationUrl(message.authorizeUrl);
      return;
    }
    if (message.type === "event") {
      setSnapshot((current) => ({
        attempt: message.attempt,
        events: current?.events ?? [],
      }));
      setEvents((current) => {
        const withoutCurrent = current.filter((event) => event.sequence !== message.event.sequence);
        return [...withoutCurrent, message.event].sort((left, right) => left.sequence - right.sequence);
      });
      return;
    }
    setSnapshot(message.snapshot);
    setEvents(message.snapshot.events);
    if (message.type === "complete") {
      setAuthorizationUrl(null);
      setRunning(false);
    }
  }

  async function runDiagnostic() {
    if (!connection) return;
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    setSnapshot(null);
    setEvents([]);
    setError(null);
    setAuthorizationUrl(null);
    setRunning(true);
    try {
      await streamDiagnostic({ connectionId: connection.id, signal: controller.signal, onMessage: applyMessage });
    } catch (streamError) {
      if (!controller.signal.aborted) {
        setError(streamError instanceof Error ? streamError.message : "The diagnostic stream stopped unexpectedly.");
      }
    } finally {
      if (abortController.current === controller) {
        abortController.current = null;
        setRunning(false);
      }
    }
  }

  if (!connection) return null;

  const attempt = snapshot?.attempt;
  const failureEvent = attempt?.firstFailedPhase
    ? [...events].reverse().find((event) => event.phase === attempt.firstFailedPhase && event.outcome === "failed")
    : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        data-testid="mcp-diagnostic-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-diagnostic-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-gray-900" aria-hidden />
              <h2 id="mcp-diagnostic-title" className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Diagnose {connection.name}</h2>
            </div>
            <p className="mt-2 text-[13px] leading-6 text-gray-600">
              This test runs from the Den server. It records phase metadata only — never tokens, authorization codes, session IDs, tool arguments, or customer content.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close diagnostics" className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2" aria-live="polite">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">Highest health</p>
            <p data-testid="mcp-diagnostic-health" className="mt-1 text-[15px] font-semibold text-gray-900">
              {attempt ? phaseLabel(attempt.highestHealthLevel) : "Not started"}
            </p>
          </div>
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">First failure</p>
            <p data-testid="mcp-diagnostic-first-failure" className={`mt-1 text-[15px] font-semibold ${attempt?.firstFailedPhase ? "text-red-700" : "text-gray-900"}`}>
              {attempt?.firstFailedPhase
                ? phaseLabel(attempt.firstFailedPhase)
                : attempt?.status === "succeeded"
                  ? "None"
                  : running
                    ? "None so far"
                    : "Not tested"}
            </p>
          </div>
        </div>

        {shouldShowMcpDiagnosticScopeBoundary(attempt) ? (
          <div
            data-testid="mcp-diagnostic-scope-boundary"
            role="status"
            className="mt-3 flex items-start gap-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-[11px] leading-5 text-sky-900"
          >
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{MCP_DIAGNOSTIC_CATALOG_READY_SCOPE_BOUNDARY}</span>
          </div>
        ) : null}

        {attempt?.firstFailureMessage ? (
          <div className="mt-4 rounded-2xl border border-red-100 bg-red-50 p-4" data-testid="mcp-diagnostic-remediation">
            <p className="text-[13px] font-semibold text-red-900">{attempt.firstFailureMessage}</p>
            <p className="mt-1 text-[12px] leading-5 text-red-700">
              Owner: {phaseLabel(attempt.actionOwner ?? failureEvent?.actionOwner ?? "provider_admin")} ·{" "}
              Action: {phaseLabel(attempt.operatorAction ?? failureEvent?.operatorAction ?? "inspect_provider_and_den_logs")}
            </p>
          </div>
        ) : null}

        <div className="mt-5 rounded-2xl border border-gray-100">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="text-[13px] font-semibold text-gray-900">Live connection timeline</p>
            {running ? <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700"><Loader2 className="h-3.5 w-3.5 animate-spin" />Live</span> : null}
          </div>
          <div data-testid="mcp-diagnostic-timeline" className="divide-y divide-gray-100">
            {phases.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-gray-500">Run the diagnostic to see each Den-side phase.</p>
            ) : phases.map((event) => {
              const samePhase = phases.filter((candidate) => candidate.phase === event.phase);
              const candidateIndex = samePhase.findIndex((candidate) => candidate.id === event.id);
              return (
              <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                <EventStatus event={event} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-semibold text-gray-900">
                        {phaseLabel(event.phase)}
                        {samePhase.length > 1 ? (
                          <span className="ml-2 font-normal text-gray-400">Candidate {candidateIndex + 1} of {samePhase.length}</span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-[12px] leading-5 text-gray-600">{event.messageSafe}</p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-gray-400">
                      <Clock3 className="h-3 w-3" />
                      {timingLabel(event)}
                    </span>
                  </div>
                  <Evidence event={event} />
                </div>
              </div>
              );
            })}
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-100 bg-emerald-50 p-3 text-[11px] leading-5 text-emerald-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Support evidence is strictly redacted and retained for 24 hours.</span>
        </div>

        {error ? <p className="mt-3 text-[13px] text-red-600">{error}</p> : null}

        {authorizationUrl && running ? (
          <div className="mt-4 rounded-2xl border border-amber-100 bg-amber-50 p-4">
            <p className="text-[13px] font-semibold text-amber-950">Provider authorization is required</p>
            <p className="mt-1 text-[12px] leading-5 text-amber-800">Open the provider in a new tab, finish consent, then return here. The live diagnostic will continue automatically.</p>
            <a
              data-testid="mcp-diagnostic-continue-authorization"
              href={authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center justify-center rounded-full bg-gray-950 px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-gray-800"
            >
              Continue authorization
            </a>
          </div>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose}>Close</DenButton>
          <DenButton variant="primary" loading={running} disabled={running} onClick={() => void runDiagnostic()}>
            {attempt ? "Run again" : "Run diagnostic"}
          </DenButton>
        </div>
      </div>
    </div>
  );
}
