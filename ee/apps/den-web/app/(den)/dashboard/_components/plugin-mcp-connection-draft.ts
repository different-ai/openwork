import { pluginSetupRequest } from "./marketplace-mcp-setup";
import type { ExternalMcpAuthType, ExternalMcpCredentialMode } from "./mcp-connections-data";

/**
 * Connector setup captured while an MCP server is added to a plugin. It asks
 * the same authentication questions as the advanced Connectors form, so the
 * server is configured the moment the plugin exists instead of waiting for a
 * separate admin setup step.
 */
export type PluginMcpConnectionDraft = {
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  apiKey: string;
  useOAuthClient: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
};

export function emptyPluginMcpConnectionDraft(): PluginMcpConnectionDraft {
  return {
    authType: "oauth",
    credentialMode: "per_member",
    apiKey: "",
    useOAuthClient: false,
    oauthClientId: "",
    oauthClientSecret: "",
  };
}

/** Switching away from OAuth drops the OAuth-only answers, as the Connectors form does. */
export function withPluginMcpAuthType(draft: PluginMcpConnectionDraft, authType: ExternalMcpAuthType): PluginMcpConnectionDraft {
  return authType === "oauth"
    ? { ...draft, authType }
    : { ...draft, authType, useOAuthClient: false, oauthClientId: "", oauthClientSecret: "" };
}

export function pluginMcpConnectionDraftError(draft: PluginMcpConnectionDraft, serverName: string): string | null {
  if (draft.authType === "apikey" && !draft.apiKey.trim()) {
    return `Enter the API key for "${serverName}".`;
  }
  return null;
}

/** The `connection` body for an mcp component of `POST /v1/plugins`. */
export function pluginMcpConnectionRequest(draft: PluginMcpConnectionDraft): ReturnType<typeof pluginSetupRequest> {
  const clientId = draft.oauthClientId.trim();
  const clientSecret = draft.oauthClientSecret.trim();
  return pluginSetupRequest({
    apiKey: draft.apiKey.trim(),
    authType: draft.authType,
    credentialMode: draft.credentialMode,
    ...(draft.authType === "oauth" && draft.useOAuthClient && clientId
      ? { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } }
      : {}),
  });
}
