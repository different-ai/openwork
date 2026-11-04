"use client";

import { useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import {
  type DenOrgScimConnection,
  type DenOrgScimHealth,
  type DenOrgSsoConnection,
  getOrgAccessFlags,
  parseOrgScimPayload,
  parseOrgSsoPayload,
} from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import type { AuthSecurityFacts, AuthSecurityScimState, AuthSecuritySsoState } from "../_features/feature-intros/intros/auth-security";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** Where an SSO connection is: none, saved without a verified domain, verified but off, on. */
export function ssoIntroState(connection: DenOrgSsoConnection | null): AuthSecuritySsoState {
  if (!connection) return "none";
  if (connection.status === "enabled") return "on";
  return connection.domainVerified ? "turn-on" : "verify-domain";
}

/** Where a SCIM connector is: none, created with nobody synced yet, syncing people. */
export function scimIntroState(connection: DenOrgScimConnection | null, health: Pick<DenOrgScimHealth, "lastSuccessfulSyncAt">): AuthSecurityScimState {
  if (!connection) return "none";
  return health.lastSuccessfulSyncAt ? "syncing" : "waiting";
}

/**
 * Section facts for the Auth & Security intro (DESIGN.md I2), from the same
 * `GET /v1/sso` and `GET /v1/scim` the tabs load. Runs only while `enabled`
 * (the `featureIntros` flag), so the page makes no extra requests with it
 * off. Null until both are known, or when this person can't read one of them:
 * the page then renders as before.
 */
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
      const { response, payload } = await requestJson("/v1/sso", { method: "GET", headers, signal }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't check single sign-on (${response.status}).`));
      return ssoIntroState(parseOrgSsoPayload(payload).connection);
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
