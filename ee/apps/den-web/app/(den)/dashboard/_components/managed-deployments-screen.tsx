"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  awsRegionSchema, deploymentStepSchema, managedDeploymentConfigurationSchema, managedDeploymentInputSchema,
  managedDeploymentLaunchSchema, managedDeploymentListSchema, managedDeploymentSchema,
  type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";
import { AlertTriangle, CheckCircle2, CircleDashed, Copy, ExternalLink, LockKeyhole, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type Configuration = z.infer<typeof managedDeploymentConfigurationSchema>;
type Launch = z.infer<typeof managedDeploymentLaunchSchema>;
type Check = ManagedDeployment["health"]["checks"][number];
type Tone = "neutral" | "warning" | "danger";

const STEP_LABELS: Record<z.infer<typeof deploymentStepSchema>, string> = {
  runner_connected: "Installer connected", release_verified: "Release verified", account_verified: "AWS account and domain verified",
  infrastructure_applied: "Infrastructure installed", services_ready: "Services started", health_verified: "HTTPS and database verified",
};
const FAILURE_LABELS: Record<string, string> = {
  release_verification_failed: "The release could not be verified. Open the installer logs in AWS.",
  infrastructure_failed: "Infrastructure installation failed. Open the installer logs in AWS, then retry.",
  service_unhealthy: "Services did not start. Check the ECS service events in AWS, then retry.",
  health_check_failed: "HTTPS or the database could not be verified. Check DNS for the domain, then retry.",
  runner_failed: "The AWS account or hosted zone did not match. Check the deployment details.",
};
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

/** One status line per deployment: installation progress first, then health. */
export function deploymentStatus(deployment: ManagedDeployment): { label: string; tone: Tone } {
  const run = deployment.run;
  if (!deployment.installedVersion) {
    if (!run) return { label: "Not launched", tone: "neutral" };
    if (run.expired) return { label: "Installer stopped reporting", tone: "danger" };
    if (run.state === "awaiting_approval") return { label: "Awaiting AWS approval", tone: "neutral" };
    if (run.state === "provisioning") return { label: "Installing", tone: "neutral" };
    if (run.state === "failed") return { label: "Install failed", tone: "danger" };
  }
  if (run?.state === "provisioning" && !run.expired) return { label: "Updating", tone: "neutral" };
  switch (deployment.health.state) {
    case "operational": return { label: "Operational", tone: "neutral" };
    case "degraded": return { label: "Degraded", tone: "warning" };
    case "down": return { label: "Down", tone: "danger" };
    case "not_reporting": return { label: "Not reporting", tone: "warning" };
    case "awaiting_report": return { label: "Waiting for first report", tone: "neutral" };
  }
}

const toneText: Record<Tone, string> = { neutral: "text-gray-700", warning: "text-amber-700", danger: "text-red-700" };

function StatusIcon({ status }: { status: Check["status"] }) {
  if (status === "ok") return <CheckCircle2 aria-hidden className="size-4 text-gray-500" />;
  if (status === "warning") return <AlertTriangle aria-hidden className="size-4 text-amber-600" />;
  if (status === "failing") return <XCircle aria-hidden className="size-4 text-red-600" />;
  return <CircleDashed aria-hidden className="size-4 text-gray-400" />;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-gray-100 py-2 text-[13px] last:border-b-0">
      <span className="text-gray-500">{label}</span>
      <span className="min-w-0 truncate text-right text-gray-900">{children}</span>
    </div>
  );
}

export function ManagedDeploymentsScreen() {
  const { orgId, orgContext, runReauthableAction } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles);
  const enabled = orgFeatureEnabled(orgContext, "managedDeployments");
  const [deployments, setDeployments] = useState<ManagedDeployment[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const generation = useRef(0);
  const aws = configuration?.providers.find((entry) => entry.provider === "aws") ?? null;
  const selected = deployments.find((entry) => entry.id === selectedId) ?? deployments[0] ?? null;

  useEffect(() => {
    const current = ++generation.current;
    setDeployments([]); setSelectedId(null); setLaunch(null); setError(null); setActionError(null); setBusy(false); setDialogOpen(false);
    setLoading(enabled && access.canViewSettings);
    if (!enabled || !orgId || !access.canViewSettings) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [list, settings] = await Promise.all([
          requestJson("/v1/managed-deployments", { method: "GET" }),
          requestJson("/v1/managed-deployments/configuration", { method: "GET" }),
        ]);
        if (!list.response.ok) throw new Error(getErrorMessage(list.payload, "Couldn't load deployments."));
        if (!settings.response.ok) throw new Error(getErrorMessage(settings.payload, "Couldn't load deployment settings."));
        const parsed = managedDeploymentListSchema.parse(list.payload);
        if (!stopped && generation.current === current) {
          setDeployments(parsed.deployments);
          setConfiguration(managedDeploymentConfigurationSchema.parse(settings.payload));
          setLoadedAt(new Date().toISOString());
          setError(null);
        }
      } catch (failure) {
        if (!stopped && generation.current === current) setError(failure instanceof Error ? failure.message : "Couldn't load deployments.");
      } finally {
        if (!stopped && generation.current === current) {
          setLoading(false);
          timer = setTimeout(() => { void refresh(); }, 10_000);
        }
      }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [orgId, enabled, access.canViewSettings]);

  function replace(item: ManagedDeployment) {
    setDeployments((previous) => previous.some((entry) => entry.id === item.id) ? previous.map((entry) => entry.id === item.id ? item : entry) : [...previous, item]);
  }

  async function prepare(deployment: ManagedDeployment, kind: Launch["kind"]) {
    const current = generation.current;
    setBusy(true); setActionError(null); setCopied(false);
    try {
      await runReauthableAction(kind === "install" ? "Prepare AWS approval" : kind === "update" ? "Prepare update" : "Prepare retry", async () => {
        const result = await requestJson(`/v1/managed-deployments/${deployment.id}/launch`, { method: "POST", body: JSON.stringify({ kind }) });
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Couldn't prepare the installer.");
        const parsed = managedDeploymentLaunchSchema.parse(result.payload);
        if (generation.current === current) { setLaunch(parsed); replace(parsed.deployment); }
      });
    } catch (failure) {
      if (generation.current === current) setActionError(failure instanceof Error ? failure.message : "Couldn't prepare the installer.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  async function remove(deployment: ManagedDeployment) {
    const current = generation.current;
    setBusy(true); setActionError(null);
    try {
      await runReauthableAction("Remove deployment", async () => {
        const result = await requestJson(`/v1/managed-deployments/${deployment.id}`, { method: "DELETE" });
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Couldn't remove the deployment.");
        if (generation.current === current) { setDeployments((previous) => previous.filter((entry) => entry.id !== deployment.id)); setSelectedId(null); setConfirmRemove(false); }
      });
    } catch (failure) {
      if (generation.current === current) setActionError(failure instanceof Error ? failure.message : "Couldn't remove the deployment.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  const locked = !enabled ? "Deployments aren't turned on for this workspace. Ask your OpenWork contact to enable them."
    : !access.canViewSettings ? "Only workspace admins can see deployments." : null;
  const canCreate = Boolean(!locked && aws?.available && access.canManageSettings);

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 p-6" data-testid="managed-deployments-screen">
      <DenPageHeader title="Deployments" size="compact" action={
        <DenButton type="button" disabled={!canCreate || loading} onClick={() => { setActionError(null); setDialogOpen(true); }}>Create deployment</DenButton>
      } />
      {locked ? (
        <p className="flex items-center gap-2 text-[13px] text-gray-500"><LockKeyhole aria-hidden className="size-4" />{locked}</p>
      ) : (
        <>
          {error ? <p role="alert" className="text-[13px] text-red-700">{error} {loadedAt ? `Showing deployments from ${new Date(loadedAt).toLocaleTimeString()}.` : ""}</p> : null}
          {!loading && aws && !aws.available ? (
            <p className="flex items-center gap-2 text-[13px] text-gray-500"><LockKeyhole aria-hidden className="size-4" />No AWS installer is published for this OpenWork environment yet. An OpenWork operator publishes it.</p>
          ) : null}
          {!loading && !access.canManageSettings ? <p className="flex items-center gap-2 text-[13px] text-gray-500"><LockKeyhole aria-hidden className="size-4" />Owners and super-admins create and update deployments.</p> : null}
          {loading ? (
            <div className="space-y-2" aria-busy="true"><DenSkeleton className="h-12 w-full" /><DenSkeleton className="h-12 w-full" /></div>
          ) : deployments.length === 0 && !error ? (
            <p className="text-[13px] text-gray-500">No deployments yet. Create one in a dedicated AWS account with a public Route 53 domain.</p>
          ) : (
            <ul className="divide-y divide-gray-100" aria-label="Deployments">
              {deployments.map((item) => {
                const status = deploymentStatus(item);
                return (
                  <li key={item.id}>
                    <button type="button" data-testid="managed-deployment-row" aria-current={selected?.id === item.id} onClick={() => { setSelectedId(item.id); setLaunch(null); setConfirmRemove(false); setActionError(null); }}
                      className="flex min-h-12 w-full items-center justify-between gap-4 rounded-lg px-2 py-2 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400 aria-[current=true]:bg-gray-50">
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-gray-900">{item.name}</span>
                        <span className="block truncate text-[12px] text-gray-500">AWS · {item.target.accountId} · {item.target.region}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-4 text-[13px]">
                        <span className="text-gray-500">{item.installedVersion ?? ""}</span>
                        <span className={toneText[status.tone]}>{status.label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {selected ? (
            <DeploymentDetail deployment={selected} launch={launch?.deployment.id === selected.id ? launch : null} busy={busy} canManage={access.canManageSettings}
              copied={copied} confirmRemove={confirmRemove} actionError={actionError}
              onPrepare={(kind) => { void prepare(selected, kind); }}
              onCopy={(command) => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setActionError("Couldn't copy. Open Technical details and copy the command.")); }}
              onRemove={() => { if (confirmRemove) void remove(selected); else setConfirmRemove(true); }} />
          ) : null}
        </>
      )}
      <CreateDeploymentDialog open={dialogOpen} onOpenChange={setDialogOpen} configuration={configuration} runReauthableAction={runReauthableAction}
        onCreated={(item) => { replace(item); setSelectedId(item.id); setLaunch(null); setDialogOpen(false); }} />
    </section>
  );
}

function DeploymentDetail({ deployment, launch, busy, canManage, copied, confirmRemove, actionError, onPrepare, onCopy, onRemove }: {
  deployment: ManagedDeployment; launch: Launch | null; busy: boolean; canManage: boolean; copied: boolean; confirmRemove: boolean;
  actionError: string | null; onPrepare: (kind: Launch["kind"]) => void; onCopy: (command: string) => void; onRemove: () => void;
}) {
  const status = deploymentStatus(deployment);
  const run = deployment.run;
  const installed = Boolean(deployment.installedVersion);
  const runFailed = Boolean(run && (run.state === "failed" || run.expired));
  const failure = run?.events.find((event) => event.outcome === "failed");
  const nextStep = run?.events.length ?? 0;
  const neverStarted = !installed && (!run || run.state === "awaiting_approval");
  const health = deployment.health;
  return (
    <div className="space-y-6 border-t border-gray-100 pt-6" data-testid="managed-deployment-detail">
      <div className="flex items-center justify-between gap-4">
        <h2 className="truncate text-[15px] font-semibold text-gray-900">{deployment.name}</h2>
        <span className={`text-[13px] ${toneText[status.tone]}`} data-testid="managed-deployment-status">{status.label}</span>
      </div>

      <div>
        <Row label="Address">{installed ? <a className="underline-offset-2 hover:underline" href={deployment.webUrl} target="_blank" rel="noopener noreferrer">{deployment.domainName}</a> : deployment.domainName}</Row>
        <Row label="Cloud">AWS · {deployment.target.accountId} · {deployment.target.region}</Row>
        <Row label="Version">{deployment.installedVersion ?? "Not installed"}{deployment.updateAvailable && deployment.availableVersion ? ` · ${deployment.availableVersion} available` : ""}</Row>
        <Row label="Updates">Approval required</Row>
        {installed ? <Row label="Last health report">{relativeTime(health.reportedAt)}</Row> : null}
      </div>

      {installed ? (
        <section aria-labelledby="checks-heading" className="space-y-2">
          <h3 id="checks-heading" className="text-[13px] font-semibold text-gray-900">Status checks</h3>
          {health.state === "not_reporting" ? <p role="status" className="text-[13px] text-amber-700">No report since {health.reportedAt ? new Date(health.reportedAt).toLocaleString() : "installation"}. Showing the last known checks. Check the health agent in AWS Lambda.</p> : null}
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
          {run.state === "awaiting_approval" && !run.expired ? <p className="text-[13px] text-gray-500">Waiting for approval in AWS.</p> : null}
          <ol data-testid="managed-deployment-steps">
            {deploymentStepSchema.options.map((step, index) => {
              const event = run.events.find((entry) => entry.step === step);
              const state = event ? (event.outcome === "succeeded" ? "ok" : "failing") : index === nextStep && run.state === "provisioning" && !run.expired ? "running" : "pending";
              return (
                <li key={step} className="flex min-h-9 items-center gap-3 text-[13px]">
                  {state === "ok" ? <CheckCircle2 aria-hidden className="size-4 text-gray-500" /> : state === "failing" ? <XCircle aria-hidden className="size-4 text-red-600" /> : <CircleDashed aria-hidden className={`size-4 ${state === "running" ? "text-gray-700 motion-safe:animate-pulse" : "text-gray-300"}`} />}
                  <span className={state === "pending" ? "text-gray-400" : "text-gray-900"}>{STEP_LABELS[step]}</span>
                  {event ? <time className="ml-auto text-gray-400" dateTime={event.receivedAt}>{new Date(event.receivedAt).toLocaleTimeString()}</time> : null}
                </li>
              );
            })}
          </ol>
          {failure?.errorCode ? <p role="alert" className="text-[13px] text-red-700">{FAILURE_LABELS[failure.errorCode]}</p> : null}
          {run.expired && !failure ? <p role="alert" className="text-[13px] text-red-700">The installer stopped reporting. Open the installer logs in AWS, then retry.</p> : null}
        </section>
      ) : null}

      {launch?.command ? (
        <section className="space-y-2" aria-label="Run in AWS CloudShell">
          <p className="text-[13px] text-gray-700">Run this in AWS CloudShell, signed in to account {deployment.target.accountId}. It updates the existing installer; nothing is deleted.</p>
          <div className="flex flex-wrap gap-2">
            <DenButton type="button" onClick={() => onCopy(launch.command ?? "")}><Copy aria-hidden className="size-4" />{copied ? "Copied" : "Copy command"}</DenButton>
            <a className={buttonVariants({ variant: "secondary" })} href={`https://${deployment.target.region}.console.aws.amazon.com/cloudshell/home?region=${deployment.target.region}`} target="_blank" rel="noopener noreferrer">Open AWS CloudShell<ExternalLink aria-hidden className="size-4" /></a>
          </div>
          <details className="text-[13px]"><summary className="cursor-pointer text-gray-500">Technical details</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-3 font-mono text-[12px] text-gray-700">{launch.command}</pre></details>
        </section>
      ) : null}

      {actionError ? <p role="alert" className="text-[13px] text-red-700">{actionError}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {canManage && !installed && (!run || (run.state === "awaiting_approval" && !run.expired)) ? (
          launch?.approvalUrl ? (
            <a className={buttonVariants({})} href={launch.approvalUrl} target="_blank" rel="noopener noreferrer">Review and approve in AWS<ExternalLink aria-hidden className="size-4" /></a>
          ) : <DenButton type="button" loading={busy} onClick={() => onPrepare("install")}>Prepare AWS approval</DenButton>
        ) : null}
        {canManage && runFailed && !(launch?.kind === "retry") ? <DenButton type="button" loading={busy} onClick={() => onPrepare(installed || run?.events.length || run?.state === "failed" ? "retry" : "install")}>Prepare retry</DenButton> : null}
        {canManage && installed && deployment.updateAvailable && !runFailed && run?.state !== "provisioning" && launch?.kind !== "update" ? <DenButton type="button" loading={busy} onClick={() => onPrepare("update")}>Update to {deployment.availableVersion}</DenButton> : null}
        {installed ? <a className={buttonVariants({ variant: "secondary" })} href={deployment.webUrl} target="_blank" rel="noopener noreferrer">Open OpenWork<ExternalLink aria-hidden className="size-4" /></a> : null}
        <a className={buttonVariants({ variant: "ghost" })} href={deployment.consoleUrl} target="_blank" rel="noopener noreferrer">Open in AWS<ExternalLink aria-hidden className="size-4" /></a>
        {canManage && neverStarted ? <DenButton type="button" variant="destructive" loading={busy} onClick={onRemove}>{confirmRemove ? "Confirm remove" : "Remove"}</DenButton> : null}
      </div>

      <details className="text-[13px]">
        <summary className="cursor-pointer text-gray-500">Technical details</summary>
        <div className="mt-2 space-y-2 text-gray-600">
          <p>First sign-in: open {deployment.webUrl}/setup and enter the code from the deployment's AWS Secrets Manager secret, field DEN_INITIAL_ADMIN_BOOTSTRAP_CODE. OpenWork never receives it.</p>
          <p>Installer logs are in AWS CodeBuild; service logs in CloudWatch. Health reports come from a read-only AWS Lambda function in your account and contain only check results.</p>
          <p>Deleting the AWS installer stack does not delete OpenWork or its database. Terraform state stays in your account.</p>
        </div>
      </details>
    </div>
  );
}

function CreateDeploymentDialog({ open, onOpenChange, configuration, runReauthableAction, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; configuration: Configuration | null;
  runReauthableAction: (label: string, action: () => Promise<void>) => Promise<void>; onCreated: (deployment: ManagedDeployment) => void;
}) {
  const [name, setName] = useState("Production");
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [domainName, setDomainName] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = managedDeploymentInputSchema.safeParse({ provider: "aws", name, domainName, ownerEmail, target: { accountId: accountId.trim(), region, route53ZoneId: zoneId.trim() } });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the deployment details."); return; }
    if (!consent) { setError("Confirm the account, permissions and AWS costs first."); return; }
    setBusy(true); setError(null);
    try {
      await runReauthableAction("Create deployment", async () => {
        const result = await requestJson("/v1/managed-deployments", { method: "POST", body: JSON.stringify(parsed.data) });
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Couldn't create the deployment.");
        onCreated(managedDeploymentSchema.parse(result.payload));
        setConsent(false);
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't create the deployment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.35)]">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-gray-900">Create deployment</Dialog.Title>
            <Dialog.Close render={<DenButton type="button" variant="ghost" aria-label="Close" disabled={busy}><X aria-hidden className="size-4" /></DenButton>} />
          </div>
          <form onSubmit={(event) => { void submit(event); }} className="space-y-4">
            <div className="space-y-1 text-[13px]">
              <label htmlFor="deployment-cloud" className="text-gray-700">Cloud</label>
              <DenSelect id="deployment-cloud" value="aws" onChange={() => undefined}>
                {(configuration?.providers ?? [{ provider: "aws", available: true, version: null }]).map((entry) => (
                  <option key={entry.provider} value={entry.provider} disabled={!entry.available}>{entry.provider === "aws" ? "AWS" : entry.provider === "azure" ? "Azure (not available yet)" : "Google Cloud (not available yet)"}</option>
                ))}
              </DenSelect>
            </div>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Name</span><DenInput value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Dedicated AWS account ID</span><DenInput value={accountId} onChange={(event) => setAccountId(event.target.value)} required inputMode="numeric" placeholder="123456789012" /></label>
            <div className="space-y-1 text-[13px]">
              <label htmlFor="deployment-region" className="text-gray-700">Region</label>
              <DenSelect id="deployment-region" value={region} onChange={(event) => setRegion(event.target.value)}>
                {awsRegionSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}
              </DenSelect>
            </div>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Address</span><DenInput value={domainName} onChange={(event) => setDomainName(event.target.value)} required placeholder="openwork.example.com" /></label>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Route 53 hosted zone ID for that address</span><DenInput value={zoneId} onChange={(event) => setZoneId(event.target.value)} required placeholder="Z0123456789ABC" /></label>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">First administrator email</span><DenInput type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} required /></label>
            <label className="flex items-start gap-3 text-[13px] text-gray-700">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>I control this AWS account and hosted zone. AWS bills my account for the containers, database, load balancer and NAT gateway (about $100–150 a month at the small size). I'll review the installer's permissions in AWS before approving.</span>
            </label>
            {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
            <DenButton type="submit" loading={busy} disabled={!consent}>Create deployment</DenButton>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
