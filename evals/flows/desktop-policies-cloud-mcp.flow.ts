import { execSync } from "node:child_process";
import { defineFlow } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import type { FlowContext } from "../runner/flow.ts";

// Narration is loaded from the approved script (evals/voiceovers/desktop-policies-cloud-mcp.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("desktop-policies-cloud-mcp");
if (!vo) throw new Error("Missing approved voice-over script for desktop-policies-cloud-mcp.");

const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "http://localhost:3005").trim().replace(/\/+$/, "");
const DEN_WEB_HOST = new URL(DEN_WEB_URL).host;
const DEN_DESKTOP_POLICIES_URL = new URL("/dashboard/desktop-policies", DEN_WEB_URL).toString();
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const DEFAULT_POLICY_NAME = "Default desktop policy";
const CLOUD_CONNECTION_NAMES = ["OpenWork Cloud Control", "OpenWork Cloud"];
const WRITE_SCOPES = ["mcp:read", "mcp:write"];

type ParsedFetch = {
  response: Response;
  body: unknown;
  text: string;
};

type DesktopPolicy = {
  id: string;
  policyName: string;
  isDefault: boolean;
  policy: Record<string, unknown>;
};

type CapabilityMatch = {
  name: string;
  summary: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
};

type MintedMcpToken = {
  token: string;
  organizationId: string;
  scopes: string[];
};

type FlowState = {
  adminMcpToken: string;
  adminMcpScopes: string[];
  organizationId: string;
  defaultPolicyId: string;
  defaultPolicyName: string;
  cloudConnectionName: string;
  searchMatches: CapabilityMatch[];
  searchMatchNames: string[];
  patchResultText: string;
  memberSessionToken: string;
  memberMcpToken: string;
  memberWriteErrorText: string;
};

const state: FlowState = {
  adminMcpToken: "",
  adminMcpScopes: [],
  organizationId: "",
  defaultPolicyId: "",
  defaultPolicyName: DEFAULT_POLICY_NAME,
  cloudConnectionName: "OpenWork Cloud",
  searchMatches: [],
  searchMatchNames: [],
  patchResultText: "",
  memberSessionToken: "",
  memberMcpToken: "",
  memberWriteErrorText: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const entry = value[key];
  return typeof entry === "string" ? entry : null;
}

function readNumber(value: Record<string, unknown>, key: string): number | null {
  const entry = value[key];
  return typeof entry === "number" ? entry : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function bodyPreview(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function denApiBase(ctx: FlowContext): string {
  return ctx.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
}

function adminSessionToken(ctx: FlowContext): string {
  return ctx.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? "";
}

async function parsedFetch(url: string, options: RequestInit): Promise<ParsedFetch> {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text, body: text.trim().length > 0 ? parseJsonText(text) : null };
}

async function denApiRequest(
  ctx: FlowContext,
  path: string,
  options: RequestInit = {},
  sessionToken = adminSessionToken(ctx),
): Promise<ParsedFetch> {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (sessionToken && !headers.has("authorization")) headers.set("authorization", `Bearer ${sessionToken}`);
  return parsedFetch(`${denApiBase(ctx)}${path}`, { ...options, headers });
}

async function denFetch(ctx: FlowContext, path: string, options: RequestInit = {}, sessionToken = adminSessionToken(ctx)): Promise<unknown> {
  const result = await denApiRequest(ctx, path, options, sessionToken);
  if (!result.response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${result.response.status}: ${bodyPreview(result.body)}`);
  }
  return result.body;
}

async function denWebRequest(path: string, options: RequestInit = {}): Promise<ParsedFetch> {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", DEN_WEB_URL);
  return parsedFetch(`${DEN_WEB_URL}${path}`, { ...options, headers });
}

function parseDesktopPolicy(value: unknown): DesktopPolicy | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const policyName = readString(value, "policyName");
  const policy = value.policy;
  if (!id || !policyName || !isRecord(policy)) return null;
  return { id, policyName, isDefault: value.isDefault === true, policy };
}

function parseDesktopPolicies(value: unknown): DesktopPolicy[] {
  if (!isRecord(value) || !Array.isArray(value.desktopPolicies)) return [];
  const policies: DesktopPolicy[] = [];
  for (const entry of value.desktopPolicies) {
    const policy = parseDesktopPolicy(entry);
    if (policy) policies.push(policy);
  }
  return policies;
}

function requireDefaultPolicy(value: unknown): DesktopPolicy {
  const policy = parseDesktopPolicies(value).find((entry) => entry.isDefault && entry.policyName === DEFAULT_POLICY_NAME);
  if (!policy) throw new Error("Default desktop policy was not returned by /v1/desktop-policies.");
  return policy;
}

function parseDesktopConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Desktop config was not an object: ${bodyPreview(value)}`);
  return value;
}

function parseMintedMcpToken(value: unknown): MintedMcpToken {
  if (!isRecord(value)) throw new Error(`MCP token response was not an object: ${bodyPreview(value)}`);
  const token = readString(value, "token");
  const organizationId = readString(value, "organizationId");
  const scopes = readStringArray(value.scopes);
  if (!token?.startsWith("ow_mcp_at_") || !organizationId || !scopes) {
    throw new Error(`Unexpected MCP token response: ${bodyPreview(value)}`);
  }
  return { token, organizationId, scopes };
}

async function mintMcpToken(ctx: FlowContext, sessionToken: string): Promise<MintedMcpToken> {
  const payload = await denFetch(ctx, "/v1/mcp/token", {
    method: "POST",
    body: JSON.stringify({ scopes: WRITE_SCOPES }),
  }, sessionToken);
  return parseMintedMcpToken(payload);
}

async function tryMintMcpToken(ctx: FlowContext, sessionToken: string): Promise<MintedMcpToken | null> {
  const result = await denApiRequest(ctx, "/v1/mcp/token", {
    method: "POST",
    body: JSON.stringify({ scopes: WRITE_SCOPES }),
  }, sessionToken);
  if (!result.response.ok) {
    ctx.log(`Member MCP token mint not ready yet: ${result.response.status} ${result.text.slice(0, 200)}`);
    return null;
  }
  return parseMintedMcpToken(result.body);
}

function toolContentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const first = result.content[0];
  if (!isRecord(first)) return "";
  return readString(first, "text") ?? "";
}

function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

async function mcpCallTo(ctx: FlowContext, path: string, mcpToken: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${denApiBase(ctx)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const raw = await response.text();
  ctx.assert(response.ok, `MCP ${method} (${path}) failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (typeof dataLine !== "string") {
    ctx.assert(false, `MCP ${method} (${path}) returned no data frame: ${raw.slice(0, 300)}`);
    throw new Error("MCP response missing data frame.");
  }
  const parsed = parseJsonText(dataLine.slice(5));
  if (!isRecord(parsed)) throw new Error(`MCP ${method} returned non-object JSON-RPC payload: ${dataLine.slice(5)}`);
  ctx.assert(!parsed.error, `MCP ${method} (${path}) returned a JSON-RPC error: ${bodyPreview(parsed.error)}`);
  return parsed.result;
}

async function mcpAgentCall(ctx: FlowContext, mcpToken: string, method: string, params: unknown): Promise<unknown> {
  return mcpCallTo(ctx, "/mcp/agent", mcpToken, method, params);
}

function parseCapabilityMatch(value: unknown): CapabilityMatch | null {
  if (!isRecord(value)) return null;
  const name = readString(value, "name");
  if (!name) return null;
  return {
    name,
    summary: readString(value, "summary") ?? "",
    pathParams: readStringArray(value.pathParams) ?? [],
    queryParams: readStringArray(value.queryParams) ?? [],
    hasBody: value.hasBody === true,
  };
}

function parseCapabilitySearchResult(result: unknown): CapabilityMatch[] {
  const text = toolContentText(result);
  const parsed = parseJsonText(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.matches)) return [];
  const matches: CapabilityMatch[] = [];
  for (const entry of parsed.matches) {
    const match = parseCapabilityMatch(entry);
    if (match) matches.push(match);
  }
  return matches;
}

async function searchCapabilities(ctx: FlowContext, query: string): Promise<CapabilityMatch[]> {
  const result = await mcpAgentCall(ctx, state.adminMcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query, limit: 20, type: "api" },
  });
  const matches = parseCapabilitySearchResult(result);
  ctx.assert(matches.length > 0, `No capability matches returned for ${query}.`);
  return matches;
}

function uniqueMatches(matches: CapabilityMatch[]): CapabilityMatch[] {
  const seen = new Set<string>();
  const unique: CapabilityMatch[] = [];
  for (const match of matches) {
    if (seen.has(match.name)) continue;
    seen.add(match.name);
    unique.push(match);
  }
  return unique;
}

function parsePolicyFromToolResult(result: unknown): DesktopPolicy | null {
  const parsed = parseJsonText(toolContentText(result));
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.desktopPolicies)) {
    return parseDesktopPolicies(parsed).find((entry) => entry.isDefault && entry.policyName === DEFAULT_POLICY_NAME) ?? null;
  }
  const fromResponse = parseDesktopPolicy(parsed.desktopPolicy);
  return fromResponse?.isDefault === true ? fromResponse : null;
}

async function readDefaultPolicyViaMcp(ctx: FlowContext): Promise<DesktopPolicy> {
  const result = await mcpAgentCall(ctx, state.adminMcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: "getDesktopPolicies" },
  });
  ctx.assert(!isToolError(result), `getDesktopPolicies returned an MCP tool error: ${toolContentText(result).slice(0, 300)}`);
  const policy = parsePolicyFromToolResult(result);
  ctx.assert(Boolean(policy), `getDesktopPolicies did not include the default policy: ${toolContentText(result).slice(0, 300)}`);
  if (!policy) throw new Error("Default policy missing from getDesktopPolicies response.");
  return policy;
}

async function patchDefaultPolicyDirect(ctx: FlowContext, allowCustomProviders: boolean): Promise<DesktopPolicy> {
  const current = requireDefaultPolicy(await denFetch(ctx, "/v1/desktop-policies"));
  const payload = await denFetch(ctx, `/v1/desktop-policies/${encodeURIComponent(current.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      policyName: current.policyName,
      policy: { allowCustomProviders },
    }),
  });
  if (!isRecord(payload)) throw new Error(`PATCH desktop policy response was not an object: ${bodyPreview(payload)}`);
  const patched = parseDesktopPolicy(payload.desktopPolicy);
  if (!patched) throw new Error(`PATCH desktop policy response did not include a policy: ${bodyPreview(payload)}`);
  state.defaultPolicyId = patched.id;
  state.defaultPolicyName = patched.policyName;
  return patched;
}

async function currentDesktopConfig(ctx: FlowContext): Promise<Record<string, unknown>> {
  return parseDesktopConfig(await denFetch(ctx, "/v1/me/desktop-config"));
}

async function syncConfigToApp(ctx: FlowContext): Promise<Record<string, unknown>> {
  const config = await currentDesktopConfig(ctx);
  await ctx.waitFor("typeof window.__openworkApplyDesktopConfig === 'function'", {
    timeoutMs: 30_000,
    label: "desktop config bridge",
  });
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.react.settings.theme-mode', 'light');
    window.__openworkApplyDesktopConfig(${JSON.stringify(config)});
    return true;
  })()`);
  return config;
}

async function revealHidden(ctx: FlowContext): Promise<void> {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (showing) return;
  if (await ctx.hasText("Show hidden")) await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
}

async function resolveCloudConnectionName(ctx: FlowContext): Promise<string> {
  for (const name of CLOUD_CONNECTION_NAMES) {
    if (await ctx.hasText(name)) return name;
  }
  throw new Error("OpenWork Cloud connection name was not visible after revealing hidden extensions.");
}

async function ensureDesktopSignedIn(ctx: FlowContext): Promise<void> {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API" });
  const signedIn = await ctx.eval("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())");
  if (!signedIn) {
    const handoff = await denFetch(ctx, "/v1/auth/desktop-handoff", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!isRecord(handoff)) throw new Error(`Desktop handoff response was not an object: ${bodyPreview(handoff)}`);
    const grant = readString(handoff, "grant");
    ctx.assert(Boolean(grant), `Desktop handoff response did not include a grant: ${bodyPreview(handoff)}`);
    await ctx.control("auth.exchange-grant", { grant });
    await ctx.waitFor(
      "window.__openworkControl.execute('auth.status').then(r => r.result?.status === 'signed_in')",
      { timeoutMs: 30_000, label: "desktop auth signed in" },
    );
  } else {
    ctx.log("Desktop already signed in; reusing session.");
  }

  await ctx.waitFor(
    "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())",
    { timeoutMs: 60_000, label: "active org" },
  );

  const onOnboarding = await ctx.eval("location.hash.includes('/onboarding')");
  if (onOnboarding) {
    await ctx.clickText("Continue with organization", { timeoutMs: 20_000 }).catch(() => undefined);
    await ctx.clickText("Continue to workspace", { timeoutMs: 20_000 }).catch(() => undefined);
  }

  const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
  if (onWelcome) {
    const workspacePath = ctx.env.OPENWORK_EVAL_WORKSPACE_PATH?.trim() ?? "";
    ctx.assert(Boolean(workspacePath), "Desktop landed on /welcome; set OPENWORK_EVAL_WORKSPACE_PATH so the eval can create/select a workspace.");
    await ctx.fill("input", workspacePath);
    await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
    await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 30_000, label: "workspace route after creation" });
  }

  // Cloud MCP auto-config only syncs once a workspace exists. Fresh sandboxes
  // land on #/session with a "Create or connect a workspace" empty state.
  const needsWorkspace = await ctx.eval("document.body.innerText.includes('Create or connect a workspace')");
  if (needsWorkspace) {
    const workspacePath = ctx.env.OPENWORK_EVAL_WORKSPACE_PATH?.trim() ?? "";
    ctx.assert(Boolean(workspacePath), "No workspace exists; set OPENWORK_EVAL_WORKSPACE_PATH so the eval can create one.");
    await ctx.control("workspace.create", { path: workspacePath });
    await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace route after control creation" });
  }

  // The sync marker records the first successful cloud MCP reconciliation for
  // a scope; on resumed profiles the connection can already be configured, in
  // which case maintenance reports "ok" without rewriting the marker.
  await ctx.waitFor(
    "Boolean(localStorage.getItem('openwork.den.mcp.sync')) || (localStorage.getItem('openwork.den.mcp.lastMaintenanceOutcome') ?? '').includes('\"status\":\"ok\"')",
    { timeoutMs: 180_000, label: "cloud MCP sync marker or healthy maintenance outcome" },
  );
}

async function enterDenPolicies(ctx: FlowContext): Promise<void> {
  // The built-in browser control action registers with the session page, so
  // leave settings for the sessions home and open an empty session first.
  await ctx.navigateHash("/session");
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "session.create_task action available" },
  );
  // The action can flicker to disabled while the workspace runtime boots.
  const createTaskDeadline = Date.now() + 45_000;
  for (;;) {
    try {
      await ctx.control("session.create_task");
      break;
    } catch (error) {
      if (Date.now() > createTaskDeadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'browser.open_url' && !action.disabled)",
    { timeoutMs: 60_000, label: "browser.open_url action available" },
  );
  await ctx.switchToNewTab({
    label: "Den web desktop policies",
    timeoutMs: 60_000,
    match: (target) => target.url.includes(DEN_WEB_HOST),
    trigger: async () => {
      await ctx.control("browser.open_url", { url: DEN_WEB_URL });
    },
  });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 60_000, label: "Den web" });
  const signIn = await ctx.eval(`fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} }),
  }).then(async (response) => ({ status: response.status, body: await response.text() }))`, { awaitPromise: true });
  const status = isRecord(signIn) ? readNumber(signIn, "status") : null;
  const body = isRecord(signIn) ? readString(signIn, "body") ?? "" : "";
  ctx.assert(status === 200, `Den browser sign-in failed: ${status ?? "unknown"} ${body}`);
  await ctx.eval(`location.assign(${JSON.stringify(DEN_DESKTOP_POLICIES_URL)})`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 60_000, label: "Den desktop policies route" });
  await ctx.waitFor(`document.body.innerText.includes('Desktop policies') && document.body.innerText.includes('New policy') && document.body.innerText.includes(${JSON.stringify(DEFAULT_POLICY_NAME)})`, {
    timeoutMs: 60_000,
    label: "desktop policies page",
  });
}

async function closeBuiltInBrowserTabs(ctx: FlowContext): Promise<void> {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__)", { timeoutMs: 10_000, label: "Electron bridge before closing browser tabs" });
  await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__;
    if (!bridge) throw new Error('Electron bridge is unavailable.');
    if (bridge.invokeDesktop) {
      try {
        return await bridge.invokeDesktop('openwork:browser:closeAllTabs');
      } catch (error) {
        if (!String(error).includes('not implemented')) throw error;
      }
    }
    if (bridge.browser?.closeAllTabs) return bridge.browser.closeAllTabs();
    throw new Error('Browser closeAllTabs IPC is unavailable.');
  })()`, { awaitPromise: true });
}

async function signInApi(email: string, password: string): Promise<string | null> {
  const result = await denWebRequest("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!result.response.ok || !isRecord(result.body)) return null;
  return readString(result.body, "token");
}

async function inviteMember(ctx: FlowContext): Promise<string> {
  const invitation = await denFetch(ctx, "/v1/invitations", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  if (!isRecord(invitation)) throw new Error(`Invitation response was not an object: ${bodyPreview(invitation)}`);
  const inviteToken = readString(invitation, "inviteToken");
  if (!inviteToken) throw new Error(`Invitation response did not include inviteToken: ${bodyPreview(invitation)}`);
  return inviteToken;
}

function markMemberVerifiedIfConfigured(ctx: FlowContext): void {
  const command = ctx.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() ?? "";
  if (!command) return;
  execSync(command.replaceAll("{email}", MEMBER_EMAIL), { stdio: "ignore" });
  ctx.log(`Marked ${MEMBER_EMAIL} verified through OPENWORK_EVAL_MARK_VERIFIED_CMD.`);
}

async function acceptInvitation(ctx: FlowContext, memberSessionToken: string, inviteToken: string): Promise<void> {
  const accept = await denApiRequest(ctx, "/v1/orgs/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ id: inviteToken }),
  }, memberSessionToken);
  if (accept.response.ok) return;
  const text = bodyPreview(accept.body);
  if (/email.*verif/i.test(text) && !(ctx.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim())) {
    throw new Error(`Member invitation accept requires email verification; set OPENWORK_EVAL_MARK_VERIFIED_CMD. Response: ${accept.response.status} ${text}`);
  }
  throw new Error(`Member invitation accept failed: ${accept.response.status} ${text}`);
}

async function ensureMemberMcpToken(ctx: FlowContext): Promise<MintedMcpToken> {
  let memberSession = await signInApi(MEMBER_EMAIL, MEMBER_PASSWORD);
  let inviteToken = "";
  if (!memberSession) {
    ctx.log(`Member ${MEMBER_EMAIL} cannot sign in yet; creating an invitation and signing up.`);
    inviteToken = await inviteMember(ctx);
    const signUp = await denWebRequest("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
    });
    ctx.assert(signUp.response.ok, `Member sign-up failed: ${signUp.response.status} ${signUp.text.slice(0, 200)}`);
    markMemberVerifiedIfConfigured(ctx);
    memberSession = await signInApi(MEMBER_EMAIL, MEMBER_PASSWORD);
    ctx.assert(Boolean(memberSession), "Member sign-in still failed after sign-up.");
  }

  if (!memberSession) throw new Error("Member session token missing after bootstrap.");
  state.memberSessionToken = memberSession;
  const mintedBeforeInvite = await tryMintMcpToken(ctx, memberSession);
  if (mintedBeforeInvite) return mintedBeforeInvite;

  if (!inviteToken) inviteToken = await inviteMember(ctx);
  markMemberVerifiedIfConfigured(ctx);
  await acceptInvitation(ctx, memberSession, inviteToken);
  const mintedAfterInvite = await tryMintMcpToken(ctx, memberSession);
  if (!mintedAfterInvite) throw new Error("Member MCP token could not be minted after accepting the invitation.");
  return mintedAfterInvite;
}

export default defineFlow({
  id: "desktop-policies-cloud-mcp",
  title: "Desktop Policies are discoverable and enforce permissions through OpenWork Cloud MCP",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Setup: desktop signed in, default policy reset, admin MCP token minted",
      run: async (ctx) => {
        await ensureDesktopSignedIn(ctx);

        const baseline = await patchDefaultPolicyDirect(ctx, true);
        ctx.assert(baseline.policy.allowCustomProviders === true, "Baseline reset did not explicitly allow custom providers.");
        const config = await currentDesktopConfig(ctx);
        ctx.assert(config.allowCustomProviders !== false, `Baseline desktop config still restricts custom providers: ${bodyPreview(config)}`);

        const minted = await mintMcpToken(ctx, adminSessionToken(ctx));
        state.adminMcpToken = minted.token;
        state.adminMcpScopes = minted.scopes;
        state.organizationId = minted.organizationId;
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "Default desktop policy was reset through the admin API and an org-scoped read/write MCP token was minted for Alex.",
          actual: { defaultPolicyId: baseline.id, organizationId: minted.organizationId, scopes: minted.scopes },
        });
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Capability search returns the desktop policy tools through OpenWork Cloud MCP", {
          voiceover: vo[0],
          action: async () => {
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.expectHashIncludes("/settings/extensions/mcp");
            await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
            await revealHidden(ctx);
            state.cloudConnectionName = await resolveCloudConnectionName(ctx);

            const primaryMatches = await searchCapabilities(ctx, "desktop policy");
            const primaryNames = primaryMatches.map((match) => match.name);
            ctx.assert(primaryNames.includes("getDesktopPolicies"), `desktop policy search missing getDesktopPolicies: ${primaryNames.join(", ")}`);
            ctx.assert(primaryNames.includes("patchDesktopPolicies"), `desktop policy search missing patchDesktopPolicies: ${primaryNames.join(", ")}`);

            let combined = primaryMatches;
            if (!primaryNames.includes("postDesktopPolicies") || !primaryNames.includes("deleteDesktopPolicies")) {
              const writeMatches = await searchCapabilities(ctx, "create delete desktop policy");
              combined = uniqueMatches([...primaryMatches, ...writeMatches]);
            }
            state.searchMatches = combined;
            state.searchMatchNames = combined.map((match) => match.name);
          },
          assert: async () => {
            for (const name of ["getDesktopPolicies", "postDesktopPolicies", "patchDesktopPolicies", "deleteDesktopPolicies"]) {
              ctx.assert(state.searchMatchNames.includes(name), `Capability search did not expose ${name}; observed ${state.searchMatchNames.join(", ")}`);
            }
            await ctx.expectText(state.cloudConnectionName, { timeoutMs: 30_000 });
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "search_capabilities returned all desktop-policy CRUD capabilities from the live /mcp/agent catalog.",
              actual: state.searchMatches,
            });
          },
          screenshot: {
            name: "frame-1-desktop-policy-capabilities",
            requireText: [state.cloudConnectionName],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The read capability returns the default desktop policy with custom providers allowed", {
          voiceover: vo[1],
          action: async () => {
            const policy = await readDefaultPolicyViaMcp(ctx);
            state.defaultPolicyId = policy.id;
            state.defaultPolicyName = policy.policyName;
            const config = await syncConfigToApp(ctx);
            ctx.assert(config.allowCustomProviders !== false, `Effective desktop config restricted custom providers before the update: ${bodyPreview(config)}`);
            await ctx.navigateHash("/settings/general");
            await ctx.waitForText("Settings", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const policy = await readDefaultPolicyViaMcp(ctx);
            ctx.assert(policy.isDefault === true, "getDesktopPolicies did not return the default policy.");
            ctx.assert(policy.policyName === DEFAULT_POLICY_NAME, `Default policy name mismatch: ${policy.policyName}`);
            ctx.assert(policy.policy.allowCustomProviders === true, `Expected custom providers allowed, got ${bodyPreview(policy.policy)}`);
            const config = await currentDesktopConfig(ctx);
            ctx.assert(config.allowCustomProviders !== false, `Effective config unexpectedly disabled custom providers: ${bodyPreview(config)}`);
            const noBanner = await ctx.eval("!document.querySelector('[data-testid=\"desktop-policy-banner\"]')");
            ctx.assert(noBanner, "Policy banner should not be visible while every default policy boolean is allowed.");
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "execute_capability(getDesktopPolicies) returned the default policy with allowCustomProviders=true, and the desktop config has no active restriction.",
              actual: { policy, desktopConfig: config },
            });
          },
          screenshot: {
            name: "frame-2-custom-providers-allowed",
            requireText: ["Settings"],
            rejectText: ["Organization policies active", "Something went wrong"],
            hashIncludes: "/settings/general",
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The update capability switches custom providers off through the guarded policy route", {
          voiceover: vo[2],
          action: async () => {
            const desktopPolicyId = state.defaultPolicyId || requireDefaultPolicy(await denFetch(ctx, "/v1/desktop-policies")).id;
            const result = await mcpAgentCall(ctx, state.adminMcpToken, "tools/call", {
              name: "execute_capability",
              arguments: {
                name: "patchDesktopPolicies",
                path: { desktopPolicyId },
                body: {
                  policyName: state.defaultPolicyName,
                  policy: { allowCustomProviders: false },
                },
              },
            });
            state.patchResultText = toolContentText(result);
            ctx.assert(!isToolError(result), `patchDesktopPolicies returned an MCP tool error: ${state.patchResultText.slice(0, 300)}`);
            const updated = parsePolicyFromToolResult(result);
            ctx.assert(Boolean(updated), `patchDesktopPolicies did not return the updated policy: ${state.patchResultText.slice(0, 300)}`);
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const reread = await readDefaultPolicyViaMcp(ctx);
            ctx.assert(reread.policy.allowCustomProviders === false, `MCP reread did not show custom providers disabled: ${bodyPreview(reread.policy)}`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "execute_capability(patchDesktopPolicies) succeeded, and a live reread shows allowCustomProviders=false on the default policy.",
              actual: { patchResponse: parseJsonText(state.patchResultText), reread },
            });
          },
          screenshot: {
            name: "frame-3-policy-patched-through-mcp",
            requireText: ["Add Custom App"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The cloud dashboard editor shows Custom providers restricted", {
          voiceover: vo[3],
          action: async () => {
            await enterDenPolicies(ctx);
            await ctx.waitForText(DEFAULT_POLICY_NAME, { timeoutMs: 30_000 });
            const clicked = await ctx.eval(`(() => {
              const rows = [...document.querySelectorAll('tr')];
              const row = rows.find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(DEFAULT_POLICY_NAME)}));
              const link = row ? [...row.querySelectorAll('a, button')].find((entry) => (entry.textContent ?? '').trim() === 'Edit') : null;
              if (!link) return false;
              link.scrollIntoView({ block: 'center' });
              link.click();
              return true;
            })()`);
            ctx.assert(clicked, "Could not click into the default desktop policy row.");
            await ctx.waitForText("Edit desktop policy", { timeoutMs: 30_000 });
            await ctx.waitForText("Custom providers", { timeoutMs: 30_000 });
            const found = await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) => (entry.textContent ?? '').includes('Custom providers'));
              label?.scrollIntoView({ block: 'center' });
              return Boolean(label);
            })()`);
            ctx.assert(found, "Custom providers label was not found in the policy editor.");
          },
          assert: async () => {
            const checked = await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) => (entry.textContent ?? '').includes('Custom providers'));
              const input = label?.querySelector('input[type="checkbox"]');
              return input instanceof HTMLInputElement ? input.checked : 'missing';
            })()`);
            ctx.assert(checked === false, `Expected Custom providers checkbox unchecked after MCP update, got ${String(checked)}.`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "Den web's Desktop Policies editor renders the Custom providers checkbox unchecked for the default policy.",
              actual: { checked },
            });
          },
          screenshot: {
            name: "frame-4-den-dashboard-restricted",
            requireText: ["Custom providers"],
            rejectText: ["Something went wrong", "Failed to load"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The desktop app picks up the restricted config and shows the organization policy banner", {
          voiceover: vo[4],
          action: async () => {
            await ctx.switchBack();
            await closeBuiltInBrowserTabs(ctx);
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API after closing Den web tab" });
            const config = await syncConfigToApp(ctx);
            ctx.assert(config.allowCustomProviders === false, `Effective desktop config did not restrict custom providers: ${bodyPreview(config)}`);
            await ctx.navigateHash("/settings/general");
            await ctx.waitForText("Settings", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"desktop-policy-banner\"]'))", {
              timeoutMs: 10_000,
              label: "desktop policy banner",
            });
            await ctx.expectText("Organization policies active", { timeoutMs: 10_000 });
            const config = await currentDesktopConfig(ctx);
            ctx.assert(config.allowCustomProviders === false, `Admin reread no longer shows the custom provider restriction: ${bodyPreview(config)}`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "The effective desktop config contains allowCustomProviders=false and the running app renders the policy banner.",
              actual: config,
            });
          },
          screenshot: {
            name: "frame-5-desktop-policy-banner",
            requireText: ["Organization policies active"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/general",
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("An ordinary member's write through execute_capability is refused and the policy stays locked", {
          voiceover: vo[5],
          action: async () => {
            const memberMcp = await ensureMemberMcpToken(ctx);
            state.memberMcpToken = memberMcp.token;
            const result = await mcpAgentCall(ctx, memberMcp.token, "tools/call", {
              name: "execute_capability",
              arguments: {
                name: "patchDesktopPolicies",
                path: { desktopPolicyId: state.defaultPolicyId },
                body: {
                  policyName: state.defaultPolicyName,
                  policy: { allowCustomProviders: true },
                },
              },
            });
            state.memberWriteErrorText = toolContentText(result);
            ctx.assert(isToolError(result), `Member patch unexpectedly succeeded: ${state.memberWriteErrorText.slice(0, 300)}`);
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
          },
          assert: async () => {
            ctx.assert(/forbidden|permission|403/i.test(state.memberWriteErrorText), `Member write error did not reference forbidden/permission/403: ${state.memberWriteErrorText}`);
            const reread = await readDefaultPolicyViaMcp(ctx);
            ctx.assert(reread.policy.allowCustomProviders === false, `Member write changed the policy unexpectedly: ${bodyPreview(reread.policy)}`);
            await ctx.expectText("Organization policies active", { timeoutMs: 10_000 });
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "Jordan's read/write-scoped MCP token receives a forbidden permission error on patchDesktopPolicies, and Alex's reread proves allowCustomProviders remains false.",
              actual: { memberError: parseJsonText(state.memberWriteErrorText), reread, memberMcpScopes: WRITE_SCOPES },
            });
          },
          screenshot: {
            name: "frame-6-member-write-refused",
            requireText: ["Organization policies active"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Cleanup: restore the default policy",
      run: async (ctx) => {
        await patchDefaultPolicyDirect(ctx, true);
        const config = await currentDesktopConfig(ctx);
        ctx.assert(config.allowCustomProviders !== false, `Cleanup did not restore custom providers: ${bodyPreview(config)}`);
        await syncConfigToApp(ctx);
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "Cleanup restored allowCustomProviders=true on the default desktop policy and pushed the refreshed config into the app.",
          actual: config,
        });
      },
    },
  ],
});
