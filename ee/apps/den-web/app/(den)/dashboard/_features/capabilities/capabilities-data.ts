"use client";

import { organizationAutomationSettingsSchema } from "@openwork/types/den/automation-settings";
import { managedDeploymentCapabilitiesSchema, type ManagedDeploymentCapabilities } from "@openwork/managed-deployments/capability-state";
import type { CustomerCapabilityId } from "@openwork/managed-deployments/capabilities";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getOrgAccessFlags, permissionLockReason } from "../../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useGatewayAccessProviders, type GatewayAccessProvider } from "../../_components/gateway-subject-access-data";
import { useMcpConnections } from "../../_components/mcp-connections-data";
import { useSlackAssistantSetupQuery } from "../../_components/slack-assistant-setup";
import { isSlackMcpUrl } from "../../_components/slack-connector-setup";
import { useWorkbotTeamSettings } from "../../_components/workbot-team-settings-data";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import {
  automationsMemberAccess,
  cloudComputersMemberAccess,
  gatewayMemberAccess,
  slackMemberAccess,
  workbotMemberAccess,
  type GatewayAccessFacts,
  type Loaded,
  type MemberAccess,
} from "./capabilities-model";

const automationSettingsSchema = z.object({ settings: organizationAutomationSettingsSchema });

function loaded<T, R>(query: Pick<UseQueryResult<T>, "data" | "error" | "isPending">, lockedReason: string | null, fallback: string, map: (data: T) => R): Loaded<R> {
  if (lockedReason) return { state: "locked", reason: lockedReason };
  if (query.data !== undefined) return { state: "ready", data: map(query.data) };
  if (query.error) return { state: "error", reason: query.error instanceof Error ? query.error.message : fallback };
  return { state: "loading" };
}

export function usableGatewayGrants(providers: readonly GatewayAccessProvider[]): GatewayAccessFacts {
  const grants: Array<GatewayAccessFacts["grants"][number]> = [];
  for (const provider of providers) {
    if (provider.status !== "active") continue;
    for (const grant of provider.accessGrants) {
      const group = provider.modelGroups.find((entry) => entry.id === grant.modelGroupId);
      const credential = provider.credentialSets.find((entry) => entry.id === grant.credentialSetId);
      if (!group || !credential || group.status !== "active" || credential.status !== "active" || group.modelIds.length === 0) continue;
      if (grant.audience.type === "organization") grants.push({ audience: "organization", subjectId: null });
      else if (grant.audience.type === "team") grants.push({ audience: "team", subjectId: grant.audience.teamId });
      else grants.push({ audience: "member", subjectId: grant.audience.memberId });
    }
  }
  return { grants };
}

export function useCapabilityMemberAccess(enabled: boolean, gatewayInstalled: boolean): { access: Record<CustomerCapabilityId, MemberAccess>; slackConnectorId: string | null } {
  const { orgId, orgContext } = useOrgDashboard();
  const organizationId = orgId ?? "";
  const flags = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions) : null;
  const on = enabled && Boolean(orgId) && flags !== null;

  const canReadWorkbot = flags?.canViewModelsSettings === true || flags?.canManageModelsSettings === true;
  const workbotQuery = useWorkbotTeamSettings(organizationId, on && canReadWorkbot);
  const workbot = workbotMemberAccess(loaded(workbotQuery, flags && !canReadWorkbot ? permissionLockReason("inference.view") : null, "Couldn't load Workbot settings.", (view) => ({
    organizationEnabled: view.organization.enabled,
    teams: view.teams.map((team) => ({ enabled: team.enabled })),
  })));

  const canReadConnections = flags?.canViewAllConnections === true || flags?.canManageConnections === true;
  const connectionsQuery = useMcpConnections("manageable", { enabled: on && canReadConnections });
  const slackConnector = connectionsQuery.data?.find((connection) => isSlackMcpUrl(connection.url)) ?? null;
  const assistantQuery = useSlackAssistantSetupQuery(slackConnector?.id ?? null, on && canReadConnections && slackConnector !== null);
  const slackLocked = flags && !canReadConnections ? permissionLockReason("connections.view") : null;
  const slack = slackMemberAccess(slackConnector && !slackLocked
    ? loaded(assistantQuery, null, "Couldn't load the Slack assistant.", (assistant) => ({
        connector: {
          orgWide: slackConnector.access?.orgWide === true,
          teamCount: slackConnector.access?.teamIds.length ?? 0,
          memberCount: slackConnector.access?.memberIds.length ?? 0,
        },
        assistant: { installed: assistant.installed, enabled: assistant.enabled },
      }))
    : loaded(connectionsQuery, slackLocked, "Couldn't load connectors.", () => ({ connector: null, assistant: null })));

  const automationsQuery = useQuery({
    queryKey: ["org-automation-settings", organizationId],
    enabled: on,
    retry: false,
    queryFn: async ({ signal }) => {
      const { response, payload } = await requestJson("/v1/org/automation-settings", { method: "GET", headers: { [ORG_SCOPE_HEADER]: organizationId }, cache: "no-store", signal }, 12_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load Automations settings."));
      const parsed = automationSettingsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Automations settings returned an unexpected response.");
      return parsed.data.settings;
    },
  });
  const automations = automationsMemberAccess(loaded(automationsQuery, null, "Couldn't load Automations settings.", (settings) => settings));

  const canReadGateway = flags?.canViewGatewayProviders === true || flags?.canManageGatewayProviders === true;
  const gatewayQuery = useGatewayAccessProviders(organizationId, on && canReadGateway && gatewayInstalled);
  const aiGateway: MemberAccess = gatewayInstalled
    ? gatewayMemberAccess(loaded(gatewayQuery, flags && !canReadGateway ? permissionLockReason("gateway_providers.view") : null, "Couldn't load AI Gateway access.", usableGatewayGrants))
    : { kind: "not_applicable" };

  return {
    access: { workbot, slackAssistant: slack, automations, aiGateway, cloudComputers: cloudComputersMemberAccess(workbot) },
    slackConnectorId: slackConnector?.id ?? null,
  };
}

export function useManagedDeploymentCapabilities(deploymentId: string, enabled: boolean) {
  const { orgId } = useOrgDashboard();
  const organizationId = orgId ?? "";
  return useQuery({
    queryKey: ["managed-deployment-capabilities", organizationId, deploymentId],
    enabled: enabled && Boolean(orgId) && Boolean(deploymentId),
    retry: false,
    queryFn: async ({ signal }): Promise<ManagedDeploymentCapabilities> => {
      const { response, payload } = await requestJson(`/v1/managed-deployments/${encodeURIComponent(deploymentId)}/capabilities`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: organizationId }, cache: "no-store", signal }, 12_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load this deployment's capabilities."));
      const parsed = managedDeploymentCapabilitiesSchema.safeParse(payload);
      if (!parsed.success) throw new Error("This deployment's capabilities returned an unexpected response.");
      return parsed.data;
    },
  });
}
