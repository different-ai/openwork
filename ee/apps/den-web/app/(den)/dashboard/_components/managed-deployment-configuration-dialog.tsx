"use client";

import { Dialog } from "@base-ui/react/dialog";
import { assistantsEnabled, gatewayAssistants, type AwsManagedDeploymentInput, type ManagedDeployment } from "@openwork/types/den/managed-deployments";
import { LockKeyhole, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DenButton } from "../../_components/ui/button";
import { DenCheckbox } from "../../_components/ui/checkbox";
import { DenInput } from "../../_components/ui/input";
import { ManagedDeploymentAssistants } from "./managed-deployment-assistants";
import {
  GATEWAY_RUNTIME_NOT_ENABLED, configurationDraft, configurationEntry, consentSentence, fixedConfigurationRows, gatewayLockReason, hasConfiguration, planConfigurationDraft, planLockReason, runtimeLabel,
  type DraftPlan, type EditableDeployment,
} from "./managed-deployment-configuration-state";
import {
  ConfigurationChangeList, ConfigurationLockLine, DeploymentConfigurationChangedError, failureMessage, loadDeployment, requestConfigurationChange,
  type ConfigurationControls,
} from "./managed-deployment-configuration-summary";

type AcceptedPlan = Extract<DraftPlan, { ok: true }>["plan"];

/** Current values, what can never change, and the one place a change starts. */
export function ConfigurationChangeForm({ deployment, draft, onDraft, planned, assistantsAvailable, busy = false, error = null, onReview }: {
  deployment: EditableDeployment; draft: AwsManagedDeploymentInput; onDraft: (draft: AwsManagedDeploymentInput) => void; planned: DraftPlan;
  assistantsAvailable: boolean; busy?: boolean; error?: string | null; onReview: () => void;
}) {
  const fixedHeading = useId();
  const gatewayLockId = useId();
  const entry = configurationEntry(deployment, { enabled: true, canManage: true });
  const locked = entry.disabled || busy;
  const recordedGateway = deployment.target.runtimeProfile === "gateway";
  const addingGateway = !recordedGateway && draft.target.runtimeProfile === "gateway";
  const gatewayLock = recordedGateway ? null : gatewayLockReason(deployment, assistantsAvailable);
  const changed = planned.ok && planned.plan.changes.length > 0;
  const planLock = planned.ok && changed ? planLockReason(deployment, planned.plan, assistantsAvailable) : null;
  // A value still to enter is why Review changes is locked, not something that went wrong.
  const missing = !error && !planned.ok && planned.incomplete ? planned.message : null;
  const message = error ?? (planned.ok || planned.incomplete ? null : planned.message);
  const setAssistants = (assistants: AwsManagedDeploymentInput["target"]["assistants"]) => onDraft({ ...draft, target: { ...draft.target, assistants } });
  const runtime = (
    <ManagedDeploymentAssistants value={draft.target.assistants} profile="gateway" onChange={setAssistants} enabled={assistantsAvailable} disabled={locked} openByDefault
      lockReason={assistantsAvailable ? undefined : GATEWAY_RUNTIME_NOT_ENABLED} />
  );
  return (
    <form noValidate className="space-y-4" data-testid="deployment-configuration-form" onSubmit={(event) => { event.preventDefault(); if (changed && !planLock && !locked) onReview(); }}>
      <label className="block space-y-1 text-[13px]"><span className="text-gray-700">Name</span>
        <DenInput value={draft.name} maxLength={80} disabled={locked} aria-invalid={!planned.ok && planned.field === "name" ? true : undefined} onChange={(event) => onDraft({ ...draft, name: event.target.value })} /></label>
      <label className="block space-y-1 text-[13px]"><span className="text-gray-700">First administrator email</span>
        <DenInput type="email" value={draft.ownerEmail} disabled={locked} aria-invalid={!planned.ok && planned.field === "ownerEmail" ? true : undefined} onChange={(event) => onDraft({ ...draft, ownerEmail: event.target.value })} /></label>

      {recordedGateway ? runtime : addingGateway ? (
        <div className="space-y-2" data-testid="deployment-configuration-gateway">
          {runtime}
          <DenButton type="button" variant="ghost" size="inline" disabled={locked} data-testid="deployment-configuration-keep-runtime"
            onClick={() => onDraft({ ...draft, target: { ...draft.target, runtimeProfile: deployment.target.runtimeProfile, assistants: deployment.target.assistants } })}>
            {assistantsEnabled(deployment.target.assistants) ? "Keep the current runtime" : "Keep core services only"}
          </DenButton>
        </div>
      ) : (
        <div className="space-y-2 text-[13px]">
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2" data-testid="deployment-configuration-runtime">
            <span className="text-gray-700">Runtime</span>
            <span className="flex flex-wrap items-center gap-3">
              <span className="text-gray-900">{runtimeLabel(deployment.target)}</span>
              <DenButton type="button" variant="secondary" size="sm" disabled={locked || gatewayLock !== null} aria-describedby={gatewayLock ? gatewayLockId : undefined} data-testid="deployment-configuration-add-gateway"
                onClick={() => onDraft({ ...draft, target: { ...draft.target, runtimeProfile: "gateway", assistants: gatewayAssistants(deployment.target.assistants) } })}>Add gateway runtime</DenButton>
            </span>
          </div>
          <ConfigurationLockLine id={gatewayLockId} reason={gatewayLock} testId="deployment-configuration-gateway-lock" />
        </div>
      )}

      <section aria-labelledby={fixedHeading} className="space-y-1 text-[13px]" data-testid="deployment-configuration-fixed">
        <h3 id={fixedHeading} className="font-semibold text-gray-900">Fixed at installation</h3>
        <p className="text-gray-500">Set when the deployment was installed. Create a new deployment to use different values.</p>
        <dl>
          {fixedConfigurationRows(deployment).map((row) => (
            <div key={row.field} className="flex min-h-10 items-center justify-between gap-4 border-b border-gray-100 py-2 last:border-b-0" data-field={row.field}>
              <dt className="shrink-0 text-gray-500">{row.label}</dt>
              <dd className="flex min-w-0 items-center gap-2 text-right text-gray-700 [overflow-wrap:anywhere]">{row.value}<LockKeyhole aria-hidden className="size-4 shrink-0 text-gray-400" /></dd>
            </div>
          ))}
        </dl>
      </section>

      <ConfigurationLockLine reason={entry.reason ?? planLock ?? missing} testId="deployment-configuration-lock" />
      {message ? <p role="alert" className="text-[13px] text-red-700" data-testid="deployment-configuration-error">{message}</p> : null}
      <div className="flex justify-end">
        <DenButton type="submit" data-testid="deployment-configuration-review" disabled={!changed || planLock !== null || locked}>Review changes</DenButton>
      </div>
    </form>
  );
}

/** Before and after, what each change does, and the approval the person gives. */
export function ConfigurationChangeReview({ deployment, plan, consent, onConsent, busy = false, error = null, onBack, onSubmit }: {
  deployment: EditableDeployment; plan: AcceptedPlan; consent: boolean; onConsent: (consent: boolean) => void;
  busy?: boolean; error?: string | null; onBack: () => void; onSubmit: () => void;
}) {
  const consentId = useId();
  return (
    <div className="space-y-4" data-testid="deployment-configuration-review-step">
      <ConfigurationChangeList deployment={deployment} changes={plan.changes} effects />
      {plan.requiresApproval ? (
        <label className="flex items-start gap-3 text-[13px] text-gray-700">
          <DenCheckbox className="mt-0.5" checked={consent} disabled={busy} aria-labelledby={consentId} onCheckedChange={(checked) => onConsent(checked)} />
          <span id={consentId} className="min-w-0" data-testid="deployment-configuration-consent">{consentSentence(deployment, plan.changes)}</span>
        </label>
      ) : null}
      {error ? <p role="alert" className="text-[13px] text-red-700" data-testid="deployment-configuration-error">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <DenButton type="button" variant="secondary" disabled={busy} data-testid="deployment-configuration-back" onClick={onBack}>Back</DenButton>
        <DenButton type="button" data-testid="deployment-configuration-submit" loading={busy} disabled={plan.requiresApproval && !consent} onClick={onSubmit}>{plan.requiresApproval ? "Prepare AWS approval" : "Save name"}</DenButton>
      </div>
    </div>
  );
}

function ConfigurationChangeEditor({ deployment, assistantsAvailable, busy, onBusy, controls, onClose }: {
  deployment: EditableDeployment; assistantsAvailable: boolean; busy: boolean; onBusy: (busy: boolean) => void; controls: ConfigurationControls; onClose: () => void;
}) {
  // The values the person is editing against. The page keeps polling, but the
  // draft moves to newer values only when the API says it is out of date.
  const [base, setBase] = useState(deployment);
  const [draft, setDraft] = useState(() => configurationDraft(deployment));
  const [step, setStep] = useState<"form" | "review">("form");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const planned = planConfigurationDraft(base, draft);

  /** The pressed button leaves with its step, so focus moves to the step that replaced it. */
  function show(next: "form" | "review") {
    if (next === step) return;
    flushSync(() => { setStep(next); setConsent(false); setError(null); });
    container.current?.focus();
  }

  async function submit() {
    if (!planned.ok) return;
    onBusy(true); setError(null);
    try {
      await controls.runReauthableAction("Prepare configuration change", async () => {
        const result = await requestConfigurationChange(base, planned.configuration);
        controls.onResult(result.deployment, result.outcome === "approval_required" ? result : null);
        onClose();
      });
    } catch (failure) {
      if (failure instanceof DeploymentConfigurationChangedError) {
        const current = await loadDeployment(base.id);
        if (current) controls.onResult(current, null);
        if (current && hasConfiguration(current)) { setBase(current); setDraft(configurationDraft(current)); }
        show("form");
      }
      setError(failureMessage(failure));
    } finally {
      onBusy(false);
    }
  }

  return (
    <div ref={container} tabIndex={-1} role="group" aria-label={step === "review" ? "Review changes" : "Configuration"} data-step={step}>
      {step === "review" && planned.ok
        ? <ConfigurationChangeReview deployment={base} plan={planned.plan} consent={consent} onConsent={setConsent} busy={busy} error={error} onBack={() => show("form")} onSubmit={() => { void submit(); }} />
        : <ConfigurationChangeForm deployment={base} draft={draft} onDraft={(next) => { setDraft(next); setError(null); }} planned={planned} assistantsAvailable={assistantsAvailable} busy={busy} error={error} onReview={() => show("review")} />}
    </div>
  );
}

/**
 * Edit an installed deployment's configuration: the form, then the review. A
 * prepared change is handed back to the Deployments screen, which shows the
 * AWS CloudShell command; nothing in AWS changes until that command is run.
 */
export function ManagedDeploymentConfigurationDialog({ deployment, open, onOpenChange, assistantsAvailable, controls }: {
  deployment: ManagedDeployment | null; open: boolean; onOpenChange: (open: boolean) => void; assistantsAvailable: boolean; controls: ConfigurationControls;
}) {
  const [busy, setBusy] = useState(false);
  if (!deployment || !hasConfiguration(deployment)) return null;
  return (
    // Steps aside for the identity check, which would open underneath, and keeps
    // the draft mounted meanwhile so the pending request resumes into it.
    <Dialog.Root open={open && !controls.reauthDialogOpen} disablePointerDismissal onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal keepMounted={open}>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Popup data-testid="deployment-configuration-dialog" className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.35)]">
          <div className="mb-5 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-gray-900">Edit configuration</Dialog.Title>
            <Dialog.Close render={<DenButton type="button" variant="ghost" aria-label="Close" disabled={busy}><X aria-hidden className="size-4" /></DenButton>} />
          </div>
          <ConfigurationChangeEditor deployment={deployment} assistantsAvailable={assistantsAvailable} busy={busy} onBusy={setBusy} controls={controls} onClose={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
