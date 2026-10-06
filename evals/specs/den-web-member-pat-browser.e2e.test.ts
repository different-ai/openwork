import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect } from "vitest";
import type { DenSession } from "@openwork/testkit";
import { allocateFreePorts, listTargets, setViewport, type Surface, chrome, faultProxy as startFaultProxy } from "@openwork/testkit";
import { requireOwnedDen } from "./member-api-key-fixture";
import { eventually, inviteMember, mcpMock, spec, type Probe, type Seed, type User, type Place } from "@openwork/testkit";

const CONNECTION_NAME = "Synthetic Personal Keys";
const SHARED_NAME = "Synthetic Shared Key Control";
const OAUTH_NAME = "Synthetic OAuth Control";
const ALPHA_KEY = "synthetic-member-alpha-key";
const BETA_KEY = "synthetic-member-beta-key";
const SHARED_KEY = "synthetic-shared-control-key";
const READINESS_TIMEOUT_MS = 120_000;
const BROWSER_TIMEOUT_MS = 300_000;

const test = spec.world(memberKeyBrowserWorld, {
  timeout: READINESS_TIMEOUT_MS + BROWSER_TIMEOUT_MS,
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) throw new Error(`Missing ${key}`);
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key}`);
  return field;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function signInThroughTheBrowser(person: User, session: DenSession): Promise<void> {
  await person.see({ role: "textbox", label: /^email$/i }, { timeoutMs: READINESS_TIMEOUT_MS });
  await person.type({ role: "textbox", label: /^email$/i }, session.email);
  await person.click({ role: "button", label: "Next" });
  await person.see({ role: "textbox", label: /^password$/i }, { timeoutMs: 30_000 });
  await person.type({ role: "textbox", label: /^password$/i }, session.password, { sensitive: true });
  await person.click({ role: "button", label: "Sign in" });
  await person.see({ testId: "den-org-sidebar" }, { timeoutMs: READINESS_TIMEOUT_MS });
}

async function pageTargetIds(surface: Surface): Promise<string[]> {
  return (await listTargets(surface.handle.cdpUrl))
    .filter((target) => target.type === "page")
    .map((target) => target.id)
    .sort();
}

async function dialogSecurity(probe: Probe, connectionName: string) {
  const state = await probe.credentialInputState(`input[aria-label="${connectionName} key"]`);
  const { dialogPresent, dialogExcludedFromCapture, inputExcludedFromCapture, inputType, autoComplete, empty } = state;
  return { dialogPresent, dialogExcludedFromCapture, inputExcludedFromCapture, inputType, autoComplete, empty };
}

async function secretChannels(probe: Probe, connectionName: string, secret: string) {
  const state = await probe.credentialInputState(`input[aria-label="${connectionName} key"]`, secret);
  const { inputContainsSecret, bodyContainsSecret, urlContainsSecret, historyContainsSecret, storageContainsSecret } = state;
  return { inputContainsSecret, bodyContainsSecret, urlContainsSecret, historyContainsSecret, storageContainsSecret };
}

function connectionRows(body: unknown): JsonRecord[] {
  return isRecord(body) ? records(body.connections) : [];
}

async function connectionFor(probe: Probe, session: DenSession, connectionId: string): Promise<JsonRecord> {
  const response = await probe.api(session, "/v1/mcp-connections?scope=usable");
  expect(response.response.status, response.text).toBe(200);
  const connection = connectionRows(response.body).find((entry) => entry.id === connectionId);
  if (!connection) throw new Error(`Connection ${connectionId} is not usable by ${session.email}`);
  return connection;
}

async function invokeIdentityProbe(token: string, apiUrl: string, connectionId: string): Promise<boolean> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "execute_capability", arguments: { name: `mcp:${connectionId}:identity_probe`, body: {} } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  const payload: unknown = JSON.parse(data ? data.slice(5) : text);
  return isRecord(payload) && isRecord(payload.result) && payload.result.isError === true;
}

async function addMemberKey(input: {
  person: User;
  page: Probe;
  surface: Surface;
  connectionId: string;
  secret: string;
}): Promise<void> {
  const targetsBefore = await pageTargetIds(input.surface);
  await input.person.click({ testId: `connect-my-mcp-account-${input.connectionId}` });
  await input.person.see({ testId: "member-api-key-dialog" }, { timeoutMs: 30_000 });
  expect(await dialogSecurity(input.page, CONNECTION_NAME)).toEqual({
    dialogPresent: true,
    dialogExcludedFromCapture: true,
    inputExcludedFromCapture: true,
    inputType: "password",
    autoComplete: "off",
    empty: true,
  });
  await input.person.screenshot();

  await input.person.type({ label: `${CONNECTION_NAME} key` }, input.secret, { sensitive: true });
  expect(await secretChannels(input.page, CONNECTION_NAME, input.secret)).toEqual({
    inputContainsSecret: true,
    bodyContainsSecret: false,
    urlContainsSecret: false,
    historyContainsSecret: false,
    storageContainsSecret: false,
  });
  await input.person.click({ role: "button", label: "Save key" });
  await input.person.see({ role: "heading", label: `${CONNECTION_NAME}: key saved` }, { timeoutMs: 30_000 });
  expect(await secretChannels(input.page, CONNECTION_NAME, input.secret)).toEqual({
    inputContainsSecret: false,
    bodyContainsSecret: false,
    urlContainsSecret: false,
    historyContainsSecret: false,
    storageContainsSecret: false,
  });
  await input.person.screenshot();
  await input.person.click({ role: "button", label: "Done" });
  await input.person.see({ text: "Key saved" }, { timeoutMs: 30_000 });
  expect(await pageTargetIds(input.surface)).toEqual(targetsBefore);
}

async function memberKeyBrowserWorld(seed: Seed, { place }: { place: Place }) {
  requireOwnedDen();
  const [apiPort, webPort] = await allocateFreePorts(2);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const proxy = await startFaultProxy({ apiUrl: apiOrigin, webUrl: apiOrigin }, { place });
  const den = await seed.den({
    web: true,
    ports: { api: apiPort, web: webPort },
    webApiBase: proxy.ref.webUrl,
    env: { DEN_API_PUBLIC_URL: proxy.ref.webUrl, DEN_PLAN_GATING_ENABLED: "false", OPENWORK_DEV_MODE: "1" },
    org: { name: "Personal Keys Browser Fixture", admin: { name: "Fixture Admin" } },
    mocks: {
      keyed: mcpMock({
        allowUnauthenticatedMcp: true,
        isolatedProcessEnv: true,
        tools: [{
          name: "identity_probe",
          description: "Return a synthetic identity marker.",
          inputSchema: { type: "object" },
          result: { content: [{ type: "text", text: "synthetic provider response" }] },
        }],
      }),
      oauth: mcpMock({ isolatedProcessEnv: true }),
    },
  });
  const alpha = await inviteMember(den, "alpha", { name: "Member A", password: `Aa1!${randomBytes(18).toString("base64url")}` });
  const beta = await inviteMember(den, "beta", { name: "Member B", password: `Aa1!${randomBytes(18).toString("base64url")}` });

  const accepted = new Set<string>();
  const wire: { fingerprint: string; status: number; scheme: string }[] = [];
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const authorization = request.headers.authorization ?? "";
    const scheme = authorization.startsWith("Token ") ? "Token" : authorization.startsWith("Bearer ") ? "Bearer" : "none";
    const key = authorization.replace(/^(?:Bearer|Token) /, "");
    const keyFingerprint = fingerprint(key);
    if (!accepted.has(key)) {
      wire.push({ fingerprint: keyFingerprint, status: 401, scheme });
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "invalid_credential" }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const upstream = await fetch(den.mocks.keyed.mcpUrl, {
      method: request.method,
      headers,
      ...(body.length > 0 ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    wire.push({ fingerprint: keyFingerprint, status: upstream.status, scheme });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  const ownedWitness = {
    [Symbol.asyncDispose]: () => new Promise<void>((resolve, reject) => {
      witness.closeAllConnections();
      witness.close((error) => error ? reject(error) : resolve());
    }),
  };
  void ownedWitness;
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("The synthetic key witness did not bind a TCP port");
  const witnessUrl = `http://127.0.0.1:${address.port}/mcp`;
  await proxy.faults.status("/v1/mcp-connections/presets", 200, {
    times: 100,
    body: { presets: [{ presetId: "synthetic-personal-keys", displayName: CONNECTION_NAME, description: "A local per-person key witness.", url: witnessUrl, authType: "apikey" }] },
  });
  await proxy.faults.status("/v1/mcp-connections/discover", 200, {
    times: 100,
    body: {
      status: "manual_action_required",
      server: { url: witnessUrl, protocolVersion: "2025-06-18", initialize: "authentication_required" },
      authentication: {
        kind: "manual_bearer",
        authorizationServers: [],
        requiredScopes: [],
        recommendedScopes: [],
        refreshSupport: "unknown",
        availableRegistrationMethods: ["pre_registered"],
        recommendedRegistrationMethod: "pre_registered",
      },
      tools: { visibility: "requires_auth" },
      manualRequirements: [{ code: "api_key", label: "API key", reason: "Each member supplies a key.", required: true }],
      warnings: [],
    },
  });

  accepted.add(SHARED_KEY);
  const shared = await seed.api(den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({ name: SHARED_NAME, url: `${witnessUrl}/shared-control`, authType: "apikey", credentialMode: "shared", apiKey: SHARED_KEY, access: { orgWide: true } }) });
  expect(shared.response.status).toBe(200);
  const oauth = await seed.api(den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({ name: OAUTH_NAME, url: den.mocks.oauth.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } }) });
  expect(oauth.response.status).toBe(200);
  const sharedId = stringField(shared.body, "id");
  const oauthId = stringField(oauth.body, "id");
  const tokens = new Map<string, string>();
  for (const member of [alpha, beta]) {
    const minted = await seed.api(member, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    expect(minted.response.status).toBe(200);
    tokens.set(member.email, stringField(minted.body, "token"));
  }
  const tokenFor = (member: DenSession) => {
    const token = tokens.get(member.email);
    if (!token) throw new Error("Missing owned member MCP token");
    return token;
  };
  return { den, proxy, alpha, beta, accepted, wire, sharedId, oauthId, tokenFor,
    async [Symbol.asyncDispose]() { await ownedWitness[Symbol.asyncDispose](); await proxy[Symbol.asyncDispose](); },
  };
}

test("Den Web gives two ordinary members private keys on one admin-created connection", async ({ world, evidence, place, probe, step, user }) => {
  const { den, proxy, alpha, beta, accepted, wire, sharedId, oauthId, tokenFor } = world;
  for (const member of [alpha, beta]) {
    const org = await probe.api(member, "/v1/org");
    expect(org.response.status, org.text).toBe(200);
    const currentMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
    expect(currentMember).toMatchObject({ role: "member", isOwner: false });
  }
  evidence.recordAssertionEvidence(
    "Both key holders are ordinary organization members",
    "The isolated Den reports role=member and isOwner=false for Alex and Blair before either browser signs in.",
    true,
  );

  let connectionId = "";
  await step("an administrator selects individual API keys and publishes one central connection", async () => {
    await using adminBrowser = await chrome({ name: "member-pat-admin", host: place.host(), startUrl: den.ref.webUrl, headless: true });
    await setViewport(adminBrowser, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    const admin = user.on(adminBrowser);
    const adminPage = probe.on(adminBrowser);
    await signInThroughTheBrowser(admin, den.admin);
    await admin.navigate(`${den.ref.webUrl}/dashboard/mcp-connections/new`);
    await admin.see({ role: "heading", label: "Add a connector" }, { timeoutMs: READINESS_TIMEOUT_MS });
    await admin.click({ role: "link", label: `Add ${CONNECTION_NAME}` });
    await admin.see({ role: "heading", label: `Add ${CONNECTION_NAME}` }, { timeoutMs: READINESS_TIMEOUT_MS });
    await admin.see({ role: "radio", label: /Each person adds a key/ });
    await admin.click({ role: "radio", label: /Each person adds a key/ });
    // The scheme is advanced, rarely changed configuration: collapsed by default (DESIGN P3).
    await admin.notSee({ role: "button", label: /Authorization scheme/ });
    await admin.click({ text: "Advanced" });
    await admin.see({ role: "button", label: /Authorization scheme/ }, { text: "Bearer" });
    await admin.click({ role: "button", label: /Authorization scheme/ });
    expect((await adminPage.dom('[role="listbox"] [role="option"]')).elements.map(option => option.text)).toEqual(["Bearer", "Token"]);
    await admin.click({ role: "option", nth: 1 });
    await admin.see({ role: "button", label: /Authorization scheme/ }, { text: "Token" });
    await admin.see({ role: "button", label: "Use individual keys" });
    await admin.notSee({ label: "API key" });
    expect((await adminPage.dom('input[name="sign-in-mode"][value="per_member"]:checked')).elements).toHaveLength(1);
    await admin.screenshot();
    await admin.click({ role: "button", label: "Use individual keys" });
    await admin.see({ role: "heading", label: `${CONNECTION_NAME} is ready` }, { timeoutMs: READINESS_TIMEOUT_MS });
    await admin.click({ role: "switch", label: "Everyone in the organization" });
    await admin.see({ text: "On. Everyone in the organization can use it." });
    await admin.click({ role: "button", label: `Add ${CONNECTION_NAME}` });
    await admin.see({ role: "heading", label: "Connectors" }, { timeoutMs: 30_000 });
    await admin.see({ text: CONNECTION_NAME }, { timeoutMs: 30_000 });

    const manageable = await probe.api(den.admin, "/v1/mcp-connections?scope=manageable");
    expect(manageable.response.status, manageable.text).toBe(200);
    const matches = connectionRows(manageable.body).filter((entry) => entry.name === CONNECTION_NAME);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ authType: "apikey", credentialMode: "per_member", apiKeyAuthScheme: "token", connectedForMe: false });
    connectionId = stringField(matches[0], "id");
    evidence.recordAssertionEvidence(
      "Admin UI creates one keyless central personal-key connection",
      `One manageable connection ${connectionId} has authType=apikey, credentialMode=per_member, Token selected through the admin UI, org-wide access, and no connected admin account. The selected setup screen had no API-key field.`,
      true,
    );
  });

  await using alphaBrowser = await chrome({ name: "member-pat-alpha", host: place.host(), startUrl: den.ref.webUrl, headless: true });
  await using betaBrowser = await chrome({ name: "member-pat-beta", host: place.host(), startUrl: den.ref.webUrl, headless: true });
  await Promise.all([
    setViewport(alphaBrowser, { width: 1440, height: 1000, deviceScaleFactor: 1 }),
    setViewport(betaBrowser, { width: 1440, height: 1000, deviceScaleFactor: 1 }),
  ]);
  const alphaUser = user.on(alphaBrowser);
  const betaUser = user.on(betaBrowser);
  const alphaPage = probe.on(alphaBrowser);
  const betaPage = probe.on(betaBrowser);

  await step("two ordinary members sign in normally and receive the same connection", async () => {
    await Promise.all([signInThroughTheBrowser(alphaUser, alpha), signInThroughTheBrowser(betaUser, beta)]);
    await Promise.all([
      alphaUser.navigate(`${den.ref.webUrl}/dashboard/your-connections`),
      betaUser.navigate(`${den.ref.webUrl}/dashboard/your-connections`),
    ]);
    await Promise.all([
      alphaUser.see({ text: CONNECTION_NAME }, { timeoutMs: READINESS_TIMEOUT_MS }),
      betaUser.see({ text: CONNECTION_NAME }, { timeoutMs: READINESS_TIMEOUT_MS }),
    ]);
    await Promise.all([
      alphaUser.see({ testId: `connect-my-mcp-account-${connectionId}` }, { text: "Add key" }),
      betaUser.see({ testId: `connect-my-mcp-account-${connectionId}` }, { text: "Add key" }),
    ]);
    expect((await connectionFor(probe, alpha, connectionId)).id).toBe(connectionId);
    expect((await connectionFor(probe, beta, connectionId)).id).toBe(connectionId);
    evidence.recordAssertionEvidence(
      "Alex and Blair receive the same central connection as ordinary members",
      `Both usable inventories contain ${connectionId}; each browser offers Add key before enrollment.`,
      true,
    );
  });

  await step("each member uses an empty password dialog and sees stored but unverified without disclosure or OAuth", async () => {
    await addMemberKey({ person: alphaUser, page: alphaPage, surface: alphaBrowser, connectionId, secret: ALPHA_KEY });
    await addMemberKey({ person: betaUser, page: betaPage, surface: betaBrowser, connectionId, secret: BETA_KEY });

    for (const [member, secret] of [[alpha, ALPHA_KEY], [beta, BETA_KEY]] as const) {
      const row = await connectionFor(probe, member, connectionId);
      expect(row).toMatchObject({ id: connectionId, authType: "apikey", credentialMode: "per_member", connectedForMe: true });
      expect(row.credentialHealth === undefined || row.credentialHealth === "unknown").toBe(true);
      expect(JSON.stringify(row)).not.toContain(secret);
    }
    const browserRequests = await proxy.requestLog();
    expect(browserRequests.filter((entry) => entry.path === `/v1/mcp-connections/${connectionId}/connect/start`)).toHaveLength(0);
    const manageable = await probe.api(den.admin, "/v1/mcp-connections?scope=manageable");
    expect(connectionRows(manageable.body).filter((entry) => entry.name === CONNECTION_NAME)).toHaveLength(1);
    evidence.recordAssertionEvidence(
      "Member key dialogs are write-only and do not start OAuth",
      "Both empty dialogs used password inputs with autocomplete off and analytics capture excluded. After save, browser text, URLs, resource history, history state, storage, and returned connection metadata contained no synthetic key; no PAT OAuth-start request or new tab occurred.",
      true,
    );
    evidence.recordAssertionEvidence(
      "A successful store remains explicitly unverified",
      "Both rows say Key saved; the usable API reports connectedForMe=true with unknown or omitted health, never ready by inference.",
      true,
    );
  });

  await step("a provider rejection changes only Blair to replacement required", async () => {
    accepted.add(BETA_KEY);
    expect(await invokeIdentityProbe(tokenFor(beta), den.ref.apiUrl, connectionId)).toBe(false);
    const afterAcceptedCall = await connectionFor(probe, beta, connectionId);
    expect(afterAcceptedCall.credentialHealth === undefined || afterAcceptedCall.credentialHealth === "unknown").toBe(true);
    accepted.delete(BETA_KEY);
    expect(await invokeIdentityProbe(tokenFor(beta), den.ref.apiUrl, connectionId)).toBe(true);
    await eventually(() => connectionFor(probe, beta, connectionId), {
      within: 30_000,
      label: "Blair personal key marked for replacement",
      until: (connection) => connection.credentialHealth === "reconnect_required" && connection.needsReconnect === true,
    });
    await betaUser.reload();
    await betaUser.see({ text: "Replace key" }, { timeoutMs: 30_000 });
    await betaUser.see({ testId: `connect-my-mcp-account-${connectionId}` }, { text: "Replace key" });
    const targetsBefore = await pageTargetIds(betaBrowser);
    await betaUser.click({ testId: `connect-my-mcp-account-${connectionId}` });
    expect(await dialogSecurity(betaPage, CONNECTION_NAME)).toEqual({
      dialogPresent: true,
      dialogExcludedFromCapture: true,
      inputExcludedFromCapture: true,
      inputType: "password",
      autoComplete: "off",
      empty: true,
    });
    await betaUser.screenshot();
    expect(await pageTargetIds(betaBrowser)).toEqual(targetsBefore);
    await betaUser.click({ role: "button", label: "Cancel" });

    await alphaUser.reload();
    await alphaUser.see({ text: "Key saved" }, { timeoutMs: 30_000 });
    // Alex keeps a saved key: only the neutral Replace key action, never the rejected-key prompt.
    await alphaUser.see({ testId: `replace-my-mcp-key-${connectionId}` }, { text: "Replace key" });
    await alphaUser.notSee({ testId: `connect-my-mcp-account-${connectionId}` });
    const betaFingerprint = fingerprint(BETA_KEY);
    expect(wire.some((entry) => entry.fingerprint === betaFingerprint && entry.status === 200 && entry.scheme === "Token")).toBe(true);
    expect(wire.some((entry) => entry.fingerprint === betaFingerprint && entry.status === 401)).toBe(true);
    evidence.recordAssertionEvidence(
      "Provider rejection asks only the affected member to replace their key",
      `The owned witness accepted then rejected fingerprint ${betaFingerprint}. Blair changed from stored/unverified to Replace key; Alex remained stored/unverified, and Replace API key reopened an empty password dialog without a new tab.`,
      true,
    );
  });

  await step("shared API-key and per-member OAuth controls keep their existing UI routes", async () => {
    await alphaUser.reload();
    await alphaUser.see({ text: SHARED_NAME }, { timeoutMs: 30_000 });
    await alphaUser.see({ text: OAUTH_NAME }, { timeoutMs: 30_000 });
    expect((await alphaPage.dom(`[data-testid="connect-my-mcp-account-${sharedId}"]`)).elements).toHaveLength(0);
    expect((await alphaPage.dom(`[data-testid="connect-my-mcp-account-${oauthId}"]`)).elements).toHaveLength(1);
    const oauthStartedAt = new Date().toISOString();
    await alphaUser.click({ testId: `connect-my-mcp-account-${oauthId}` });
    const authorization = await den.mocks.oauth.authorizeRequestSince(oauthStartedAt, { timeoutMs: 30_000 });
    expect(authorization.path).toBe("/authorize");
    await eventually(async () => (await proxy.requestLog()).filter((entry) => entry.path === `/v1/mcp-connections/${oauthId}/connect/start`), {
      within: 30_000,
      label: "OAuth control starts OAuth",
      until: (requests) => requests.length === 1,
    });
    expect((await proxy.requestLog()).filter((entry) => entry.path === `/v1/mcp-connections/${connectionId}/connect/start`)).toHaveLength(0);
    evidence.recordAssertionEvidence(
      "Shared keys and OAuth do not enter the member-key dialog path",
      `Shared connection ${sharedId} has no member Connect control. OAuth connection ${oauthId} has its normal Connect control and reached the synthetic provider authorization endpoint; personal-key connection ${connectionId} still made zero OAuth-start requests.`,
      true,
    );
  });

  const log = await den.apiLog();
  for (const secret of [ALPHA_KEY, BETA_KEY, SHARED_KEY]) expect(log.includes(secret)).toBe(false);
  const finalManageable = await probe.api(den.admin, "/v1/mcp-connections?scope=manageable");
  expect(connectionRows(finalManageable.body).filter((entry) => entry.id === connectionId)).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "Synthetic member keys are absent from Den logs and central inventory",
    `The isolated Den log contains none of the three synthetic key values, and central inventory still has exactly one personal-key connection with id ${connectionId}.`,
    true,
  );
});
