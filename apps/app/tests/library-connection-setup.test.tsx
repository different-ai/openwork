import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps, type ReactNode } from "react";
import {
  createDenClient,
  DenApiError,
  type DenClient,
  type DenExternalMcpConnection,
} from "../src/app/lib/den";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const openDesktopUrl = mock(async (_url: string) => {});

function mockModules() {
  mock.module("../src/app/lib/desktop", () => ({ openDesktopUrl }));
  mock.module("@/components/ui/dialog", () => ({
    Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  }));
}
mockModules();
const { createRoot } = await import("react-dom/client");
const {
  LibraryConnectionSetup,
  libraryExternalConnectionInput,
  libraryConnectionReady,
  mergeLibraryConnections,
} = await import("../src/react-app/domains/settings/pages/library-connection-setup");

type Props = ComponentProps<typeof LibraryConnectionSetup>;
type Fields = Parameters<typeof libraryExternalConnectionInput>[0];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  openDesktopUrl.mockClear();
});
afterAll(async () => {
  mock.restore();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function connection(patch: Partial<DenExternalMcpConnection> = {}): DenExternalMcpConnection {
  return {
    id: "emc_saved",
    name: "Reference connection",
    url: "https://reference.example.test/mcp",
    authType: "oauth",
    credentialMode: "per_member",
    exposeDirectly: false,
    connected: false,
    connectedAt: null,
    connectedForMe: false,
    updatedAt: "2026-09-14T12:00:00.000Z",
    access: { orgWide: false, memberIds: ["mem_owner"], teamIds: ["team_existing"] },
    ...patch,
  };
}

function fields(patch: Partial<Fields> = {}): Fields {
  return {
    name: " Reference connection ",
    url: "https://reference.example.test/mcp",
    authType: "oauth",
    credentialMode: "per_member",
    apiKey: "",
    clientId: "",
    clientSecret: "",
    scopes: "",
    issuer: "",
    orgWide: false,
    exposeDirectly: false,
    ...patch,
  };
}

function clientWith(overrides: Partial<DenClient> = {}): DenClient {
  return {
    ...createDenClient({ baseUrl: "https://den.example.test" }),
    listMcpConnections: mock(async () => []),
    listMcpConnectionPresets: mock(async () => []),
    getLibraryAccessTargets: mock(async () => ({
      members: [
        { id: "mem_other", userId: "usr_other", name: "Other member" },
        { id: "mem_owner", userId: "usr_owner", name: "Current member" },
      ],
      teams: [],
    })),
    getMcpConnection: mock(async () => connection()),
    createMcpConnection: mock(async () => connection()),
    updateMcpConnection: mock(async () => connection()),
    startMcpConnectionConnect: mock<DenClient["startMcpConnectionConnect"]>(async () => ({ status: "connected", authorizeUrl: null })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mount(client: DenClient, overrides: Partial<Props> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChanged = mock(async () => {});
  const onClose = mock(() => {});
  const retries: Array<(client: DenClient) => Promise<void>> = [];
  const props: Props = {
    client,
    organizationId: "org_reference",
    principalId: "usr_owner",
    canManage: true,
    onChanged,
    onClose,
    onReauthenticate: (retry) => { retries.push(retry); },
    ...overrides,
  };
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  await act(async () => root.render(<LibraryConnectionSetup {...props} />));
  const button = (label: string) => {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  };
  const click = async (label: string) => { await act(async () => button(label).click()); };
  const input = (label: string) => {
    const result = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!result) throw new Error(`Missing input: ${label}`);
    return result;
  };
  const fill = async (label: string, value: string) => {
    const element = input(label);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing input setter");
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const select = async (label: string, value: string) => {
    const element = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (!element) throw new Error(`Missing select: ${label}`);
    await act(async () => {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = host.querySelector("form");
    if (!form) throw new Error("Missing connection form");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  };
  const custom = async () => {
    await click("Custom MCP");
    await fill("Name", " Reference connection ");
    await fill("Server URL", "https://reference.example.test/mcp");
  };
  return { host, button, click, input, fill, select, submit, custom, onChanged, onClose, retries, unmount };
}

describe("libraryExternalConnectionInput", () => {
  test("creates private grants with the organization member ID and requires confirmed membership", () => {
    expect(libraryExternalConnectionInput(fields(), "mem_owner")).toMatchObject({
      name: "Reference connection",
      access: { orgWide: false, memberIds: ["mem_owner"], teamIds: [] },
    });
    expect(() => libraryExternalConnectionInput(fields(), null)).toThrow("membership could not be confirmed");
    expect(libraryExternalConnectionInput(fields({ orgWide: true }), null).access)
      .toEqual({ orgWide: true, memberIds: [], teamIds: [] });
  });

  test.each([false, true])("editing preserves all grants when saved orgWide is %s and the form disagrees", (orgWide) => {
    const existing = connection({ access: { orgWide, memberIds: ["mem_existing", "mem_second"], teamIds: ["team_existing"] } });
    const original = structuredClone(existing.access);
    const input = libraryExternalConnectionInput(fields({ orgWide: !orgWide }), "mem_owner", existing);
    expect(input.access).toEqual(original);
    expect(existing.access).toEqual(original);
  });

  test.each([undefined, null])("editing refuses unavailable access grants (%s)", (access) => {
    expect(() => libraryExternalConnectionInput(fields({ orgWide: true }), "mem_owner", connection({ access })))
      .toThrow("existing access grants could not be loaded");
  });

  test("blank stored-credential replacements are omitted, not sent as empty strings", () => {
    const api = libraryExternalConnectionInput(fields({ authType: "apikey", apiKey: " \n " }), null, connection({ authType: "apikey", credentialMode: "shared" }));
    expect(api).not.toHaveProperty("apiKey");
    const oauth = libraryExternalConnectionInput(fields({ clientId: " saved-client ", clientSecret: " \n " }), null, connection());
    expect(oauth.oauthClient).toEqual({ clientId: "saved-client" });
    expect(libraryExternalConnectionInput(fields({ clientId: " ", clientSecret: "orphaned-secret" }), "mem_owner"))
      .not.toHaveProperty("oauthClient");
  });

  test.each(["", " \n "])("blank creation policy is omitted to preserve preset defaults: %j", (blank) => {
    const input = libraryExternalConnectionInput(fields({ scopes: blank, issuer: blank }), "mem_owner");
    expect(input).not.toHaveProperty("requestedScopes");
    expect(input).not.toHaveProperty("authorizationServerIssuer");
    expect(input).not.toHaveProperty("oauthClient");
  });

  test("unchanged OAuth policy and auto-registered client metadata are not resubmitted on edit", () => {
    const existing = connection({
      oauthClientId: "auto-registered-client", requestedScopes: ["read", "write"],
      authorizationServerIssuer: "https://issuer.example.test",
    });
    const input = libraryExternalConnectionInput(fields({
      clientId: " auto-registered-client ", clientSecret: " \n ", scopes: "read write", issuer: existing.authorizationServerIssuer!,
    }), null, existing);
    expect(input).not.toHaveProperty("oauthClient");
    expect(input).not.toHaveProperty("requestedScopes");
    expect(input).not.toHaveProperty("authorizationServerIssuer");
    expect(input.access).toEqual(existing.access);
  });

  test("editing can explicitly clear unmanaged policy without resubmitting unchanged client metadata", () => {
    const existing = connection({
      oauthClientId: "auto-registered-client", requestedScopes: ["read"],
      authorizationServerIssuer: "https://issuer.example.test",
    });
    const input = libraryExternalConnectionInput(fields({ clientId: "auto-registered-client" }), null, existing);
    expect(input.requestedScopes).toEqual([]);
    expect(input.authorizationServerIssuer).toBeNull();
    expect(input).not.toHaveProperty("oauthClient");
    expect(input.access).toEqual(existing.access);
  });

  test("replacing a secret includes its unchanged client ID but omits unchanged policy", () => {
    const existing = connection({ oauthClientId: "saved-client" });
    const input = libraryExternalConnectionInput(fields({ clientId: " saved-client ", clientSecret: " replacement " }), null, existing);
    expect(input.oauthClient).toEqual({ clientId: "saved-client", clientSecret: "replacement" });
    expect(input).not.toHaveProperty("requestedScopes");
    expect(input).not.toHaveProperty("authorizationServerIssuer");
  });

  test.each(["apikey", "none"] satisfies Fields["authType"][])("switching to %s never sends stale OAuth fields", (authType) => {
    expect(libraryExternalConnectionInput(fields({
      authType, apiKey: " fixture-key ", clientId: "old-client", clientSecret: "old-secret",
      scopes: "old.scope", issuer: "https://old.example.test", exposeDirectly: true,
    }), "mem_owner")).toEqual({
      name: "Reference connection", url: "https://reference.example.test/mcp", authType,
      credentialMode: "shared", exposeDirectly: true,
      access: { orgWide: false, memberIds: ["mem_owner"], teamIds: [] },
      ...(authType === "apikey" ? { apiKey: "fixture-key" } : {}),
    });
  });

  test("switching to OAuth omits a stale API key and normalizes OAuth-only fields", () => {
    const input = libraryExternalConnectionInput(fields({
      apiKey: "old-key", clientId: " client ", clientSecret: " secret ",
      scopes: " read\n write  ", issuer: " https://issuer.example.test ",
    }), "mem_owner");
    expect(input).not.toHaveProperty("apiKey");
    expect(input.oauthClient).toEqual({ clientId: "client", clientSecret: "secret" });
    expect(input.requestedScopes).toEqual(["read", "write"]);
    expect(input.authorizationServerIssuer).toBe("https://issuer.example.test");
  });

  test.each([
    { url: "https://other.example.test/mcp" },
    { authType: "apikey" },
    { credentialMode: "shared" },
  ] satisfies Partial<Fields>[])("plugin-managed identity rejects changes: %j", (patch) => {
    const existing = connection({ identityManagedBy: [{ pluginId: "plg_owner", name: "Reference plugin" }] });
    expect(() => libraryExternalConnectionInput(fields(patch), "mem_owner", existing))
      .toThrow("plugin manages the connection identity");
  });

  test.each([
    { scopes: "plugin.read", issuer: "https://plugin.example.test" },
    { scopes: "", issuer: "" },
    { scopes: "different.scope", issuer: "https://other.example.test" },
  ])("plugin-managed credentials preserve grants and always omit issuer and scopes: %j", (policy) => {
    const existing = connection({
      identityManagedBy: [{ pluginId: "plg_owner", name: "Reference plugin" }],
      requestedScopes: ["plugin.read"], authorizationServerIssuer: "https://plugin.example.test",
    });
    const input = libraryExternalConnectionInput(fields({ clientId: "new-client", clientSecret: "replacement", ...policy }), null, existing);
    expect(input).toMatchObject({
      url: existing.url, authType: existing.authType, credentialMode: existing.credentialMode,
      access: existing.access, oauthClient: { clientId: "new-client", clientSecret: "replacement" },
    });
    expect(input).not.toHaveProperty("authorizationServerIssuer");
    expect(input).not.toHaveProperty("requestedScopes");
  });
});

test("plugin-owned API keys must use the plugin requirement configuration route", () => {
  expect(() => libraryExternalConnectionInput(fields({ authType: "apikey", credentialMode: "shared", apiKey: "replacement" }), null,
    connection({ authType: "apikey", credentialMode: "shared", identityManagedBy: [{ pluginId: "plg_owner", name: "Plugin" }] })))
    .toThrow("owning plugin's Connections section");
});

describe("libraryConnectionReady", () => {
  test("shared readiness uses connected while per-member readiness uses connectedForMe", () => {
    expect(libraryConnectionReady(connection({ credentialMode: "shared", connected: true, connectedForMe: false }))).toBe(true);
    expect(libraryConnectionReady(connection({ credentialMode: "shared", connected: false, connectedForMe: true }))).toBe(false);
    expect(libraryConnectionReady(connection({ connected: false, connectedForMe: true }))).toBe(true);
    expect(libraryConnectionReady(connection({ connected: true, connectedForMe: false }))).toBe(false);
  });

  test.each([
    { setupRequired: true },
    { needsReconnect: true },
    { needsReconnect: false, missingFeatures: ["required.scope"] },
  ] satisfies Partial<DenExternalMcpConnection>[])("setup and reconnect requirements override both connected flags: %j", (patch) => {
    for (const credentialMode of ["shared", "per_member"] satisfies DenExternalMcpConnection["credentialMode"][]) {
      expect(libraryConnectionReady(connection({ credentialMode, connected: true, connectedForMe: true, ...patch }))).toBe(false);
    }
    expect(libraryConnectionReady(connection({ connectedForMe: true, setupRequired: false, needsReconnect: false, missingFeatures: [] }))).toBe(true);
  });
});

describe("mergeLibraryConnections", () => {
  test.each(["google-workspace", "microsoft-365"])("retains the usable native alias %s absent from manageable", (id) => {
    const native = connection({ id, nativeProviderKey: id, connectedForMe: true, access: undefined });
    const adminOnly = connection({ id: "emc_admin_only", credentialMode: "shared", setupRequired: true });
    const manageable = [adminOnly];
    const usable = [native];
    expect(mergeLibraryConnections(manageable, usable)).toEqual([adminOnly, native]);
    expect(mergeLibraryConnections([], usable)).toEqual([native]);
    expect(manageable).toEqual([adminOnly]);
    expect(usable).toEqual([native]);
  });

  test.each([false, true])("usable missing features override managed readiness while preserving orgWide=%s and all grants", (orgWide) => {
    const managed = connection({
      connected: true, connectedForMe: true, needsReconnect: false, missingFeatures: [],
      access: { orgWide, memberIds: ["mem_existing", "mem_second"], teamIds: ["team_existing"] },
    });
    const usable = connection({
      connected: true, connectedForMe: true, needsReconnect: false, missingFeatures: ["required.scope"],
      access: { orgWide: !orgWide, memberIds: ["mem_owner"], teamIds: [] },
    });
    const before = structuredClone({ managed, usable });
    expect(libraryConnectionReady(managed)).toBe(true);
    const merged = mergeLibraryConnections([managed], [usable]);
    expect(merged).toHaveLength(1);
    const result = merged[0];
    if (!result) throw new Error("Missing merged connection");
    expect(result.missingFeatures).toEqual(["required.scope"]);
    expect(libraryConnectionReady(result)).toBe(false);
    expect(result.access).toEqual(managed.access);
    expect(libraryExternalConnectionInput(fields({ orgWide: !orgWide }), "mem_owner", result).access).toEqual(managed.access);
    expect({ managed, usable }).toEqual(before);
  });
});

describe("LibraryConnectionSetup", () => {
  test("creates once with the matched member ID and keeps the saved ID after refresh fails", async () => {
    const pending = deferred<DenExternalMcpConnection>();
    const saved = connection();
    const list = mock(async () => [connection({ id: "emc_decoy", name: "Other connection" }), saved]);
    list.mockImplementationOnce(async () => []);
    list.mockImplementationOnce(async () => []);
    list.mockImplementationOnce(async () => []);
    list.mockImplementationOnce(async () => { throw new Error("Status unavailable"); });
    const client = clientWith({ listMcpConnections: list, createMcpConnection: mock(() => pending.promise) });
    const view = await mount(client);
    expect(list.mock.calls).toEqual([["org_reference", "usable"], ["org_reference", "manageable"]]);
    await view.custom();
    await view.submit();
    await view.submit();
    expect(client.createMcpConnection).toHaveBeenCalledTimes(1);
    expect(client.getLibraryAccessTargets).toHaveBeenCalledWith("org_reference");
    expect(client.createMcpConnection).toHaveBeenCalledWith("org_reference", {
      name: "Reference connection", url: saved.url, authType: "oauth", credentialMode: "per_member",
      exposeDirectly: false, access: { orgWide: false, memberIds: ["mem_owner"], teamIds: [] },
    });
    await act(async () => pending.resolve(saved));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Configuration was saved");
    expect(view.host.querySelector("form")).toBeNull();
    expect(view.host.textContent).not.toContain("Ready to use");
    expect(view.onChanged).not.toHaveBeenCalled();
    await view.click("Refresh status");
    expect(list.mock.calls).toEqual([
      ["org_reference", "usable"], ["org_reference", "manageable"],
      ["org_reference", "usable"], ["org_reference", "manageable"],
      ["org_reference", "usable"], ["org_reference", "manageable"],
    ]);
    expect(view.host.querySelector("h3")?.textContent).toBe(saved.name);
    await view.click("Configure connection");
    expect(client.getMcpConnection).toHaveBeenCalledWith("org_reference", saved.id);
    expect(client.createMcpConnection).toHaveBeenCalledTimes(1);
    expect(client.startMcpConnectionConnect).not.toHaveBeenCalled();
    expect(openDesktopUrl).not.toHaveBeenCalled();
  });

  test.each(["google-workspace", "microsoft-365"])("the admin catalog retains usable native alias %s when manageable omits it", async (id) => {
    const native = connection({ id, name: `Existing ${id}`, nativeProviderKey: id, connectedForMe: true });
    const adminOnly = connection({ id: "emc_admin_only", name: "Admin-only connection", credentialMode: "shared", setupRequired: true });
    const list = mock<DenClient["listMcpConnections"]>(async (_orgId, scope) => scope === "usable" ? [native] : [adminOnly]);
    const view = await mount(clientWith({ listMcpConnections: list }));
    expect(list.mock.calls).toEqual([["org_reference", "usable"], ["org_reference", "manageable"]]);
    expect(view.button(`${adminOnly.name}Needs admin setup`)).toBeDefined();
    await view.click(`${native.name}Ready to use`);
    expect(view.host.querySelector("h3")?.textContent).toBe(native.name);
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Ready to use");
    await view.click("Refresh status");
    expect(list).toHaveBeenCalledTimes(4);
    expect(view.host.querySelector("h3")?.textContent).toBe(native.name);
    expect(view.button("Configure connection").disabled).toBe(false);
  });

  test("admin status uses member missing features rather than the manageable ready flag", async () => {
    const managed = connection({ connected: true, connectedForMe: true, missingFeatures: [], needsReconnect: false });
    const usable = connection({ connected: true, connectedForMe: true, missingFeatures: ["required.scope"], needsReconnect: false, access: undefined });
    const list = mock<DenClient["listMcpConnections"]>(async (_orgId, scope) => scope === "usable" ? [usable] : [managed]);
    const view = await mount(clientWith({ listMcpConnections: list }), { connectionId: managed.id });
    expect(view.host.querySelector("h3")?.textContent).toBe(managed.name);
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("sign-in is still required");
    expect(view.host.textContent).not.toContain("Ready to use");
    expect(view.button("Connect account").disabled).toBe(false);
    expect(list.mock.calls).toEqual([["org_reference", "usable"], ["org_reference", "manageable"]]);
  });

  test("creation waits for membership rather than falling back to the principal user ID", async () => {
    const targets = deferred<Awaited<ReturnType<DenClient["getLibraryAccessTargets"]>>>();
    const client = clientWith({ getLibraryAccessTargets: mock(() => targets.promise) });
    const view = await mount(client);
    await view.custom();
    expect(view.button("Save connection").disabled).toBe(true);
    await view.submit();
    expect(client.createMcpConnection).not.toHaveBeenCalled();
    await act(async () => targets.resolve({ members: [{ id: "mem_other", userId: "usr_other", name: "Other member" }], teams: [] }));
    expect(view.button("Save connection").disabled).toBe(true);
    await view.submit();
    expect(client.createMcpConnection).not.toHaveBeenCalled();
  });

  test("members see only available connections and never administrator setup buttons", async () => {
    const available = connection({ setupRequired: true, connected: true, connectedForMe: true });
    const client = clientWith({ listMcpConnections: mock(async () => [available]) });
    const view = await mount(client, { canManage: false });
    expect(client.listMcpConnections).toHaveBeenCalledTimes(1);
    expect(client.listMcpConnections).toHaveBeenCalledWith("org_reference", "usable");
    expect(client.listMcpConnections).not.toHaveBeenCalledWith("org_reference", "manageable");
    expect(client.listMcpConnectionPresets).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("Available connections");
    expect(view.host.textContent).not.toContain("Ready to use");
    for (const label of ["Custom MCP", "Google Workspace", "Microsoft 365", "Configure connection", "Save connection"]) {
      expect(view.host.textContent).not.toContain(label);
    }
    await view.click(`${available.name}Needs admin setup`);
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Needs admin setup");
    expect(view.host.textContent).not.toContain("Configure connection");
    expect(view.host.textContent).not.toContain("Connect account");
    expect(view.host.querySelector("form")).toBeNull();
    expect(client.getMcpConnection).not.toHaveBeenCalled();
    expect(client.createMcpConnection).not.toHaveBeenCalled();
    expect(client.updateMcpConnection).not.toHaveBeenCalled();
  });

  test("editing preserves member, team, and organization grants and omits a blank API key replacement", async () => {
    const existing = connection({ authType: "apikey", credentialMode: "shared", access: { orgWide: true, memberIds: ["mem_existing"], teamIds: ["team_existing"] } });
    const client = clientWith({ listMcpConnections: mock(async () => [existing]), getMcpConnection: mock(async () => existing) });
    const view = await mount(client, { connectionId: existing.id });
    await view.click("Configure connection");
    expect(view.input("API key").type).toBe("password");
    expect(view.input("API key").value).toBe("");
    expect(view.host.textContent).not.toContain("Share with everyone");
    await view.fill("Name", " Renamed connection ");
    await view.submit();
    expect(client.updateMcpConnection).toHaveBeenCalledWith("org_reference", existing.id, {
      name: "Renamed connection", url: existing.url, authType: "apikey", credentialMode: "shared",
      exposeDirectly: false, access: existing.access, expectedUpdatedAt: existing.updatedAt,
    });
    expect(client.getLibraryAccessTargets).not.toHaveBeenCalled();
    expect(client.createMcpConnection).not.toHaveBeenCalled();
    expect(view.onChanged).toHaveBeenCalledTimes(1);
  });

  test("renaming an auto-registered OAuth connection does not resubmit client metadata or unchanged policy", async () => {
    const existing = connection({
      oauthClientId: "auto-registered-client", requestedScopes: ["read", "write"],
      authorizationServerIssuer: "https://issuer.example.test",
      access: { orgWide: true, memberIds: ["mem_existing"], teamIds: ["team_existing"] },
    });
    const update = mock<DenClient["updateMcpConnection"]>(async () => existing);
    const client = clientWith({
      listMcpConnections: mock(async () => [existing]), getMcpConnection: mock(async () => existing),
      updateMcpConnection: update,
    });
    const view = await mount(client, { connectionId: existing.id });
    await view.click("Configure connection");
    expect(view.input("OAuth client ID").value).toBe("auto-registered-client");
    expect(view.input("OAuth client secret").value).toBe("");
    await view.fill("Name", "Renamed connection");
    await view.submit();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("org_reference", existing.id, {
      name: "Renamed connection", url: existing.url, authType: "oauth", credentialMode: "per_member",
      exposeDirectly: false, access: existing.access, expectedUpdatedAt: existing.updatedAt,
    });
    const input = update.mock.calls[0]?.[2];
    expect(input).not.toHaveProperty("oauthClient");
    expect(input).not.toHaveProperty("authorizationServerIssuer");
    expect(input).not.toHaveProperty("requestedScopes");
    expect(client.createMcpConnection).not.toHaveBeenCalled();
    expect(view.onChanged).toHaveBeenCalledTimes(1);
  });

  test("switching authentication in the form does not leak hidden credential fields", async () => {
    const client = clientWith();
    const view = await mount(client);
    await view.custom();
    await view.fill("OAuth client ID", "old-client");
    await view.fill("OAuth client secret", "old-secret");
    await view.select("Authentication", "apikey");
    await view.fill("API key", "old-key");
    await view.select("Authentication", "none");
    expect(view.host.querySelector('input[type="password"]')).toBeNull();
    await view.submit();
    expect(client.createMcpConnection).toHaveBeenCalledWith("org_reference", {
      name: "Reference connection", url: "https://reference.example.test/mcp", authType: "none",
      credentialMode: "shared", exposeDirectly: false,
      access: { orgWide: false, memberIds: ["mem_owner"], teamIds: [] },
    });
  });

  test("plugin-managed identity fields are locked while credential inputs remain editable", async () => {
    const existing = connection({
      identityManagedBy: [{ pluginId: "plg_owner", name: "Reference plugin" }],
      requestedScopes: ["plugin.read"], authorizationServerIssuer: "https://plugin.example.test",
    });
    const update = mock<DenClient["updateMcpConnection"]>(async () => existing);
    const client = clientWith({
      listMcpConnections: mock(async () => [existing]), getMcpConnection: mock(async () => existing),
      updateMcpConnection: update,
    });
    const view = await mount(client, { connectionId: existing.id });
    await view.click("Configure connection");
    expect(view.input("Server URL").readOnly).toBe(true);
    expect(view.host.querySelector<HTMLSelectElement>('select[aria-label="Authentication"]')?.disabled).toBe(true);
    expect(view.host.querySelector<HTMLSelectElement>('select[aria-label="Account access"]')?.disabled).toBe(true);
    expect(view.input("OAuth client secret").readOnly).toBe(false);
    await view.fill("OAuth client ID", "replacement-client");
    await view.fill("OAuth client secret", "replacement-secret");
    await view.submit();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("org_reference", existing.id, {
      name: existing.name, url: existing.url, authType: existing.authType, credentialMode: existing.credentialMode,
      exposeDirectly: false, access: existing.access, expectedUpdatedAt: existing.updatedAt,
      oauthClient: { clientId: "replacement-client", clientSecret: "replacement-secret" },
    });
    const input = update.mock.calls[0]?.[2];
    expect(input).not.toHaveProperty("authorizationServerIssuer");
    expect(input).not.toHaveProperty("requestedScopes");
  });

  test("a create response after unmount cannot refresh or notify completion", async () => {
    const pending = deferred<DenExternalMcpConnection>();
    const client = clientWith({ createMcpConnection: mock(() => pending.promise) });
    const view = await mount(client);
    await view.custom();
    await view.submit();
    expect(client.createMcpConnection).toHaveBeenCalledTimes(1);
    await view.unmount();
    await act(async () => pending.resolve(connection()));
    expect(client.listMcpConnections).toHaveBeenCalledTimes(2);
    expect(view.onChanged).not.toHaveBeenCalled();
    expect(openDesktopUrl).not.toHaveBeenCalled();
  });

  test("reauthentication retries once with the verified client and retained fields", async () => {
    const stale = clientWith({ createMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify identity"); }) });
    const verified = clientWith();
    const view = await mount(stale);
    await view.custom();
    await view.fill("OAuth client ID", "client");
    await view.fill("OAuth client secret", "fixture-secret");
    await view.submit();
    expect(view.retries).toHaveLength(1);
    expect(view.onChanged).not.toHaveBeenCalled();
    expect(view.input("OAuth client secret").value).toBe("fixture-secret");
    const retry = view.retries[0];
    if (!retry) throw new Error("Missing reauthentication retry");
    await act(async () => { await Promise.all([retry(verified), retry(verified)]); });
    await act(async () => retry(verified));
    expect(stale.createMcpConnection).toHaveBeenCalledTimes(1);
    expect(verified.createMcpConnection).toHaveBeenCalledTimes(1);
    expect(verified.createMcpConnection).toHaveBeenCalledWith("org_reference", expect.objectContaining({
      oauthClient: { clientId: "client", clientSecret: "fixture-secret" },
      access: { orgWide: false, memberIds: ["mem_owner"], teamIds: [] },
    }));
    expect(verified.listMcpConnections).toHaveBeenCalledTimes(2);
    expect(verified.listMcpConnections).toHaveBeenNthCalledWith(1, "org_reference", "usable");
    expect(verified.listMcpConnections).toHaveBeenNthCalledWith(2, "org_reference", "manageable");
    expect(view.onChanged).toHaveBeenCalledTimes(1);
  });

  test("reauthentication callbacks cannot save after canceling the form or unmounting", async () => {
    const stale = clientWith({ createMcpConnection: mock(async () => { throw new DenApiError(403, "reauth", "Verify identity"); }) });
    const verified = clientWith();
    const view = await mount(stale);
    await view.custom();
    await view.submit();
    const canceledRetry = view.retries[0];
    if (!canceledRetry) throw new Error("Missing canceled retry");
    await view.click("Cancel");
    await view.custom();
    await act(async () => canceledRetry(verified));
    expect(verified.createMcpConnection).not.toHaveBeenCalled();
    await view.unmount();
    const abandoned = await mount(stale);
    await abandoned.custom();
    await abandoned.submit();
    const abandonedRetry = abandoned.retries[0];
    if (!abandonedRetry) throw new Error("Missing abandoned retry");
    await abandoned.unmount();
    await act(async () => abandonedRetry(verified));
    expect(verified.createMcpConnection).not.toHaveBeenCalled();
    expect(abandoned.onChanged).not.toHaveBeenCalled();
  });

  test.each([new Error("Connection lost"), new DenApiError(503, "unavailable", "Unavailable")])("an uncertain save cannot be submitted twice: %s", async (cause) => {
    const client = clientWith({ createMcpConnection: mock(async () => { throw cause; }) });
    const view = await mount(client);
    await view.custom();
    await view.submit();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("save result is unknown");
    expect(view.button("Save connection").disabled).toBe(true);
    await view.submit();
    expect(client.createMcpConnection).toHaveBeenCalledTimes(1);
    expect(view.onChanged).not.toHaveBeenCalled();
  });

  test("reconnect-required member accounts are not falsely ready and authorize the selected ID", async () => {
    const stale = connection({ connected: true, connectedForMe: true, needsReconnect: true });
    const ready = connection({ connected: true, connectedForMe: true, needsReconnect: false });
    const list = mock(async () => [ready]);
    list.mockImplementationOnce(async () => [stale]);
    list.mockImplementationOnce(async () => [stale]);
    const client = clientWith({ listMcpConnections: list });
    const view = await mount(client, { connectionId: stale.id, canManage: false });
    expect(view.host.querySelector('[role="status"]')?.textContent).not.toBe("Ready to use");
    await view.click("Connect account");
    expect(client.startMcpConnectionConnect).toHaveBeenCalledWith("org_reference", stale.id);
    expect(client.startMcpConnectionConnect).toHaveBeenCalledTimes(1);
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe("Ready to use");
    expect(view.onChanged).toHaveBeenCalledTimes(1);
    expect(client.updateMcpConnection).not.toHaveBeenCalled();
    expect(openDesktopUrl).not.toHaveBeenCalled();
  });
});
