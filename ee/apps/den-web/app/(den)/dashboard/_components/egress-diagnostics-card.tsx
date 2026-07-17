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
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";

function statusStyles(status: EgressDiagnosticStep["status"]) {
  if (status === "passed") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-800";
  return "border-gray-200 bg-gray-50 text-gray-500";
}

function StatusIcon({ status }: { status: EgressDiagnosticStep["status"] }) {
  if (status === "passed") return <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />;
  if (status === "failed") return <XCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />;
  return <CircleDashed aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />;
}

function ownerLabel(owner: EgressDiagnosticStep["owner"]) {
  if (owner === "network-administrator") return "Network administrator";
  if (owner === "openwork-support") return "OpenWork support";
  return "Den operator";
}

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

export function EgressDiagnosticsCard({ canRun }: { canRun: boolean }) {
  const [available, setAvailable] = useState(false);
  const [targetOrigin, setTargetOrigin] = useState<string | null>(null);
  const [missingConfiguration, setMissingConfiguration] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EgressDiagnosticRun | null>(null);
  const [copied, setCopied] = useState(false);
  const [bearerTokenDraft, setBearerTokenDraft] = useState("");
  const [savingBearerToken, setSavingBearerToken] = useState(false);
  const [editingBearerToken, setEditingBearerToken] = useState(false);

  useEffect(() => {
    if (!canRun) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function loadConfiguration() {
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
          setMissingConfiguration(parsed.data.missingConfiguration);
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
  }, [canRun]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function runDiagnostic() {
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
      setMissingConfiguration([]);
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
          disabled={!canRun || loading || !available}
          onClick={() => void runDiagnostic()}
        >
          Run egress diagnostic
        </DenButton>
      </div>

      <div className="rounded-[22px] border border-gray-200 bg-gray-50 px-4 py-4 text-[13px] text-gray-600">
        <p><strong>Fixed target:</strong> {targetOrigin ? <code className="break-all">{targetOrigin}</code> : "Not configured"}</p>
        <p className="mt-1">The browser cannot change this target and the test never sends organization data or customer/provider credentials.</p>
      </div>

      {!canRun ? <p className="text-[13px] text-gray-500">Only workspace owners and admins can run this diagnostic.</p> : null}
      {loading ? <p className="text-[13px] text-gray-500" role="status">Loading diagnostic configuration...</p> : null}
      {!loading && canRun && available && !editingBearerToken ? (
        <div className="flex items-center justify-between gap-3 rounded-[22px] border border-gray-200 bg-gray-50 px-4 py-3 text-[13px] text-gray-600">
          <p>Diagnostic token configured in Den.</p>
          <DenButton type="button" size="sm" variant="secondary" onClick={() => setEditingBearerToken(true)}>
            Change token
          </DenButton>
        </div>
      ) : null}
      {!loading && canRun && (!available || editingBearerToken) ? (
        <div className="rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-4 text-[13px] text-amber-800" role="status">
          <p className="font-medium">{available ? "Replace the diagnostic token." : "Add a diagnostic token to run this test."}</p>
          <p className="mt-1">Den encrypts the token for this organization and never shows it again.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="grid min-w-[280px] flex-1 gap-1">
              <span className="text-[12px] font-medium">Diagnostic bearer token</span>
              <DenInput
                autoComplete="new-password"
                minLength={24}
                onChange={(event) => setBearerTokenDraft(event.target.value)}
                placeholder="Paste the synthetic diagnostic token"
                type="password"
                value={bearerTokenDraft}
              />
            </label>
            <DenButton type="button" loading={savingBearerToken} onClick={() => void saveBearerToken()}>
              Save token
            </DenButton>
            {available ? (
              <DenButton type="button" size="sm" variant="secondary" onClick={() => setEditingBearerToken(false)}>
                Cancel
              </DenButton>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <div className="rounded-[22px] border border-red-200 bg-red-50 px-4 py-4 text-[13px] text-red-800" role="alert">{error}</div> : null}

      {result ? (
        <section className="grid gap-4" aria-live="polite">
          <div className={`rounded-[22px] border px-4 py-4 ${result.overallStatus === "passed" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
            <p className="font-semibold">Diagnostic {result.overallStatus === "passed" ? "passed" : `stopped at ${result.failedStep ?? "an unknown step"}`}.</p>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-[12px]">Run ID</span>
              <code className="min-w-0 break-all text-[12px]">{result.runId}</code>
              <DenButton type="button" size="sm" variant="secondary" icon={copied ? Check : Copy} onClick={() => void copyRunId()}>
                {copied ? "Copied" : "Copy"}
              </DenButton>
              <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={result.supportUrl} target="_blank" rel="noreferrer">
                Open support trace <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
          <ol className="grid gap-3">
            {result.steps.map((step) => <StepResult key={step.id} step={step} />)}
          </ol>
        </section>
      ) : null}
    </DenCard>
  );
}
