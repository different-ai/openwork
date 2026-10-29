"use client";

import {
  egressDiagnosticConfigurationSchema,
  egressDiagnosticRunSchema,
  type EgressDiagnosticRun,
  type EgressDiagnosticStep,
} from "@openwork/types/den/egress-diagnostics";
import {
  Activity,
  Check,
  CheckCircle2,
  CircleDashed,
  Copy,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DiagnosticsCode, DiagnosticsFacts } from "../../../../components/diagnostics/diagnostics-row";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { permissionLockReason } from "../../_lib/den-org";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenSkeleton } from "../../_components/ui/skeleton";

function statusStyles(status: EgressDiagnosticStep["status"]) {
  if (status === "passed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-800";
  return "border-gray-200 bg-gray-50 text-gray-500";
}

function StatusIcon({ status, size = "md" }: { status: EgressDiagnosticStep["status"]; size?: "md" | "sm" }) {
  const sizeClass = size === "sm" ? "mt-0.5 size-4 shrink-0" : "mt-0.5 h-5 w-5 shrink-0";
  if (status === "passed") return <CheckCircle2 aria-hidden="true" strokeWidth={1.5} className={`${sizeClass} ${size === "sm" ? "text-emerald-600" : ""}`} />;
  if (status === "failed") return <XCircle aria-hidden="true" strokeWidth={1.5} className={`${sizeClass} ${size === "sm" ? "text-red-600" : ""}`} />;
  return <CircleDashed aria-hidden="true" strokeWidth={1.5} className={`${sizeClass} ${size === "sm" ? "text-[var(--dls-text-secondary)]" : ""}`} />;
}

function ownerLabel(owner: EgressDiagnosticStep["owner"]) {
  if (owner === "network-administrator") return "Network administrator";
  if (owner === "openwork-support") return "OpenWork support";
  return "Den operator";
}

const STEP_STATUS_LABELS: Record<EgressDiagnosticStep["status"], string> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

function StepResult({ step }: { step: EgressDiagnosticStep }) {
  return (
    <li className={`grid gap-3 rounded-[22px] border px-4 py-4 ${statusStyles(step.status)}`}>
      <div className="flex min-w-0 items-start gap-3">
        <StatusIcon status={step.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium">{step.label}</p>
            <span className="text-[12px] font-semibold uppercase tracking-[0.1em]">
              {step.status} · {step.durationMs} ms
            </span>
          </div>
          <p className="mt-1 text-[13px] opacity-90">{step.message}</p>
        </div>
      </div>
      {step.httpStatuses.length > 0 ? (
        <p className="text-[12px]">
          HTTP responses: <span className="font-mono">{step.httpStatuses.join(" → ")}</span>
        </p>
      ) : null}
      {step.diagnosticIds.length > 0 ? (
        <div className="grid gap-1 text-[12px]">
          <span>Remote diagnostic references</span>
          {step.diagnosticIds.map((diagnosticId) => (
            <code className="break-all" key={diagnosticId}>{diagnosticId}</code>
          ))}
        </div>
      ) : null}
      {step.status === "failed" ? (
        <div className="rounded-xl border border-current/15 bg-white/60 px-3 py-3 text-[13px]">
          <p><strong>Suggested owner:</strong> {ownerLabel(step.owner)}</p>
          <p className="mt-1"><strong>Next action:</strong> {step.action}</p>
          {step.code ? <p className="mt-1"><strong>Failure code:</strong> <code>{step.code}</code></p> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Flat step row for the embedded variant: icon, label, state and duration, then direction on failure. */
function CompactStepResult({ step }: { step: EgressDiagnosticStep }) {
  return (
    <li className="flex min-w-0 items-start gap-2 border-b border-[var(--dls-border)] py-2 last:border-b-0">
      <StatusIcon status={step.status} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium text-[var(--dls-text-primary)]">{step.label}</span>
          <span className="tabular-nums text-[var(--dls-text-secondary)]">{STEP_STATUS_LABELS[step.status]}, {step.durationMs} ms</span>
        </div>
        <p className="mt-0.5 text-[var(--dls-text-secondary)] [overflow-wrap:anywhere]">{step.message}</p>
        {step.status === "failed" ? (
          <div className="mt-2">
            <DiagnosticsFacts facts={[
              { label: "Next step", value: step.action },
              { label: "Who can fix it", value: ownerLabel(step.owner) },
              step.code !== null && { label: "Failure code", value: <DiagnosticsCode>{step.code}</DiagnosticsCode> },
              step.httpStatuses.length > 0 && { label: "HTTP responses", value: <DiagnosticsCode>{step.httpStatuses.join(", ")}</DiagnosticsCode> },
              step.diagnosticIds.length > 0 && { label: "Remote references", value: step.diagnosticIds.map((id) => <DiagnosticsCode key={id}>{id}</DiagnosticsCode>) },
            ]} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function useEgressDiagnostics(canView: boolean, canManage: boolean) {
  const [available, setAvailable] = useState(false);
  const [targetOrigin, setTargetOrigin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EgressDiagnosticRun | null>(null);
  const [copied, setCopied] = useState(false);
  const [bearerTokenDraft, setBearerTokenDraft] = useState("");
  const [savingBearerToken, setSavingBearerToken] = useState(false);
  const [editingBearerToken, setEditingBearerToken] = useState(false);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function loadConfiguration() {
      setLoading(true);
      try {
        const { response, payload } = await requestJson("/v1/diagnostics/egress", { method: "GET" }, 12_000);
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, `Could not load egress diagnostics (${response.status}).`));
        }
        const parsed = egressDiagnosticConfigurationSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Den returned an invalid diagnostics configuration response.");
        if (!cancelled) {
          setAvailable(parsed.data.available);
          setTargetOrigin(parsed.data.targetOrigin);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load egress diagnostics.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadConfiguration();
    return () => { cancelled = true; };
  }, [canView]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function runDiagnostic() {
    if (!canManage) {
      setError("You don't have permission to run this diagnostic.");
      return;
    }

    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const { response, payload } = await requestJson("/v1/diagnostics/egress", { method: "POST" }, 90_000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Egress diagnostic could not start (${response.status}).`));
      }
      const parsed = egressDiagnosticRunSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Den returned an invalid egress diagnostic result.");
      setResult(parsed.data);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Egress diagnostic could not complete.");
    } finally {
      setRunning(false);
    }
  }

  async function saveBearerToken() {
    if (!canManage) {
      setError("You don't have permission to change the diagnostic token.");
      return;
    }

    const bearerToken = bearerTokenDraft.trim();
    if (bearerToken.length < 24) {
      setError("Enter a diagnostic token with at least 24 characters.");
      return;
    }
    setSavingBearerToken(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/diagnostics/egress/token", {
        method: "PUT",
        body: JSON.stringify({ bearerToken }),
      }, 12_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Could not save the diagnostic token (${response.status}).`));
      setBearerTokenDraft("");
      setAvailable(true);
      setEditingBearerToken(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the diagnostic token.");
    } finally {
      setSavingBearerToken(false);
    }
  }

  async function copyRunId() {
    if (!result) return;
    await navigator.clipboard.writeText(result.runId);
    setCopied(true);
  }

  return {
    available, targetOrigin, loading, running, error, result, copied,
    bearerTokenDraft, setBearerTokenDraft, savingBearerToken, editingBearerToken, setEditingBearerToken,
    runDiagnostic, saveBearerToken, copyRunId,
  };
}

type EgressDiagnostics = ReturnType<typeof useEgressDiagnostics>;

function TokenEditor({ state, canManage, compact }: { state: EgressDiagnostics; canManage: boolean; compact: boolean }) {
  const { available } = state;
  return (
    <div className={compact ? "grid gap-2" : "rounded-[22px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-4 py-4 text-[13px] text-[var(--dls-text-primary)]"} role="status">
      <p className="font-medium">{available ? "Replace the diagnostic token." : "Add a diagnostic token to run this test."}</p>
      <p className={compact ? "text-[var(--dls-text-secondary)]" : "mt-1"}>Den encrypts the token for this organization and never shows it again.</p>
      <div className={`${compact ? "" : "mt-3 "}flex flex-wrap items-end gap-2`}>
        <label className="grid min-w-0 flex-1 basis-60 gap-1">
          <span className="text-[12px] font-medium">Diagnostic bearer token</span>
          <DenSecretInput
            autoComplete="new-password"
            minLength={24}
            onChange={state.setBearerTokenDraft}
            placeholder="Paste the synthetic diagnostic token"
            value={state.bearerTokenDraft}
            disabled={!canManage}
          />
        </label>
        <DenButton type="button" size={compact ? "sm" : "md"} loading={state.savingBearerToken} onClick={() => void state.saveBearerToken()} disabled={!canManage}>
          Save token
        </DenButton>
        {available ? (
          <DenButton type="button" size="sm" variant="secondary" onClick={() => state.setEditingBearerToken(false)}>
            Cancel
          </DenButton>
        ) : null}
      </div>
    </div>
  );
}

function RunSummary({ result, copied, onCopy, compact }: { result: EgressDiagnosticRun; copied: boolean; onCopy: () => void; compact: boolean }) {
  const failedLabel = result.steps.find((step) => step.id === result.failedStep)?.label ?? result.failedStep ?? "an unknown step";
  return (
    <div className={compact ? "grid gap-2" : `rounded-[22px] border px-4 py-4 ${result.overallStatus === "passed" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
      <p className={`font-semibold ${compact && result.overallStatus === "failed" ? "text-red-700" : ""}`}>
        {compact
          ? result.overallStatus === "passed" ? "Passed" : `Stopped at ${failedLabel}`
          : `Diagnostic ${result.overallStatus === "passed" ? "passed" : `stopped at ${result.failedStep ?? "an unknown step"}`}.`}
      </p>
      <div className={`${compact ? "" : "mt-3 "}flex min-w-0 flex-wrap items-center gap-2`}>
        <span className="text-[12px]">Run ID</span>
        <code className="min-w-0 break-all text-[12px]">{result.runId}</code>
        <DenButton type="button" size="sm" variant="secondary" icon={copied ? Check : Copy} onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </DenButton>
        <a className={buttonVariants({ variant: "secondary", size: "sm", className: "gap-1.5" })} href={result.supportUrl} target="_blank" rel="noreferrer">
          Open support trace <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

/** Embedded in Settings › Diagnostics › Advanced › Network check: no card, eyebrow or page-size heading. */
function EmbeddedEgressDiagnostics({ state, canView, canManage }: { state: EgressDiagnostics; canView: boolean; canManage: boolean }) {
  const { loading, available, editingBearerToken, result, error } = state;
  if (loading) {
    return (
      <div className="grid gap-2" aria-busy="true" data-testid="egress-diagnostics-embedded">
        <DenSkeleton className="h-3 w-64 max-w-full" />
        <DenSkeleton className="h-3 w-48 max-w-full" />
        <DenSkeleton className="h-8 w-24 rounded-lg" />
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-3" data-testid="egress-diagnostics-embedded">
      <DiagnosticsFacts facts={[
        { label: "Target", value: state.targetOrigin ? <DiagnosticsCode>{state.targetOrigin}</DiagnosticsCode> : "Not configured" },
        { label: "Path", value: "The same route enterprise connectors use" },
        { label: "Sends", value: "No organization data or credentials" },
        canView && available && !editingBearerToken && {
          label: "Diagnostic token",
          value: (
            <span className="inline-flex flex-wrap items-center gap-2">
              Configured
              <DenButton type="button" size="inline" variant="ghost" className="!h-auto underline underline-offset-2" onClick={() => state.setEditingBearerToken(true)} disabled={!canManage}>
                Change token
              </DenButton>
            </span>
          ),
        },
      ]} />
      {canView && (!available || editingBearerToken) ? <TokenEditor state={state} canManage={canManage} compact /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <DenButton
          type="button"
          size="sm"
          icon={Activity}
          loading={state.running}
          disabled={!canManage || !available}
          onClick={() => void state.runDiagnostic()}
        >
          Run check
        </DenButton>
        {canView && !canManage ? <span className="text-[var(--dls-text-secondary)]">{permissionLockReason("egress_diagnostics.manage")}</span> : null}
      </div>
      {error ? <DenNotice tone="error" message={error} className="!rounded-lg !px-3 !py-2 !text-[13px]" /> : null}
      {result ? (
        <section className="grid gap-2" aria-live="polite">
          <RunSummary result={result} copied={state.copied} onCopy={() => void state.copyRunId()} compact />
          <ol className="grid border-t border-[var(--dls-border)]">
            {result.steps.map((step) => <CompactStepResult key={step.id} step={step} />)}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export function EgressDiagnosticsCard({ canView, canManage, variant = "card" }: { canView: boolean; canManage: boolean; variant?: "card" | "embedded" }) {
  const state = useEgressDiagnostics(canView, canManage);
  if (variant === "embedded") return <EmbeddedEgressDiagnostics state={state} canView={canView} canManage={canManage} />;
  const { available, targetOrigin, loading, running, error, result, editingBearerToken } = state;

  return (
    <DenCard size="spacious" className="grid gap-6" data-testid="egress-diagnostics-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid max-w-[660px] gap-2">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Private-cloud support</p>
          <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">Den egress diagnostic</h2>
          <p className="text-[14px] text-gray-500">
            Run a controlled connection from this Den process through the same DNS, proxy, TLS, firewall, service-mesh, and Kubernetes egress path used by enterprise MCP connections.
          </p>
        </div>
        <DenButton
          type="button"
          icon={Activity}
          loading={running}
          disabled={!canManage || loading || !available}
          onClick={() => void state.runDiagnostic()}
        >
          Run egress diagnostic
        </DenButton>
      </div>

      <div className="rounded-[22px] border border-gray-200 bg-gray-50 px-4 py-4 text-[13px] text-gray-600">
        <p><strong>Fixed target:</strong> {targetOrigin ? <code className="break-all">{targetOrigin}</code> : "Not configured"}</p>
        <p className="mt-1">The browser cannot change this target and the test never sends organization data or customer/provider credentials.</p>
      </div>

      {canView && !canManage ? <p className="text-[13px] text-gray-500">{`Read only. ${permissionLockReason("egress_diagnostics.manage")}`}</p> : null}
      {loading ? <p className="text-[13px] text-gray-500" role="status">Loading diagnostic configuration...</p> : null}
      {!loading && canView && available && !editingBearerToken ? (
        <div className="flex items-center justify-between gap-3 rounded-[22px] border border-gray-200 bg-gray-50 px-4 py-3 text-[13px] text-gray-600">
          <p>Diagnostic token configured in Den.</p>
          <DenButton type="button" size="sm" variant="secondary" onClick={() => state.setEditingBearerToken(true)} disabled={!canManage}>
            Change token
          </DenButton>
        </div>
      ) : null}
      {!loading && canView && (!available || editingBearerToken) ? <TokenEditor state={state} canManage={canManage} compact={false} /> : null}
      {error ? <div className="rounded-[22px] border border-red-200 bg-red-50 px-4 py-4 text-[13px] text-red-800" role="alert">{error}</div> : null}

      {result ? (
        <section className="grid gap-4" aria-live="polite">
          <RunSummary result={result} copied={state.copied} onCopy={() => void state.copyRunId()} compact={false} />
          <ol className="grid gap-3">
            {result.steps.map((step) => <StepResult key={step.id} step={step} />)}
          </ol>
        </section>
      ) : null}
    </DenCard>
  );
}
