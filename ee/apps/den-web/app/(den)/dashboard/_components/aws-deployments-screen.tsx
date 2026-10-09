"use client";

import { Dialog } from "@base-ui/react/dialog";
import { awsDeploymentInputSchema, awsDeploymentLaunchSchema, awsDeploymentListSchema, awsDeploymentRegionSchema, awsDeploymentSchema, type AwsDeployment } from "@openwork/types/den/aws-deployments";
import { Check, ExternalLink, LockKeyhole, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const configurationSchema = z.object({ available: z.boolean(), updateMode: z.literal("manual") });
const stepLabels: Record<string, string> = {
  runner_connected: "Connected to AWS", release_verified: "Verified release", account_verified: "Verified account and domain",
  infrastructure_applied: "Installed infrastructure", services_ready: "Started services", health_verified: "Verified HTTPS and database health",
};
const failureLabels: Record<string, string> = {
  release_verification_failed: "Release verification failed. Open the AWS build logs before retrying.",
  infrastructure_failed: "Infrastructure installation failed. Review the Terraform error in the AWS build logs.",
  service_unhealthy: "Services did not start. Review the ECS service events in AWS.",
  health_check_failed: "HTTPS or database health could not be verified. Check DNS and the AWS service logs.",
  runner_failed: "The AWS account or public hosted zone could not be verified. Check the launch parameters.",
};
function deploymentStatus(deployment: AwsDeployment) {
  if (deployment.run?.expired) return "Not reporting";
  if (!deployment.run) return "Not launched";
  return { awaiting_aws: "Awaiting AWS approval", provisioning: "Installing", ready: "Installed", failed: "Failed" }[deployment.run.state];
}

export function AwsDeploymentsScreen() {
  const { orgId, orgContext, runReauthableAction } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles);
  const enabled = orgFeatureEnabled(orgContext, "awsManagedDeployments");
  const [deployments, setDeployments] = useState<AwsDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<z.infer<typeof awsDeploymentLaunchSchema> | null>(null);
  const [name, setName] = useState("Production");
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [domainName, setDomainName] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const generation = useRef(0);
  const selected = deployments.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    const current = ++generation.current;
    setDeployments([]); setSelectedId(null); setLaunch(null); setError(null); setDialogOpen(false); setBusy(false); setLoading(enabled);
    if (!enabled || !orgId || !access.canViewSettings) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [list, configuration] = await Promise.all([
          requestJson("/v1/aws-deployments", { method: "GET" }),
          requestJson("/v1/aws-deployments/configuration", { method: "GET" }),
        ]);
        if (!list.response.ok) throw new Error(getErrorMessage(list.payload, "Could not verify AWS deployments. Retry to refresh."));
        if (!configuration.response.ok) throw new Error(getErrorMessage(configuration.payload, "Could not verify AWS launch availability."));
        const data = awsDeploymentListSchema.parse(list.payload);
        const settings = configurationSchema.parse(configuration.payload);
        if (!stopped && generation.current === current) {
          setDeployments(data.deployments); setAvailable(settings.available); setError(null);
        }
      } catch (failure) {
        if (!stopped && generation.current === current) setError(failure instanceof Error ? failure.message : "Could not verify deployments. Open AWS to check the current state.");
      } finally {
        if (!stopped && generation.current === current) { setLoading(false); timeout = setTimeout(() => { void refresh(); }, 5000); }
      }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timeout); };
  }, [orgId, enabled, access.canViewSettings]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const data = awsDeploymentInputSchema.safeParse({ name, accountId, region, domainName, route53ZoneId: zoneId, ownerEmail });
    if (!data.success) { setError(data.error.issues[0]?.message ?? "Check the AWS deployment fields."); return; }
    if (!consent) { setError("Confirm the AWS account, permissions and costs before creating the deployment."); return; }
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      await runReauthableAction("Create AWS deployment", async () => {
        if (generation.current !== current) return;
        const result = await requestJson("/v1/aws-deployments", { method: "POST", body: JSON.stringify(data.data) });
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Could not create the deployment.");
        const item = awsDeploymentSchema.parse(result.payload);
        if (generation.current === current) {
          setDeployments((previous) => [...previous.filter((entry) => entry.id !== item.id), item]);
          setSelectedId(item.id); setDialogOpen(false); setConsent(false);
        }
      });
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : "Could not create the deployment. Refresh before retrying.");
    } finally { if (generation.current === current) setBusy(false); }
  }
  async function prepareLaunch(deployment: AwsDeployment) {
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      await runReauthableAction("Launch AWS deployment", async () => {
        if (generation.current !== current) return;
        const result = await requestJson(`/v1/aws-deployments/${deployment.id}/launch`, { method: "POST" });
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Could not prepare the AWS launch. Refresh before retrying.");
        const value = awsDeploymentLaunchSchema.parse(result.payload);
        if (generation.current === current) {
          setLaunch(value); setDeployments((previous) => previous.map((entry) => entry.id === deployment.id ? value.deployment : entry));
        }
      });
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : "Could not prepare the AWS launch.");
    } finally { if (generation.current === current) setBusy(false); }
  }
  const locked = !enabled ? "AWS deployments are not enabled for this workspace. Contact your OpenWork administrator." : !access.canViewSettings ? "An organization administrator can view AWS deployments." : null;

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 p-6 text-[var(--dls-text-primary)]" data-testid="aws-deployments-screen">
      <DenPageHeader title="AWS deployments" size="compact" action={<DenButton type="button" disabled={Boolean(locked) || !available || !access.canManageSettings || loading} onClick={() => setDialogOpen(true)}>Create deployment</DenButton>} />
      {locked ? <p className="flex items-center gap-2 text-sm text-[var(--dls-text-secondary)]"><LockKeyhole className="size-4" />{locked}</p> : <>
        {error ? <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p> : null}
        {!loading && !available ? <p className="text-sm text-[var(--dls-text-secondary)]">AWS release artifacts are not configured. An OpenWork operator must publish the installer before launches are available.</p> : null}
        {loading ? <div className="space-y-3"><DenSkeleton className="h-12 w-full" /><DenSkeleton className="h-12 w-full" /></div> : !deployments.length && !error ? <p className="text-sm text-[var(--dls-text-secondary)]">No AWS deployments. Create one using a dedicated AWS account and a public Route 53 hosted zone.</p> : <ul className="divide-y divide-[var(--border)]">
          {deployments.map((item) => <li key={item.id} className="flex min-h-12 items-center justify-between gap-4 py-3">
            <div className="min-w-0"><p className="font-medium">{item.name}</p><p className="text-sm text-[var(--dls-text-secondary)]">{item.accountId} · {item.region}</p></div>
            <div className="flex items-center gap-4"><span className="text-sm">{deploymentStatus(item)}</span><DenButton type="button" variant="ghost" onClick={() => { setSelectedId(item.id); setLaunch(null); }}>View</DenButton></div>
          </li>)}
        </ul>}
        {selected ? <div className="space-y-4 border-t border-[var(--border)] pt-6" data-testid="aws-deployment-detail">
          <div className="flex items-center justify-between gap-4"><h2 className="font-semibold">{selected.name}</h2><span>{deploymentStatus(selected)}</span></div>
          <dl className="grid grid-cols-2 gap-3 text-sm"><dt>Domain</dt><dd>{selected.domainName}</dd><dt>Updates</dt><dd>Approval required</dd><dt>Version</dt><dd>{selected.run?.version ?? "Not installed"}</dd><dt>Last report</dt><dd>{selected.run?.lastSeenAt ? new Date(selected.run.lastSeenAt).toLocaleString() : "No report received"}</dd></dl>
          {selected.run?.expired ? <p role="alert" className="text-sm">The runner stopped reporting. Review AWS build logs before starting another run.</p> : null}
          {selected.run?.events.length ? <ol className="divide-y divide-[var(--border)]">{selected.run.events.map((item) => <li key={item.sequence} className="flex items-center gap-3 py-3 text-sm"><Check aria-hidden className="size-4" /><span>{stepLabels[item.step]}</span><span className="ml-auto">{item.outcome === "succeeded" ? "Verified" : "Failed"}</span>{item.errorCode ? <p role="alert">{failureLabels[item.errorCode]}</p> : null}</li>)}</ol> : null}
          <div className="flex flex-wrap items-center gap-3">
            {selected.run?.state === "ready" ? <a href={selected.webUrl + "/setup"} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm" })}>Open deployment<ExternalLink className="ml-2 size-4" /></a> : access.canManageSettings && available ? launch?.deployment.id === selected.id ? <a href={launch.launchUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm" })}>Review and launch in AWS<ExternalLink className="ml-2 size-4" /></a> : <DenButton type="button" loading={busy} onClick={() => { void prepareLaunch(selected); }}>Prepare AWS launch</DenButton> : null}
            <a href={selected.stackUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>Open AWS stack</a>
          </div>
          <details className="text-sm"><summary className="cursor-pointer">AWS logs and setup credentials</summary><div className="space-y-2 pt-3 text-[var(--dls-text-secondary)]"><p>Detailed logs stay in your AWS account. Open CodeBuild for installation logs and ECS for service logs.</p><p>Get the one-time setup code from your deployment’s AWS Secrets Manager secret, field DEN_INITIAL_ADMIN_BOOTSTRAP_CODE. OpenWork does not receive this code.</p><p>Deleting the bootstrap stack does not delete the application or its database. Terraform state is retained in your AWS account.</p></div></details>
        </div> : null}
      </>}
      <Dialog.Root open={dialogOpen} onOpenChange={(open) => { if (!busy) setDialogOpen(open); }}>
        <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--dls-dialog-overlay)]" /><Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-[var(--background)] p-6 shadow-xl">
          <div className="mb-5 flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">Create AWS deployment</Dialog.Title><Dialog.Close render={<DenButton type="button" variant="ghost" aria-label="Close" disabled={busy}><X className="size-4" /></DenButton>} /></div>
          <form onSubmit={(event) => { void create(event); }} className="space-y-4">
            <label className="block space-y-1 text-sm"><span>Name</span><DenInput value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
            <label className="block space-y-1 text-sm"><span>Dedicated AWS account ID</span><DenInput value={accountId} onChange={(event) => setAccountId(event.target.value)} required inputMode="numeric" pattern="[0-9]{12}" placeholder="123456789012" /></label>
            <div className="space-y-1 text-sm"><label htmlFor="aws-region">Region</label><DenSelect id="aws-region" value={region} onChange={(event) => setRegion(event.target.value)}>{awsDeploymentRegionSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}</DenSelect></div>
            <label className="block space-y-1 text-sm"><span>Deployment domain</span><DenInput value={domainName} onChange={(event) => setDomainName(event.target.value)} required placeholder="den.example.com" /></label>
            <label className="block space-y-1 text-sm"><span>Public Route 53 hosted zone ID</span><DenInput value={zoneId} onChange={(event) => setZoneId(event.target.value)} required placeholder="Z0123456789" /></label>
            <label className="block space-y-1 text-sm"><span>First administrator email</span><DenInput type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} required /></label>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required /><span>I control this dedicated AWS account and public hosted zone. AWS will bill my account for ECS, RDS, a load balancer and a NAT gateway. I will review the installer’s IAM permissions in AWS before launching.</span></label>
            {error ? <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p> : null}
            <DenButton type="submit" loading={busy} disabled={!consent}>Create deployment</DenButton>
          </form>
        </Dialog.Popup></Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
