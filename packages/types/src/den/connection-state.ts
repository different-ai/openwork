/** Facts about authentication repair, independent of a connection's provider. */
export type ConnectionRepairFacts = {
  needsReconnect?: boolean;
  missingFeatures?: readonly string[];
  reconnectActionOwner?: string | null;
};

export type MemberConnectionAuthorization = ConnectionRepairFacts & {
  authType: "oauth" | "apikey" | "none";
  credentialMode: "shared" | "per_member";
  connectedForMe: boolean;
};

/** Transport-independent facts used by member access and readiness surfaces. */
export type ConnectionStateFacts = ConnectionRepairFacts & {
  credentialMode: "shared" | "per_member";
  connected: boolean;
  connectedForMe: boolean;
  setupRequired?: boolean;
  issuerReviewRequired?: boolean;
  authTypeMismatch?: boolean;
  authPolicyConfirmed?: boolean;
  oauthClientRequired?: boolean;
  oauthClientConfigured?: boolean;
  /** Undefined means the server predates readiness checks; null means unchecked. */
  readiness?: { status: "ready" | "could_not_verify" } | null;
};

export type MemberConnectionState = "needs_admin_setup" | "needs_signin" | "connected" | "available";
export type ConnectionReadinessState = "needs_admin_setup" | "needs_signin" | "ready" | "could_not_verify";

export function connectionNeedsReconnect(connection: Pick<ConnectionRepairFacts, "needsReconnect" | "missingFeatures">): boolean {
  return connection.needsReconnect === true || (connection.missingFeatures?.length ?? 0) > 0;
}

/** Repair ownership only applies while a repair is required. */
export function connectionNeedsAdminRepair(connection: Pick<ConnectionRepairFacts, "needsReconnect" | "reconnectActionOwner">): boolean {
  return connection.needsReconnect === true && connection.reconnectActionOwner === "organization_admin";
}

export function canMemberAuthorizeConnection(connection: MemberConnectionAuthorization): boolean {
  return connection.credentialMode === "per_member" && connection.authType !== "none" && !connectionNeedsAdminRepair(connection);
}

export function canDisconnectMemberConnection(connection: Pick<MemberConnectionAuthorization, "credentialMode" | "connectedForMe">): boolean {
  return connection.credentialMode === "per_member" && connection.connectedForMe;
}

/**
 * Access and verification answer different questions. Shared member access is
 * based on connectedForMe; org readiness uses the shared connected account.
 * Keep both projections so an unverified connection never implies lost access,
 * and an older server never appears to have failed a readiness check.
 */
export function deriveConnectionState(connection: ConnectionStateFacts): {
  member: MemberConnectionState;
  readiness: ConnectionReadinessState | null;
} {
  const shared = connection.credentialMode === "shared";
  const perMember = connection.credentialMode === "per_member";
  const setupRequired = Boolean(connection.setupRequired || connection.issuerReviewRequired || connection.authTypeMismatch);

  let member: MemberConnectionState;
  if (setupRequired
    || connection.reconnectActionOwner === "organization_admin"
    || connection.authPolicyConfirmed === false
    || (connection.oauthClientRequired && !connection.oauthClientConfigured)
    || (shared && !connection.connectedForMe)) {
    member = "needs_admin_setup";
  } else if (perMember && (!connection.connectedForMe || connection.needsReconnect)) {
    member = "needs_signin";
  } else if (connection.connectedForMe || (shared && connection.connected)) {
    member = "connected";
  } else {
    member = "available";
  }

  let readiness: ConnectionReadinessState | null;
  if (connection.readiness === undefined) {
    readiness = null;
  } else if (setupRequired || (shared && !connection.connected)) {
    readiness = "needs_admin_setup";
  } else if (connection.needsReconnect || (perMember && !connection.connectedForMe)) {
    readiness = "needs_signin";
  } else {
    readiness = connection.readiness?.status === "ready" ? "ready" : "could_not_verify";
  }
  return { member, readiness };
}
