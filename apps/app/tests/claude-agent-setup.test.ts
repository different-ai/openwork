import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { claudeAgentStatus, type ClaudeAgentIntegration } from "../src/app/lib/claude-agent";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient, } from "../src/react-app/infra/query-client";

beforeEach(() => GlobalRegistrator.register({ url: "http://localhost:5173/" }));
afterEach(async () => { getReactQueryClient().clear(); await GlobalRegistrator.unregister(); });

function fixture(input: { enabled?: boolean; workspace?: string | null; legacyFails?: boolean; uncertainPost?: boolean; catalogFails?: boolean; beforeRequest?: (request: Request, integration: ClaudeAgentIntegration) => void | Promise<void> } = {}) {
  let enabled = input.enabled ?? true;
  let workspace = input.workspace === undefined ? "workspace" : input.workspace;
  const requests: Request[] = [];
  let initialized = false;
  let nextCredential = 0;
  let policyBlocked = false;
  let integration: ClaudeAgentIntegration = {
    id: "claude-agent", name: "Claude Agent",
    methods: [{ id: "claude-login", type: "external", label: "Connect Claude Code" }], connections: [],
  };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = url instanceof Request ? url : new Request(url, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;
    await input.beforeRequest?.(request, integration);
    if (path.endsWith("/connect/external")) {
      integration.connections.unshift({ type: "credential", id: `credential-${nextCredential++}`, label: "Claude Code", method: "external", status: { status: "needs_auth", message: "Run claude auth login" } });
      if (input.uncertainPost) throw new Error("Connection interrupted. Check again before retrying.");
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/api/integration")) {
      initialized = true;
      return Response.json({ data: [{ id: "unrelated-integration", methods: "unrelated shape" }, integration] });
    }
    if (path.endsWith("/integration/claude-agent")) return initialized ? Response.json({ data: integration }) : Response.json({ name: "IntegrationNotFoundError" }, { status: 404 });
    if (path.includes("/api/credential/") && request.method === "DELETE") {
      integration = { ...integration, connections: integration.connections.filter((connection) => connection.id !== decodeURIComponent(path.split("/").at(-1) ?? "")) };
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/provider/auth")) return input.legacyFails ? Response.json({ message: "Legacy auth unavailable" }, { status: 500 }) : Response.json({ anthropic: [{ type: "api", label: "API key" }] });
    if (path.endsWith("/config/providers") || path.endsWith("/api/provider") || path.endsWith("/api/model")) {
      if (input.catalogFails) return Response.json({ message: "Catalog unavailable" }, { status: 500 });
      return Response.json({ providers: [], all: [], connected: [], default: {} });
    }
    return Response.json({});
  });
  let server = createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "fixture-server-token", hostToken: "fixture-host" });
  const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
  const store = createProviderAuthStore({
    claudeAgentEnabled: () => enabled, nativeOpenworkClient: () => server, nativeWorkspaceId: () => workspace,
    client: () => client, providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    checkDesktopAppRestriction: () => policyBlocked,
    selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
    providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace", runtimeWorkspaceId: () => workspace,
    openworkServer: { getSnapshot: () => ({ openworkServerStatus: "connected", openworkServerClient: server, openworkServerCapabilities: {} }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {}, markOpencodeConfigReloadRequired: () => {},
  });
  return { store, requests, server, setToken: (token: string) => { server = createOpenworkServerClient({ baseUrl: server.baseUrl, token }); }, setPolicyBlocked: () => { policyBlocked = true; }, integration: () => integration, setEnabled: (next: boolean) => { enabled = next; }, setWorkspace: (next: string) => { workspace = next; }, cleanup: () => { store.dispose(); fetch.mockRestore(); } };
}

test("fresh-engine discovery initializes integrations before reading any model catalog", async () => {
  const f = fixture();
  try {
    const integration = await f.server.claudeAgentIntegration("workspace");
    expect(integration.id).toBe("claude-agent");
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual(["/workspace/workspace/opencode2/api/integration"]);
    await f.store.connectClaudeAgent();
    const paths = f.requests.map((request) => new URL(request.url).pathname);
    expect(paths.findIndex((path) => path.endsWith("/api/integration"))).toBeLessThan(paths.findIndex((path) => path.endsWith("/api/model")));
    expect(paths.some((path) => path.endsWith("/integration/claude-agent"))).toBe(false);
  } finally { f.cleanup(); }
});

test("native external setup is independent of legacy auth discovery and retains the Anthropic API key", async () => {
  const f = fixture();
  try {
    await f.store.openProviderAuthModal();
    expect(f.store.getSnapshot().providerAuthMethods.anthropic).toContainEqual({ type: "api", label: "API key", methodIndex: 0 });
    expect(f.store.getSnapshot().providerAuthMethods["claude-agent"]).toEqual([{ type: "external", label: "Connect Claude Code" }]);
    expect(f.store.getSnapshot().providerAuthProviders.find((provider) => provider.id === "claude-agent")?.env).toEqual([]);
  } finally { f.cleanup(); }
  const failed = fixture({ legacyFails: true });
  try {
    await failed.store.openProviderAuthModal();
    expect(failed.store.getSnapshot().providerAuthModalOpen).toBe(true);
    expect(failed.store.getSnapshot().providerAuthMethods["claude-agent"]?.[0]?.type).toBe("external");
    expect(failed.store.getSnapshot().claudeAgent?.integration?.id).toBe("claude-agent");
    expect(failed.store.getSnapshot().providerAuthError).toContain("Other provider connections could not be loaded");
    expect(failed.store.getSnapshot().providerAuthError).not.toContain("Legacy auth unavailable");
  } finally { failed.cleanup(); }
});

test("external connect uses the workspace proxy and server token, never a secret or legacy OAuth", async () => {
  const f = fixture();
  try {
    await f.store.connectClaudeAgent();
    const post = f.requests.find((request) => request.method === "POST");
    expect(post?.url).toBe("http://localhost:8787/workspace/workspace/opencode2/api/integration/claude-agent/connect/external");
    expect(post?.headers.get("Authorization")).toBe("Bearer fixture-server-token");
    expect(post?.headers.get("X-OpenWork-Host-Token")).toBeNull();
    expect(await post?.json()).toEqual({ methodID: "claude-login" });
    expect(f.requests.some((request) => request.url.endsWith("/api/provider"))).toBe(true);
    expect(f.requests.some((request) => /\/auth\//.test(request.url))).toBe(false);
    const state = f.store.getSnapshot().claudeAgent;
    expect(state?.integration?.connections).toHaveLength(1);
    expect(state && claudeAgentStatus(state)).toBe("Run claude auth login");
    expect(state && claudeAgentStatus(state)).not.toContain("verified");
    await expect(f.store.submitProviderApiKey("claude-agent", "should-not-send")).rejects.toThrow("not an API key");
  } finally { f.cleanup(); }
});

test("retry removes superseded connection references; disconnect removes all, never Claude auth", async () => {
  const f = fixture();
  try {
    await f.store.connectClaudeAgent();
    await f.store.connectClaudeAgent();
    expect(f.integration().connections).toHaveLength(1);
    f.integration().connections.push({ type: "credential", id: "extra-reference", label: "Claude", method: "external" });
    const result = await f.store.disconnectProvider("claude-agent");
    expect(result).toContain("Claude Code is still signed in");
    expect(f.integration().connections).toHaveLength(0);
    expect(f.requests.filter((request) => request.method === "DELETE").map((request) => new URL(request.url).pathname)).toEqual([
      "/workspace/workspace/opencode2/api/credential/credential-0",
      "/workspace/workspace/opencode2/api/credential/credential-1",
      "/workspace/workspace/opencode2/api/credential/extra-reference",
    ]);
    expect(f.requests.some((request) => request.url.includes("/auth/"))).toBe(false);
  } finally { f.cleanup(); }
});

test("an uncertain external POST is never replayed; checking again only reads", async () => {
  const f = fixture({ uncertainPost: true });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("interrupted");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    await f.store.refreshClaudeAgent();
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(f.store.getSnapshot().claudeAgent?.integration?.connections).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("flag off leaves the entry locked and does not mutate stored connections", async () => {
  const f = fixture();
  try {
    await f.store.connectClaudeAgent();
    f.setEnabled(false);
    f.store.syncFromOptions();
    expect(f.store.getSnapshot().claudeAgent?.blockedReason).toContain("administrator");
    const nativeRequests = () => f.requests.filter((request) => request.url.includes("/api/integration") || request.url.includes("/credential/"));
    const count = nativeRequests().length;
    await expect(f.store.disconnectProvider("claude-agent")).rejects.toThrow("administrator");
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("administrator");
    expect(nativeRequests()).toHaveLength(count);
    expect(f.integration().connections).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("without a workspace setup is blocked instead of calling a root integration endpoint", async () => {
  const f = fixture({ workspace: null });
  try {
    await f.store.openProviderAuthModal({ preferredProviderId: "claude-agent" });
    expect(f.store.getSnapshot().claudeAgent?.blockedReason).toContain("Choose a workspace");
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("Choose a workspace");
    expect(f.requests.some((request) => request.url.includes("/api/integration"))).toBe(false);
  } finally { f.cleanup(); }
});

test("feature and policy changes during discovery prevent a new external POST", async () => {
  for (const restriction of ["feature", "policy"]) {
    const f = fixture({ beforeRequest: (request) => {
      if (!request.url.endsWith("/api/integration")) return;
      if (restriction === "feature") f.setEnabled(false);
      else f.setPolicyBlocked();
    } });
    try {
      await f.store.connectClaudeAgent();
      expect(f.requests.some((request) => request.method === "POST" || request.method === "DELETE")).toBe(false);
      expect(f.store.getSnapshot().claudeAgent?.integration).toBeNull();
    } finally { f.cleanup(); }
  }
});

test("turning the feature off after POST stops cleanup writes without undoing the dispatched action", async () => {
  let reads = 0;
  const f = fixture({ beforeRequest: (request) => {
    if (request.url.endsWith("/api/integration") && ++reads === 2) f.setEnabled(false);
  } });
  try {
    f.integration().connections.push({ type: "credential", id: "old-reference", label: "Claude Code", method: "external" });
    await f.store.connectClaudeAgent();
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(f.integration().connections).toHaveLength(2);
  } finally { f.cleanup(); }
});

test("authorization changes prevent an old integration response from publishing", async () => {
  let reads = 0;
  let release = () => {};
  const nextRead = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ beforeRequest: async (request) => {
    if (!request.url.endsWith("/api/integration")) return;
    reads += 1;
    if (reads === 1) f.setToken("replacement-token");
    else await nextRead;
  } });
  try {
    await f.store.refreshClaudeAgent();
    expect(f.store.getSnapshot().claudeAgent?.integration).toBeNull();
    expect(f.requests.some((request) => request.headers.get("Authorization") === "Bearer replacement-token")).toBe(true);
  } finally { f.cleanup(); release(); }
});

test("retry preserves concurrent new references and chooses the first active connection", async () => {
  let reads = 0;
  const f = fixture({ beforeRequest: (request, integration) => {
    if (!request.url.endsWith("/api/integration")) return;
    reads += 1;
    if (reads === 2) integration.connections.unshift({ type: "credential", id: "concurrent-active", label: "Concurrent Claude Code", method: "external" });
  } });
  try {
    f.integration().connections.push({ type: "credential", id: "old-reference", label: "Claude Code", method: "external" });
    await f.store.connectClaudeAgent();
    expect(f.integration().connections.map((connection) => connection.id)).toEqual(["concurrent-active", "credential-0"]);
    expect(f.requests.filter((request) => request.method === "DELETE").map((request) => request.url.split("/").at(-1))).toEqual(["old-reference"]);
  } finally { f.cleanup(); }
});

test("retry never deletes a reference another client switched active during cleanup", async () => {
  let reads = 0;
  const f = fixture({ beforeRequest: (request, integration) => {
    if (!request.url.endsWith("/api/integration")) return;
    reads += 1;
    if (reads === 3) integration.connections.reverse();
  } });
  try {
    f.integration().connections.push({ type: "credential", id: "old-reference", label: "Claude Code", method: "external" });
    await f.store.connectClaudeAgent();
    expect(f.integration().connections[0]?.id).toBe("old-reference");
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
  } finally { f.cleanup(); }
});

test("only the active first connection determines the sign-in status", () => {
  const state = { enabled: true, blockedReason: null, busy: false, error: null, catalogError: null, integration: {
    id: "claude-agent", name: "Claude Agent", methods: [], connections: [
      { type: "credential", id: "active", label: "Active", method: "external" },
      { type: "credential", id: "old", label: "Old", method: "external", status: { status: "needs_auth", message: "Stale sign-in warning" } },
    ],
  } } satisfies Parameters<typeof claudeAgentStatus>[0];
  expect(claudeAgentStatus(state)).toBe("Connection saved");
  state.integration.connections.reverse();
  expect(claudeAgentStatus(state)).toBe("Stale sign-in warning");
});

test("catalog failure preserves a saved native connection without claiming authentication", async () => {
  const f = fixture({ catalogFails: true });
  try {
    await f.store.connectClaudeAgent();
    expect(f.store.getSnapshot().claudeAgent?.integration?.connections).toHaveLength(1);
    expect(f.store.getSnapshot().claudeAgent?.catalogError).toContain("Models could not be refreshed");
  } finally { f.cleanup(); }
});
