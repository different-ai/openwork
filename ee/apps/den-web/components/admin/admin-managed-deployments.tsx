"use client";

import { ChevronRight, LockKeyhole } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ManagedInstallerApprovalMode, ManagedInstallerProvider, ManagedInstallerProviderState, ManagedInstallerQualification, ManagedInstallerReport, ManagedInstallerValidation } from "@openwork/types/den/managed-installer-releases";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSegmented } from "../../app/(den)/_components/ui/segmented";
import { AdminAccessScreen } from "./admin-access-screen";
import { requestAdmin, sendAdmin, type AdminAccess } from "./admin-request";
import { MANAGED_RELEASES_API, managedApprovalLabel, managedServiceLabel, managedSourceLabel, parseManagedLatest, parseManagedReport, parseManagedValidation, pinBlockedReason, sourceInputError, versionInputError } from "./admin-managed-deployments-model";

const EMPTY_QUALIFICATION: ManagedInstallerQualification = { freshInstallUrl: "", approvedUpdateUrl: "" };
const SUMMARY_CLASS = "flex cursor-pointer list-none items-center gap-2 py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 [&::-webkit-details-marker]:hidden";

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return <details className="group border-t border-border">
    <summary className={SUMMARY_CLASS}><ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none group-open:rotate-90" />{title}</summary>
    <div className="pb-4 pl-6">{children}</div>
  </details>;
}

function timestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
}

export function ManagedDeploymentsSkeleton() {
  return <section aria-label="Loading managed deployments" aria-busy="true" className="max-w-3xl space-y-6">
    <h1 className="text-xl font-semibold tracking-tight">Managed deployments</h1>
    <div className="h-8 w-32 rounded-md bg-muted" />
    <div className="space-y-3 border-y border-border py-6"><div className="h-4 w-32 rounded bg-muted" /><div className="h-8 w-48 rounded bg-muted" /><div className="h-4 w-64 rounded bg-muted" /></div>
    <div className="h-10 rounded-md bg-muted" /><div className="h-10 rounded-md bg-muted" />
  </section>;
}

export function ManagedDeploymentCurrent({ state }: { state: ManagedInstallerProviderState }) {
  return <section aria-label="Current default" className="border-y border-border py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-muted-foreground">Current default</p><p className="mt-1 text-xl font-semibold tracking-tight" data-testid="managed-current-version">{state.release?.version ?? "Not configured"}</p></div>
      <dl className="text-right"><dt className="text-muted-foreground">Source</dt><dd className="mt-1 font-medium">{managedSourceLabel(state.source)}</dd></dl>
    </div>
    <dl className="mt-3 flex justify-between gap-3"><dt className="text-muted-foreground">Approval</dt><dd>{managedApprovalLabel(state.approvalMode)}</dd></dl>
    {!state.available && state.release ? <p className="mt-3 text-muted-foreground">Unavailable for new installs and offered updates. Configure a published release source and verify a release.</p> : null}
    {state.source === "invalid_configuration" ? <p className="mt-3 text-destructive">The environment default is invalid. Configure a published release source below.</p> : null}
    {!state.sourceBaseUrl ? <p className="mt-3 text-muted-foreground">No published release source. Configure a release folder under Advanced to verify and pin a default.</p> : null}
  </section>;
}

export function ManagedDeploymentPreview({ validation }: { validation: ManagedInstallerValidation }) {
  return <section aria-label="Verified release" className="space-y-3 border-t border-border pt-4" data-testid="managed-release-preview">
    <div className="flex flex-wrap justify-between gap-2"><h2 className="font-medium">Verified release {validation.release.version}</h2><p className="text-muted-foreground">{timestamp(validation.verifiedAt)}</p></div>
    <dl className="space-y-2"><div><dt className="text-muted-foreground">Included services</dt><dd className="mt-1">{validation.services.map(managedServiceLabel).join(", ") || "No services reported"}</dd></div><div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Verification expires</dt><dd>{timestamp(validation.expiresAt)}</dd></div></dl>
    <p className="text-muted-foreground">Published files verified. Cloud qualification requires the test reports below.</p>
  </section>;
}

export function ManagedDeploymentHistory({ history, provider }: { history: ManagedInstallerReport["history"]; provider: ManagedInstallerProvider }) {
  const entries = history.filter(entry => entry.provider === provider).slice(0, 10);
  return <section aria-label="Release history" className="border-t border-border pt-4">
    <h2 className="font-medium">Release history</h2>
    {entries.length ? <ul className="mt-2 divide-y divide-border">{entries.map(entry => <li key={entry.id} className="py-3">
      <div className="flex flex-wrap justify-between gap-2"><span>{entry.action === "pinned" ? `Pinned ${entry.version}` : entry.action === "source_saved" ? "Saved release source" : entry.action === "approval_saved" ? "Changed approval policy" : "Restored environment default"}</span><time className="text-muted-foreground" dateTime={entry.createdAt}>{timestamp(entry.createdAt)}</time></div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground"><span>{entry.actor}</span>{entry.qualification ? <><a className="underline underline-offset-2" href={entry.qualification.freshInstallUrl} target="_blank" rel="noreferrer">Fresh install report</a><a className="underline underline-offset-2" href={entry.qualification.approvedUpdateUrl} target="_blank" rel="noreferrer">Approved update report</a></> : null}</div>
    </li>)}</ul> : <p className="mt-2 text-muted-foreground">No admin changes recorded.</p>}
  </section>;
}

export function ManagedDeploymentsPage() {
  const [report, setReport] = useState<ManagedInstallerReport | null>(null);
  const [access, setAccess] = useState<AdminAccess>("ready");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [provider, setProvider] = useState<ManagedInstallerProvider>("aws");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void requestAdmin(MANAGED_RELEASES_API, parseManagedReport, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setAccess(result.access);
      if (result.access === "ready") { setReport(result.data); setError(null); }
      else setError(result.message);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { setAccess("error"); setError(cause instanceof Error ? cause.message : "Could not load the current default. Retry to reconnect."); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  if (access === "signed-out" || access === "forbidden") return <AdminAccessScreen state={access} onRetry={refresh} />;
  if (!report && loading) return <ManagedDeploymentsSkeleton />;
  if (!report) return <AdminAccessScreen state="error" message={error ?? undefined} onRetry={refresh} />;
  const current = report.providers.find(item => item.provider === provider);
  return <div className="max-w-3xl space-y-6 text-sm text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold tracking-tight">Managed deployments</h1><DenSegmented<ManagedInstallerProvider> aria-label="Cloud provider" value={provider} onChange={setProvider} options={[{ value: "aws", label: "AWS" }, { value: "gcp", label: "GCP" }]} /></div>
    {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-destructive"><p>{error}</p><DenButton variant="secondary" size="sm" loading={loading} onClick={refresh}>Refresh current default</DenButton></div> : null}
    {current ? <ManagedDeploymentEditor key={`${provider}:${attempt}`} state={current} report={report} onReport={setReport} onAccess={setAccess} refresh={refresh} refreshing={loading} /> : <div role="alert">This provider did not return a default. <DenButton variant="secondary" size="sm" onClick={refresh}>Retry</DenButton></div>}
  </div>;
}

export function ManagedDeploymentEditor({ state, report, onReport, onAccess, refresh, refreshing }: { state: ManagedInstallerProviderState; report: ManagedInstallerReport; onReport: (report: ManagedInstallerReport) => void; onAccess: (access: AdminAccess) => void; refresh: () => void; refreshing: boolean }) {
  const [version, setVersion] = useState(state.pendingValidation?.release.version ?? "");
  const [source, setSource] = useState(state.sourceBaseUrl ?? "");
  const [approvalMode, setApprovalMode] = useState<ManagedInstallerApprovalMode>(state.approvalMode);
  const [approvalConfirmation, setApprovalConfirmation] = useState(false);
  const [validation, setValidation] = useState<ManagedInstallerValidation | null>(state.pendingValidation);
  const [qualification, setQualification] = useState(EMPTY_QUALIFICATION);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [restoreConfirmation, setRestoreConfirmation] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const disabled = busy !== null || refreshing;
  const blocked = pinBlockedReason(validation, state, version, qualification, now, stale);

  useEffect(() => {
    if (!validation) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(validation.expiresAt) - Date.now()) + 10);
    return () => window.clearTimeout(timer);
  }, [validation]);

  async function run(action: string, operation: () => Promise<void>) {
    setBusy(action); setError(null); setNotice(null);
    try { await operation(); }
    catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : "The request failed. Refresh the current default and try again.";
      setError(action === "verify" ? `Verification failed. ${message}` : message);
    }
    finally { setBusy(null); }
  }

  async function write(path: string, method: "PUT" | "POST", body: unknown) {
    const result = await sendAdmin(`${MANAGED_RELEASES_API}${path}`, method, body);
    if (!result.ok) {
      if (result.status === 401) onAccess("signed-out");
      if (result.status === 403 && result.code !== "independent_approval_required") onAccess("forbidden");
      if (result.status === 409) { setStale(true); setValidation(null); }
      if (path.endsWith("/source") && result.status === 400) setSourceError(result.message);
      if (path === "/pin") {
        if (result.code === "independent_approval_required") setValidation(current => current ? { ...current, canPin: false } : null);
        else setValidation(null);
      }
      throw new Error(result.status === 409 ? `${result.message} Refresh the current default before trying again.` : result.message);
    }
    return result.payload;
  }

  function acceptReport(payload: unknown) {
    const parsed = parseManagedReport(payload);
    if (!parsed) throw new Error("The server returned an unreadable default. Refresh before making another change.");
    onReport(parsed);
    const current = parsed.providers.find(item => item.provider === state.provider);
    setSource(current?.sourceBaseUrl ?? "");
    setApprovalMode(current?.approvalMode ?? state.approvalMode);
    setApprovalConfirmation(false);
    setStale(false);
    setValidation(null);
    setQualification(EMPTY_QUALIFICATION);
    setRestoreConfirmation(false);
  }

  function changeVersion(value: string) { setVersion(value); setValidation(null); setQualification(EMPTY_QUALIFICATION); setVersionError(null); setNotice(null); }

  async function saveApproval() {
    await run("approval", async () => {
      acceptReport(await write(`/${state.provider}/approval`, "PUT", { approvalMode, expectedRevision: state.revision }));
      setNotice("Saved approval policy. Verify the release again before pinning it.");
    });
  }

  async function verify() {
    const problem = versionInputError(state, version);
    setVersionError(problem);
    if (problem) return;
    setValidation(null);
    setQualification(EMPTY_QUALIFICATION);
    await run("verify", async () => {
      const parsed = parseManagedValidation(await write("/validate", "POST", { provider: state.provider, version: version.trim(), expectedRevision: state.revision }));
      if (!parsed || parsed.provider !== state.provider || parsed.release.version !== version.trim()) throw new Error("The server returned a different release. Verify this release again.");
      setNow(Date.now()); setValidation(parsed);
    });
  }

  return <div className="space-y-5">
    <ManagedDeploymentCurrent state={state} />
    <p className="text-muted-foreground">New installs and available updates. Existing installations change only through an owner-approved Update.</p>
    {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-destructive"><p className="min-w-0 flex-1">{error}</p><DenButton variant="secondary" size="sm" disabled={disabled} onClick={() => { setValidation(null); refresh(); }}>Refresh current default</DenButton></div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="managed-version" className="font-medium">Choose version</label><DenButton variant="plain" size="sm" disabled={disabled || stale} loading={busy === "latest"} onClick={() => void run("latest", async () => {
        const result = await requestAdmin(`${MANAGED_RELEASES_API}/latest`, parseManagedLatest);
        if (result.access !== "ready") { if (result.access !== "error") onAccess(result.access); throw new Error(result.message); }
        changeVersion(result.data.version);
      })}>Use latest stable</DenButton></div>
      <div className="flex flex-wrap gap-2"><div className="min-w-48 flex-1"><DenInput id="managed-version" value={version} onChange={event => changeVersion(event.target.value)} disabled={disabled || stale} placeholder="1.2.3" aria-invalid={!!versionError} aria-describedby={versionError ? "managed-version-error" : undefined} /></div><DenButton variant="secondary" disabled={disabled || stale || !state.sourceBaseUrl} loading={busy === "verify"} onClick={() => void verify()}>Verify release</DenButton></div>
      {versionError ? <p id="managed-version-error" className="text-destructive">{versionError}</p> : null}
    </div>
    {validation ? <>
      <ManagedDeploymentPreview validation={validation} />
      <div className="space-y-3">
        <h2 className="font-medium">Qualification reports for {validation.release.version}</h2>
        <div className="space-y-1"><label htmlFor="managed-fresh-install">Successful fresh install report</label><DenInput id="managed-fresh-install" type="url" placeholder="https://…" value={qualification.freshInstallUrl} disabled={disabled || stale} onChange={event => setQualification({ ...qualification, freshInstallUrl: event.target.value.trim() })} /></div>
        <div className="space-y-1"><label htmlFor="managed-approved-update">Approved update report</label><DenInput id="managed-approved-update" type="url" placeholder="https://…" value={qualification.approvedUpdateUrl} disabled={disabled || stale} onChange={event => setQualification({ ...qualification, approvedUpdateUrl: event.target.value.trim() })} /></div>
        <p className="text-muted-foreground">Pinning attests that both reports qualify this exact release and its verified hash.</p>
      </div>
    </> : null}
    <div className="flex flex-wrap items-center gap-3"><DenButton disabled={disabled || !!blocked} loading={busy === "pin"} aria-describedby={blocked ? "managed-pin-blocked" : "managed-pin-impact"} onClick={() => void run("pin", async () => {
      if (!validation || blocked) return;
      acceptReport(await write("/pin", "POST", { provider: state.provider, validationId: validation.id, expectedRevision: state.revision, qualification }));
      setNotice(`Pinned ${validation.release.version} for new ${state.provider.toUpperCase()} installs and available updates.`);
    })}>Pin {validation?.release.version ?? "release"}</DenButton>{blocked ? <p id="managed-pin-blocked" className="flex min-w-0 flex-1 items-start gap-2 text-muted-foreground"><LockKeyhole size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />{blocked}</p> : <p id="managed-pin-impact" className="text-muted-foreground">Sets the {state.provider.toUpperCase()} default for new installs and offered updates. Pinned runs stay frozen.</p>}</div>
    <Disclosure title="Advanced">
      <div className="space-y-5">
        <section className="space-y-3" aria-label="Approval policy">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Approval policy</h2><DenSegmented<ManagedInstallerApprovalMode> aria-label="Approval policy" value={approvalMode} onChange={value => { setApprovalMode(value); setApprovalConfirmation(false); }} options={[{ value: "independent_admin", label: "Second administrator", disabled: disabled || stale }, { value: "platform_admin", label: "One administrator", disabled: disabled || stale }]} /></div>
          {approvalConfirmation ? <div className="space-y-3" role="group" aria-label="Confirm approval policy"><p>Allow one platform administrator to verify and pin releases?</p><p className="text-muted-foreground">Applies to all new {state.provider.toUpperCase()} installs and update availability. Existing installations and pinned runs will not change.</p><div className="flex flex-wrap gap-2"><DenButton variant="secondary" size="sm" disabled={disabled || stale} loading={busy === "approval"} onClick={() => void saveApproval()}>Confirm one administrator</DenButton><DenButton variant="ghost" size="sm" disabled={disabled} onClick={() => { setApprovalConfirmation(false); setApprovalMode(state.approvalMode); }}>Keep current policy</DenButton></div></div> : <DenButton variant="secondary" size="sm" disabled={disabled || stale || approvalMode === state.approvalMode} loading={busy === "approval"} onClick={() => { if (approvalMode === "platform_admin" && state.approvalMode === "independent_admin") setApprovalConfirmation(true); else void saveApproval(); }}>Save approval policy</DenButton>}
        </section>
        <section className="space-y-2 border-t border-border pt-4"><label htmlFor="managed-source" className="font-medium">Release source</label>
          {state.sourceBaseUrl ? <p className="break-all text-muted-foreground">Current: {state.sourceBaseUrl}</p> : null}
          <DenInput id="managed-source" type="url" placeholder={state.provider === "aws" ? "https://example.s3.us-east-1.amazonaws.com/releases/aws/" : "https://storage.googleapis.com/example/releases/gcp/"} value={source} disabled={disabled || stale} onChange={event => { setSource(event.target.value); setSourceError(null); }} aria-invalid={!!sourceError} aria-describedby={sourceError ? "managed-source-error" : "managed-source-help"} />
          <p id="managed-source-help" className="text-muted-foreground">Published release folder only. Saving does not publish files or qualify a cloud installation.</p>
          {sourceError ? <p id="managed-source-error" className="text-destructive">{sourceError}</p> : null}
          <DenButton variant="secondary" size="sm" disabled={disabled || stale || source.trim() === state.sourceBaseUrl} loading={busy === "source"} onClick={() => {
            const problem = sourceInputError(source, state.revision); setSourceError(problem); if (problem) return;
            void run("source", async () => { acceptReport(await write(`/${state.provider}/source`, "PUT", { sourceBaseUrl: source.trim(), expectedRevision: state.revision })); setNotice("Saved release source. Verify a release before pinning it."); });
          }}>Save release source</DenButton>
        </section>
        <section className="space-y-2 border-t border-border pt-4"><h2 className="font-medium">Environment default</h2>
          {restoreConfirmation ? <div className="space-y-3" role="group" aria-label="Confirm restore environment default"><p>Restore the {state.provider.toUpperCase()} environment default for new installs and offered updates? Existing installations will not change; pinned runs stay frozen.</p><div className="flex flex-wrap gap-2"><DenButton variant="secondary" size="sm" disabled={disabled || stale} loading={busy === "reset"} onClick={() => void run("reset", async () => { acceptReport(await write("/reset", "POST", { provider: state.provider, expectedRevision: state.revision })); setNotice("Restored environment default for new installs and offered updates."); })}>Confirm restore default</DenButton><DenButton variant="ghost" size="sm" disabled={disabled} onClick={() => setRestoreConfirmation(false)}>Keep current default</DenButton></div></div> : <DenButton variant="secondary" size="sm" disabled={disabled || stale || state.source !== "admin"} onClick={() => setRestoreConfirmation(true)}>Restore environment default</DenButton>}
        </section>
      </div>
    </Disclosure>
    <Disclosure title="Technical details">
      <dl className="space-y-3 break-all text-muted-foreground">
        <div><dt>Revision</dt><dd className="font-mono text-xs">{state.revision}</dd></div>
        {(validation?.release ?? state.release) ? <ReleaseCoordinates release={validation?.release ?? state.release} /> : null}
        {validation ? <div><dt>Manifest SHA-256</dt><dd className="font-mono text-xs">{validation.manifestSha256}</dd></div> : null}
      </dl>
    </Disclosure>
    <ManagedDeploymentHistory history={report.history} provider={state.provider} />
  </div>;
}

function ReleaseCoordinates({ release }: { release: ManagedInstallerProviderState["release"] }) {
  if (!release) return null;
  return <><div><dt>Template URL</dt><dd><a href={release.templateUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{release.templateUrl}</a></dd></div><div><dt>Bundle URL</dt><dd><a href={release.bundleUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{release.bundleUrl}</a></dd></div><div><dt>Bundle SHA-256</dt><dd className="font-mono text-xs">{release.bundleSha256}</dd></div></>;
}
