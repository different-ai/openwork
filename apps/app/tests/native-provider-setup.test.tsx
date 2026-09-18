import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { MICROSOFT_365_FEATURES } from "@openwork/types/den/microsoft-365";

import { createDenClient, DenApiError, type DenClient, type DenExternalMcpConnection } from "../src/app/lib/den";
import type { NativeProviderSetupProps } from "../src/react-app/domains/settings/pages/native-provider-setup";
import {
  nativeProviderClientPayload,
  nativeProviderDefaultFeatures,
  nativeProviderPermissions,
  selectNativeProviderFeatures,
} from "../src/react-app/domains/settings/pages/native-provider-setup-fields";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { NativeProviderSetup } = await import("../src/react-app/domains/settings/pages/native-provider-setup");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

type Metadata = Awaited<ReturnType<DenClient["getNativeProviderClient"]>>;
const metadata: Metadata = {
  providerId: "google-workspace",
  configured: true,
  clientId: "saved-client",
  tenantId: null,
  features: ["gmailDraft"],
  scopes: ["openid", "https://www.googleapis.com/auth/gmail.compose"],
  redirectUri: "https://den.example.test/api/callback/from-server",
};
const connection: DenExternalMcpConnection = {
  id: "mcp_named_google",
  name: "Google Workspace",
  url: "https://workspace.google.com",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: false,
  connectedAt: null,
  connectedForMe: false,
  nativeProviderKey: "google-workspace",
};

function clientWith(overrides: Partial<DenClient> = {}, config: Metadata = metadata): DenClient {
  return {
    ...createDenClient({ baseUrl: "https://den.example.test" }),
    getNativeProviderClient: mock(async () => config),
    saveNativeProviderClient: mock(async () => {}),
    createNativeProviderConnection: mock(async () => connection),
    ...overrides,
  };
}

async function mount(client: DenClient, overrides: Partial<NativeProviderSetupProps> = {}, strict = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSaved = mock((id: string) => {});
  const onCancel = mock(() => {});
  const retries: ((client: DenClient) => Promise<void>)[] = [];
  const props: NativeProviderSetupProps = {
    providerKey: "google-workspace",
    organizationId: "org_setup",
    client,
    onSaved,
    onCancel,
    onReauthenticate: (retry) => { retries.push(retry); },
    ...overrides,
  };
  await act(async () => root.render(strict
    ? <StrictMode><NativeProviderSetup {...props} /></StrictMode>
    : <NativeProviderSetup {...props} />));
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  const input = (label: string) => {
    const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!element) throw new Error(`Missing input: ${label}`);
    return element;
  };
  const fill = async (label: string, value: string) => {
    const element = input(label);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Input setter unavailable");
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = host.querySelector("form");
    if (!form) throw new Error("Missing setup form");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  };
  const feature = (key: string) => {
    const element = host.querySelector<HTMLInputElement>(`input[data-feature="${key}"]`);
    if (!element) throw new Error(`Missing feature: ${key}`);
    return element;
  };
  return { host, input, fill, submit, feature, retries, onSaved, onCancel, unmount };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("native provider payloads", () => {
  test("omits empty credentials and keeps explicit empty feature selection", () => {
    expect(nativeProviderClientPayload("google-workspace", {
      clientId: " ", clientSecret: "\n", tenantId: "not-google", features: [],
    })).toEqual({ features: [] });
    expect(nativeProviderClientPayload("microsoft-365", {
      clientId: " app ", clientSecret: " ", tenantId: " tenant ", features: ["mailDraft"],
    })).toEqual({ clientId: "app", tenantId: "tenant", features: ["mailDraft"] });
    expect(nativeProviderClientPayload("google-workspace", {
      clientId: " app ", clientSecret: " replacement ", tenantId: "not-google", features: ["gmailDraft"],
    })).toEqual({ clientId: "app", clientSecret: "replacement", features: ["gmailDraft"] });
  });

  test("mirrors defaults and never derives send or broader features from shared scopes", () => {
    expect(nativeProviderDefaultFeatures("google-workspace")).toEqual(["calendarRead", "gmailDraft", "driveFile"]);
    expect(nativeProviderDefaultFeatures("microsoft-365")).toEqual(["mailRead", "calendarRead", "filesRead"]);
    expect(selectNativeProviderFeatures("google-workspace", ["gmailDraft", "gmailDraft", "mailSend", "unknown"]))
      .toEqual(["gmailDraft"]);
    expect(selectNativeProviderFeatures("microsoft-365", ["mailDraft", "gmailSend"])).toEqual(["mailDraft"]);
    expect(selectNativeProviderFeatures("google-workspace", [])).toEqual([]);
    const google = nativeProviderPermissions("google-workspace").flatMap((group) => group.permissions);
    expect(google.find((permission) => permission.key === "gmailDraft")?.scope).toBe("gmail.compose");
    expect(google.find((permission) => permission.key === "gmailSend")?.scope).toBe("gmail.compose");
    expect(google.map((permission) => permission.key).sort()).toEqual([
      "calendarRead", "calendarWrite", "gmailDraft", "gmailSend", "gmailRead", "gmailManage", "gmailLabels",
      "sheetsRead", "sheetsWrite", "driveFile", "driveRead", "driveFull", "chat",
    ].sort());
    const microsoft = nativeProviderPermissions("microsoft-365").flatMap((group) => group.permissions);
    expect(microsoft.map((permission) => permission.key).sort()).toEqual([...MICROSOFT_365_FEATURES].sort());
  });
});

describe("NativeProviderSetup", () => {
  test("creates a named Google connection, using server redirect metadata but not legacy credentials or features", async () => {
    const client = clientWith();
    const view = await mount(client);
    expect(client.getNativeProviderClient).toHaveBeenCalledWith("org_setup", "google-workspace");
    expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    expect(view.input("Redirect URI").value).toBe(metadata.redirectUri);
    expect(view.input("Redirect URI").readOnly).toBe(true);
    expect(view.input("Client ID").value).toBe("");
    expect(view.input("Client secret").type).toBe("password");
    expect(view.feature("calendarRead").checked).toBe(true);
    expect(view.feature("gmailSend").checked).toBe(false);
    expect(view.host.textContent).toContain("Saving settings does not connect anyone's account");
    expect(view.host.textContent).toContain("available to everyone in your organization");
    await view.submit();
    expect(client.createNativeProviderConnection).not.toHaveBeenCalled();
    await view.fill("Name", "  Team mail  ");
    await view.fill("Client ID", " client ");
    await view.fill("Client secret", " fixture-secret ");
    await view.submit();
    expect(client.createNativeProviderConnection).toHaveBeenCalledWith("org_setup", {
      nativeProviderKey: "google-workspace", name: "Team mail",
      oauthClient: { clientId: "client", clientSecret: "fixture-secret", features: ["calendarRead", "gmailDraft", "driveFile"] },
    });
    expect(client.saveNativeProviderClient).not.toHaveBeenCalled();
    expect(view.onSaved).toHaveBeenCalledWith("mcp_named_google");
    expect(view.input("Client secret").value).toBe("");
    expect(view.host.textContent).toContain("Settings saved. Your account is not connected");
    await view.submit();
    expect(client.createNativeProviderConnection).toHaveBeenCalledTimes(1);
  });

  test.each([
    { providerKey: "google-workspace", connectionId: "mcp_selected_google" },
    { providerKey: "google-workspace", connectionId: "google-workspace" },
    { providerKey: "microsoft-365", connectionId: "mcp_selected_microsoft" },
    { providerKey: "microsoft-365", connectionId: "microsoft-365" },
  ] satisfies Pick<NativeProviderSetupProps, "providerKey" | "connectionId">[])("edits only the selected $connectionId without replacing its secret or adding features", async ({ providerKey, connectionId }) => {
    const client = clientWith({}, { ...metadata, providerId: connectionId, features: [], tenantId: providerKey === "microsoft-365" ? "saved-tenant" : null });
    const view = await mount(client, { providerKey, connectionId });
    expect(client.getNativeProviderClient).toHaveBeenCalledWith("org_setup", connectionId);
    expect(view.host.querySelector('input[aria-label="Name"]')).toBeNull();
    expect(view.input("Client ID").value).toBe("saved-client");
    expect(view.input("Client secret").value).toBe("");
    expect(view.input("Client secret").required).toBe(false);
    expect(view.host.querySelectorAll('input[type="checkbox"]:checked').length).toBe(0);
    await view.submit();
    expect(client.saveNativeProviderClient).toHaveBeenCalledWith("org_setup", connectionId, {
      clientId: "saved-client", features: [], ...(providerKey === "microsoft-365" ? { tenantId: "saved-tenant" } : {}),
    });
    expect(client.createNativeProviderConnection).not.toHaveBeenCalled();
    expect(view.onSaved).toHaveBeenCalledWith(connectionId);
  });

  test("sets up Microsoft through its alias and requires tenant and secret for unconfigured credentials", async () => {
    const client = clientWith({}, { ...metadata, providerId: "microsoft-365", configured: false, clientId: null, features: nativeProviderDefaultFeatures("microsoft-365") });
    const view = await mount(client, { providerKey: "microsoft-365" });
    await view.fill("Client ID", "entra-app");
    await view.fill("Client secret", "entra-secret");
    await view.submit();
    expect(client.saveNativeProviderClient).not.toHaveBeenCalled();
    await view.fill("Directory (tenant) ID", "tenant");
    await view.submit();
    expect(client.saveNativeProviderClient).toHaveBeenCalledWith("org_setup", "microsoft-365", {
      clientId: "entra-app", clientSecret: "entra-secret", tenantId: "tenant", features: ["mailRead", "calendarRead", "filesRead"],
    });
    expect(client.createNativeProviderConnection).not.toHaveBeenCalled();
    expect(view.onSaved).toHaveBeenCalledWith("microsoft-365");
  });

  test("selecting draft does not select send, and deselecting every feature saves an empty list", async () => {
    const client = clientWith({}, { ...metadata, features: [] });
    const view = await mount(client, { connectionId: "google-workspace" });
    await act(async () => view.feature("gmailDraft").click());
    expect(view.feature("gmailDraft").checked).toBe(true);
    expect(view.feature("gmailSend").checked).toBe(false);
    await act(async () => view.feature("gmailDraft").click());
    await view.submit();
    expect(client.saveNativeProviderClient).toHaveBeenCalledWith("org_setup", "google-workspace", { clientId: "saved-client", features: [] });
  });

  test("reauth retries the captured create exactly once with the verified client and kept fields", async () => {
    const stale = clientWith({ createNativeProviderConnection: mock(async () => { throw new DenApiError(403, "reauth", "Confirm identity"); }) });
    const verified = clientWith();
    const view = await mount(stale);
    await view.fill("Name", "Team mail");
    await view.fill("Client ID", "client");
    await view.fill("Client secret", "fixture-secret");
    await view.submit();
    expect(view.retries).toHaveLength(1);
    expect(view.input("Client secret").value).toBe("fixture-secret");
    expect(view.onSaved).not.toHaveBeenCalled();
    const retry = view.retries[0];
    if (!retry) throw new Error("Expected reauthentication retry");
    await act(async () => { await Promise.all([retry(verified), retry(verified)]); });
    expect(stale.createNativeProviderConnection).toHaveBeenCalledTimes(1);
    expect(verified.createNativeProviderConnection).toHaveBeenCalledTimes(1);
    expect(verified.createNativeProviderConnection).toHaveBeenCalledWith("org_setup", {
      nativeProviderKey: "google-workspace", name: "Team mail",
      oauthClient: { clientId: "client", clientSecret: "fixture-secret", features: ["calendarRead", "gmailDraft", "driveFile"] },
    });
    expect(view.onSaved).toHaveBeenCalledTimes(1);
  });

  test("editing after a reauth request invalidates its old payload", async () => {
    const stale = clientWith({ saveNativeProviderClient: mock(async () => { throw new DenApiError(403, "reauth", "Confirm identity"); }) });
    const verified = clientWith();
    const view = await mount(stale, { connectionId: "mcp_selected_google" });
    await view.submit();
    const retry = view.retries[0];
    if (!retry) throw new Error("Expected reauthentication retry");
    await view.fill("Client ID", "changed-client");
    await act(async () => retry(verified));
    expect(verified.saveNativeProviderClient).not.toHaveBeenCalled();
    expect(view.onSaved).not.toHaveBeenCalled();
    await view.submit();
    expect(verified.saveNativeProviderClient).toHaveBeenCalledWith("org_setup", "mcp_selected_google", {
      clientId: "changed-client", features: ["gmailDraft"],
    });
    expect(stale.saveNativeProviderClient).toHaveBeenCalledTimes(1);
  });

  test("reauthenticates a metadata load without saving, and ignores retries after unmount", async () => {
    const stale = clientWith({ getNativeProviderClient: mock(async () => { throw new DenApiError(403, "reauth", "Confirm identity"); }) });
    const verified = clientWith();
    const view = await mount(stale, { connectionId: "mcp_selected_google" });
    const retry = view.retries[0];
    if (!retry) throw new Error("Expected metadata retry");
    await act(async () => retry(verified));
    expect(verified.getNativeProviderClient).toHaveBeenCalledWith("org_setup", "mcp_selected_google");
    expect(view.input("Client ID").value).toBe("saved-client");
    expect(verified.saveNativeProviderClient).not.toHaveBeenCalled();
    const abandoned = await mount(stale, { connectionId: "mcp_other" });
    const abandonedRetry = abandoned.retries[0];
    if (!abandonedRetry) throw new Error("Expected abandoned retry");
    await abandoned.unmount();
    await act(async () => abandonedRetry(verified));
    expect(verified.getNativeProviderClient).toHaveBeenCalledTimes(1);
  });

  test("ignores the stale first metadata response during StrictMode effect cleanup", async () => {
    const first = deferred<Metadata>();
    const get = mock(async () => metadata);
    get.mockImplementationOnce(() => first.promise);
    const view = await mount(clientWith({ getNativeProviderClient: get }), { connectionId: "mcp_selected_google" }, true);
    expect(view.input("Client ID").value).toBe("saved-client");
    await act(async () => first.resolve({ ...metadata, clientId: "stale-client", features: ["gmailSend"] }));
    expect(view.input("Client ID").value).toBe("saved-client");
    expect(view.feature("gmailSend").checked).toBe(false);
  });

  test("blocks saving when metadata fails, shows the server error, and can reload without an invented redirect", async () => {
    const get = mock(async () => metadata);
    get.mockImplementationOnce(async () => { throw new DenApiError(403, "forbidden", "Only organization administrators can configure this provider."); });
    const client = clientWith({ getNativeProviderClient: get });
    const view = await mount(client);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Only organization administrators");
    expect(view.input("Redirect URI").value).toBe("");
    await view.submit();
    expect(client.createNativeProviderConnection).not.toHaveBeenCalled();
    const button = [...view.host.querySelectorAll("button")].find((item) => item.textContent === "Retry loading settings");
    if (!button) throw new Error("Expected reload button");
    await act(async () => button.click());
    expect(view.input("Redirect URI").value).toBe(metadata.redirectUri);
  });

  test("does not create twice while pending or retry an uncertain network failure", async () => {
    const request = deferred<DenExternalMcpConnection>();
    const client = clientWith({ createNativeProviderConnection: mock(() => request.promise) });
    const view = await mount(client);
    await view.fill("Client ID", "client");
    await view.fill("Client secret", "fixture-secret");
    await view.submit();
    await view.submit();
    expect(client.createNativeProviderConnection).toHaveBeenCalledTimes(1);
    await act(async () => request.reject(new Error("Network unavailable")));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("check Library");
    await view.submit();
    expect(client.createNativeProviderConnection).toHaveBeenCalledTimes(1);
    expect(view.onSaved).not.toHaveBeenCalled();
  });

  test("does not notify or retry after canceling an in-flight save", async () => {
    const request = deferred<void>();
    const client = clientWith({ saveNativeProviderClient: mock(() => request.promise) });
    const view = await mount(client, { connectionId: "mcp_selected_google" });
    await view.submit();
    const cancel = [...view.host.querySelectorAll("button")].find((item) => item.textContent === "Cancel");
    if (!cancel) throw new Error("Expected Cancel button");
    await act(async () => cancel.click());
    expect(view.onCancel).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve());
    expect(view.onSaved).not.toHaveBeenCalled();
  });
});
