import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { claudeAgentConnected, claudeAgentProblem, type ClaudeAgentIntegration, type ClaudeAgentSetupState } from "../src/app/lib/claude-agent";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient, } from "../src/react-app/infra/query-client";

beforeEach(() => GlobalRegistrator.register({ url: "http://localhost:5173/" }));
afterEach(async () => { getReactQueryClient().clear(); await GlobalRegistrator.unregister(); });

type Login = "ok" | "signed-out" | "missing";
/** What the server's sign-in route answers, one per request; the last answer repeats. */
type SignIn = { status: "idle" | "waiting" | "signed_in"; installed?: boolean } | { status: "failed"; message: string } | { error: number; code: string; message: string };
const PROBLEMS: Record<Exclude<Login, "ok">, { status: "needs_auth"; message: string; url?: string }> = {
  "signed-out": { status: "needs_auth", message: "Claude Code is not logged in. Run `claude auth login` in a terminal." },
  missing: { status: "needs_auth", message: "Claude Code is not installed. Install it, then run `claude auth login`.", url: "https://code.claude.com/docs/en/setup" },
};

/**
 * The engine as measured on 2.2.6: connecting saves a new active reference
 * with no status, the engine then checks `claude` and only afterwards lists
 * its models and, when the login is not usable, reports a problem on the
 * active reference. `probeReads` is how many integration reads that takes.
 */
function fixture(input: { enabled?: boolean; workspace?: string | null; legacyFails?: boolean; uncertainPost?: boolean; catalogFails?: boolean; login?: Login; probeReads?: number; settleMs?: number; timeoutMs?: number; signIn?: SignIn[]; beforeRequest?: (request: Request, integration: ClaudeAgentIntegration) => void | Promise<void> } = {}) {
  let enabled = input.enabled ?? true;
  let workspace = input.workspace === undefined ? "workspace" : input.workspace;
  let login: Login = input.login ?? "ok";
  const requests: Request[] = [];
  let initialized = false;
  let nextCredential = 0;
  let policyBlocked = false;
  let modelsListed = false;
  let pendingProbe: number | null = null;
  const signIn = [...(input.signIn ?? [])];
  let integration: ClaudeAgentIntegration = {
    id: "claude-agent", name: "Claude Agent",
    methods: [{ id: "claude-login", type: "external", label: "Claude Code login (claude auth login)" }], connections: [],
  };
  const finishProbe = () => {
    pendingProbe = null;
    if (login !== "missing") modelsListed = true;
    const active = integration.connections[0];
    if (active) integration.connections[0] = login === "ok" ? { type: active.type, id: active.id, label: active.label, method: active.method } : { ...active, status: PROBLEMS[login] };
  };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = url instanceof Request ? url : new Request(url, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;
    await input.beforeRequest?.(request, integration);
    if (path === "/claude-code/sign-in") {
      const answer = signIn.length > 1 ? signIn.shift() : signIn[0];
      if (request.method === "DELETE") return Response.json({ status: "idle" });
      if (!answer) return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
      if (answer && "error" in answer) return Response.json({ code: answer.code, message: answer.message }, { status: answer.error });
      // Signing in is what makes a signed-out Claude Code usable.
      if (answer.status === "signed_in") login = "ok";
      return Response.json(answer);
    }
    if (path.endsWith("/connect/external")) {
      integration.connections.unshift({ type: "credential", id: `credential-${nextCredential++}`, label: "Claude Code", method: "external" });
      pendingProbe = input.probeReads ?? 1;
      if (input.uncertainPost) throw new Error("Connection interrupted. Check again before retrying.");
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/api/integration")) {
      initialized = true;
      if (pendingProbe !== null && --pendingProbe <= 0) finishProbe();
      return Response.json({ data: [{ id: "unrelated-integration", methods: "unrelated shape" }, integration] });
    }
    if (path.endsWith("/integration/claude-agent")) return initialized ? Response.json({ data: integration }) : Response.json({ name: "IntegrationNotFoundError" }, { status: 404 });
    if (path.includes("/api/credential/") && request.method === "DELETE") {
      integration = { ...integration, connections: integration.connections.filter((connection) => connection.id !== decodeURIComponent(path.split("/").at(-1) ?? "")) };
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/provider/auth")) return input.legacyFails ? Response.json({ message: "Legacy auth unavailable" }, { status: 500 }) : Response.json({ anthropic: [{ type: "api", label: "API key" }] });
    if (path.endsWith("/api/model")) {
      if (input.catalogFails) return Response.json({ message: "Catalog unavailable" }, { status: 500 });
      return Response.json({ data: modelsListed ? [{ id: "claude-sonnet-4-6", providerID: "claude-agent", name: "Claude Sonnet" }] : [] });
    }
    if (path.endsWith("/api/provider")) return Response.json({ data: [{ id: "claude-agent", name: "Claude Agent" }] });
    if (path.endsWith("/config/providers")) return Response.json({ providers: [], all: [], connected: [], default: {} });
    return Response.json({});
  });
  let server = createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "fixture-server-token", hostToken: "fixture-host" });
  const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
  const store = createProviderAuthStore({
    claudeAgentEnabled: () => enabled, nativeOpenworkClient: () => server, nativeWorkspaceId: () => workspace,
    claudeCheckTiming: { pollMs: 1, settleMs: input.settleMs ?? 15, timeoutMs: input.timeoutMs ?? 400, followUpMs: 60_000, signInPollMs: 1 },
    claudeSignInAvailable: () => input.signIn !== undefined,
    client: () => client, providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    checkDesktopAppRestriction: () => policyBlocked,
    selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
    providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace", runtimeWorkspaceId: () => workspace,
    openworkServer: { getSnapshot: () => ({ openworkServerStatus: "connected", openworkServerClient: server, openworkServerCapabilities: {} }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {}, markOpencodeConfigReloadRequired: () => {},
  });
  return { store, requests, server, setToken: (token: string) => { server = createOpenworkServerClient({ baseUrl: server.baseUrl, token }); }, setPolicyBlocked: () => { policyBlocked = true; }, integration: () => integration, setLogin: (next: Login) => { login = next; }, setEnabled: (next: boolean) => { enabled = next; }, setWorkspace: (next: string) => { workspace = next; }, cleanup: () => { store.dispose(); fetch.mockRestore(); } };
}
const posts = (f: ReturnType<typeof fixture>) => f.requests.filter((request) => request.method === "POST");
const deletes = (f: ReturnType<typeof fixture>) => f.requests.filter((request) => request.method === "DELETE").map((request) => request.url.split("/").at(-1));

test("connecting waits for the engine's check, then says connected with a verified connection", async () => {
  const f = fixture({ probeReads: 3 });
  try {
    const pending = f.store.connectClaudeAgent();
    expect(f.store.getSnapshot().claudeAgent?.checking).toBe(true);
    expect(await pending).toBe("Claude Code connected");
    const state = f.store.getSnapshot().claudeAgent;
    expect(state?.checking).toBe(false);
    expect(state?.verified).toBe(true);
    expect(state?.error).toBeNull();
    expect(claudeAgentProblem(state)).toBeNull();
    expect(state?.integration?.connections).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("a signed-out or missing Claude Code ends with the engine's reason, never connected", async () => {
  for (const [login, reason] of [["signed-out", "not logged in"], ["missing", "not installed"]] as const) {
    const f = fixture({ login, probeReads: 2 });
    try {
      await expect(f.store.connectClaudeAgent()).rejects.toThrow(reason);
      const state = f.store.getSnapshot().claudeAgent;
      expect(state?.verified).toBe(false);
      expect(state?.checking).toBe(false);
      expect(state?.error).toContain(reason);
      expect(claudeAgentProblem(state)?.message).toContain(reason);
      // The engine words its reason for a terminal; people get it without the backticks.
      expect(`${state?.error} ${claudeAgentProblem(state)?.message}`).not.toContain("`");
      // The reference stays so the row can say what is wrong and offer the fix.
      expect(claudeAgentConnected(state)).toBe(true);
    } finally { f.cleanup(); }
  }
});

test("checking again after signing in replaces the reference and reports connected", async () => {
  const f = fixture({ login: "signed-out" });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not logged in");
    f.setLogin("ok");
    expect(await f.store.connectClaudeAgent()).toBe("Claude Code connected");
    expect(f.integration().connections.map((connection) => connection.id)).toEqual(["credential-1"]);
    expect(f.store.getSnapshot().claudeAgent?.verified).toBe(true);
    expect(claudeAgentProblem(f.store.getSnapshot().claudeAgent)).toBeNull();
  } finally { f.cleanup(); }
});

test("a repeat check holds on for a late problem instead of trusting models the engine kept", async () => {
  // Still signed out on the second try: the new reference has no status for
  // several reads while the engine's kept model list already looks ready.
  const f = fixture({ login: "signed-out", probeReads: 6, settleMs: 200 });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not logged in");
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not logged in");
    expect(f.store.getSnapshot().claudeAgent?.verified).toBe(false);
  } finally { f.cleanup(); }
  // Without the hold the same engine answers look like a working login.
  const hasty = fixture({ login: "signed-out", probeReads: 6, settleMs: 0 });
  try {
    await expect(hasty.store.connectClaudeAgent()).rejects.toThrow("not logged in");
    expect(await hasty.store.connectClaudeAgent()).toBe("Claude Code connected");
  } finally { hasty.cleanup(); }
});

test("a check the engine never finishes ends with what to do, not a saved connection", async () => {
  const f = fixture({ probeReads: 1_000_000, timeoutMs: 30 });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("Couldn't confirm that Claude Code is ready");
    expect(f.store.getSnapshot().claudeAgent?.verified).toBe(false);
    expect(f.store.getSnapshot().claudeAgent?.checking).toBe(false);
  } finally { f.cleanup(); }
});

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

test("Claude Code is offered as a way to connect Anthropic, next to its API key, not as its own provider", async () => {
  const f = fixture();
  try {
    await f.store.openProviderAuthModal();
    const snapshot = f.store.getSnapshot();
    expect(snapshot.providerAuthMethods.anthropic).toEqual([{ type: "external", label: "Claude Code" }, { type: "api", label: "API key", methodIndex: 0 }]);
    expect(snapshot.providerAuthMethods["claude-agent"]).toBeUndefined();
    expect(snapshot.providerAuthProviders.some((provider) => provider.id === "claude-agent")).toBe(false);
  } finally { f.cleanup(); }
  const failed = fixture({ legacyFails: true });
  try {
    await failed.store.openProviderAuthModal();
    expect(failed.store.getSnapshot().providerAuthModalOpen).toBe(true);
    // The engine's own sign-in list failed, so Anthropic carries Claude Code alone.
    expect(failed.store.getSnapshot().providerAuthMethods.anthropic).toEqual([{ type: "external", label: "Claude Code" }]);
    expect(failed.store.getSnapshot().providerAuthProviders.find((provider) => provider.id === "anthropic")?.name).toBe("Anthropic");
    expect(failed.store.getSnapshot().providerAuthError).toContain("Other provider connections could not be loaded");
    expect(failed.store.getSnapshot().providerAuthError).not.toContain("Legacy auth unavailable");
  } finally { failed.cleanup(); }
});

test("with the feature off nothing about Claude Code is shown, read or changed", async () => {
  const f = fixture({ enabled: false });
  try {
    f.store.syncFromOptions();
    await f.store.openProviderAuthModal();
    const snapshot = f.store.getSnapshot();
    expect(snapshot.claudeAgent).toBeUndefined();
    expect(snapshot.providerAuthMethods.anthropic).toEqual([{ type: "api", label: "API key", methodIndex: 0 }]);
    expect(snapshot.providerAuthMethods["claude-agent"]).toBeUndefined();
    expect(snapshot.providerAuthProviders.some((provider) => provider.id === "claude-agent")).toBe(false);
    expect(snapshot.providerAuthError).toBeNull();
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not available");
    expect(f.requests.some((request) => request.url.includes("/api/integration") || request.url.includes("/credential/"))).toBe(false);
  } finally { f.cleanup(); }
  // Without the feature, a failing sign-in list fails exactly as it did before Claude Code existed.
  const failed = fixture({ enabled: false, legacyFails: true });
  try {
    await failed.store.openProviderAuthModal();
    expect(failed.store.getSnapshot().providerAuthError ?? "").not.toContain("Other provider connections could not be loaded");
  } finally { failed.cleanup(); }
});

test("external connect uses the workspace proxy and server token, never a secret or legacy OAuth", async () => {
  const f = fixture();
  try {
    await f.store.connectClaudeAgent();
    const post = posts(f)[0];
    expect(post?.url).toBe("http://localhost:8787/workspace/workspace/opencode2/api/integration/claude-agent/connect/external");
    expect(post?.headers.get("Authorization")).toBe("Bearer fixture-server-token");
    expect(post?.headers.get("X-OpenWork-Host-Token")).toBeNull();
    expect(await post?.json()).toEqual({ methodID: "claude-login" });
    expect(f.requests.some((request) => request.url.endsWith("/api/provider"))).toBe(true);
    expect(f.requests.some((request) => /\/auth\//.test(request.url))).toBe(false);
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
    expect(result).toContain("Claude Code itself stays signed in");
    expect(f.integration().connections).toHaveLength(0);
    expect(f.store.getSnapshot().claudeAgent?.verified).toBe(false);
    expect(deletes(f)).toEqual(["credential-0", "credential-1", "extra-reference"]);
    expect(f.requests.some((request) => request.url.includes("/auth/"))).toBe(false);
  } finally { f.cleanup(); }
});

test("an uncertain external POST is never replayed", async () => {
  const f = fixture({ uncertainPost: true });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("interrupted");
    expect(posts(f)).toHaveLength(1);
    await f.store.openProviderAuthModal();
    expect(posts(f)).toHaveLength(1);
    expect(f.store.getSnapshot().claudeAgent?.integration?.connections).toHaveLength(1);
    expect(f.store.getSnapshot().claudeAgent?.verified).toBe(false);
  } finally { f.cleanup(); }
});

test("turning the feature off hides Claude Code and does not mutate stored connections", async () => {
  const f = fixture();
  try {
    await f.store.connectClaudeAgent();
    f.setEnabled(false);
    f.store.syncFromOptions();
    expect(f.store.getSnapshot().claudeAgent).toBeUndefined();
    const nativeRequests = () => f.requests.filter((request) => request.url.includes("/api/integration") || request.url.includes("/credential/"));
    const count = nativeRequests().length;
    await expect(f.store.disconnectProvider("claude-agent")).rejects.toThrow("not available");
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not available");
    expect(nativeRequests()).toHaveLength(count);
    expect(f.integration().connections).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("without a workspace Claude Code is not offered and no root integration endpoint is called", async () => {
  const f = fixture({ workspace: null });
  try {
    await f.store.openProviderAuthModal();
    expect(f.store.getSnapshot().claudeAgent).toBeUndefined();
    expect(f.store.getSnapshot().providerAuthMethods.anthropic).toEqual([{ type: "api", label: "API key", methodIndex: 0 }]);
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not available");
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
      expect(f.store.getSnapshot().claudeAgent).toBeUndefined();
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
    expect(posts(f)).toHaveLength(1);
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
    f.store.syncFromOptions();
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    expect(deletes(f)).toEqual(["old-reference"]);
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

test("only the active first connection determines the sign-in problem", () => {
  const state: ClaudeAgentSetupState = { busy: false, checking: false, verified: false, error: null, integration: {
    id: "claude-agent", name: "Claude Agent", methods: [], connections: [
      { type: "credential", id: "active", label: "Active", method: "external" },
      { type: "credential", id: "old", label: "Old", method: "external", status: { status: "needs_auth", message: "Stale sign-in warning" } },
    ],
  } };
  expect(claudeAgentProblem(state)).toBeNull();
  state.integration?.connections.reverse();
  expect(claudeAgentProblem(state)?.message).toBe("Stale sign-in warning");
  expect(claudeAgentProblem(undefined)).toBeNull();
});

test("a model list that cannot be read is not taken for a working login", async () => {
  const f = fixture({ catalogFails: true, timeoutMs: 30 });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("Couldn't confirm that Claude Code is ready");
    expect(f.store.getSnapshot().claudeAgent?.verified).toBe(false);
  } finally { f.cleanup(); }
});

const signInRequests = (f: ReturnType<typeof fixture>) => f.requests.filter((request) => new URL(request.url).pathname === "/claude-code/sign-in");

test("sign-in is offered only where OpenWork can run it, and uses the host token, never the workspace proxy", async () => {
  const web = fixture();
  try {
    expect(web.store.getSnapshot().claudeAgent?.canSignIn).toBe(false);
    await expect(web.store.signInClaudeAgent()).rejects.toThrow("not available");
    expect(signInRequests(web)).toHaveLength(0);
  } finally { web.cleanup(); }
  const f = fixture({ signIn: [{ status: "signed_in" }] });
  try {
    expect(f.store.getSnapshot().claudeAgent?.canSignIn).toBe(true);
    expect(await f.store.signInClaudeAgent()).toBe("Claude Code connected");
    const [start] = signInRequests(f);
    expect(start?.method).toBe("POST");
    expect(start?.headers.get("x-openwork-host-token")).toBe("fixture-host");
    expect(start?.headers.get("authorization")).toBeNull();
    expect(await start?.json()).toEqual({ force: false });
  } finally { f.cleanup(); }
});

test("a Claude Code that is already signed in connects without the browser step", async () => {
  const f = fixture({ signIn: [{ status: "signed_in" }] });
  try {
    const pending = f.store.signInClaudeAgent();
    expect(f.store.getSnapshot().claudeAgent).toMatchObject({ busy: true, checking: true, signingIn: false });
    expect(await pending).toBe("Claude Code connected");
    expect(signInRequests(f)).toHaveLength(1);
    expect(f.store.getSnapshot().claudeAgent).toMatchObject({ busy: false, checking: false, signingIn: false, verified: true });
  } finally { f.cleanup(); }
});

test("a signed-out Claude Code waits on its browser sign-in, then connects by itself", async () => {
  let waiting = false;
  const f = fixture({ login: "signed-out", signIn: [{ status: "waiting" }, { status: "waiting" }, { status: "waiting" }, { status: "signed_in" }] });
  try {
    const stop = f.store.subscribe(() => { waiting ||= f.store.getSnapshot().claudeAgent?.signingIn === true; });
    expect(await f.store.signInClaudeAgent()).toBe("Claude Code connected");
    stop();
    expect(waiting).toBe(true);
    expect(posts(f).filter((request) => request.url.endsWith("/connect/external"))).toHaveLength(1);
    expect(f.store.getSnapshot().claudeAgent).toMatchObject({ signingIn: false, verified: true, error: null });
  } finally { f.cleanup(); }
});

test("a sign-in that fails or a missing Claude Code ends with the reason and never connects", async () => {
  for (const answer of [
    { status: "failed", message: "Claude Code could not finish signing in. Sign in again, or run claude auth login in a terminal." },
    { error: 409, code: "claude_code_not_installed", message: "Claude Code is not installed. Install it, then sign in." },
  ] satisfies SignIn[]) {
    const f = fixture({ signIn: [answer] });
    try {
      await expect(f.store.signInClaudeAgent()).rejects.toThrow(answer.message);
      expect(f.store.getSnapshot().claudeAgent).toMatchObject({ busy: false, signingIn: false, error: answer.message });
      expect(posts(f).filter((request) => request.url.endsWith("/connect/external"))).toHaveLength(0);
    } finally { f.cleanup(); }
  }
});

test("after a failed check, signing in again asks for a fresh browser sign-in", async () => {
  const f = fixture({ login: "signed-out", probeReads: 2, signIn: [{ status: "waiting" }, { status: "signed_in" }] });
  try {
    await expect(f.store.connectClaudeAgent()).rejects.toThrow("not logged in");
    const pending = f.store.signInClaudeAgent();
    // The browser is certain to open, so the sheet says so straight away.
    expect(f.store.getSnapshot().claudeAgent?.signingIn).toBe(true);
    expect(await pending).toBe("Claude Code connected");
    expect(await signInRequests(f)[0]?.json()).toEqual({ force: true });
  } finally { f.cleanup(); }
});

test("cancel stops waiting, tells the server, and nothing connects", async () => {
  const f = fixture({ login: "signed-out", signIn: [{ status: "waiting" }] });
  try {
    const pending = f.store.signInClaudeAgent();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(f.store.getSnapshot().claudeAgent?.signingIn).toBe(true);
    await f.store.cancelClaudeAgentSignIn();
    expect(await pending).toBeUndefined();
    expect(signInRequests(f).at(-1)?.method).toBe("DELETE");
    expect(f.store.getSnapshot().claudeAgent).toMatchObject({ busy: false, signingIn: false, error: null });
    expect(posts(f).filter((request) => request.url.endsWith("/connect/external"))).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("a server too old to run the sign-in says to use the terminal", async () => {
  const f = fixture({ signIn: [] });
  try {
    await expect(f.store.signInClaudeAgent()).rejects.toThrow();
    expect(f.store.getSnapshot().claudeAgent?.error).toContain("Run claude auth login in a terminal");
  } finally { f.cleanup(); }
});

test("the step learns whether Claude Code is installed, and finds it once the person has installed it", async () => {
  const f = fixture({ signIn: [{ status: "idle", installed: false }, { status: "idle", installed: false }, { status: "idle", installed: true }] });
  try {
    expect(f.store.getSnapshot().claudeAgent?.installed).toBeUndefined();
    await f.store.checkClaudeAgentInstalled();
    expect(f.store.getSnapshot().claudeAgent?.installed).toBe(false);
    expect(signInRequests(f).map((request) => request.method)).toEqual(["GET"]);
    expect(signInRequests(f)[0]?.headers.get("x-openwork-host-token")).toBe("fixture-host");
    await f.store.checkClaudeAgentInstalled();
    await f.store.checkClaudeAgentInstalled();
    expect(f.store.getSnapshot().claudeAgent?.installed).toBe(true);
    // Looking never starts a sign-in or connects anything.
    expect(posts(f)).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("a missing Claude Code is remembered as not installed, and installing it clears that reason", async () => {
  const f = fixture({ signIn: [{ error: 409, code: "claude_code_not_installed", message: "Claude Code is not installed. Install it, then sign in." }, { status: "idle", installed: true }, { status: "signed_in", installed: true }] });
  try {
    await expect(f.store.signInClaudeAgent()).rejects.toThrow("not installed");
    expect(f.store.getSnapshot().claudeAgent).toMatchObject({ installed: false, error: "Claude Code is not installed. Install it, then sign in." });
    await f.store.checkClaudeAgentInstalled();
    expect(f.store.getSnapshot().claudeAgent).toMatchObject({ installed: true, error: null });
    // The new install has no login to replace: ask whether it is signed in before opening the browser.
    expect(await f.store.signInClaudeAgent()).toBe("Claude Code connected");
    expect(await signInRequests(f).at(-1)?.json()).toEqual({ force: false });
  } finally { f.cleanup(); }
});

test("where OpenWork cannot look, or the server is too old to say, installed stays unknown", async () => {
  const web = fixture();
  try {
    await web.store.checkClaudeAgentInstalled();
    expect(signInRequests(web)).toHaveLength(0);
    expect(web.store.getSnapshot().claudeAgent?.installed).toBeUndefined();
  } finally { web.cleanup(); }
  for (const signIn of [[], [{ status: "idle" }]] satisfies SignIn[][]) {
    const f = fixture({ signIn });
    try {
      await f.store.checkClaudeAgentInstalled();
      expect(f.store.getSnapshot().claudeAgent?.installed).toBeUndefined();
      expect(f.store.getSnapshot().claudeAgent?.error).toBeNull();
    } finally { f.cleanup(); }
  }
});
