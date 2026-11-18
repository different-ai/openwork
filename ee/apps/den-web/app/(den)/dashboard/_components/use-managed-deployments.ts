"use client";

import {
  awsTargetSchema, managedDeploymentConfigurationSchema, managedDeploymentLaunchSchema, managedDeploymentListSchema,
  type AwsAssistants, type AwsRuntimeProfile, type AwsSignIn, type DeploymentLaunchKind, type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { providerName } from "./managed-deployments-state";

export type DeploymentConfiguration = z.infer<typeof managedDeploymentConfigurationSchema>;
export type DeploymentLaunch = z.infer<typeof managedDeploymentLaunchSchema>;

async function loadDeployments() {
  const list = await requestJson("/v1/managed-deployments", { method: "GET" });
  if (!list.response.ok) throw new Error(getErrorMessage(list.payload, "Couldn't load deployments."));
  return managedDeploymentListSchema.parse(list.payload).deployments;
}

/** The organization's deployments, kept fresh, and the steps a person takes on one. */
export function useManagedDeployments() {
  const { orgId, orgContext, runReauthableAction } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions);
  const enabled = orgFeatureEnabled(orgContext, "managedDeployments");
  const canView = access.canViewDeployments;
  const [deployments, setDeployments] = useState<ManagedDeployment[]>([]);
  const [configuration, setConfiguration] = useState<DeploymentConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<DeploymentLaunch | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const assistantsAvailable = enabled && orgFeatureEnabled(orgContext, "managedDeploymentAssistants") && (configuration?.assistantsAvailable ?? false);
  const available = configuration?.providers.some((entry) => entry.available && (entry.provider === "aws" || entry.provider === "gcp")) ?? false;

  useEffect(() => {
    const current = ++generation.current;
    setDeployments([]); setConfiguration(null); setLoadedAt(null); setLaunch(null); setError(null); setActionError(null); setBusy(false);
    setLoading(enabled && canView);
    if (!enabled || !orgId || !canView) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [list, settings] = await Promise.all([loadDeployments(), requestJson("/v1/managed-deployments/configuration", { method: "GET" })]);
        if (!settings.response.ok) throw new Error(getErrorMessage(settings.payload, "Couldn't load deployment settings."));
        if (!stopped && generation.current === current) {
          setDeployments(list);
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
  }, [orgId, enabled, canView]);

  function replace(item: ManagedDeployment) {
    setDeployments((previous) => previous.some((entry) => entry.id === item.id) ? previous.map((entry) => entry.id === item.id ? item : entry) : [...previous, item]);
  }

  async function prepare(deployment: ManagedDeployment, kind: DeploymentLaunchKind, assistants?: AwsAssistants, runtimeProfile?: AwsRuntimeProfile) {
    if ((assistants || runtimeProfile) && deployment.provider === "aws") {
      const parsed = awsTargetSchema.safeParse({ ...deployment.target, ...(runtimeProfile ? { runtimeProfile } : {}), ...(assistants ? { assistants } : {}) });
      if (!parsed.success) { setActionError(parsed.error.issues[0]?.message ?? "Check the assistant settings."); return; }
    }
    const current = generation.current;
    setBusy(true); setActionError(null);
    try {
      await runReauthableAction(kind === "install" ? `Prepare ${providerName(deployment.provider)} approval` : kind === "update" ? "Prepare update" : "Prepare retry", async () => {
        const result = await requestJson(`/v1/managed-deployments/${deployment.id}/launch`, { method: "POST", body: JSON.stringify({ kind, ...(assistants ? { assistants } : {}), ...(runtimeProfile ? { runtimeProfile } : {}) }) });
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

  /**
   * Fetches the approval a person already prepared, so its link is there when
   * they come back to the page. The same run; false when it can't be fetched.
   */
  async function reopen(deployment: ManagedDeployment): Promise<boolean> {
    const run = deployment.run;
    if (!run || run.kind === "configure") return false;
    const current = generation.current;
    try {
      const result = await requestJson(`/v1/managed-deployments/${deployment.id}/launch`, { method: "POST", body: JSON.stringify({ kind: run.kind }) });
      if (!result.response.ok) return false;
      const parsed = managedDeploymentLaunchSchema.parse(result.payload);
      if (generation.current !== current || parsed.deployment.run?.id !== run.id) return false;
      setLaunch(parsed); replace(parsed.deployment);
      return true;
    } catch {
      return false;
    }
  }

  async function remove(deployment: ManagedDeployment) {
    const current = generation.current;
    setBusy(true); setActionError(null);
    try {
      await runReauthableAction("Remove deployment", async () => {
        const result = await requestJson(`/v1/managed-deployments/${deployment.id}`, { method: "DELETE" });
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Couldn't remove the deployment.");
        if (generation.current === current) { setDeployments((previous) => previous.filter((entry) => entry.id !== deployment.id)); setLaunch(null); }
      });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  /** Saves or removes how the organization signs in to AWS; every AWS link is then issued again. */
  async function saveAwsSignIn(awsSignIn: AwsSignIn | null) {
    const current = generation.current;
    await runReauthableAction(awsSignIn ? "Save AWS sign-in" : "Remove AWS sign-in", async () => {
      const result = await requestJson("/v1/managed-deployments/aws-sign-in", { method: "PUT", body: JSON.stringify({ awsSignIn }) });
      if (!result.response.ok) throw getRequestError(result.payload, result.response, "Couldn't save the AWS sign-in.");
      const list = await loadDeployments().catch(() => null);
      if (generation.current !== current) return;
      setConfiguration((previous) => previous ? { ...previous, awsSignIn } : previous);
      setLaunch(null);
      if (list) setDeployments(list);
    });
  }

  return {
    orgId, enabled, access, deployments, configuration, loading, loadedAt, error, actionError, setActionError, launch, setLaunch, busy,
    assistantsAvailable, available, runReauthableAction, replace, prepare, reopen, remove, saveAwsSignIn,
  };
}
