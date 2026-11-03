"use client";

import { useQuery } from "@tanstack/react-query";
import { workbotModelRecoverySchema, type WorkbotAccessReason } from "@openwork/types/den/workbot-settings";
import { Clock, ExternalLink, FileText, Lock } from "lucide-react";
import type { WorkbotTurn } from "./data";
import { workbotHost } from "./host";
import { modelRecoveryView } from "./model-recovery-state";

function useRecoveryOptions() {
  const host = workbotHost();
  return useQuery({
    queryKey: ["workbot", "model-recovery", host.identity?.principalId, host.identity?.organizationId],
    enabled: Boolean(host.usageRecovery && host.identity && host.documentAuthorization === undefined),
    queryFn: async () => {
      const { response, payload } = await host.requestJson("/v1/workbot/model-recovery", { method: "GET" });
      if (!response.ok) throw new Error("Couldn't check model access.");
      return workbotModelRecoverySchema.parse(payload);
    },
    staleTime: 0,
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

const linkClass = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

function managementUrl(path: string) {
  const destination = workbotHost().usageRecovery;
  return destination ? `${destination.denUrl}/dashboard/${path}${path.includes("?") ? "&" : "?"}workbotOrganizationId=${encodeURIComponent(destination.organizationId)}` : null;
}

const primaryClass = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--wb-ink)] px-3 text-[12px] font-medium text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
const secondaryClass = "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-ring)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

function resetPhrase(resetsAt: string) {
  return new Date(resetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/**
 * The usage-limit card, the same anatomy as the desktop: what ran out, when it resets, that the message is saved,
 * one primary action for the person's role (an upgrade only when Den says they can buy), and a way to keep working.
 */
export function ModelRecovery({ issue, onRetry }: { issue: NonNullable<WorkbotTurn["modelIssue"]>; onRetry?: () => void }) {
  const host = workbotHost();
  const recovery = useRecoveryOptions();
  if (!host.usageRecovery || host.documentAuthorization !== undefined) return null;
  const options = recovery.isError ? undefined : recovery.data;
  const view = modelRecoveryView(issue, options);
  const primaryUrl = view.primary?.kind === "link" ? managementUrl(view.primary.path) : null;
  const changeModelUrl = view.changeModel ? managementUrl(view.changeModel.path) : null;
  return <div role="status" data-testid="workbot-model-recovery" data-issue={issue}
    className="mt-3 flex flex-col gap-2 rounded-xl bg-[var(--wb-surface)] px-3.5 py-3 text-[13px] text-[var(--wb-muted)] shadow-[0_0_0_1px_var(--wb-ring)]">
    <div className="flex flex-col gap-0.5">
      <p className="font-medium text-[var(--wb-text)]">{view.title}</p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
        {view.resetsAt && <span className="inline-flex items-center gap-1"><Clock size={12} aria-hidden />Resets {resetPhrase(view.resetsAt)}</span>}
        <span className="inline-flex items-center gap-1"><FileText size={12} aria-hidden />Your message is saved</span>
      </p>
    </div>
    {view.note && <p className="text-[12px]">{view.note}</p>}
    <div className="flex flex-wrap items-center gap-1.5">
      {view.primary?.kind === "link" && primaryUrl && <a className={primaryClass} href={primaryUrl} target="_blank" rel="noopener noreferrer">{view.primary.label}<ExternalLink size={12} aria-label="Opens in a new tab" /></a>}
      {view.primary?.kind === "locked" && <span data-testid="workbot-model-recovery-locked" title={view.primary.reason}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-[var(--wb-muted)] shadow-[inset_0_0_0_1px_var(--wb-ring)]">
        <Lock size={12} aria-hidden />{view.primary.label}<span className="sr-only">. {view.primary.reason}</span></span>}
      {view.changeModel && changeModelUrl && <a className={secondaryClass} href={changeModelUrl} target="_blank" rel="noopener noreferrer">{view.changeModel.label}<ExternalLink size={12} aria-label="Opens in a new tab" /></a>}
      {recovery.isError ? <button type="button" className={linkClass} onClick={() => void recovery.refetch()}>Check recovery options</button>
        : onRetry && options && (view.check === "check"
          ? <button type="button" className={linkClass} disabled={recovery.isFetching} onClick={() => void recovery.refetch()}>Check access</button>
          : <button type="button" className={linkClass} onClick={onRetry}>Try again</button>)}
    </div>
    {recovery.isError && <p className="text-[12px]">Couldn't check your recovery options.</p>}
  </div>;
}

/** A Den refusal happens before execution. Preserve the pending message and retry only on the person's action. */
export function AccessRecovery({ reason, onRetry }: { reason: WorkbotAccessReason; onRetry?: () => void }) {
  const host = workbotHost();
  const recovery = useRecoveryOptions();
  if (host.documentAuthorization !== undefined) return null;
  const copy: Record<WorkbotAccessReason, string> = {
    gateway_not_configured: "Model access hasn’t been set up for Workbot. Ask a workspace admin to finish setup.",
    gateway_provider_missing: "Workbot doesn’t have a model it can use in this workspace yet. A workspace admin can turn on OpenWork Models or add a model provider.",
    gateway_member_access_missing: "You haven’t been granted access to Workbot’s selected model. Ask a workspace admin for access.",
    gateway_model_unavailable: "Workbot’s saved model is no longer available. Ask a workspace admin to choose an available model.",
    gateway_authentication_required: "Workbot’s model needs an account connection. Ask a workspace admin to check the model’s connection requirements.",
    gateway_credentials_unavailable: "Workbot’s model credentials need attention. Ask a workspace admin to check the model connection.",
    oauth_scope_missing: "Your sign-in doesn’t include permission to run Workbot. Sign in again to review access.",
    managed_models_setup_required: "Your Models access isn’t ready. Check access again shortly, or ask a workspace admin to review Models setup.",
    model_access_unavailable: "Workbot can’t access its selected model. Ask a workspace admin to check model access.",
    rate_limited: "Model access is temporarily limited. Wait a minute, then try again.",
  };
  const managed = recovery.data?.managedLuna === true;
  const canManageModels = recovery.data?.canManageModels === true;
  const signIn = host.signInHref ? new URL(host.signInHref, window.location.href) : null;
  if (signIn) signIn.searchParams.set("workspace", "choose");
  const link = (path: string, label: string) => {
    const href = managementUrl(path);
    return href ? { href, label } : null;
  };
  // No model at all: both ways to give Workbot one, each opening Den's page that rechecks permissions and billing.
  const actions = reason === "oauth_scope_missing" ? (signIn ? [{ href: signIn.toString(), label: "Review sign-in access" }] : [])
    : reason === "rate_limited" || !canManageModels ? []
      : reason === "gateway_provider_missing" ? [link("ai-gateway?tab=openwork-models", "Set up OpenWork Models"), link("ai-gateway?tab=ai-providers", "Add a model provider")]
        : [link(managed ? "ai-gateway?tab=openwork-models" : "workbot-settings", managed ? "Review Models access" : "Review Workbot’s model")];
  return <div role="status" data-testid="workbot-access-recovery" data-reason={reason} className="mt-3 text-[13px] text-[var(--wb-muted)]">
    <p>{copy[reason]}</p>
    <div className="-ml-2 mt-1 flex flex-wrap items-center gap-1">
      {actions.map(action => action && <a key={action.href} className={linkClass} href={action.href} target="_blank" rel="noopener noreferrer">{action.label}<ExternalLink size={12} aria-label="Opens in a new tab" /></a>)}
      {onRetry && <button type="button" className={linkClass} onClick={onRetry}>{reason === "rate_limited" ? "Try again" : "Check access and retry"}</button>}
    </div>
  </div>;
}
