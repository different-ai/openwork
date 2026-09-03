import { describe, expect, test } from "bun:test";

import {
  emptyPluginMcpConnectionDraft,
  pluginMcpConnectionDraftError,
  pluginMcpConnectionRequest,
  withPluginMcpAuthType,
} from "../app/(den)/dashboard/_components/plugin-mcp-connection-draft";
import { AUTH_TYPE_OPTIONS, CREDENTIAL_MODE_OPTIONS } from "../app/(den)/dashboard/_components/mcp-connection-form-controls";

describe("plugin MCP connection draft", () => {
  test("offers the same authentication and account choices as the Connectors form", () => {
    expect(AUTH_TYPE_OPTIONS.map((option) => option.value)).toEqual(["oauth", "apikey", "none"]);
    expect(CREDENTIAL_MODE_OPTIONS.map((option) => option.value)).toEqual(["per_member", "shared"]);
    expect(emptyPluginMcpConnectionDraft()).toMatchObject({ authType: "oauth", credentialMode: "per_member" });
  });

  test("sends only the answers that apply to the chosen authentication", () => {
    const oauth = { ...emptyPluginMcpConnectionDraft(), credentialMode: "shared" as const };
    expect(pluginMcpConnectionRequest(oauth)).toEqual({ authType: "oauth", credentialMode: "shared" });

    const oauthWithApp = { ...oauth, useOAuthClient: true, oauthClientId: " client-1 ", oauthClientSecret: " secret-1 " };
    expect(pluginMcpConnectionRequest(oauthWithApp)).toEqual({
      authType: "oauth",
      credentialMode: "shared",
      oauthClient: { clientId: "client-1", clientSecret: "secret-1" },
    });

    const apiKey = { ...emptyPluginMcpConnectionDraft(), authType: "apikey" as const, apiKey: " sk-test ", oauthClientId: "ignored" };
    expect(pluginMcpConnectionRequest(apiKey)).toEqual({ authType: "apikey", credentialMode: "shared", apiKey: "sk-test" });

    const none = { ...emptyPluginMcpConnectionDraft(), authType: "none" as const, apiKey: "ignored" };
    expect(pluginMcpConnectionRequest(none)).toEqual({ authType: "none", credentialMode: "shared" });
  });

  test("leaving OAuth clears the OAuth app answers", () => {
    const draft = { ...emptyPluginMcpConnectionDraft(), useOAuthClient: true, oauthClientId: "client-1", oauthClientSecret: "secret-1" };
    expect(withPluginMcpAuthType(draft, "apikey")).toMatchObject({ authType: "apikey", useOAuthClient: false, oauthClientId: "", oauthClientSecret: "" });
    expect(withPluginMcpAuthType(draft, "oauth")).toEqual(draft);
  });

  test("requires an API key only for API-key authentication", () => {
    expect(pluginMcpConnectionDraftError({ ...emptyPluginMcpConnectionDraft(), authType: "apikey" }, "Linear")).toBe('Enter the API key for "Linear".');
    expect(pluginMcpConnectionDraftError({ ...emptyPluginMcpConnectionDraft(), authType: "apikey", apiKey: "sk-test" }, "Linear")).toBeNull();
    expect(pluginMcpConnectionDraftError(emptyPluginMcpConnectionDraft(), "Linear")).toBeNull();
    expect(pluginMcpConnectionDraftError({ ...emptyPluginMcpConnectionDraft(), authType: "none" }, "Linear")).toBeNull();
  });
});
