"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  awsRegionSchema, gcpRegionSchema, deploymentStepSchema, managedDeploymentConfigurationSchema, managedDeploymentInputSchema,
  managedDeploymentLaunchSchema, managedDeploymentListSchema, managedDeploymentSchema,
  type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";
import { AlertTriangle, CheckCircle2, CircleDashed, Copy, ExternalLink, LockKeyhole, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ConfirmDialog } from "./item-list";
import { DeploymentReadinessError, deploymentActionError, deploymentPreparationLockMessage, deploymentReadGateAfterFailure, deploymentStatus, providerName, readinessMessage, type DeploymentReadGate, type DeploymentReadResponse, type DeploymentTone, type ProviderReadiness } from "./managed-deployments-state";
export { deploymentStatus } from "./managed-deployments-state";

type Configuration = z.infer<typeof managedDeploymentConfigurationSchema>;
type DeploymentMutationRequest = (path: string, init: RequestInit) => Promise<Awaited<ReturnType<typeof requestJson>> | null>;
type Launch = z.infer<typeof managedDeploymentLaunchSchema>;
type Check = ManagedDeployment["health"]["checks"][number];
type Tone = DeploymentTone;

const STEP_LABELS: Record<z.infer<typeof deploymentStepSchema>, string> = {
  runner_connected: "Installer connected", release_verified: "Release verified", account_verified: "AWS account and domain verified",
  infrastructure_applied: "Infrastructure installed", services_ready: "Services started", health_verified: "HTTPS and database verified",
};
const FAILURE_LABELS: Record<string, string> = {
  release_verification_failed: "The release could not be verified. Open the installer logs in AWS.",
  infrastructure_failed: "Infrastructure installation failed. Open the installer logs in AWS, then retry.",
  certificate_failed: "AWS could not issue the HTTPS certificate. Make sure the domain's CAA records allow amazon.com, then retry.",
  service_unhealthy: "Services did not start. Check the ECS service events in AWS, then retry.",
  health_check_failed: "HTTPS or the database could not be verified. Check DNS for the domain, then retry.",
  network_check_failed: "The existing network can't host OpenWork. The installer logs in AWS CodeBuild say what to change (subnets, routes, DNS or the ECS cluster); fix it, then retry.",
  runner_failed: "The AWS account or hosted zone did not match. Check the deployment details.",
};
function gcpFailureMessage(code: string) {
  if (code === "runner_failed") return "The Google Cloud project or DNS zone did not match. Check the project ID, project number and public Cloud DNS zone, then retry.";
  if (code === "certificate_failed") return "Google Cloud could not issue the HTTPS certificate. Check the domain's DNS and certificate status in Google Cloud, then retry.";
  if (code === "service_unhealthy") return "Services did not start. Check Cloud Run service logs in Google Cloud Logging, then retry.";
  if (code === "health_check_failed") return "HTTPS or the database could not be verified. Check DNS and Cloud SQL in Google Cloud, then retry.";
  if (code === "release_verification_failed") return "The release could not be verified. Check the installer output in Google Cloud Shell before retrying.";
  return "Installation failed. Check the installer output in Google Cloud Shell and Google Cloud Logging, fix the reported problem, then retry.";
}

const CHECK_LABELS: Record<Check["id"], string> = {
  api_health: "API", database_ready: "Database connection", web_available: "Web app", services_running: "Services",
  load_balancer_targets: "Load balancer", database_instance: "Database instance", database_storage: "Database storage",
  database_backups: "Backups", certificate: "HTTPS certificate",
};
const CODE_LABELS: Record<string, string> = {
  http_error: "Returns an error", unreachable: "Not reachable", slow: "Slow", not_running: "Not running", unhealthy: "Unhealthy",
  unavailable: "Couldn't check", permission_denied: "Couldn't check: permission", low_storage: "Low on space", stale_backup: "No recent backup",
  backups_disabled: "Backups off", not_issued: "Not issued", expiring: "Expires soon", expired: "Expired",
};

function relativeTime(iso: string | null) {
  if (!iso) return "Never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(iso).toLocaleDateString();
}

function checkDetail(check: Check) {
  const value = check.value ?? 0;
  if (check.status === "unknown" || (check.status !== "ok" && check.code && check.id !== "services_running" && check.id !== "load_balancer_targets")) {
    return CODE_LABELS[check.code ?? "unavailable"] ?? "Couldn't check";
  }
  switch (check.id) {
    case "api_health": case "web_available": return `${Math.round(value)} ms`;
    case "database_ready": return "Connected";
    case "services_running": return `${value} of ${check.total ?? 0} services running`;
    case "load_balancer_targets": return `${value} of ${check.total ?? 0} routes serving`;
    case "database_instance": return "Available";
    case "database_storage": return `${value.toFixed(1)} of ${check.total ?? 0} GiB free`;
    case "database_backups": return value < 1 ? "Backed up within the last hour" : `Last backup ${Math.round(value)} h ago`;
    case "certificate": return `Renews automatically · ${Math.floor(value)} days left`;
  }
}

const toneText: Record<Tone, string> = { neutral: "text-gray-700", warning: "text-amber-700", danger: "text-red-700" };

function StatusIcon({ status }: { status: Check["status"] }) {
  if (status === "ok") return <CheckCircle2 aria-hidden className="size-4 text-gray-500" />;
  if (status === "warning") return <AlertTriangle aria-hidden className="size-4 text-amber-600" />;
  if (status === "failing") return <XCircle aria-hidden className="size-4 text-red-600" />;
  return <CircleDashed aria-hidden className="size-4 text-gray-400" />;
}

function networkLabel(network: Extract<ManagedDeployment, { provider: "aws" }>["target"]["network"]) {
  if (network.mode === "dedicated") return "Dedicated VPC";
  const cluster = network.ecsClusterArn ? ` · cluster ${network.ecsClusterArn.split("/").pop()}` : "";
  return `${network.vpcId}${cluster}`;
}

function idList(value: string) {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function ProviderLock({ entry }: { entry: ProviderReadiness }) {
  return (
    <div className="space-y-2 text-[13px] text-gray-500" data-testid={`deployment-provider-lock-${entry.provider}`}>
      <p className="flex items-start gap-2"><LockKeyhole aria-hidden className="mt-0.5 size-4 shrink-0" />{readinessMessage(entry)}</p>
      {entry.missingFields?.length ? <details><summary className="cursor-pointer">Technical details</summary><p className="mt-2 break-words">Configuration fields to check: {entry.missingFields.join(", ")}</p></details> : null}
    </div>
  );
}

function DeploymentActionFeedback({ error }: { error: Error | null }) {
  if (!error) return null;
  if (error instanceof DeploymentReadinessError) return <DenNotice tone="neutral" presentation="inline" icon={LockKeyhole} message={error.message} />;
  return <p role="alert" className="text-[13px] text-red-700">{error.message}</p>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 flex-col gap-1 border-b border-gray-100 py-2 text-[13px] last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="shrink-0 text-gray-500">{label}</span>
      <span className="min-w-0 break-words text-gray-900 [overflow-wrap:anywhere] sm:text-right">{children}</span>
    </div>
  );
}

export function ManagedDeploymentsScreen() {
  const { orgId, orgContext, runReauthableAction } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions);
  const memberId = orgContext?.currentMember.id;
  const [deployments, setDeployments] = useState<ManagedDeployment[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [readGate, setReadGate] = useState<DeploymentReadGate>("pending");
  const readGateRef = useRef<DeploymentReadGate>("pending");
  const readBarrier = useRef(0);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const updateReadGate = useCallback((next: DeploymentReadGate) => {
    if (next === "feature_locked" || next === "access_denied") readBarrier.current++;
    readGateRef.current = next; setReadGate(next);
  }, []);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deploymentToRemove, setDeploymentToRemove] = useState<ManagedDeployment | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const generation = useRef(0);
  const available = configuration?.providers.some((entry) => entry.available && (entry.provider === "aws" || entry.provider === "gcp")) ?? false;
  const selected = deployments.find((entry) => entry.id === selectedId) ?? deployments[0] ?? null;

  const maskObservations = useCallback(() => {
    setDeployments([]); setConfiguration(null); setLoadedAt(null); setSelectedId(null); setLaunch(null); setDialogOpen(false); setDeploymentToRemove(null);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    maskObservations(); setActionError(null); setBusy(false);
    updateReadGate("pending");
    setLoading(Boolean(orgId && access.canViewDeployments));
    if (!orgId || !access.canViewDeployments) { updateReadGate("access_denied"); return; }
    let stopped = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (stopped || pending) return;
      pending = true;
      const verificationBarrier = readBarrier.current;
      clearTimeout(timer);
      const responses: DeploymentReadResponse[] = [];
      function applyFailure() {
        if (stopped || generation.current !== current) return;
        const next = deploymentReadGateAfterFailure(readGateRef.current, responses);
        if (next === "access_denied") maskObservations();
        updateReadGate(next);
        setActionError(null);
        setLoading(false);
      }
      async function read(path: string) {
        const result = await requestJson(path, { method: "GET", cache: "no-store" }, 30_000, (response) => {
          responses.push({ status: response.status, payload: null });
          // Mask on receipt of auth headers, even if this body or the sibling hangs/fails.
          if (response.status === 401 || response.status === 403) applyFailure();
        });
        responses.push({ status: result.response.status, payload: result.payload });
        // A completed refusal takes effect immediately, not after the sibling settles.
        if (!result.response.ok) applyFailure();
        return result;
      }
      try {
        const [list, settings] = await Promise.allSettled([
          read("/v1/managed-deployments"),
          read("/v1/managed-deployments/configuration"),
        ]);
        if (stopped || generation.current !== current) return;
        if (list.status !== "fulfilled" || settings.status !== "fulfilled" || !list.value.response.ok || !settings.value.response.ok) {
          applyFailure();
          return;
        }
        // A read begun before an authoritative refusal cannot lift that lock.
        if (verificationBarrier !== readBarrier.current) return;
        const parsed = managedDeploymentListSchema.parse(list.value.payload);
        const parsedSettings = managedDeploymentConfigurationSchema.parse(settings.value.payload);
        if (!stopped && generation.current === current) {
          setDeployments(parsed.deployments);
          setConfiguration(parsedSettings);
          setLoadedAt(new Date().toISOString());
          // Only this matching, fully validated read pair may lift the lock.
          updateReadGate("verified");
        }
      } catch {
        // Parsing/transport failures never discard an already observed refusal.
        applyFailure();
      } finally {
        pending = false;
        if (!stopped && generation.current === current) {
          setLoading(false);
          timer = setTimeout(() => { void refresh(); }, 10_000);
        }
      }
    }
    refreshRef.current = refresh;
    void refresh();
    return () => {
      stopped = true; clearTimeout(timer);
      // Invalidate mutation callbacks on both scope changes and unmount, not just the next mount.
      if (generation.current === current) generation.current++;
      if (refreshRef.current === refresh) refreshRef.current = null;
    };
  }, [orgId, memberId, access.canViewDeployments, maskObservations, updateReadGate]);

  /** Every write stays pinned to its starting scope and uses the same denial precedence as reads. */
  function beginMutation(): DeploymentMutationRequest {
    const current = generation.current;
    function observe(response: DeploymentReadResponse) {
      if (generation.current !== current) return;
      const refusal = deploymentReadGateAfterFailure("pending", [response]);
      if (refusal !== "access_denied" && refusal !== "feature_locked") return;
      const next = deploymentReadGateAfterFailure(readGateRef.current, [response]);
      if (next === "access_denied") maskObservations();
      setDeploymentToRemove(null);
      updateReadGate(next);
      setActionError(null);
    }
    return async (path, init) => {
      if (generation.current !== current || readGateRef.current !== "verified") return null;
      try {
        const result = await requestJson(path, init, 30_000, (response) => observe({ status: response.status, payload: null }));
        if (generation.current !== current) return null;
        observe({ status: result.response.status, payload: result.payload });
        return result;
      } catch (failure) {
        // Stale body/transport errors must not reopen recovery in a different scope either.
        if (generation.current !== current) return null;
        throw failure;
      }
    };
  }

  function replace(item: ManagedDeployment) {
    setDeployments((previous) => previous.some((entry) => entry.id === item.id) ? previous.map((entry) => entry.id === item.id ? item : entry) : [...previous, item]);
  }

  async function prepare(deployment: ManagedDeployment, kind: Launch["kind"]) {
    if (readGateRef.current !== "verified") return;
    const current = generation.current;
    const barrier = readBarrier.current;
    const request = beginMutation();
    setBusy(true); setActionError(null); setCopied(false);
    try {
      await runReauthableAction(kind === "install" ? `Prepare ${providerName(deployment.provider)} approval` : kind === "update" ? "Prepare update" : "Prepare retry", async () => {
        const result = await request(`/v1/managed-deployments/${deployment.id}/launch`, { method: "POST", body: JSON.stringify({ kind }) });
        if (!result) return;
        if (!result.response.ok) {
          const recovery = deploymentActionError(result.payload, deployment.provider);
          throw recovery ? new DeploymentReadinessError(recovery) : getRequestError(result.payload, result.response, "Couldn't prepare the installer.");
        }
        const parsed = managedDeploymentLaunchSchema.parse(result.payload);
        if (generation.current === current && readBarrier.current === barrier && readGateRef.current === "verified") { setLaunch(parsed); replace(parsed.deployment); }
      });
    } catch (failure) {
      if (generation.current === current && readGateRef.current === "verified") setActionError(failure instanceof Error ? failure : new Error("Couldn't prepare the installer."));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  async function remove(deployment: ManagedDeployment) {
    if (readGateRef.current !== "verified") return;
    const current = generation.current;
    const barrier = readBarrier.current;
    const request = beginMutation();
    setBusy(true); setActionError(null);
    try {
      await runReauthableAction("Remove deployment", async () => {
        const result = await request(`/v1/managed-deployments/${deployment.id}`, { method: "DELETE" });
        if (!result) return;
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Couldn't remove the deployment.");
        if (generation.current === current && readBarrier.current === barrier && readGateRef.current === "verified") { setDeployments((previous) => previous.filter((entry) => entry.id !== deployment.id)); setSelectedId(null); setLaunch(null); }
      });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  const accessDenied = !access.canViewDeployments || readGate === "access_denied";
  const blockedReason = readGate === "feature_locked" ? deploymentPreparationLockMessage
    : readGate === "verified" ? null : "Deployment access couldn't be verified. Check again before preparing cloud approval.";
  const lastKnown = loadedAt !== null && readGate !== "verified";
  const canCreate = Boolean(!accessDenied && readGate === "verified" && available && access.canManageDeployments);

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6 p-4 sm:p-6" data-testid="managed-deployments-screen" data-deployment-read-state={readGate}>
      <DenPageHeader title="Deployments" size="compact" className="max-sm:flex-col max-sm:gap-3" action={
        <DenButton type="button" data-testid="managed-deployment-create" disabled={!canCreate || loading} onClick={() => { setActionError(null); setDialogOpen(true); }}>Create deployment</DenButton>
      } />
      {accessDenied ? (
        <DenNotice tone="neutral" icon={LockKeyhole} message={access.canViewDeployments ? "Deployment access changed. Sign in again or ask an organization owner for access." : permissionLockReason("deployments.view")} />
      ) : (
        <>
          {readGate === "feature_locked" ? <DenNotice tone="neutral" icon={LockKeyhole} message={deploymentPreparationLockMessage} action={<DenButton variant="secondary" onClick={() => void refreshRef.current?.()}>Check again</DenButton>} />
            : readGate === "unavailable" ? <DenNotice message="Could not verify deployments. Check again to refresh the last known observations." action={<DenButton variant="secondary" onClick={() => void refreshRef.current?.()}>Check again</DenButton>} /> : null}
          {lastKnown ? <p role="status" className="text-[13px] text-gray-500" data-testid="deployment-last-known">Last verified {new Date(loadedAt).toLocaleString()}. Showing last known observations.</p> : null}
          {!loading ? configuration?.providers.filter((entry) => !entry.available).map((entry) => <ProviderLock key={entry.provider} entry={entry} />) : null}
          {!loading && !access.canManageDeployments ? <p className="flex items-center gap-2 text-[13px] text-gray-500"><LockKeyhole aria-hidden className="size-4" />{permissionLockReason("deployments.manage")}</p> : null}
          {loading ? (
            <div className="space-y-2" aria-busy="true"><DenSkeleton className="h-12 w-full" /><DenSkeleton className="h-12 w-full" /></div>
          ) : deployments.length === 0 && readGate === "verified" ? (
            <p className="text-[13px] text-gray-500">No deployments yet. Create one in your cloud account with a public domain.</p>
          ) : (
            <ul className="divide-y divide-gray-100" aria-label="Deployments">
              {deployments.map((item) => {
                const status = deploymentStatus(item);
                return (
                  <li key={item.id}>
                    <button type="button" data-testid="managed-deployment-row" aria-current={selected?.id === item.id} onClick={() => { setSelectedId(item.id); setLaunch(null); setDeploymentToRemove(null); setActionError(null); }}
                      className="grid min-h-12 w-full grid-cols-[minmax(0,1fr)_5rem] items-center gap-x-4 gap-y-1 rounded-lg px-2 py-2 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400 aria-[current=true]:bg-gray-50 sm:grid-cols-[minmax(0,1fr)_5rem_13rem]">
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-gray-900" data-deployment-name>{item.name}</span>
                        <span className="block truncate text-[12px] text-gray-500">{providerName(item.provider)} · {item.provider === "aws" ? item.target.accountId : item.target.projectId} · {item.target.region}{item.provider === "aws" && item.target.network.mode === "existing" ? ` · ${item.target.network.vpcId}` : ""}</span>
                      </span>
                      <span className="text-right text-[13px] text-gray-500" data-deployment-version>{item.installedVersion ?? ""}</span>
                      <span className={`col-span-2 min-w-0 text-right text-[13px] sm:col-span-1 ${toneText[status.tone]}`} data-deployment-status>{lastKnown ? `Last known: ${status.label}` : status.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {selected ? (
            <DeploymentDetail deployment={selected} launch={launch?.deployment.id === selected.id ? launch : null} busy={busy} canManage={access.canManageDeployments}
              copied={copied} actionError={readGate === "verified" ? actionError : null} lastKnown={lastKnown} canPrepare={readGate === "verified" && (configuration?.providers.some((entry) => entry.provider === selected.provider && entry.available) ?? false)}
              onPrepare={(kind) => { void prepare(selected, kind); }}
              onCopy={(command) => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setActionError(new Error("Couldn't copy. Open Technical details and copy the command."))); }}
              onRemove={() => { setActionError(null); setDeploymentToRemove(selected); }} />
          ) : null}
        </>
      )}
      <ConfirmDialog destructive confirm={deploymentToRemove ? {
        title: `Remove ${deploymentToRemove.name}?`,
        description: `This removes the deployment record and its pending approval from this workspace. ${providerName(deploymentToRemove.provider)} resources and charges are unchanged. This cannot be undone.`,
        action: "Remove",
      } : null} onConfirm={async () => { if (deploymentToRemove) await remove(deploymentToRemove); }} onClose={() => setDeploymentToRemove(null)} />
      {configuration ? <CreateDeploymentDialog key={`${orgId}:${orgContext?.currentMember.id}`} open={dialogOpen} onOpenChange={setDialogOpen} configuration={configuration} blockedReason={blockedReason} beginMutation={beginMutation} runReauthableAction={runReauthableAction}
        onCreated={(item) => {
          setDialogOpen(false);
          if (readGateRef.current !== "verified") return;
          replace(item); setSelectedId(item.id); setLaunch(null);
          // Preparing a handoff does not run it or approve billable cloud work.
          if (item.provider === "gcp") void prepare(item, "install");
        }} /> : null}
    </section>
  );
}

function DeploymentDetail({ deployment, launch, busy, canManage, canPrepare, copied, actionError, lastKnown, onPrepare, onCopy, onRemove }: {
  deployment: ManagedDeployment; launch: Launch | null; busy: boolean; canManage: boolean; canPrepare: boolean; copied: boolean;
  actionError: Error | null; lastKnown: boolean; onPrepare: (kind: Launch["kind"]) => void; onCopy: (command: string) => void; onRemove: () => void;
}) {
  const status = deploymentStatus(deployment);
  const cloud = providerName(deployment.provider);
  const gcp = deployment.provider === "gcp";
  const run = deployment.run;
  const installed = Boolean(deployment.installedVersion);
  const runFailed = Boolean(run && (run.state === "failed" || run.expired));
  const failure = run?.events.find((event) => event.outcome === "failed");
  const nextStep = run?.events.length ?? 0;
  const neverStarted = !installed && (!run || run.state === "awaiting_approval");
  const health = deployment.health;
  return (
    <div className="flex min-w-0 flex-col gap-6 border-t border-gray-100 px-2 pt-6" data-testid="managed-deployment-detail">
      <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_13rem]">
        <h2 className="min-w-0 break-words text-[15px] font-semibold text-gray-900 [overflow-wrap:anywhere]">{deployment.name}</h2>
        <span className={`text-right text-[13px] ${toneText[status.tone]}`} data-testid="managed-deployment-status">{lastKnown ? `Last known: ${status.label}` : status.label}</span>
      </div>

      <div data-testid="managed-deployment-configuration">
        <Row label="Address">{installed ? <a className="underline-offset-2 hover:underline" href={deployment.webUrl} target="_blank" rel="noopener noreferrer">{deployment.domainName}</a> : deployment.domainName}</Row>
        <Row label="Cloud">{cloud} · {deployment.provider === "aws" ? deployment.target.accountId : deployment.target.projectId} · {deployment.target.region}</Row>
        {deployment.provider === "aws" ? <Row label="Network">{networkLabel(deployment.target.network)}</Row> : <><Row label="Project number">{deployment.target.projectNumber}</Row><Row label="DNS zone">{deployment.target.dnsZoneName}</Row></>}
        <Row label="Version">{deployment.installedVersion ?? "Not installed"}{deployment.updateAvailable && deployment.availableVersion ? ` · ${deployment.availableVersion} available` : ""}</Row>
        <Row label="Updates">Approval required</Row>
        {installed ? <Row label="Last health report">{relativeTime(health.reportedAt)}</Row> : null}
      </div>

      {installed ? (
        <section aria-labelledby="checks-heading" className="space-y-2">
          <h3 id="checks-heading" className="text-[13px] font-semibold text-gray-900">Status checks</h3>
          {health.state === "not_reporting" ? <p role="status" className="text-[13px] text-amber-700">No report since {health.reportedAt ? new Date(health.reportedAt).toLocaleString() : "installation"}. Showing the last known checks. Check the health agent in {gcp ? "Google Cloud Run and Cloud Scheduler" : "AWS Lambda"}.</p> : null}
          {health.state === "awaiting_report" ? <p className="text-[13px] text-gray-500">Waiting for the first report. Reports arrive every 5 minutes.</p> : null}
          {health.checks.length ? (
            <ul data-testid="managed-deployment-checks">
              {health.checks.map((check) => (
                <li key={check.id} className="flex min-h-10 items-center gap-3 border-b border-gray-100 py-2 text-[13px] last:border-b-0">
                  <StatusIcon status={check.status} />
                  <span className="text-gray-900">{CHECK_LABELS[check.id]}</span>
                  <span className="ml-auto text-gray-500">{checkDetail(check)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {run && run.state !== "ready" ? (
        <section aria-labelledby="run-heading" className="space-y-2">
          <h3 id="run-heading" className="text-[13px] font-semibold text-gray-900">{run.kind === "update" ? `Update to ${run.version}` : run.kind === "retry" ? `Retry ${run.version}` : `Install ${run.version}`}</h3>
          {run.state === "awaiting_approval" && !run.expired ? <p className="text-[13px] text-gray-500">Waiting for approval in {cloud}{gcp ? " Shell" : ""}.</p> : null}
          <ol data-testid="managed-deployment-steps">
            {deploymentStepSchema.options.map((step, index) => {
              const event = run.events.find((entry) => entry.step === step);
              const state = event ? (event.outcome === "succeeded" ? "ok" : "failing") : index === nextStep && run.state === "provisioning" && !run.expired ? "running" : "pending";
              return (
                <li key={step} className="flex min-h-9 items-center gap-3 text-[13px]">
                  {state === "ok" ? <CheckCircle2 aria-hidden className="size-4 text-gray-500" /> : state === "failing" ? <XCircle aria-hidden className="size-4 text-red-600" /> : <CircleDashed aria-hidden className={`size-4 ${state === "running" ? "text-gray-700 motion-safe:animate-pulse" : "text-gray-300"}`} />}
                  <span className={state === "pending" ? "text-gray-500" : "text-gray-900"}>{gcp && step === "account_verified" ? "Google Cloud project and domain verified" : STEP_LABELS[step]}</span>
                  {event ? <time className="ml-auto text-gray-400" dateTime={event.receivedAt}>{new Date(event.receivedAt).toLocaleTimeString()}</time> : null}
                </li>
              );
            })}
          </ol>
          {failure?.errorCode ? <p role="alert" className="text-[13px] text-red-700">{gcp ? gcpFailureMessage(failure.errorCode) : FAILURE_LABELS[failure.errorCode]}</p> : null}
          {run.expired && !failure ? <p role="alert" className="text-[13px] text-red-700">The installer stopped reporting. Open the installer logs in {cloud}, then retry.</p> : null}
        </section>
      ) : null}

      {launch?.command && run?.state === "awaiting_approval" && !run.expired ? (
        <section className="space-y-2" aria-label={`Run in ${gcp ? "Google Cloud Shell" : "AWS CloudShell"}`}>
          <p className="text-[13px] text-gray-700">{deployment.provider === "gcp"
            ? `Review and run this command in Google Cloud Shell for project ${deployment.target.projectId}. Running it approves the ${launch.kind === "update" ? "update" : "installation"} and creates or changes billable resources in your project. OpenWork does not run it for you.`
            : `Run this in AWS CloudShell, signed in to account ${deployment.target.accountId}. It updates the existing installer; nothing is deleted.`}</p>
          <div className="flex flex-wrap gap-2">
            <DenButton type="button" onClick={() => onCopy(launch.command ?? "")}><Copy aria-hidden className="size-4" />{copied ? "Copied" : "Copy command"}</DenButton>
            <a className={buttonVariants({ variant: "secondary" })} href={deployment.provider === "gcp" ? `https://console.cloud.google.com/?project=${encodeURIComponent(deployment.target.projectId)}&cloudshell=true` : `https://${deployment.target.region}.console.aws.amazon.com/cloudshell/home?region=${deployment.target.region}`} target="_blank" rel="noopener noreferrer">Open {gcp ? "Google Cloud Shell" : "AWS CloudShell"}<ExternalLink aria-hidden className="size-4" /></a>
          </div>
          <details className="text-[13px]"><summary className="cursor-pointer text-gray-500">Technical details</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-3 font-mono text-[12px] text-gray-700">{launch.command}</pre></details>
        </section>
      ) : null}

      <DeploymentActionFeedback error={actionError} />

      <div className="flex flex-wrap items-center gap-2">
        {canManage && !installed && (!run || (run.state === "awaiting_approval" && !run.expired)) ? (
          launch?.approvalUrl ? (
            <a className={buttonVariants({})} href={launch.approvalUrl} target="_blank" rel="noopener noreferrer">Review and approve in AWS<ExternalLink aria-hidden className="size-4" /></a>
          ) : !launch?.command ? <DenButton type="button" data-testid="deployment-prepare-install" loading={busy} disabled={!canPrepare} onClick={() => onPrepare("install")}>Prepare {cloud} approval</DenButton> : null
        ) : null}
        {canManage && runFailed ? <DenButton type="button" loading={busy} disabled={!canPrepare} onClick={() => onPrepare(installed || run?.events.length || run?.state === "failed" ? "retry" : "install")}>Prepare retry</DenButton> : null}
        {canManage && installed && deployment.updateAvailable && !runFailed && run?.state !== "provisioning" && (launch?.kind !== "update" || run?.state === "ready") ? <DenButton type="button" loading={busy} disabled={!canPrepare} onClick={() => onPrepare("update")}>Update to {deployment.availableVersion}</DenButton> : null}
        {installed ? <a className={buttonVariants({ variant: "secondary" })} href={deployment.webUrl} target="_blank" rel="noopener noreferrer">Open OpenWork<ExternalLink aria-hidden className="size-4" /></a> : null}
        <a className={buttonVariants({ variant: "ghost" })} href={deployment.consoleUrl} target="_blank" rel="noopener noreferrer">Open in {cloud}<ExternalLink aria-hidden className="size-4" /></a>
        {canManage && neverStarted ? <DenButton type="button" variant="secondary" disabled={busy || !canPrepare} data-testid="managed-deployment-remove" onClick={onRemove}>Remove</DenButton> : null}
      </div>

      <details className="text-[13px]">
        <summary className="cursor-pointer text-gray-500" data-testid="deployment-technical-details-toggle">Technical details</summary>
        <div className="mt-2 space-y-2 text-gray-600">
          <p className="[overflow-wrap:anywhere]" data-testid="deployment-setup-directions">{`First sign-in: open ${deployment.webUrl}/setup and enter the code from the deployment's ${gcp ? "Google Cloud Secret Manager" : "AWS Secrets Manager"} secret, field DEN_INITIAL_ADMIN_BOOTSTRAP_CODE. OpenWork never receives it.`}</p>
          <p>{gcp ? "Installer output is in Google Cloud Shell; service and health-agent logs are in Google Cloud Logging. Check Cloud Run and Cloud Scheduler for missing health reports. Reports contain only check results." : "Installer logs are in AWS CodeBuild; service logs in CloudWatch. Health reports come from a read-only AWS Lambda function in your account and contain only check results."}</p>
          <p>{gcp ? "Removing this record does not delete Google Cloud resources or stop charges. Terraform state stays in your project." : "Deleting the AWS installer stack does not delete OpenWork or its database. Terraform state stays in your account."}</p>
        </div>
      </details>
    </div>
  );
}

function CreateDeploymentDialog({ open, onOpenChange, configuration, blockedReason, beginMutation, runReauthableAction, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; configuration: Configuration;
  blockedReason: string | null; beginMutation: () => DeploymentMutationRequest;
  runReauthableAction: (label: string, action: () => Promise<void>) => Promise<void>; onCreated: (deployment: ManagedDeployment) => void;
}) {
  // Snapshot the initial cloud once: polling a late lock must not switch the entered target to another cloud.
  const [provider, setProvider] = useState<"aws" | "gcp">(() => configuration.providers.find((entry) => entry.available && (entry.provider === "aws" || entry.provider === "gcp"))?.provider === "gcp" ? "gcp" : "aws");
  const readiness = configuration?.providers.find((entry) => entry.provider === provider);
  const [projectId, setProjectId] = useState("");
  const [projectNumber, setProjectNumber] = useState("");
  const [gcpRegion, setGcpRegion] = useState("us-central1");
  const [dnsZoneName, setDnsZoneName] = useState("");
  const [name, setName] = useState("Production");
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [domainName, setDomainName] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [networkMode, setNetworkMode] = useState<"dedicated" | "existing">("dedicated");
  const [vpcId, setVpcId] = useState("");
  const [serviceSubnets, setServiceSubnets] = useState("");
  const [loadBalancerSubnets, setLoadBalancerSubnets] = useState("");
  const [clusterArn, setClusterArn] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blockedReason) { setError(new DeploymentReadinessError(blockedReason)); return; }
    const network = networkMode === "dedicated" ? { mode: "dedicated" } : {
      mode: "existing", vpcId: vpcId.trim(), serviceSubnetIds: idList(serviceSubnets), loadBalancerSubnetIds: idList(loadBalancerSubnets),
      ...(clusterArn.trim() ? { ecsClusterArn: clusterArn.trim() } : {}),
    };
    if (!readiness?.available) { setError(new DeploymentReadinessError("This cloud is not ready. Ask your OpenWork operator to resolve the deployment lock.")); return; }
    const parsed = managedDeploymentInputSchema.safeParse(provider === "gcp"
      ? { provider, name, domainName, ownerEmail, target: { projectId: projectId.trim(), projectNumber: projectNumber.trim(), region: gcpRegion, dnsZoneName: dnsZoneName.trim() } }
      : { provider, name, domainName, ownerEmail, target: { accountId: accountId.trim(), region, route53ZoneId: zoneId.trim(), network } });
    if (!parsed.success) { setError(new Error(parsed.error.issues[0]?.message ?? "Check the deployment details.")); return; }
    if (!consent) { setError(new Error("Confirm the cloud account, permissions and costs first.")); return; }
    const request = beginMutation();
    setBusy(true); setError(null);
    try {
      await runReauthableAction("Create deployment", async () => {
        if (!mounted.current) return;
        const result = await request("/v1/managed-deployments", { method: "POST", body: JSON.stringify(parsed.data) });
        if (!mounted.current || !result) return;
        if (!result.response.ok) {
          const recovery = deploymentActionError(result.payload, provider);
          throw recovery ? new DeploymentReadinessError(recovery) : getRequestError(result.payload, result.response, "Couldn't create the deployment.");
        }
        const created = managedDeploymentSchema.parse(result.payload);
        // A completed request still belongs to its original organization/account.
        if (mounted.current) { onCreated(created); setConsent(false); }
      });
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure : new Error("Couldn't create the deployment."));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    // Keep a configuration draft open when choosing portaled provider/region
    // options. Close and Escape remain explicit dismissal paths.
    <Dialog.Root open={open} disablePointerDismissal onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Popup data-testid="create-deployment-dialog" className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.35)]">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-gray-900">Create deployment</Dialog.Title>
            <Dialog.Close render={<DenButton type="button" variant="ghost" aria-label="Close" disabled={busy}><X aria-hidden className="size-4" /></DenButton>} />
          </div>
          <form onSubmit={(event) => { void submit(event); }} className="space-y-4">
            <div className="space-y-1 text-[13px]">
              <label htmlFor="deployment-cloud" className="text-gray-700">Cloud</label>
              <DenSelect id="deployment-cloud" value={provider} onChange={(event) => {
                if (event.target.value === "aws" || event.target.value === "gcp") { setProvider(event.target.value); setConsent(false); setError(null); }
              }}>
                {(configuration?.providers ?? []).map((entry) => (
                  <option key={entry.provider} value={entry.provider} disabled={!entry.available || entry.provider === "azure"}>{providerName(entry.provider)}{!entry.available ? " (locked)" : ""}</option>
                ))}
              </DenSelect>
            </div>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Name</span><DenInput value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
            {provider === "aws" ? <>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">AWS account ID</span><DenInput value={accountId} onChange={(event) => setAccountId(event.target.value)} required inputMode="numeric" placeholder="123456789012" /></label>
            <div className="space-y-1 text-[13px]">
              <label htmlFor="deployment-region" className="text-gray-700">Region</label>
              <DenSelect id="deployment-region" value={region} onChange={(event) => setRegion(event.target.value)}>
                {awsRegionSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}
              </DenSelect>
            </div>
            <fieldset className="flex flex-col gap-2 text-[13px] [&>label]:rounded-lg" data-testid="deployment-network-options">
              <legend className="mb-1 text-gray-700">Network</legend>
              <DenOptionCard type="radio" name="deployment-network" testId="network-dedicated" checked={networkMode === "dedicated"} onChange={() => setNetworkMode("dedicated")}
                title="New dedicated network" description="Creates its own VPC, NAT gateway and ECS cluster. Best for an AWS account that holds nothing else." />
              <DenOptionCard type="radio" name="deployment-network" testId="network-existing" checked={networkMode === "existing"} onChange={() => setNetworkMode("existing")}
                title="Existing VPC" description="Runs in your VPC and, optionally, your ECS cluster. The installer can change only what it creates." />
            </fieldset>
            {networkMode === "existing" ? (
              <div className="space-y-4 border-l border-gray-200 pl-4">
                <label className="block space-y-1 text-[13px]"><span className="text-gray-700">VPC ID</span><DenInput value={vpcId} onChange={(event) => setVpcId(event.target.value)} required placeholder="vpc-0abc12345" /></label>
                <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Private subnet IDs</span><DenInput value={serviceSubnets} onChange={(event) => setServiceSubnets(event.target.value)} required placeholder="subnet-0aaa…, subnet-0bbb…" /><span className="block text-gray-500">Two or more, in different availability zones, with outbound internet through NAT.</span></label>
                <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Public subnet IDs</span><DenInput value={loadBalancerSubnets} onChange={(event) => setLoadBalancerSubnets(event.target.value)} required placeholder="subnet-0ccc…, subnet-0ddd…" /><span className="block text-gray-500">For the load balancer. Two or more, routed to an internet gateway.</span></label>
                <label className="block space-y-1 text-[13px]"><span className="text-gray-700">ECS cluster ARN (optional)</span><DenInput value={clusterArn} onChange={(event) => setClusterArn(event.target.value)} placeholder="arn:aws:ecs:us-east-1:123456789012:cluster/platform" /><span className="block text-gray-500">Leave empty to create a cluster for OpenWork.</span></label>
              </div>
            ) : null}
            </> : <>
              <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Google Cloud project ID</span><DenInput value={projectId} onChange={(event) => setProjectId(event.target.value)} required placeholder="openwork-production" /></label>
              <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Google Cloud project number</span><DenInput value={projectNumber} onChange={(event) => setProjectNumber(event.target.value)} required inputMode="numeric" placeholder="123456789012" /></label>
              <div className="space-y-1 text-[13px]">
                <label htmlFor="deployment-gcp-region" className="text-gray-700">Region</label>
                <DenSelect id="deployment-gcp-region" value={gcpRegion} onChange={(event) => setGcpRegion(event.target.value)}>
                  {gcpRegionSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}
                </DenSelect>
              </div>
            </>}
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Address</span><DenInput value={domainName} onChange={(event) => setDomainName(event.target.value)} required placeholder="openwork.example.com" /></label>
            {provider === "aws" ? <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Route 53 hosted zone ID for that address</span><DenInput value={zoneId} onChange={(event) => setZoneId(event.target.value)} required placeholder="Z0123456789ABC" /></label>
              : <div className="space-y-1 text-[13px]"><label htmlFor="deployment-dns-zone" className="text-gray-700">Cloud DNS managed zone name for that address</label><DenInput id="deployment-dns-zone" aria-describedby="deployment-dns-zone-hint" value={dnsZoneName} onChange={(event) => setDnsZoneName(event.target.value)} required placeholder="example-com" /><p id="deployment-dns-zone-hint" className="text-gray-500">Use a public zone in this project that serves the address.</p></div>}
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">First administrator email</span><DenInput type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} required /></label>
            <label className="flex items-start gap-3 text-[13px] text-gray-700">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span className="min-w-0" data-testid="deployment-cost-consent">{provider === "gcp" ? "I control this Google Cloud project and public DNS zone, with billing enabled. I'll review the installer's permissions and run its command in Google Cloud Shell to approve. Only running the command creates or changes billable Cloud Run, Cloud SQL, load balancer and storage resources in my project. Removing this record does not delete those resources or stop charges. OpenWork receives deployment progress and health checks, never the first-sign-in code." : `I control this AWS account and hosted zone. AWS bills my account for the containers, database and load balancer${networkMode === "dedicated" ? " and NAT gateway (about $100–150 a month at the small size)" : " (about $60–100 a month at the small size, plus my network's own costs)"}. I'll review the installer's permissions in AWS before approving.`}</span>
            </label>
            {blockedReason ? <DenNotice tone="neutral" icon={LockKeyhole} message={blockedReason} /> : readiness && !readiness.available ? <ProviderLock entry={readiness} /> : <DeploymentActionFeedback error={error} />}
            <DenButton type="submit" data-testid="create-deployment-submit" loading={busy} disabled={!consent || !readiness?.available || Boolean(blockedReason)}>{provider === "gcp" ? "Prepare Google Cloud approval" : "Create deployment"}</DenButton>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
