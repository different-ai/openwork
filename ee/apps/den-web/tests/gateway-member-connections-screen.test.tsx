import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as requests from "../app/(den)/_lib/den-flow";
import { GatewayMemberConnectionsPanel } from "../app/(den)/dashboard/_components/gateway-member-connections-screen";
import type { GatewayMemberConnection } from "../app/(den)/dashboard/_components/gateway-member-connections-data";

const connection: GatewayMemberConnection = {
  providerId: "ipr_00000000000000000000000001", credentialSetId: "gcs_00000000000000000000000002",
  providerName: "Vertex", name: "Personal Google", ready: false, hasAccess: true, hasCredential: false,
  authorizationRevision: null, accountEmail: null, configurationRequired: false,
};
const connected: GatewayMemberConnection = {
  ...connection, ready: true, hasCredential: true, authorizationRevision: "revision-old", accountEmail: "member@example.test",
};
const inventoryPath = "/v1/inference-providers/member-connections";
const reply = (payload: unknown, status = 200) => ({ payload, response: new Response(null, { status }), text: JSON.stringify(payload) });
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

async function fixture(run: (input: {
  container: HTMLDivElement;
  button: (label: string) => HTMLButtonElement;
  render: (orgId: string, userId?: string) => Promise<void>;
}) => Promise<void>) {
  GlobalRegistrator.register({ url: "https://den.example.test/dashboard/model-connections" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (orgId: string, userId = "user_fixture") => {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><GatewayMemberConnectionsPanel key={`${orgId}:${userId}`} orgId={orgId} userId={userId} orgSlug="example" /></QueryClientProvider>));
    await flush();
  };
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  try {
    await render("org_fixture");
    await run({ container, button, render });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    await GlobalRegistrator.unregister();
  }
}

test("no token or ready models still supports Connect, revision-confirmed authorization and Disconnect", async () => {
  let ready = false;
  const calls: { path: string; method: string }[] = [];
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.includes("oauth/start")) return reply({ authUrl: "https://den.example.test/gateway/connect?attempt=fixture" });
    if (init?.method === "DELETE") { ready = false; return reply(null, 204); }
    expect(path).toBe(inventoryPath);
    return reply({ connections: [ready ? connected : connection] });
  });
  try {
    await fixture(async ({ container, button }) => {
      expect(container.textContent).toContain("Sign-in required");
      await act(async () => button("Connect with Google").click());
      await flush();
      expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://den.example.test/gateway/connect?attempt=fixture");
      expect(container.textContent).toContain("Waiting for Google sign-in");
      ready = true;
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).toContain("Google token ready");
      expect(container.textContent).toContain("Connected as member@example.test");
      expect(container.textContent).toContain("Google authorization completed");
      expect(container.textContent).not.toContain("models available");
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
      expect(button("Reconnect with Google")).toBeDefined();
      await act(async () => button("Disconnect").click());
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      await act(async () => button("Confirm disconnect").click());
      await flush();
      expect(calls.some((call) => call.method === "DELETE" && call.path.endsWith(`/oauth?credentialSetId=${connection.credentialSetId}`))).toBe(true);
      expect(container.textContent).toContain("Sign-in required");
    });
  } finally { request.mockRestore(); }
});

test("reconnect captures a fresh pre-start revision and ignores unchanged readiness until a new authorization is ready", async () => {
  let current = connected;
  const request = spyOn(requests, "requestJson").mockImplementation(async (path) => {
    if (path.includes("oauth/start")) return reply({ authUrl: "https://den.example.test/gateway/connect?attempt=reconnect" });
    expect(path).toBe(inventoryPath);
    return reply({ connections: [current] });
  });
  try {
    await fixture(async ({ container, button }) => {
      current = { ...connected, authorizationRevision: "revision-before-start" };
      await act(async () => button("Reconnect with Google").click());
      await flush();
      expect(container.textContent).toContain("Waiting for Google sign-in");
      expect(container.textContent).toContain("cleanup revocation may affect your previous connection");
      expect(container.textContent).toContain("You may need to reconnect them.");
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).not.toContain("Google authorization completed");
      expect(container.querySelector('a[target="_blank"]')).not.toBeNull();
      current = { ...current, ready: false, authorizationRevision: "revision-new", accountEmail: "replacement@example.test" };
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).not.toContain("Google authorization completed");
      current = { ...current, ready: true };
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).toContain("Google authorization completed");
      expect(container.textContent).toContain("Connected as replacement@example.test");
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
    });
  } finally { request.mockRestore(); }
});

test("retained credentials after access loss or provider disable remain disconnectable, never connectable", async () => {
  let retained = true;
  const calls: string[] = [];
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    calls.push(path);
    if (init?.method === "DELETE") { retained = false; return reply(null, 204); }
    expect(path).toBe(inventoryPath);
    return reply({ connections: retained ? [{ ...connected, ready: false, hasAccess: false }] : [] });
  });
  try {
    await fixture(async ({ container, button }) => {
      expect(container.textContent).toContain("Access removed");
      expect(container.textContent).toContain("Connected as member@example.test");
      expect([...container.querySelectorAll("button")].some((item) => item.textContent?.includes("with Google"))).toBe(false);
      await act(async () => button("Disconnect").click());
      await act(async () => button("Confirm disconnect").click());
      await flush();
      expect(container.textContent).toContain("No model connections are currently assigned");
      expect(calls.some((path) => path.includes("oauth/start"))).toBe(false);
    });
  } finally { request.mockRestore(); }
});

test("refreshing immediately before Connect prevents starting with a stale grant", async () => {
  let hasAccess = true;
  let starts = 0;
  const request = spyOn(requests, "requestJson").mockImplementation(async (path) => {
    if (path.includes("oauth/start")) { starts += 1; return reply({ authUrl: "https://den.example.test/gateway/connect?attempt=unexpected" }); }
    return reply({ connections: [{ ...connection, hasAccess }] });
  });
  try {
    await fixture(async ({ container, button }) => {
      hasAccess = false;
      await act(async () => button("Connect with Google").click());
      await flush();
      expect(starts).toBe(0);
      expect(container.textContent).toContain("Access removed");
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
    });
  } finally { request.mockRestore(); }
});

test("access loss during reconnect stops waiting but keeps the retained credential's Disconnect action", async () => {
  let hasAccess = true;
  const request = spyOn(requests, "requestJson").mockImplementation(async (path) => {
    if (path.includes("oauth/start")) return reply({ authUrl: "https://den.example.test/gateway/connect?attempt=fixture" });
    return reply({ connections: [{ ...connected, hasAccess, ready: hasAccess }] });
  });
  try {
    await fixture(async ({ container, button }) => {
      await act(async () => button("Reconnect with Google").click());
      await flush();
      hasAccess = false;
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).toContain("Access removed");
      expect(container.textContent).not.toContain("Google authorization completed");
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
      expect(button("Disconnect")).toBeDefined();
    });
  } finally { request.mockRestore(); }
});

test("client configuration failure requires administrator repair and blocks Reconnect while preserving Disconnect", async () => {
  let retained = true;
  let starts = 0;
  let deletes = 0;
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    if (path.includes("oauth/start")) { starts += 1; throw new Error("Unexpected sign-in"); }
    if (init?.method === "DELETE") { deletes += 1; retained = false; return reply(null, 204); }
    return reply({ connections: retained ? [{ ...connected, configurationRequired: true, ready: false }] : [] });
  });
  try {
    await fixture(async ({ container, button }) => {
      expect(container.textContent).toContain("Administrator action required");
      expect(container.textContent).not.toContain("Google token ready");
      expect(container.textContent).toContain("Connected as member@example.test");
      expect(button("Reconnect with Google").disabled).toBe(true);
      await act(async () => button("Reconnect with Google").click());
      expect(starts).toBe(0);
      expect(button("Disconnect").disabled).toBe(false);
      await act(async () => button("Disconnect").click());
      await act(async () => button("Confirm disconnect").click());
      await flush();
      expect(deletes).toBe(1);
    });
  } finally { request.mockRestore(); }
});

test("refreshing a repaired configuration restores Connect without requiring a ready credential", async () => {
  let current = { ...connected, configurationRequired: true, ready: false };
  let starts = 0;
  const request = spyOn(requests, "requestJson").mockImplementation(async (path) => {
    if (path.includes("oauth/start")) { starts += 1; return reply({ authUrl: "https://den.example.test/gateway/connect?attempt=repaired" }); }
    return reply({ connections: [current] });
  });
  try {
    await fixture(async ({ container, button }) => {
      expect(button("Reconnect with Google").disabled).toBe(true);
      current = { ...connection, configurationRequired: false, ready: false };
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).not.toContain("Administrator action required");
      expect(button("Connect with Google").disabled).toBe(false);
      await act(async () => button("Connect with Google").click());
      await flush();
      expect(starts).toBe(1);
      expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toContain("attempt=repaired");
    });
  } finally { request.mockRestore(); }
});

test("a newly observed client failure prevents a stale Connect and stops an existing browser handoff", async () => {
  let configurationRequired = false;
  let starts = 0;
  const request = spyOn(requests, "requestJson").mockImplementation(async (path) => {
    if (path.includes("oauth/start")) { starts += 1; return reply({ authUrl: "https://den.example.test/gateway/connect?attempt=fixture" }); }
    return reply({ connections: [{ ...connected, configurationRequired, ready: !configurationRequired }] });
  });
  try {
    await fixture(async ({ container, button }) => {
      configurationRequired = true;
      await act(async () => button("Reconnect with Google").click());
      await flush();
      expect(starts).toBe(0);
      expect(button("Reconnect with Google").disabled).toBe(true);
      configurationRequired = false;
      await act(async () => button("Refresh status").click());
      await flush();
      await act(async () => button("Reconnect with Google").click());
      await flush();
      expect(starts).toBe(1);
      expect(container.querySelector('a[target="_blank"]')).not.toBeNull();
      configurationRequired = true;
      await act(async () => button("Refresh status").click());
      await flush();
      expect(container.textContent).toContain("Administrator action required");
      expect(container.textContent).not.toContain("Google authorization completed");
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
      expect(button("Disconnect").disabled).toBe(false);
    });
  } finally { request.mockRestore(); }
});

test.each(["organization", "account"])("switching %s discards an in-flight OAuth response and aborts its request", async (scope) => {
  let finish: (value: ReturnType<typeof reply>) => void = () => { throw new Error("OAuth not started"); };
  let requestSignal: AbortSignal | null | undefined;
  let changed = false;
  const pending = new Promise<ReturnType<typeof reply>>((resolve) => { finish = resolve; });
  const request = spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    if (path.includes("oauth/start")) { requestSignal = init?.signal; return pending; }
    return reply({ connections: changed ? [] : [connection] });
  });
  try {
    await fixture(async ({ container, button, render }) => {
      await act(async () => button("Connect with Google").click());
      await flush();
      changed = true;
      await render(scope === "organization" ? "org_other" : "org_fixture", scope === "account" ? "user_other" : "user_fixture");
      expect(requestSignal?.aborted).toBe(true);
      await act(async () => finish(reply({ authUrl: "https://den.example.test/gateway/connect?attempt=old" })));
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
      expect(container.textContent).toContain("No model connections are currently assigned");
    });
  } finally { request.mockRestore(); }
});
