"use client";

import { Dialog } from "@base-ui/react/dialog";
import {
  assistantsEnabled, awsSignInSchema, deploymentStepSchema, gatewayAssistants,
  type AwsAssistants, type AwsRuntimeProfile, type AwsSignIn, type DeploymentLaunchKind, type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";
import { CheckCircle2, ChevronRight, CircleDashed, Copy, ExternalLink, LockKeyhole, X, XCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getDeploymentsRoute, orgFeatureEnabled, permissionLockReason } from "../../_lib/den-org";
import { useFeatureIntro } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { BackLink, ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { DetailRows, DisclosureGroup, DisclosureSection, ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton, type ItemMenuEntry } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { ManagedDeploymentAssistants } from "./managed-deployment-assistants";
import {
  CHECK_LABELS, CreateDeploymentDialog, FAILURE_LABELS, ProviderLock, STEP_LABELS, StatusIcon, checkDetail, gcpFailureMessage, networkLabel, relativeTime,
} from "./managed-deployments-screen";
import { assistantSettingsState, deploymentStatus, providerName, type DeploymentTone } from "./managed-deployments-state";
import { useManagedDeployments, type DeploymentLaunch } from "./use-managed-deployments";
import { ManagedDeploymentConfigurationDialog } from "./managed-deployment-configuration-dialog";
import { CHANGE_STOPPED_REPORTING, approvalReserved, changeFailureMessage, changeNeverApproved, configurationEntry, currentHandoff, runtimeBlock } from "./managed-deployment-configuration-state";
import { ConfigurationLockLine, ManagedDeploymentConfigurationSummary, type ConfigurationControls } from "./managed-deployment-configuration-summary";

const TONE_TEXT: Record<DeploymentTone, string> = { neutral: "", warning: "text-amber-700", danger: "text-red-700" };
const ROW_CLASS = "flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 py-2";
const LOCKED = "Deployments aren't turned on for this workspace. Ask your OpenWork contact to enable them.";

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** An AWS account number in the groups AWS shows it in. */
function accountNumber(id: string) {
  return id.replace(/^(\d{4})(\d{4})(\d{4})$/, "$1 $2 $3");
}

function portalHost(signIn: AwsSignIn) {
  return new URL(signIn.portalUrl).host;
}

function cloudAccount(deployment: ManagedDeployment) {
  return deployment.provider === "aws" ? accountNumber(deployment.target.accountId) : deployment.target.projectId;
}

function CloudLogo({ provider }: { provider: ManagedDeployment["provider"] }) {
  if (provider === "gcp") return <ConnectorLogo name="Google Cloud" url="https://cloud.google.com" />;
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white" data-testid="aws-logo">
      <svg width="24" height="15" viewBox="0 0 32 20" role="img" aria-label="AWS">
        <text x="16" y="11" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="700" fill="#232f3e">aws</text>
        <path d="M5 14.5c6.5 3.6 15.5 3.6 22 0" stroke="#f90" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Lock({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-[13px] text-gray-500"><LockKeyhole aria-hidden className="size-4 shrink-0" />{children}</p>;
}

function StepNumber({ value }: { value: number }) {
  return <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--den-list-line)] text-[12px] text-[var(--dls-text-secondary)]">{value}</span>;
}

function StepText({ title, description, pending = false }: { title: ReactNode; description?: ReactNode; pending?: boolean }) {
  return (
    <span className="flex min-w-[12rem] flex-1 flex-col">
      <span className={`text-[13px] leading-5 ${pending ? "text-[var(--dls-text-secondary)]" : "font-medium text-[var(--dls-text-primary)]"}`}>{title}</span>
      {description ? <span className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">{description}</span> : null}
    </span>
  );
}

/** Where the organization's people sign in to AWS, so every AWS link lands in the right account. */
function AwsSignInDialog({ open, onClose, saved, onSave }: {
  open: boolean; onClose: () => void; saved: AwsSignIn | null; onSave: (value: AwsSignIn | null) => Promise<void>;
}) {
  const [portalUrl, setPortalUrl] = useState("");
  const [roleName, setRoleName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setPortalUrl(saved?.portalUrl ?? ""); setRoleName(saved?.roleName ?? "AdministratorAccess"); setError(null); }
  }

  async function save(value: AwsSignIn | null) {
    setBusy(true); setError(null);
    try {
      await onSave(value);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the AWS sign-in.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = awsSignInSchema.safeParse({ portalUrl, roleName });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the access portal URL and role."); return; }
    void save(parsed.data);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Popup data-testid="aws-sign-in-dialog" className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.35)]">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-gray-900">AWS sign-in</Dialog.Title>
            <Dialog.Close render={<DenButton type="button" variant="ghost" aria-label="Close" disabled={busy}><X aria-hidden className="size-4" /></DenButton>} />
          </div>
          <form onSubmit={submit} className="space-y-4">
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">AWS access portal URL</span>
              <DenInput data-testid="aws-sign-in-portal" value={portalUrl} onChange={(event) => setPortalUrl(event.target.value)} required placeholder="https://your-company.awsapps.com/start" /></label>
            <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Role</span>
              <DenInput data-testid="aws-sign-in-role" value={roleName} onChange={(event) => setRoleName(event.target.value)} required placeholder="AdministratorAccess" /></label>
            <p className="text-[12px] leading-4 text-gray-500">Every AWS link in Deployments opens through this sign-in, in the deployment&apos;s own account.</p>
            {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {saved ? <DenButton type="button" variant="ghost" disabled={busy} data-testid="aws-sign-in-remove" onClick={() => { void save(null); }}>Remove</DenButton> : <span />}
              <span className="flex items-center gap-2">
                <DenButton type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</DenButton>
                <DenButton type="submit" loading={busy} data-testid="aws-sign-in-save">Save sign-in</DenButton>
              </span>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Deployments as a list; each one opens as its own page. */
export function GuidedDeploymentsList() {
  const { orgSlug } = useOrgDashboard();
  const router = useRouter();
  const {
    enabled, access, deployments, configuration, loading, loadedAt, error, setActionError, assistantsAvailable, available, runReauthableAction, replace, saveAwsSignIn,
  } = useManagedDeployments();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const signIn = configuration?.awsSignIn ?? null;
  const route = getDeploymentsRoute(orgSlug);

  const intro = useFeatureIntro(
    "deployments",
    enabled && access.canViewDeployments && !loading && !error && configuration ? { deployments: deployments.length, cloudReady: available } : null,
  );

  // Feature intro action (DESIGN.md I5): ?new=1 opens Create deployment once, then leaves the address.
  const searchParams = useSearchParams();
  const newRequested = searchParams.get("new") === "1";
  useEffect(() => {
    if (!newRequested || loading) return;
    if (enabled && access.canManageDeployments && available) { setActionError(null); setDialogOpen(true); }
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url);
  }, [newRequested, loading, enabled, access.canManageDeployments, available, setActionError]);

  const createDialog = (
    <CreateDeploymentDialog open={dialogOpen} onOpenChange={setDialogOpen} configuration={configuration} assistantsAvailable={assistantsAvailable} runReauthableAction={runReauthableAction}
      onCreated={(item) => { replace(item); setDialogOpen(false); router.push(`${route}/${item.id}`); }} />
  );

  if (intro.size === "fullscreen") {
    return <ItemPage wide testId="managed-deployments-screen">{intro.element}{createDialog}</ItemPage>;
  }

  const locked = !enabled ? LOCKED : !access.canViewDeployments ? permissionLockReason("deployments.view") : null;
  const canCreate = Boolean(!locked && available && access.canManageDeployments);
  const running = deployments.filter((item) => item.installedVersion && (item.health.state === "operational" || item.health.state === "degraded")).length;
  const count = `${deployments.length} deployment${deployments.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`;

  return (
    <ItemPage wide testId="managed-deployments-screen">
      <ItemHeader compact title="Deployments" state={!locked && !loading && deployments.length ? count : undefined}
        actions={<DenButton type="button" disabled={!canCreate || loading} onClick={() => setDialogOpen(true)}>Create deployment</DenButton>} />
      {locked ? <Lock>{locked}</Lock> : (
        <>
          {error ? <p role="alert" className="text-[13px] text-red-700">{error} {loadedAt ? `Showing deployments from ${new Date(loadedAt).toLocaleTimeString()}.` : ""}</p> : null}
          {!loading && !available ? configuration?.providers.filter((entry) => !entry.available).map((entry) => <ProviderLock key={entry.provider} entry={entry} />) : null}
          {!loading && !access.canManageDeployments ? <Lock>{permissionLockReason("deployments.manage")}</Lock> : null}
          {loading ? <ItemRowsSkeleton label="Loading deployments" rows={2} /> : deployments.length === 0 && !error ? (
            <p className="text-[13px] text-gray-500">No deployments yet. Create one in your cloud account with a public domain.</p>
          ) : (
            <ItemPanel>
              {deployments.map((item) => {
                const status = deploymentStatus(item);
                return (
                  <ItemRow key={item.id} testId="managed-deployment-row" href={`${route}/${item.id}`} statusOnNarrow
                    logo={<CloudLogo provider={item.provider} />}
                    title={<span data-deployment-name>{item.name}</span>}
                    description={`${item.domainName} · ${cloudAccount(item)} · ${item.target.region}`}
                    comparison={<span className="w-16 shrink-0 text-right text-[13px] text-[var(--dls-text-secondary)]" data-deployment-version>{item.installedVersion ?? ""}</span>}
                    status={<span className={TONE_TEXT[status.tone]} data-deployment-status>{status.label}</span>}
                    action={<ChevronRight aria-hidden className="h-4 w-4 text-gray-400" strokeWidth={1.5} />} />
                );
              })}
            </ItemPanel>
          )}
          {!loading && configuration ? (
            <section className="flex flex-col gap-2.5" data-testid="deployment-settings">
              <SectionTitle title="Settings" />
              <ItemPanel>
                <ItemRow testId="aws-sign-in-setting" logo={<CloudLogo provider="aws" />} title="AWS sign-in" statusOnNarrow
                  status={signIn ? `${portalHost(signIn)} · ${signIn.roleName}` : "Not set"}
                  action={access.canManageDeployments ? <DenButton type="button" variant="secondary" size="sm" data-testid="aws-sign-in-open" onClick={() => setSignInOpen(true)}>{signIn ? "Edit" : "Set up"}</DenButton> : undefined} />
              </ItemPanel>
            </section>
          ) : null}
        </>
      )}
      <AwsSignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} saved={signIn} onSave={saveAwsSignIn} />
      {createDialog}
    </ItemPage>
  );
}

/** One deployment: what to do next in the cloud account, then how it is running. */
export function GuidedDeploymentPage({ deploymentId }: { deploymentId: string }) {
  const { orgSlug, orgContext, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const [configuring, setConfiguring] = useState(false);
  const configUpdates = orgFeatureEnabled(orgContext, "managedDeploymentConfigUpdates");
  const router = useRouter();
  const {
    enabled, access, deployments, configuration, loading, error, actionError, setActionError, launch, setLaunch, replace, busy, assistantsAvailable, prepare, reopen, remove, saveAwsSignIn,
  } = useManagedDeployments();
  const [signInOpen, setSignInOpen] = useState(false);
  const route = getDeploymentsRoute(orgSlug);
  const deployment = deployments.find((entry) => entry.id === deploymentId) ?? null;
  const signIn = configuration?.awsSignIn ?? null;
  const canManage = access.canManageDeployments;
  const canPrepare = Boolean(deployment) && (configuration?.providers.some((entry) => entry.provider === deployment?.provider && entry.available) ?? false)
    && !(deployment?.provider === "aws" && (deployment.target.runtimeProfile === "gateway" || assistantsEnabled(deployment.target.assistants)) && !assistantsAvailable);
  const run = deployment?.run ?? null;
  const awaiting = Boolean(run && run.state === "awaiting_approval" && !run.expired && !approvalReserved(run));
  const activeLaunch = deployment ? currentHandoff(launch, deployment) : null;
  const configurationControls: ConfigurationControls | null = configUpdates ? {
    onEdit: () => setConfiguring(true), runReauthableAction, reauthDialogOpen, permissionReason: permissionLockReason("deployments.manage"),
    onResult: (item, next) => { replace(item); setLaunch(next); setActionError(null); },
  } : null;

  // Coming back to an approval that is still open: fetch its link again, once for each sign-in.
  const reopenKey = deployment && run && run.kind !== "configure" && awaiting && canManage && canPrepare && !activeLaunch ? `${run.id} ${signIn?.portalUrl ?? ""} ${signIn?.roleName ?? ""}` : null;
  const attempted = useRef<string | null>(null);
  const reopenRef = useRef<() => Promise<boolean>>(async () => false);
  reopenRef.current = () => deployment ? reopen(deployment) : Promise.resolve(false);
  const [reopening, setReopening] = useState(false);
  useEffect(() => {
    if (!reopenKey || attempted.current === reopenKey) return;
    attempted.current = reopenKey;
    setReopening(true);
    void reopenRef.current().finally(() => setReopening(false));
  }, [reopenKey]);

  const locked = !enabled ? LOCKED : !access.canViewDeployments ? permissionLockReason("deployments.view") : null;
  if (locked || loading || !deployment) {
    return (
      <ItemPage testId="managed-deployment-detail">
        <BackLink href={route} label="Deployments" />
        {locked ? <Lock>{locked}</Lock> : loading ? <ItemRowsSkeleton label="Loading deployment" rows={3} />
          : error ? <p role="alert" className="text-[13px] text-red-700">{error}</p>
          : <p className="text-[13px] text-gray-500" data-testid="managed-deployment-missing">This deployment isn&apos;t in this workspace. It may have been removed.</p>}
      </ItemPage>
    );
  }

  return (
    <>
      <DeploymentView key={`${deployment.id}:${run?.id ?? "none"}`} deployment={deployment} launch={activeLaunch} reopening={reopening} busy={busy} canManage={canManage} canPrepare={canPrepare}
        assistantsAvailable={assistantsAvailable} signIn={signIn} actionError={actionError} backHref={route} configurationControls={configurationControls}
        onPrepare={(kind, assistants, profile) => { void prepare(deployment, kind, assistants, profile); }}
        onCopyFailed={() => setActionError("Couldn't copy. Open Technical details and copy it from there.")}
        onSignIn={() => setSignInOpen(true)}
        onRemove={async () => { await remove(deployment); router.push(route); }} />
      <AwsSignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} saved={signIn} onSave={saveAwsSignIn} />
      {configurationControls ? <ManagedDeploymentConfigurationDialog deployment={deployment} open={configuring} onOpenChange={setConfiguring} assistantsAvailable={assistantsAvailable} controls={configurationControls} /> : null}
    </>
  );
}

function DeploymentView({ deployment, launch, reopening, busy, canManage, canPrepare, assistantsAvailable, signIn, actionError, backHref, onPrepare, onCopyFailed, onSignIn, onRemove, configurationControls }: {
  deployment: ManagedDeployment; launch: DeploymentLaunch | null; reopening: boolean; busy: boolean; canManage: boolean; canPrepare: boolean; assistantsAvailable: boolean;
  signIn: AwsSignIn | null; actionError: string | null; backHref: string;
  onPrepare: (kind: DeploymentLaunchKind, assistants?: AwsAssistants, runtimeProfile?: AwsRuntimeProfile) => void;
  configurationControls: ConfigurationControls | null;
  onCopyFailed: () => void; onSignIn: () => void; onRemove: () => Promise<void>;
}) {
  const [assistantDraft, setAssistantDraft] = useState<AwsAssistants | null>(null);
  const [runtimeProfileDraft, setRuntimeProfileDraft] = useState<AwsRuntimeProfile | null>(null);
  const [copied, setCopied] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const assistantState = assistantSettingsState(deployment, assistantsAvailable, canManage);
  const status = deploymentStatus(deployment);
  const configurationControl = configurationEntry(deployment, { enabled: configurationControls !== null, canManage, permissionReason: configurationControls?.permissionReason });
  const runtime = runtimeBlock(deployment, assistantState.reason, configurationControl, assistantsAvailable);
  const changeRun = deployment.run?.kind === "configure";
  const cloud = providerName(deployment.provider);
  const aws = deployment.provider === "aws";
  const shell = aws ? "AWS CloudShell" : "Google Cloud Shell";
  const account = cloudAccount(deployment);
  const run = deployment.run;
  const launchKind = run?.kind === "configure" ? null : run?.kind;
  const installed = Boolean(deployment.installedVersion);
  const awaiting = Boolean(run && run.state === "awaiting_approval" && !run.expired && !approvalReserved(run));
  const runFailed = Boolean(run && (run.state === "failed" || run.expired));
  const failure = run?.events.find((event) => event.outcome === "failed");
  const nextStep = run?.events.length ?? 0;
  const neverStarted = !installed && (!run || run.state === "awaiting_approval");
  const health = deployment.health;
  const until = run ? clock(run.expiresAt) : "";
  const canUpdate = canManage && installed && deployment.updateAvailable && !(run?.state === "provisioning" && !run.expired) && !awaiting && !(changeRun && deployment.configuration?.lock === "run_in_progress");
  const shellUrl = launch?.handoff?.url ?? (deployment.provider === "gcp"
    ? `https://console.cloud.google.com/?project=${encodeURIComponent(deployment.target.projectId)}&cloudshell=true`
    : `https://${deployment.target.region}.console.aws.amazon.com/cloudshell/home?region=${deployment.target.region}`);
  const approvalLink = launch?.approvalUrl ?? null;

  function copy(value: string) {
    void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(onCopyFailed);
  }

  const menu: ItemMenuEntry[] = [
    { label: `Open in ${cloud}`, onSelect: () => { window.open(deployment.consoleUrl, "_blank", "noopener,noreferrer"); } },
    ...(canManage && neverStarted ? [{
      label: "Remove", destructive: true, testId: "managed-deployment-remove", onSelect: onRemove,
      confirm: { title: `Remove ${deployment.name}?`, description: `This removes the deployment record and its pending approval from this workspace. ${cloud} resources and charges are unchanged. This cannot be undone.`, action: "Remove" },
    }] : []),
  ];

  const signInStep = aws && signIn ? 0 : 1;
  const approve = awaiting && run && !approvalReserved(run) ? (
    <section className="flex flex-col gap-2.5" data-testid="deployment-approve">
      <SectionTitle title={`Approve in ${cloud}`} meta={`Open until ${until}`} />
      <ItemPanel>
        {aws ? (signIn ? (
          <div className={ROW_CLASS} data-testid="deployment-approve-sign-in">
            <CheckCircle2 aria-hidden className="mx-1 size-4 shrink-0 text-gray-500" />
            <StepText title={`Signs in through ${portalHost(signIn)}`} description={`Account ${account} · ${signIn.roleName}`} />
            {canManage ? <DenButton type="button" variant="ghost" size="sm" onClick={onSignIn}>Change</DenButton> : null}
          </div>
        ) : (
          <div className={ROW_CLASS} data-testid="deployment-approve-sign-in">
            <StepNumber value={1} />
            <StepText title={`Sign in to AWS account ${account}`} description="In this browser, the way you usually do" />
            {canManage ? <DenButton type="button" variant="secondary" size="sm" data-testid="aws-sign-in-open" onClick={onSignIn}>Save your sign-in page</DenButton> : null}
          </div>
        )) : null}
        <div className={ROW_CLASS} data-testid="deployment-approve-step">
          <StepNumber value={aws ? signInStep + 1 : 1} />
          {approvalLink ? (
            <>
              <StepText title="Review the permissions and choose Create stack" description="CloudFormation opens filled in" />
              <DenButton type="button" variant="secondary" size="sm" data-testid="deployment-copy-link" onClick={() => copy(approvalLink)}><Copy aria-hidden className="size-4" />{copied ? "Copied" : "Copy link"}</DenButton>
              <a className={buttonVariants({ size: "sm" })} data-testid="deployment-approve-link" href={approvalLink} target="_blank" rel="noopener noreferrer">Review and approve in AWS<ExternalLink aria-hidden className="size-4" /></a>
            </>
          ) : launch?.command ? (
            <>
              <StepText title={`Paste and run the command in ${shell}`} description={deployment.provider === "gcp"
                ? `Running it approves the ${launch.kind === "update" ? "update" : "installation"} and creates or changes billable resources in project ${deployment.target.projectId}`
                : "It updates the existing installer; nothing is deleted"} />
              <DenButton type="button" variant="secondary" size="sm" onClick={() => copy(launch.command ?? "")}><Copy aria-hidden className="size-4" />{copied ? "Copied" : "Copy command"}</DenButton>
              <a className={buttonVariants({ size: "sm" })} href={shellUrl} target="_blank" rel="noopener noreferrer">Open {shell}<ExternalLink aria-hidden className="size-4" /></a>
            </>
          ) : (
            <>
              <StepText title={`Review and approve in ${cloud}`} description={!canManage ? "Someone who can manage deployments does this step" : reopening ? "Getting your approval link" : "Prepare the approval again to get its link"} />
              {canManage && !reopening && launchKind ? <DenButton type="button" size="sm" loading={busy} disabled={!canPrepare} onClick={() => onPrepare(launchKind)}>Prepare {cloud} approval</DenButton> : null}
            </>
          )}
        </div>
        <div className={ROW_CLASS}>
          <StepNumber value={aws ? signInStep + 2 : 2} />
          <StepText pending title={changeRun ? "OpenWork applies the configuration change" : run.kind === "update" ? "OpenWork updates" : "OpenWork installs"} description="About 20 minutes" />
        </div>
      </ItemPanel>
    </section>
  ) : null;

  const started = run?.events[0]?.receivedAt ?? null;
  const steps = run && run.state !== "ready" && !awaiting && !changeNeverApproved(run) ? (
    <section className="flex flex-col gap-2.5">
      <SectionTitle title={changeRun ? "Configuration change" : `${run.kind === "update" ? "Update to" : run.kind === "retry" ? "Retry" : "Install"} ${run.version}`}
        meta={failure ? `Stopped at ${clock(failure.receivedAt)}` : started ? `Started ${clock(started)}` : undefined} />
      <ol data-testid="managed-deployment-steps" className="flex flex-col divide-y divide-[var(--den-list-line)] border-y border-[var(--den-list-line)]">
        {deploymentStepSchema.options.map((step, index) => {
          const event = run.events.find((entry) => entry.step === step);
          const state = event ? (event.outcome === "succeeded" ? "ok" : "failing") : index === nextStep && run.state === "provisioning" && !run.expired ? "running" : "pending";
          return (
            <li key={step} className="flex min-h-10 items-center gap-3 py-2 text-[13px]">
              {state === "ok" ? <CheckCircle2 aria-hidden className="size-4 text-gray-500" /> : state === "failing" ? <XCircle aria-hidden className="size-4 text-red-600" /> : <CircleDashed aria-hidden className={`size-4 ${state === "running" ? "text-gray-700 motion-safe:animate-pulse" : "text-gray-300"}`} />}
              <span className={state === "pending" ? "text-[var(--dls-text-secondary)]" : "text-[var(--dls-text-primary)]"}>{!aws && step === "account_verified" ? "Google Cloud project and domain verified" : STEP_LABELS[step]}</span>
              {event ? <time className="ml-auto text-[var(--dls-text-secondary)]" dateTime={event.receivedAt}>{clock(event.receivedAt)}</time> : null}
            </li>
          );
        })}
      </ol>
    </section>
  ) : null;

  const failureMessage = failure?.errorCode ? (aws ? (changeRun ? changeFailureMessage(failure.errorCode) : null) ?? FAILURE_LABELS[failure.errorCode] : gcpFailureMessage(failure.errorCode))
    : run?.expired && run.state !== "ready" && !changeNeverApproved(run) ? (changeRun ? CHANGE_STOPPED_REPORTING : `The installer stopped reporting. Open the installer logs in ${cloud}, then retry.`) : null;

  return (
    <ItemPage testId="managed-deployment-detail">
      <ItemHeader compact back={{ href: backHref, label: "Deployments" }} logo={<CloudLogo provider={deployment.provider} />} title={deployment.name}
        state={<span className={TONE_TEXT[status.tone]} data-testid="managed-deployment-status">{status.label}{awaiting ? ` · until ${until}` : installed && status.tone === "neutral" && !run?.expired ? ` · ${deployment.installedVersion}` : ""}</span>}
        actions={<>
          {canManage && !installed && !run ? <DenButton type="button" loading={busy} disabled={!canPrepare} data-testid="deployment-prepare" onClick={() => onPrepare("install")}>Prepare {cloud} approval</DenButton> : null}
          {canManage && runFailed && !changeRun ? <DenButton type="button" loading={busy} disabled={!canPrepare} onClick={() => onPrepare(installed || run?.events.length || run?.state === "failed" ? "retry" : "install")}>Prepare retry</DenButton> : null}
          {canUpdate ? <DenButton type="button" loading={busy} disabled={!canPrepare || (runtimeProfileDraft === "gateway" && !assistantsAvailable)} onClick={() => onPrepare("update", assistantState.editable ? assistantDraft ?? undefined : undefined, assistantState.editable ? runtimeProfileDraft ?? undefined : undefined)}>Update to {deployment.availableVersion}</DenButton> : null}
          {installed ? <a className={buttonVariants({ variant: canUpdate || (canManage && runFailed) ? "secondary" : "primary" })} href={deployment.webUrl} target="_blank" rel="noopener noreferrer">Open OpenWork<ExternalLink aria-hidden className="size-4" /></a> : null}
          {configurationControl.shown ? <DenButton type="button" variant="secondary" data-testid="managed-deployment-edit-configuration" disabled={configurationControl.disabled || busy} onClick={configurationControls?.onEdit}>Edit configuration</DenButton> : null}
          <ItemMenu label="More" size="md" entries={menu} testId="managed-deployment-more" />
        </>} />

      {actionError ? <p role="alert" className="text-[13px] text-red-700">{actionError}</p> : null}
      {failureMessage ? <p role="alert" className="text-[13px] text-red-700" data-testid="managed-deployment-failure">{failureMessage}</p> : null}
      <ConfigurationLockLine reason={configurationControl.reason} testId="managed-deployment-configuration-lock" />
      {configurationControls ? <ManagedDeploymentConfigurationSummary deployment={deployment} canManage={canManage} commandShown={Boolean(launch?.command)} controls={configurationControls} /> : null}
      {approve}
      {steps}

      {installed ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Status checks" meta={health.reportedAt ? `Reported ${relativeTime(health.reportedAt).replace(/^Just now$/, "just now")}` : undefined} />
          {health.state === "not_reporting" ? <p role="status" className="text-[13px] text-amber-700">No report since {health.reportedAt ? new Date(health.reportedAt).toLocaleString() : "installation"}. Showing the last known checks. Check the health agent in {aws ? "AWS Lambda" : "Google Cloud Run and Cloud Scheduler"}.</p> : null}
          {health.state === "awaiting_report" ? <p className="text-[13px] text-gray-500">Waiting for the first report. Reports arrive every 5 minutes.</p> : null}
          {health.checks.length ? (
            <ul data-testid="managed-deployment-checks" className="flex flex-col divide-y divide-[var(--den-list-line)] border-y border-[var(--den-list-line)]">
              {health.checks.map((check) => (
                <li key={check.id} className="flex min-h-10 items-center gap-3 py-2 text-[13px]">
                  <StatusIcon status={check.status} />
                  <span className="text-[var(--dls-text-primary)]">{CHECK_LABELS[check.id]}</span>
                  <span className="ml-auto text-right text-[var(--dls-text-secondary)]">{checkDetail(check)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {deployment.provider === "aws" ? <ManagedDeploymentAssistants value={assistantDraft ?? deployment.target.assistants} profile={runtimeProfileDraft ?? deployment.target.runtimeProfile} onChange={setAssistantDraft}
        onUpgrade={() => { setRuntimeProfileDraft("gateway"); setAssistantDraft(gatewayAssistants(deployment.target.assistants)); }}
        enabled={assistantsAvailable} disabled={!assistantState.editable || busy} lockReason={runtime.reason ?? undefined} viaConfiguration={runtime.viaConfiguration} /> : null}

      <section className="flex flex-col gap-2.5" data-testid="managed-deployment-configuration">
        <SectionTitle title="Details" />
        <DetailRows rows={[
          { label: "Address", value: installed ? <a className="underline-offset-2 hover:underline" href={deployment.webUrl} target="_blank" rel="noopener noreferrer">{deployment.domainName}</a> : deployment.domainName },
          { label: "Cloud", value: `${cloud} · ${account} · ${deployment.target.region}` },
          ...(deployment.provider === "aws" ? [{ label: "Network", value: networkLabel(deployment.target.network) }]
            : [{ label: "Project number", value: deployment.target.projectNumber }, { label: "DNS zone", value: deployment.target.dnsZoneName }]),
          { label: "Version", value: `${deployment.installedVersion ?? "Not installed"}${deployment.updateAvailable && deployment.availableVersion ? ` · ${deployment.availableVersion} available` : ""}` },
          { label: "Updates", value: "Approval required" },
          ...(configurationControls ? [{ label: "First administrator", value: deployment.ownerEmail }] : []),
          ...(aws ? [{
            label: "AWS sign-in",
            value: canManage
              ? <button type="button" className="underline-offset-2 hover:underline" data-testid="aws-sign-in-detail" onClick={onSignIn}>{signIn ? `${portalHost(signIn)} · ${signIn.roleName}` : "Set up"}</button>
              : signIn ? `${portalHost(signIn)} · ${signIn.roleName}` : "Not set",
          }] : []),
        ]} />
      </section>

      <DisclosureGroup>
        {awaiting && aws ? (
          <DisclosureSection label="If AWS shows something else" open={otherOpen} onToggle={() => setOtherOpen((value) => !value)} testId="deployment-aws-help-toggle">
            <DetailRows rows={[
              { wrap: true, label: "A sign-in page asking for a root or IAM user", value: `This browser isn't signed in to account ${account}. ${signIn ? `Sign in at ${portalHost(signIn)}` : "Sign in on your company's AWS page"}, then open the link again.` },
              { wrap: true, label: "“Select a role”", value: `Choose ${signIn ? signIn.roleName : "a role that can create CloudFormation stacks"}. The filled-in form opens next.` },
              { wrap: true, label: "A different account number in the top right", value: `Don't create the stack. Switch to account ${account}, then open the link again.` },
              { wrap: true, label: "You closed the tab or want a teammate to approve", value: `Open or send the same link. It returns to this approval until ${until}.` },
            ]} />
          </DisclosureSection>
        ) : null}
        <DisclosureSection label="Technical details" open={technicalOpen} onToggle={() => setTechnicalOpen((value) => !value)} testId="deployment-technical-details-toggle">
          <DetailRows rows={[
            ...(awaiting && approvalLink ? [{ wrap: true, label: "Approval link", value: <span className="break-all font-mono text-[12px]" data-testid="deployment-approval-link">{approvalLink}</span> }] : []),
            ...(awaiting && launch?.command ? [{ wrap: true, label: "Command", value: <span className="whitespace-pre-wrap break-all font-mono text-[12px]">{launch.command}</span> }] : []),
            { wrap: true, label: "First sign-in", value: <span data-testid="deployment-setup-directions">{`Open ${deployment.webUrl}/setup and enter the code from the deployment's ${aws ? "AWS Secrets Manager" : "Google Cloud Secret Manager"} secret, field DEN_INITIAL_ADMIN_BOOTSTRAP_CODE. OpenWork never receives it.`}</span> },
            { wrap: true, label: "Logs", value: aws ? "Installer logs are in AWS CodeBuild; service logs in CloudWatch. Health reports come from a read-only AWS Lambda function in your account and contain only check results." : "Installer output is in Google Cloud Shell; service and health-agent logs are in Google Cloud Logging. Check Cloud Run and Cloud Scheduler for missing health reports. Reports contain only check results." },
            { wrap: true, label: "Removal", value: aws ? "Deleting the AWS installer stack does not delete OpenWork or its database. Terraform state stays in your account." : "Removing this record does not delete Google Cloud resources or stop charges. Terraform state stays in your project." },
          ]} />
        </DisclosureSection>
      </DisclosureGroup>
    </ItemPage>
  );
}
