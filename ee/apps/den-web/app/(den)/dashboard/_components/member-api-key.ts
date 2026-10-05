import type { ExternalMcpAuthType, ExternalMcpCredentialMode } from "./mcp-connections-data";

export const MEMBER_API_KEY_MAX_LENGTH = 8192;
export const MEMBER_API_KEY_GRANT_HELP = "You can't add a key to this connection yet. Ask an administrator to give you access directly, through your team, or for everyone.";
export const MEMBER_API_KEY_DIALOG_SUBTITLE = "Add your own key. OpenWork uses it only for your requests.";
export const MEMBER_API_KEY_UNCERTAIN_MESSAGE = "OpenWork could not confirm whether the key was saved. Check the connection status before retrying because retrying may replace a key that was saved.";

type MemberApiKeyConnection = {
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
};

type PersonalApiKeyConnection = MemberApiKeyConnection & {
  connectedForMe: boolean;
  needsReconnect?: boolean;
  credentialHealth?: "unknown" | "ready" | "reconnect_required";
};

export type PersonalApiKeyStatus = "missing" | "saved_unverified" | "ready" | "reconnect_required";

export type MemberApiKeyBoundary = {
  organizationId: string | null;
  connectionId: string | null;
  generation: number;
};

export type MemberApiKeySaveOutcome =
  | { kind: "stored" }
  | { kind: "failed"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "stale" };

export function nextMemberApiKeyBoundary(
  current: MemberApiKeyBoundary,
  organizationId: string | null,
  connectionId: string | null,
  invalidate = false,
): MemberApiKeyBoundary {
  if (!invalidate && current.organizationId === organizationId && current.connectionId === connectionId) return current;
  return { organizationId, connectionId, generation: current.generation + 1 };
}

export function isCurrentMemberApiKeyBoundary(current: MemberApiKeyBoundary, attempt: MemberApiKeyBoundary): boolean {
  return current.generation === attempt.generation
    && current.organizationId === attempt.organizationId
    && current.connectionId === attempt.connectionId;
}

export async function settleMemberApiKeySave(input: {
  request: () => Promise<{ ok: boolean; status: number }>;
  refresh: () => Promise<void>;
  isCurrent: () => boolean;
}): Promise<MemberApiKeySaveOutcome> {
  let response: { ok: boolean; status: number };
  try {
    response = await input.request();
  } catch {
    return input.isCurrent()
      ? { kind: "uncertain", message: MEMBER_API_KEY_UNCERTAIN_MESSAGE }
      : { kind: "stale" };
  }
  if (!input.isCurrent()) return { kind: "stale" };
  if (!response.ok) {
    return isDefinitiveMemberApiKeyFailureStatus(response.status)
      ? { kind: "failed", message: memberApiKeyFailureMessage(response.status) }
      : { kind: "uncertain", message: MEMBER_API_KEY_UNCERTAIN_MESSAGE };
  }
  try {
    await input.refresh();
  } catch {
    // HTTP success confirms storage; a stale query must not reverse that result.
  }
  return input.isCurrent() ? { kind: "stored" } : { kind: "stale" };
}

export function usesMemberApiKey(connection: MemberApiKeyConnection): boolean {
  return connection.authType === "apikey" && connection.credentialMode === "per_member";
}

/** A stored personal key is not ready until an upstream request validates it. */
export function personalApiKeyStatus(connection: PersonalApiKeyConnection): PersonalApiKeyStatus | null {
  if (!usesMemberApiKey(connection)) return null;
  if (connection.needsReconnect === true || connection.credentialHealth === "reconnect_required") return "reconnect_required";
  if (!connection.connectedForMe) return "missing";
  return connection.credentialHealth === "ready" ? "ready" : "saved_unverified";
}

export function personalApiKeyStatusLabel(status: PersonalApiKeyStatus): string {
  if (status === "missing") return "No key";
  if (status === "saved_unverified") return "Key saved";
  if (status === "ready") return "Key saved";
  return "Replace key";
}

export function credentialModeForAuth(
  authType: ExternalMcpAuthType,
  selectedMode: ExternalMcpCredentialMode,
): ExternalMcpCredentialMode {
  return authType === "none" ? "shared" : selectedMode;
}

/** Member keys are opaque printable ASCII. Never trim or otherwise rewrite them. */
export function validateMemberApiKey(apiKey: string): string | null {
  if (!apiKey) return "Paste your key.";
  if (apiKey.length > MEMBER_API_KEY_MAX_LENGTH) return "The key is too long.";
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    return "Use the raw key without spaces or control characters.";
  }
  return null;
}

export function memberApiKeyRequest(connectionId: string, orgId: string, apiKey: string): {
  path: string;
  init: RequestInit;
} {
  return {
    path: `/v1/mcp-connections/${encodeURIComponent(connectionId)}/my-credential`,
    init: {
      method: "PUT",
      headers: { "x-openwork-org-id": orgId },
      body: JSON.stringify({ apiKey }),
    },
  };
}

/** Provider and server response text is deliberately excluded because it may echo a key. */
export function isDefinitiveMemberApiKeyFailureStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 409;
}

export function memberApiKeyFailureMessage(status?: number): string {
  if (status === 400) return "That key is not accepted. Paste the raw key and try again.";
  if (status === 403) return MEMBER_API_KEY_GRANT_HELP;
  if (status === 404) return "This connection is no longer available. Reload the page.";
  if (status === 409) return "This connection changed. Reload the page and try again.";
  return MEMBER_API_KEY_UNCERTAIN_MESSAGE;
}
