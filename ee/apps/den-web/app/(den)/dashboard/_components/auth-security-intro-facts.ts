"use client";

import { useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import {
  type DenOrgScimConnection,
  type DenOrgScimHealth,
  type DenOrgSsoConnection,
  getOrgAccessFlags,
  parseOrgScimPayload,
  parseOrgSsoConnectionsPayload,
} from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import type { AuthSecurityFacts, AuthSecurityScimState, AuthSecuritySsoState } from "../_features/feature-intros/intros/auth-security";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function ssoIntroStateForConnections(connections: readonly DenOrgSsoConnection[]): AuthSecuritySsoState {
  if (connections.some((connection) => connection.status === "enabled")) return "on";
  if (connections.some((connection) => connection.domainVerified)) return "turn-on";
  return connections.length > 0 ? "verify-domain" : "none";
}

export function scimIntroState(connection: DenOrgScimConnection | null, health: Pick<DenOrgScimHealth, "lastSuccessfulSyncAt">): AuthSecurityScimState {
  if (!connection) return "none";
  return health.lastSuccessfulSyncAt ? "syncing" : "waiting";
}

export function useAuthSecurityIntroFacts(enabled: boolean): AuthSecurityFacts | null {
  const { orgId, orgContext } = useOrgDashboard();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  );
  const readable = enabled && Boolean(orgId) && access.canViewSso && access.canViewScim;
  const headers = { [ORG_SCOPE_HEADER]: orgId ?? "" };
  const sso = useQuery({
    queryKey: ["feature-intros", "auth-security", "sso", orgId ?? ""],
    enabled: readable,
    retry: false,
    staleTime: 10_000,
    queryFn: async ({ signal }): Promise<AuthSecuritySsoState> => {
      const { response, payload } = await requestJson("/v1/sso/connections", { method: "GET", headers, signal }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't check single sign-on (${response.status}).`));
      return ssoIntroStateForConnections(parseOrgSsoConnectionsPayload(payload));
    },
  });
  const scim = useQuery({
    queryKey: ["feature-intros", "auth-security", "scim", orgId ?? ""],
    enabled: readable,
    retry: false,
    staleTime: 10_000,
    queryFn: async ({ signal }): Promise<{ state: AuthSecurityScimState; ssoReady: boolean }> => {
      const { response, payload } = await requestJson("/v1/scim", { method: "GET", headers, signal }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't check user provisioning (${response.status}).`));
      const parsed = parseOrgScimPayload(payload);
      return { state: scimIntroState(parsed.connection, parsed.health), ssoReady: parsed.ssoReady };
    },
  });

  if (!readable || !orgContext || sso.data === undefined || scim.data === undefined) return null;
  return {
    sso: sso.data,
    scim: scim.data.state,
    ssoReady: scim.data.ssoReady,
    ssoIncluded: orgContext.entitlements.sso,
    scimIncluded: orgContext.entitlements.scim,
  };
}
