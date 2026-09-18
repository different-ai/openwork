import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import {
  createDenClient,
  DenApiError,
  type DenClient,
  type DenExternalMcpPreset,
  type DenOrgPluginResolved,
  type DenPluginCloudReadiness,
  type DenPluginCloudReadinessConnection,
} from "../src/app/lib/den";
import { emptyLibraryMcpConnectionForm } from "../src/react-app/domains/settings/library";
import type { PluginConnectionSetupProps } from "../src/react-app/domains/settings/pages/plugin-connection-setup";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const {
  PluginConnectionSetup,
  pluginRequirementAuth,
  pluginRequirementPolicy,
  pluginRequirementSetupRequest,
} = await import("../src/react-app/domains/settings/pages/plugin-connection-setup");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function requirement(patch: Partial<DenPluginCloudReadinessConnection> = {}): DenPluginCloudReadinessConnection {
  return {
    id: null,
    name: "Reference server",
    url: "https://reference.example.test/mcp",
    configObjectId: "cob_requirement",
    serverName: "exact-server-name",
    ...patch,
  };
}

function resolved(connections: DenPluginCloudReadinessConnection[], state: DenPluginCloudReadiness["state"] = "needs_admin_setup"): DenOrgPluginResolved {
  return {
    plugin: {
      id: "plg_reference",
      name: "Reference plugin",
      description: null,
      status: "active",
      memberCount: connections.length,
      updatedAt: null,
      componentCounts: { mcp: connections.length },
      cloudReadiness: { state, hasInstructional: false, connections },
    },
    memberships: [],
  };
}

function clientFor(data: DenOrgPluginResolved, overrides: Partial<DenClient> = {}): DenClient {
  return {
    ...createDenClient({ baseUrl: "https://den.example.test", apiBaseUrl: "https://api.den.example.test" }),
    getLibraryPlugin: mock(async () => data.plugin),
    listMcpConnectionPresets: mock(async () => []),
    configurePluginMcpConnection: mock(async () => ({ connectionId: "emc_saved" })),
    ...overrides,
  };
}

function propsFor(client: DenClient, overrides: Partial<PluginConnectionSetupProps> = {}): PluginConnectionSetupProps {
  return {
    client,
    pluginId: "plg_reference",
    organizationId: "org_reference",
    canManage: true,
    onConfigureConnection: mock(() => {}),
    onConnect: mock(async () => {}),
    onChanged: mock(async () => {}),
    onReauthenticate: mock(() => {}),
    ...overrides,
  };
}

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  const render = async (next: ReactNode) => { await act(async () => root.render(next)); };
  await render(node);
  return { host, unmount, render };
}

function button(host: HTMLElement, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

const apiKeyPreset: DenExternalMcpPreset = {
  presetId: "reference",
  displayName: "Reference server",
  description: "Reference tools",
  url: "https://reference.example.test/mcp/",
  authType: "apikey",
};

const githubPreset: DenExternalMcpPreset = {
  presetId: "github",
  displayName: "GitHub",
  description: "Repository tools",
  url: "https://api.githubcopilot.com/mcp/",
  authType: "oauth",
  supportedAuthTypes: ["oauth", "apikey"],
  requiresOAuthClient: true,
};

function githubRequirement(patch: Partial<DenPluginCloudReadinessConnection> = {}) {
  return requirement({ name: "GitHub", url: githubPreset.url, ...patch });
}

async function selectAuth(host: HTMLElement, value: string) {
  const select = host.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("Missing authentication selector");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function boundKeyRequirement(patch: Partial<DenPluginCloudReadinessConnection> = {}) {
  return requirement({ id: "emc_previous", authType: "apikey", requiredAuthType: "apikey", credentialMode: "shared", connectedForMe: false, ...patch });
}

async function enterApiKey(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!input || !setter) throw new Error("Missing API-key input");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("plugin connection requirement policy", () => {
  test("missing bindings require admin setup and exact server targets", () => {
    expect(pluginRequirementPolicy(requirement(), "needs_admin_setup", true)).toEqual({ label: "Needs admin setup", action: "create" });
    expect(pluginRequirementPolicy(requirement(), "needs_admin_setup", false).action).toBe("none");
    expect(pluginRequirementPolicy(requirement({ serverName: undefined }), "needs_admin_setup", true).action).toBe("none");
    expect(pluginRequirementPolicy(requirement({ configObjectId: undefined }), "needs_admin_setup", true).action).toBe("none");
  });

  test("members connect only their accounts, never configure admin-owned setup", () => {
    const connection = requirement({ id: "emc_existing", authType: "oauth", credentialMode: "per_member", connectedForMe: false });
    expect(pluginRequirementPolicy(connection, "needs_signin", false)).toEqual({ label: "Needs your sign-in", action: "connect" });
    expect(pluginRequirementPolicy({ ...connection, credentialMode: "shared" }, "needs_admin_setup", false).action).toBe("none");
    expect(pluginRequirementPolicy({ ...connection, credentialMode: "shared" }, "needs_admin_setup", true).action).toBe("connect");
    expect(pluginRequirementPolicy({ ...connection, oauthClientRequired: true, oauthClientConfigured: false }, "needs_admin_setup", false).action).toBe("none");
    expect(pluginRequirementPolicy({ ...connection, oauthClientRequired: true, oauthClientConfigured: false }, "needs_admin_setup", true).action).toBe("configure");
  });

  test("setup conflicts beat connected flags and unknown status is not ready", () => {
    const connection = requirement({ id: "emc_existing", connectedForMe: true, authTypeMismatch: true });
    expect(pluginRequirementPolicy(connection, "needs_admin_setup", true).action).toBe("configure");
    expect(pluginRequirementPolicy(requirement({ id: "emc_existing" }), "needs_admin_setup", true).label).toBe("Connection status unavailable");
    expect(pluginRequirementPolicy(requirement({ id: "emc_existing", connectedForMe: true }), "ready", false).label).toBe("Ready to use");
    expect(pluginRequirementPolicy(requirement(), "desktop_only", true).action).toBe("none");
    expect(pluginRequirementPolicy(requirement(), "not_synced", true).action).toBe("none");
  });

  test("declarations and exact presets select auth without defaulting unknown servers to OAuth", () => {
    expect(pluginRequirementAuth(requirement(), [apiKeyPreset]).authType).toBe("apikey");
    expect(pluginRequirementAuth(requirement({ requiredAuthType: "none" }), [apiKeyPreset]).authType).toBe("none");
    expect(pluginRequirementAuth(requirement({ url: "https://other.example.test/mcp" }), [apiKeyPreset]).authType).toBeNull();
    expect(pluginRequirementAuth(requirement({ url: "https://reference.example.test/mcp?different=1" }), [apiKeyPreset]).authType).toBeNull();
  });

  test("GitHub offers OAuth or PAT and only OAuth requires client registration", () => {
    const connection = githubRequirement();
    expect(pluginRequirementAuth(connection, [githubPreset])).toMatchObject({
      authType: "oauth", authTypes: ["oauth", "apikey"], locked: false, requiresOAuthClient: true,
    });
    expect(pluginRequirementAuth(connection, [githubPreset], "apikey")).toMatchObject({
      authType: "apikey", requiresOAuthClient: false, apiKeyLabel: "Personal access token (PAT)",
    });
    expect(pluginRequirementSetupRequest(connection, [githubPreset], {
      ...emptyLibraryMcpConnectionForm(), apiKey: " example-pat ",
    }, "apikey")).toEqual({
      configObjectId: "cob_requirement", serverName: "exact-server-name", authType: "apikey", credentialMode: "shared", apiKey: "example-pat",
    });
    expect(() => pluginRequirementSetupRequest(connection, [githubPreset], emptyLibraryMcpConnectionForm(), "oauth")).toThrow("OAuth client ID");
    expect(pluginRequirementSetupRequest(connection, [githubPreset], {
      ...emptyLibraryMcpConnectionForm(), apiKey: "stale-pat", oauthClientId: " client-id ", oauthClientSecret: " client-secret ",
    }, "oauth")).toEqual({
      configObjectId: "cob_requirement", serverName: "exact-server-name", authType: "oauth", credentialMode: "per_member",
      oauthClient: { clientId: "client-id", clientSecret: "client-secret" },
    });
    expect(() => pluginRequirementSetupRequest(connection, [githubPreset], emptyLibraryMcpConnectionForm(), "none")).toThrow("not supported");
  });

  test("server declarations override GitHub alternatives and stale client requirements", () => {
    const tokenOnly = githubRequirement({ requiredAuthType: "apikey", oauthClientRequired: true });
    expect(pluginRequirementAuth(tokenOnly, [githubPreset], "oauth")).toMatchObject({
      authType: "apikey", authTypes: ["apikey"], locked: true, requiresOAuthClient: false,
    });
    expect(pluginRequirementPolicy({ ...tokenOnly, id: "emc_pat", authType: "apikey", connectedForMe: true, oauthClientConfigured: false }, "ready", false).label).toBe("Ready to use");
    expect(pluginRequirementSetupRequest(tokenOnly, [githubPreset], {
      ...emptyLibraryMcpConnectionForm(), apiKey: "example-pat", useOAuthClient: true, oauthClientId: "old-client", oauthClientSecret: "old-secret",
    }, "oauth")).toEqual({
      configObjectId: "cob_requirement", serverName: "exact-server-name", authType: "apikey", credentialMode: "shared", apiKey: "example-pat",
    });
    const oauthOnly = githubRequirement({ requiredAuthType: "oauth" });
    expect(pluginRequirementAuth(oauthOnly, [githubPreset], "apikey")).toMatchObject({
      authType: "oauth", authTypes: ["oauth"], locked: true, requiresOAuthClient: true,
    });
    expect(() => pluginRequirementSetupRequest(oauthOnly, [githubPreset], {
      ...emptyLibraryMcpConnectionForm(), apiKey: "example-pat",
    }, "apikey")).toThrow("OAuth client ID");
  });

  test("payloads preserve exact target IDs and omit URL, audience, and irrelevant credentials", () => {
    const form = {
      ...emptyLibraryMcpConnectionForm(),
      apiKey: " example-key ",
      useOAuthClient: true,
      oauthClientId: "old-client",
      oauthClientSecret: "old-secret",
    };
    expect(pluginRequirementSetupRequest(requirement(), [apiKeyPreset], form, "oauth")).toEqual({
      configObjectId: "cob_requirement",
      serverName: "exact-server-name",
      authType: "apikey",
      credentialMode: "shared",
      apiKey: "example-key",
    });
    expect(pluginRequirementSetupRequest(requirement({ requiredAuthType: "none" }), [], form, "oauth")).toEqual({
      configObjectId: "cob_requirement",
      serverName: "exact-server-name",
      authType: "none",
      credentialMode: "shared",
    });
    expect(pluginRequirementSetupRequest(requirement({ requiredAuthType: "oauth" }), [], form, "apikey")).toEqual({
      configObjectId: "cob_requirement",
      serverName: "exact-server-name",
      authType: "oauth",
      credentialMode: "per_member",
      oauthClient: { clientId: "old-client", clientSecret: "old-secret" },
    });
  });

  test("bound API keys use requirement configuration for repair and explicit admin rotation", () => {
    expect(pluginRequirementPolicy(boundKeyRequirement(), "needs_admin_setup", true)).toEqual({ label: "Needs admin setup", action: "configure-requirement" });
    expect(pluginRequirementPolicy(boundKeyRequirement({ connectedForMe: true }), "ready", true)).toEqual({ label: "Ready to use", action: "configure-requirement" });
    expect(pluginRequirementPolicy(boundKeyRequirement(), "needs_admin_setup", false).action).toBe("none");
    expect(pluginRequirementPolicy(boundKeyRequirement({ connectedForMe: true }), "ready", false).action).toBe("none");
    expect(pluginRequirementPolicy(boundKeyRequirement({ configObjectId: undefined }), "needs_admin_setup", true).action).toBe("none");
    expect(pluginRequirementPolicy(boundKeyRequirement({ serverName: undefined }), "needs_admin_setup", true).action).toBe("none");
    expect(pluginRequirementPolicy(boundKeyRequirement({ authType: "oauth", requiredAuthType: "oauth", connectedForMe: true }), "ready", true).action).toBe("none");
  });

  test("bound key payload targets only the exact requirement, never a URL or generic connection edit", () => {
    const form = { ...emptyLibraryMcpConnectionForm(), apiKey: " replacement-key ", useOAuthClient: true, oauthClientId: "unused-client", oauthClientSecret: "unused-secret" };
    expect(pluginRequirementSetupRequest(boundKeyRequirement(), [], form, "apikey")).toEqual({
      configObjectId: "cob_requirement", serverName: "exact-server-name", authType: "apikey", credentialMode: "shared", apiKey: "replacement-key",
    });
    expect(pluginRequirementAuth(githubRequirement({ id: "emc_pat", authType: "apikey" }), [githubPreset], "oauth")).toMatchObject({ authType: "apikey", locked: true });
    expect(() => pluginRequirementSetupRequest(boundKeyRequirement(), [], form, "oauth")).toThrow("Only the API key");
    expect(() => pluginRequirementSetupRequest(boundKeyRequirement({ requiredAuthType: "oauth" }), [], form, "apikey")).toThrow("Only the API key");
    expect(() => pluginRequirementSetupRequest(boundKeyRequirement({ authType: "oauth" }), [], form, "apikey")).toThrow("already has a connection");
    expect(() => pluginRequirementSetupRequest(boundKeyRequirement({ configObjectId: undefined }), [], form, "apikey")).toThrow("exact plugin requirement");
    expect(() => pluginRequirementSetupRequest(boundKeyRequirement({ serverName: undefined }), [], form, "apikey")).toThrow("exact plugin requirement");
    expect(() => pluginRequirementSetupRequest(boundKeyRequirement(), [], emptyLibraryMcpConnectionForm(), "apikey")).toThrow("Enter an API key");
  });

  test("does not guess auth, omit required credentials, or recreate an existing binding", () => {
    const form = emptyLibraryMcpConnectionForm();
    expect(() => pluginRequirementSetupRequest(requirement(), [], form, "")).toThrow("Choose how this server authenticates");
    expect(() => pluginRequirementSetupRequest(requirement(), [apiKeyPreset], form, "")).toThrow("Enter an API key");
    expect(() => pluginRequirementSetupRequest(requirement({ requiredAuthType: "oauth", oauthClientRequired: true }), [], form, "")).toThrow("OAuth client ID");
    expect(() => pluginRequirementSetupRequest(requirement({ id: "emc_existing" }), [], form, "oauth")).toThrow("already has a connection");
    expect(() => pluginRequirementSetupRequest(requirement({ configObjectId: undefined }), [], form, "oauth")).toThrow("exact plugin requirement");
  });
});

describe("PluginConnectionSetup", () => {
  test("delegates an existing setup ID and keeps member admin controls absent", async () => {
    const data = resolved([requirement({ id: "emc_existing", authType: "oauth", oauthClientRequired: true, oauthClientConfigured: false })]);
    const client = clientFor(data);
    const props = propsFor(client);
    const { host } = await mount(<PluginConnectionSetup {...props} />);
    await act(async () => button(host, "Configure connection").click());
    expect(props.onConfigureConnection).toHaveBeenCalledWith("emc_existing");
    expect(client.configurePluginMcpConnection).not.toHaveBeenCalled();
    const member = await mount(<PluginConnectionSetup {...propsFor(client, { canManage: false })} />);
    expect(member.host.textContent).toContain("An organization admin must configure");
    expect(member.host.querySelector("form")).toBeNull();
    expect(member.host.textContent).not.toContain("Configure connection");
    expect(member.host.textContent).not.toContain("Set up connection");
  });

  test("bound key repair dispatches the plugin API and retains the returned replacement binding", async () => {
    let data = resolved([boundKeyRequirement()]);
    const configure = mock(async () => {
      data = resolved([boundKeyRequirement({ id: "emc_replacement", connectedForMe: true })], "ready");
      return { connectionId: "emc_replacement" };
    });
    const genericEdit = mock(async () => { throw new Error("Generic connection edit must not run"); });
    const client = clientFor(data, { getLibraryPlugin: mock(async () => data.plugin), configurePluginMcpConnection: configure, updateMcpConnection: genericEdit });
    const props = propsFor(client);
    const { host } = await mount(<PluginConnectionSetup {...props} />);
    await act(async () => button(host, "Update API key").click());
    expect(host.textContent).toContain("validated before this plugin switches connections");
    expect(host.querySelector("select")).toBeNull();
    await enterApiKey(host, " replacement-key ");
    await act(async () => button(host, "Save configuration").click());
    expect(configure).toHaveBeenCalledWith("org_reference", "plg_reference", {
      configObjectId: "cob_requirement", serverName: "exact-server-name", authType: "apikey", credentialMode: "shared", apiKey: "replacement-key",
    });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(genericEdit).not.toHaveBeenCalled();
    expect(props.onConfigureConnection).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Connection readiness confirmed");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(button(host, "Update API key").disabled).toBe(false);
    await act(async () => button(host, "Update API key").click());
    await enterApiKey(host, "next-key");
    await act(async () => button(host, "Save configuration").click());
    expect(configure).toHaveBeenCalledTimes(2);
    expect(props.onChanged).toHaveBeenCalledTimes(2);
  });

  test("ready API-key rotation stays admin-only and does not broaden OAuth editing", async () => {
    for (const canManage of [false, true]) {
      const client = clientFor(resolved([boundKeyRequirement({ connectedForMe: true })], "ready"));
      const { host, unmount } = await mount(<PluginConnectionSetup {...propsFor(client, { canManage })} />);
      expect(host.textContent?.includes("Update API key")).toBe(canManage);
      expect(client.configurePluginMcpConnection).not.toHaveBeenCalled();
      await unmount();
    }
    const client = clientFor(resolved([requirement({ id: "emc_oauth", authType: "oauth", connectedForMe: true, credentialMode: "per_member" })], "ready"));
    const { host } = await mount(<PluginConnectionSetup {...propsFor(client)} />);
    expect(host.textContent).not.toContain("Update API key");
    expect(host.querySelector("form")).toBeNull();
  });

  test("an unconfirmed replacement ID cannot submit another key or report the old binding as ready", async () => {
    const client = clientFor(resolved([boundKeyRequirement({ connectedForMe: true })], "ready"));
    const props = propsFor(client);
    const { host } = await mount(<PluginConnectionSetup {...props} />);
    await act(async () => button(host, "Update API key").click());
    await enterApiKey(host, "replacement-key");
    await act(async () => button(host, "Save configuration").click());
    expect(host.textContent).toContain("Configuration saved");
    expect(host.textContent).not.toContain("Connection readiness confirmed");
    expect(button(host, "Update API key").disabled).toBe(true);
    await act(async () => button(host, "Refresh status").click());
    expect(button(host, "Update API key").disabled).toBe(true);
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
    expect(props.onConfigureConnection).not.toHaveBeenCalled();
  });

  test("an uncertain bound-key update cannot be retried through either editor", async () => {
    const client = clientFor(resolved([boundKeyRequirement()]), {
      configurePluginMcpConnection: mock(async () => { throw new Error("Response lost"); }),
    });
    const props = propsFor(client);
    const { host } = await mount(<PluginConnectionSetup {...props} />);
    await act(async () => button(host, "Update API key").click());
    await enterApiKey(host, "replacement-key");
    await act(async () => button(host, "Save configuration").click());
    expect(host.textContent).toContain("setup result is unknown");
    await act(async () => button(host, "Refresh status").click());
    expect(host.textContent).not.toContain("Update API key");
    expect(host.textContent).not.toContain("Save configuration");
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
    expect(props.onConfigureConnection).not.toHaveBeenCalled();
  });

  test("reauthentication resumes a bound-key update after a same-binding refresh", async () => {
    const data = resolved([boundKeyRequirement()]);
    const client = clientFor(data, { configurePluginMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify"); }) });
    const retries: Array<(client: DenClient) => Promise<void>> = [];
    const props = propsFor(client, { onReauthenticate: (retry) => { retries.push(retry); } });
    const { host, render } = await mount(<PluginConnectionSetup {...props} refreshKey={0} />);
    await act(async () => button(host, "Update API key").click());
    await enterApiKey(host, "replacement-key");
    await act(async () => button(host, "Save configuration").click());
    expect(retries).toHaveLength(1);
    await render(<PluginConnectionSetup {...props} refreshKey={1} />);
    const verifiedClient = clientFor(data);
    await act(async () => { await retries[0]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).toHaveBeenCalledWith("org_reference", "plg_reference", {
      configObjectId: "cob_requirement", serverName: "exact-server-name", authType: "apikey", credentialMode: "shared", apiKey: "replacement-key",
    });
    expect(verifiedClient.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
    expect(props.onConfigureConnection).not.toHaveBeenCalled();
  });

  test("a replacement binding invalidates a pending API-key verification retry", async () => {
    let data = resolved([boundKeyRequirement()]);
    const client = clientFor(data, {
      getLibraryPlugin: mock(async () => data.plugin),
      configurePluginMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify"); }),
    });
    const retries: Array<(client: DenClient) => Promise<void>> = [];
    const props = propsFor(client, { onReauthenticate: (retry) => { retries.push(retry); } });
    const { host, render } = await mount(<PluginConnectionSetup {...props} refreshKey={0} />);
    await act(async () => button(host, "Update API key").click());
    await enterApiKey(host, "replacement-key");
    await act(async () => button(host, "Save configuration").click());
    data = resolved([boundKeyRequirement({ id: "emc_changed", connectedForMe: true })], "ready");
    await render(<PluginConnectionSetup {...props} refreshKey={1} />);
    const verifiedClient = clientFor(data);
    await act(async () => { await retries[0]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).not.toHaveBeenCalled();
    await act(async () => button(host, "Cancel").click());
    expect(button(host, "Update API key").disabled).toBe(false);
  });

  test("member sign-in calls Connect with the exact ID and refreshes without configuring", async () => {
    const client = clientFor(resolved([requirement({ id: "emc_member", authType: "oauth", credentialMode: "per_member", connectedForMe: false })], "needs_signin"));
    const props = propsFor(client, { canManage: false });
    const { host } = await mount(<PluginConnectionSetup {...props} />);
    expect(host.textContent).toContain("Needs your sign-in");
    await act(async () => button(host, "Connect").click());
    expect(props.onConnect).toHaveBeenCalledWith("emc_member");
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    expect(client.configurePluginMcpConnection).not.toHaveBeenCalled();
    expect(client.getLibraryPlugin).toHaveBeenCalledTimes(2);
  });

  test("saved configuration retains its ID through stale refresh and sign-in failure", async () => {
    const client = clientFor(resolved([requirement({ requiredAuthType: "oauth" })]));
    const props = propsFor(client, { onConnect: mock(async () => { throw new Error("Consent canceled"); }) });
    const { host } = await mount(<PluginConnectionSetup {...props} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    expect(client.configurePluginMcpConnection).toHaveBeenCalledWith("org_reference", "plg_reference", {
      configObjectId: "cob_requirement",
      serverName: "exact-server-name",
      authType: "oauth",
      credentialMode: "per_member",
    });
    expect(host.textContent).toContain("Configuration saved");
    expect(host.textContent).toContain("Needs your sign-in");
    expect(host.textContent).not.toContain("Ready to use");
    await act(async () => button(host, "Connect").click());
    expect(props.onConnect).toHaveBeenCalledWith("emc_saved");
    expect(host.textContent).toContain("still configured");
    expect(host.textContent).not.toContain("Set up connection");
    expect(host.querySelector("form")).toBeNull();
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
  });

  test("uncertain setup cannot be resubmitted after a refresh returns an old missing binding", async () => {
    const client = clientFor(resolved([requirement({ requiredAuthType: "none" })]), {
      configurePluginMcpConnection: mock(async () => { throw new Error("Connection lost"); }),
    });
    const { host } = await mount(<PluginConnectionSetup {...propsFor(client)} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    expect(host.textContent).toContain("setup result is unknown");
    await act(async () => button(host, "Refresh status").click());
    expect(host.textContent).not.toContain("Save configuration");
    expect(host.textContent).not.toContain("Set up connection");
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
  });

  test("API-key inputs stay password-only and known preset auth cannot be overridden", async () => {
    const client = clientFor(resolved([requirement()]), { listMcpConnectionPresets: mock(async () => [apiKeyPreset]) });
    const { host } = await mount(<PluginConnectionSetup {...propsFor(client)} />);
    await act(async () => button(host, "Set up connection").click());
    const input = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    expect(input?.autocomplete).toBe("new-password");
    expect(host.textContent).toContain("Authentication: API key");
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector('input[type="url"]')).toBeNull();
  });

  test("GitHub's selector exposes PAT without OAuth client fields and restores member OAuth mode", async () => {
    const client = clientFor(resolved([githubRequirement()]), { listMcpConnectionPresets: mock(async () => [githubPreset]) });
    const { host } = await mount(<PluginConnectionSetup {...propsFor(client)} />);
    await act(async () => button(host, "Set up connection").click());
    const selector = host.querySelector<HTMLSelectElement>("select");
    expect([...selector?.options ?? []].map((option) => option.textContent)).toEqual(["Choose authentication", "OAuth", "Personal access token (PAT)"]);
    expect(selector?.value).toBe("oauth");
    expect(host.textContent).toContain("OAuth client ID");
    await selectAuth(host, "apikey");
    expect(host.textContent).toContain("Personal access token (PAT)");
    expect(host.textContent).not.toContain("OAuth client ID");
    expect(host.textContent).not.toContain("OAuth client secret");
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(host.querySelectorAll("select")).toHaveLength(1);
    await selectAuth(host, "oauth");
    expect(host.querySelectorAll<HTMLSelectElement>("select")[1]?.value).toBe("per_member");
    expect(host.textContent).toContain("OAuth client ID");
  });

  test("non-OAuth preset defaults normalize shared mode and do not carry it into OAuth", async () => {
    for (const authType of ["none", "apikey"] satisfies DenExternalMcpPreset["authType"][]) {
      const preset: DenExternalMcpPreset = { ...apiKeyPreset, authType, supportedAuthTypes: [authType, "oauth"] };
      const client = clientFor(resolved([requirement()]), { listMcpConnectionPresets: mock(async () => [preset]) });
      const { host, unmount } = await mount(<PluginConnectionSetup {...propsFor(client)} />);
      await act(async () => button(host, "Set up connection").click());
      expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe(authType);
      expect(pluginRequirementSetupRequest(requirement(), [preset], { ...emptyLibraryMcpConnectionForm(), apiKey: "example-key" }, "").credentialMode).toBe("shared");
      await selectAuth(host, "oauth");
      expect(host.querySelectorAll<HTMLSelectElement>("select")[1]?.value).toBe("per_member");
      await unmount();
    }
  });

  test("refreshKey refreshes completed sign-in without remounting a saved requirement", async () => {
    let data = resolved([requirement({ requiredAuthType: "oauth" })]);
    const client = clientFor(data, { getLibraryPlugin: mock(async () => data.plugin) });
    const props = propsFor(client, { onConnect: mock(() => {}) });
    const { host, render } = await mount(<PluginConnectionSetup {...props} refreshKey={0} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    await act(async () => button(host, "Connect").click());
    expect(host.textContent).toContain("Needs your sign-in");
    data = resolved([requirement({ id: "emc_saved", authType: "oauth", credentialMode: "per_member", connectedForMe: true })], "ready");
    await render(<PluginConnectionSetup {...props} refreshKey={1} />);
    expect(host.textContent).toContain("Ready to use");
    expect(host.textContent).toContain("Configuration saved");
    expect(host.textContent).toContain("Connection readiness confirmed");
    expect(host.textContent).not.toContain("use Connect to authorize");
    expect(host.textContent).not.toContain("Needs your sign-in");
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
  });

  test("refreshKey preserves pending verification and manual cancellation works when the form disappears", async () => {
    let data = resolved([requirement({ requiredAuthType: "none" })]);
    const client = clientFor(data, {
      getLibraryPlugin: mock(async () => data.plugin),
      configurePluginMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify"); }),
    });
    const retries: Array<(client: DenClient) => Promise<void>> = [];
    const props = propsFor(client, { onReauthenticate: (retry) => { retries.push(retry); } });
    const { host, render } = await mount(<PluginConnectionSetup {...props} refreshKey={0} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    await render(<PluginConnectionSetup {...props} refreshKey={1} />);
    expect(host.textContent).toContain("Waiting for identity verification");
    expect(retries).toHaveLength(1);
    data = resolved([requirement({ id: "emc_existing", authType: "oauth", oauthClientRequired: true, oauthClientConfigured: false })]);
    await render(<PluginConnectionSetup {...props} refreshKey={2} />);
    expect(host.querySelector("form")).toBeNull();
    expect(button(host, "Configure connection").disabled).toBe(true);
    await act(async () => button(host, "Cancel").click());
    expect(host.textContent).not.toContain("Waiting for identity verification");
    expect(button(host, "Configure connection").disabled).toBe(false);
    const verifiedClient = clientFor(data);
    await act(async () => { await retries[0]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).not.toHaveBeenCalled();
  });

  test("reauthentication retries with the supplied client, but not after the panel unmounts", async () => {
    const data = resolved([requirement({ requiredAuthType: "none" })]);
    const client = clientFor(data, { configurePluginMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify"); }) });
    const retries: Array<(client: DenClient) => Promise<void>> = [];
    const props = propsFor(client, { onReauthenticate: (retry) => { retries.push(retry); } });
    const { host, unmount, render } = await mount(<PluginConnectionSetup {...props} refreshKey={0} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    expect(retries).toHaveLength(1);
    await render(<PluginConnectionSetup {...props} refreshKey={1} />);
    const verifiedClient = clientFor(data);
    await act(async () => { await retries[0]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
    await unmount();
    await act(async () => { await retries[0]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
  });

  test("a canceled verification cannot submit a later setup attempt", async () => {
    const data = resolved([requirement({ requiredAuthType: "none" })]);
    const client = clientFor(data, { configurePluginMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify"); }) });
    const retries: Array<(client: DenClient) => Promise<void>> = [];
    const { host } = await mount(<PluginConnectionSetup {...propsFor(client, { onReauthenticate: (retry) => { retries.push(retry); } })} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    await act(async () => button(host, "Cancel").click());
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    expect(retries).toHaveLength(2);
    const verifiedClient = clientFor(data);
    await act(async () => { await retries[0]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).not.toHaveBeenCalled();
    await act(async () => { await retries[1]?.(verifiedClient); });
    expect(verifiedClient.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
  });

  test("refresh failure after a save cannot offer another creation", async () => {
    const data = resolved([requirement({ requiredAuthType: "oauth" })]);
    let reads = 0;
    const client = clientFor(data, {
      getLibraryPlugin: mock(async () => {
        reads += 1;
        if (reads === 2) throw new Error("Status unavailable");
        return data.plugin;
      }),
    });
    const { host } = await mount(<PluginConnectionSetup {...propsFor(client)} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    expect(host.textContent).toContain("Configuration saved");
    expect(host.textContent).toContain("Could not refresh");
    expect(host.textContent).not.toContain("Set up connection");
    await act(async () => button(host, "Refresh status").click());
    expect(button(host, "Connect").disabled).toBe(false);
    expect(client.configurePluginMcpConnection).toHaveBeenCalledTimes(1);
  });

  test("a save response after unmount cannot refresh or notify the next scope", async () => {
    const completions: Array<(result: { connectionId: string }) => void> = [];
    const client = clientFor(resolved([requirement({ requiredAuthType: "none" })]), {
      configurePluginMcpConnection: mock(() => new Promise<{ connectionId: string }>((resolve) => { completions.push(resolve); })),
    });
    const props = propsFor(client);
    const { host, unmount } = await mount(<PluginConnectionSetup {...props} />);
    await act(async () => button(host, "Set up connection").click());
    await act(async () => button(host, "Save configuration").click());
    expect(completions).toHaveLength(1);
    await unmount();
    await act(async () => completions[0]?.({ connectionId: "emc_late" }));
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(client.getLibraryPlugin).toHaveBeenCalledTimes(1);
  });
});
