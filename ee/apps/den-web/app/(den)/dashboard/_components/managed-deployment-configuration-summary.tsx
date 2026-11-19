"use client";

import {
  deploymentConfigurationChangeResultSchema, deploymentConfigurationErrorSchema, managedDeploymentListSchema,
  type AwsManagedDeploymentInput, type DeploymentConfigurationChange, type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";
import { LockKeyhole } from "lucide-react";
import { useId, useState } from "react";
import type { z } from "zod";
import { DenButton } from "../../_components/ui/button";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import {
  approvalReserved, changeGroups, changeStateLine, fieldLabel, hasConfiguration, recordedDocument, valueLabel,
  type AwsDeployment, type EditableDeployment,
} from "./managed-deployment-configuration-state";

export type ConfigurationChangeResult = z.infer<typeof deploymentConfigurationChangeResultSchema>;
/** The approval handoff of a prepared change; the screen shows it as it shows an Update's. */
export type ConfigurationLaunch = Extract<ConfigurationChangeResult, { outcome: "approval_required" }>;
export type RunReauthableAction = (label: string, action: () => Promise<void>) => Promise<void>;
/** What the Deployments screen hands the deployment detail when configuration changes are on. */
export type ConfigurationControls = {
  onEdit: () => void;
  onResult: (deployment: ManagedDeployment, launch: ConfigurationLaunch | null) => void;
  runReauthableAction: RunReauthableAction;
  /** The identity check is on screen; a dialog steps aside so it can be reached. */
  reauthDialogOpen: boolean;
  /** Why someone who may not manage deployments finds these controls locked, and who can change that. */
  permissionReason: string;
};

/** The deployment changed after the page last loaded it, so the request was not applied. */
export class DeploymentConfigurationChangedError extends Error {}

const REQUEST_FAILED = "Couldn't prepare the configuration change. Try again.";

/** Records the request in OpenWork. Nothing in AWS changes until its command is run there. */
export async function requestConfigurationChange(deployment: EditableDeployment, configuration: AwsManagedDeploymentInput): Promise<ConfigurationChangeResult> {
  const result = await requestJson(`/v1/managed-deployments/${deployment.id}/configuration-changes`, {
    method: "POST", body: JSON.stringify({ expectedRevision: deployment.configuration.revision, configuration }),
  });
  if (result.response.ok) return deploymentConfigurationChangeResultSchema.parse(result.payload);
  const failure = getRequestError(result.payload, result.response, REQUEST_FAILED);
  const refusal = deploymentConfigurationErrorSchema.safeParse(result.payload);
  if (refusal.success && refusal.data.error === "configuration_changed") throw new DeploymentConfigurationChangedError(failure.message);
  throw failure;
}

/** The deployment as the API has it now, or null when it can't be read. */
export async function loadDeployment(id: string): Promise<ManagedDeployment | null> {
  try {
    const result = await requestJson("/v1/managed-deployments", { method: "GET" });
    const list = result.response.ok ? managedDeploymentListSchema.safeParse(result.payload) : null;
    return list?.success ? list.data.deployments.find((entry) => entry.id === id) ?? null : null;
  } catch {
    return null;
  }
}

export function failureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message ? failure.message : REQUEST_FAILED;
}

export function ConfigurationLockLine({ id, reason, testId, className = "" }: { id?: string; reason: string | null; testId: string; className?: string }) {
  if (!reason) return null;
  return <p id={id} className={`flex items-start gap-2 text-[13px] text-gray-500 ${className}`} data-testid={testId}><LockKeyhole aria-hidden className="mt-0.5 size-4 shrink-0" />{reason}</p>;
}

/** Before and after of each change; with `effects`, what each does to the running installation. */
export function ConfigurationChangeList({ deployment, changes, effects = false }: { deployment: AwsDeployment; changes: DeploymentConfigurationChange[]; effects?: boolean }) {
  return (
    <ul className="divide-y divide-gray-100 text-[13px]" data-testid="deployment-configuration-changes">
      {changeGroups(deployment, changes).map((group) => (
        <li key={group.changes[0]?.field} className="space-y-2 py-3 first:pt-0 last:pb-0">
          {group.changes.map((change) => (
            <div key={change.field} data-testid="deployment-configuration-change" data-field={change.field}>
              <p className="font-medium text-gray-900">{fieldLabel(change.field)}</p>
              <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3">
                <dt className="text-gray-500">Before</dt>
                <dd className="text-gray-500 [overflow-wrap:anywhere]" data-change-before>{valueLabel(change.field, change.before, deployment)}</dd>
                <dt className="text-gray-500">After</dt>
                <dd className="text-gray-900 [overflow-wrap:anywhere]" data-change-after>{valueLabel(change.field, change.after, deployment)}</dd>
              </dl>
            </div>
          ))}
          {effects ? <p className="text-gray-700" data-testid="deployment-configuration-change-effect">{group.sentence}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A requested change on the deployment detail: what was asked for, what is true
 * of it now, and what the person can do next. It renders nothing without one.
 */
export function ManagedDeploymentConfigurationSummary({ deployment, canManage, commandShown, controls }: {
  deployment: ManagedDeployment; canManage: boolean; commandShown: boolean; controls: ConfigurationControls;
}) {
  const heading = useId();
  const [pending, setPending] = useState<"show" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!hasConfiguration(deployment) || !deployment.configuration.change) return null;
  const editable = deployment;
  const change = deployment.configuration.change;
  const locked = !canManage || pending !== null;

  async function send(action: "show" | "discard") {
    setPending(action); setError(null);
    try {
      await controls.runReauthableAction(action === "show" ? "Prepare configuration change" : "Discard configuration change", async () => {
        const result = await requestConfigurationChange(editable, action === "show" ? change.requested : recordedDocument(editable));
        controls.onResult(result.deployment, result.outcome === "approval_required" ? result : null);
      });
    } catch (failure) {
      setError(failureMessage(failure));
      if (failure instanceof DeploymentConfigurationChangedError) {
        const current = await loadDeployment(editable.id);
        if (current) controls.onResult(current, null);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby={heading} className="space-y-2" data-testid="managed-deployment-configuration-change" data-change-state={change.state}>
      <h3 id={heading} className="text-[13px] font-semibold text-gray-900">Requested changes</h3>
      <ConfigurationChangeList deployment={editable} changes={change.changes} />
      <p className={`text-[13px] ${change.state === "failed" ? "text-gray-900" : "text-gray-500"}`} data-testid="managed-deployment-configuration-change-state">{changeStateLine(change, undefined, approvalReserved(deployment.run))}</p>
      {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
      {change.state === "applying" ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {change.state === "awaiting_approval" && !commandShown ? <DenButton type="button" data-testid="managed-deployment-configuration-show-command" loading={pending === "show"} disabled={locked} onClick={() => { void send("show"); }}>Show approval command</DenButton> : null}
          {change.state === "expired" ? <DenButton type="button" data-testid="managed-deployment-configuration-prepare-again" loading={pending === "show"} disabled={locked} onClick={() => { void send("show"); }}>Prepare again</DenButton> : null}
          {change.state === "failed" ? <DenButton type="button" data-testid="managed-deployment-configuration-try-again" disabled={locked} onClick={controls.onEdit}>Review and try again</DenButton> : null}
          {change.state === "awaiting_approval" ? <DenButton type="button" variant="secondary" data-testid="managed-deployment-configuration-edit-change" disabled={locked} onClick={controls.onEdit}>Edit change</DenButton> : null}
          {change.state === "awaiting_approval" || change.state === "expired" ? <DenButton type="button" variant="secondary" data-testid="managed-deployment-configuration-discard" loading={pending === "discard"} disabled={locked} onClick={() => { void send("discard"); }}>Discard change</DenButton> : null}
        </div>
      )}
      {change.state === "applying" || canManage ? null : <ConfigurationLockLine reason={controls.permissionReason} testId="managed-deployment-configuration-change-lock" />}
    </section>
  );
}
