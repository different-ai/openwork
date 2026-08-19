import { expect, onTestFinished } from "vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import {
  assignPluginToMarketplace,
  clickButton,
  createMarketplace,
  createPluginWithSkill,
  denFetch,
  evalIn,
  fill,
  grantMarketplaceAccess,
  readResolvedMarketplace,
  signIn,
  waitFor,
} from "@openwork/behaviors";
import type { DenRef, DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, needs, selfHostServer, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

/**
 * CORE JOURNEY: a truly empty, self-hosted-shaped Den is claimed by its configured
 * first owner in a real browser. The deployment then keeps every later account in
 * that one organization while serving org-wide models and personally granted
 * marketplace skills through the same REST and MCP surfaces used in production.
 *
 * This stays one spec because its proof depends on strict lifecycle order: the
 * empty database must be observed before first signup, the member must exist before
 * a personal grant, and the same MCP token must be denied before that grant and
 * authorized after it.
 */

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const daytonaPlacement = process.env.OPENWORK_EVAL_DAYTONA === "1";
const mysqlOpen = await localMysqlIsRunning();
const title = missingRequirements.length > 0
  ? `self-host onboarding skipped — needs: ${missingRequirements.join(", ")}`
  : daytonaPlacement
    ? "self-host onboarding skipped — needs: local placement (unset OPENWORK_EVAL_DAYTONA)"
    : !mysqlOpen
      ? "self-host onboarding skipped — needs: MySQL on 127.0.0.1:3306"
      : "a fresh self-hosted Den onboards its first owner, constrains the org, and serves the skill-sharing journey";

const OWNER_EMAIL = "morgan.owner@selfhost.test";
const MEMBER_EMAIL = "riley.member@selfhost.test";
const PASSWORD = "OpenWorkEval123!";
const ORGANIZATION_NAME = "Bluefin Robotics";
const ORGANIZATION_SLUG = "bluefin";
const MODEL_ID = "selfhost-proof-model";
const REQUEST_TIMEOUT_MS = 15_000;
let mcpRequestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function recordList(value: unknown, key: string, label: string): Record<string, unknown>[] {
  const record = requireRecord(value, label);
  const entries = record[key];
  if (!Array.isArray(entries)) throw new Error(`${label}.${key} was not an array: ${JSON.stringify(value).slice(0, 500)}`);
  return entries.filter(isRecord);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function toolText(result: unknown): string {
  const record = requireRecord(result, "MCP tool result");
  const first = Array.isArray(record.content) ? record.content[0] : null;
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error(`MCP tool result had no text content: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return first.text;
}

function toolJson(result: unknown): unknown {
  return JSON.parse(toolText(result));
}

function searchMatches(result: unknown): Record<string, unknown>[] {
  const payload = requireRecord(toolJson(result), "search_capabilities payload");
  return Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
}

function matchNamed(result: unknown, capabilityName: string): Record<string, unknown> | undefined {
  return searchMatches(result).find((entry) => entry.name === capabilityName);
}

async function mintMcpToken(session: DenSession, organizationId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: { ...auth(session), "x-openwork-org-id": organizationId },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function callTool(
  ref: DenRef,
  mcpToken: string,
  name: "search_capabilities" | "execute_capability",
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${ref.apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++mcpRequestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP tools/call returned no SSE data frame: ${raw.slice(0, 500)}`);
  const payload: unknown = JSON.parse(dataLine.slice(5));
  const record = requireRecord(payload, "MCP JSON-RPC payload");
  if (record.error) throw new Error(`MCP tools/call returned JSON-RPC error: ${JSON.stringify(record.error)}`);
  return record.result;
}

async function organizationMemberIdByEmail(owner: DenSession, organizationId: string, email: string): Promise<string> {
  const result = await denFetch(owner, "/v1/org", {
    headers: { ...auth(owner), "x-openwork-org-id": organizationId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const member = recordList(result.body, "members", "organization context")
    .find((entry) => isRecord(entry.user) && entry.user.email === email);
  const memberId = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !memberId.startsWith("om_")) {
    throw new Error(`Resolving ${email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return memberId;
}

test.skipIf(missingRequirements.length > 0 || daytonaPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await selfHostServer({
    place,
    name: ORGANIZATION_NAME,
    slug: ORGANIZATION_SLUG,
    ownerEmails: [OWNER_EMAIL],
    allowPublicSignup: true,
  });

  let cleanupOwner: DenSession | undefined;
  let providerId = "";
  let pluginId = "";
  let marketplaceId = "";
  onTestFinished(async () => {
    if (!cleanupOwner) return;
    if (pluginId) {
      await denFetch(cleanupOwner, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, {
        method: "POST",
        headers: auth(cleanupOwner),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    if (marketplaceId) {
      await denFetch(cleanupOwner, `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/delete`, {
        method: "POST",
        headers: auth(cleanupOwner),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    if (providerId) {
      await denFetch(cleanupOwner, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
        headers: auth(cleanupOwner),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined);
    }
  });

  const runtimeResponse = await fetch(`${den.ref.webUrl}/api/runtime-config`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const runtimeBody: unknown = await runtimeResponse.json();
  expect(runtimeResponse.status).toBe(200);
  expect(runtimeBody).toMatchObject({
    orgMode: "single_org",
    singleOrgName: ORGANIZATION_NAME,
    singleOrgSlug: ORGANIZATION_SLUG,
    singleOrgAllowPublicSignup: true,
  });

  const beforeSignup = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: OWNER_EMAIL, password: PASSWORD }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(beforeSignup.response.ok).toBe(false);
  evidence.recordAssertionEvidence(
    "The fresh stack is single-org but unclaimed",
    `GET /api/runtime-config returned single_org/${ORGANIZATION_SLUG} with public signup enabled; owner sign-in before signup returned HTTP ${beforeSignup.response.status}.`,
    runtimeResponse.status === 200 && beforeSignup.response.ok === false,
  );

  await using browser = await chrome({ name: "self-host-first-owner", startUrl: den.ref.webUrl, headless: true });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && Boolean(document.querySelector('input[type="email"]'))`, {
    timeoutMs: 60_000,
    label: "fresh self-host auth panel",
  });
  const landingText = await evalIn(browser, "document.body.innerText");
  const landingShot = await screenshot(browser);
  expect(landingText).toEqual(expect.any(String));
  expect(landingText).toContain("Start using OpenWork");
  expect(landingText).toContain("Enter your email and we'll send you to the right sign-in step.");
  {
    const seen = await validate(landingShot, [
      "The self-hosted account landing says Start using OpenWork",
      "An email entry action is visible",
      "No error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  await fill(browser, 'input[type="email"]', OWNER_EMAIL, { timeoutMs: 30_000 });
  await clickButton(browser, "Next", { timeoutMs: 30_000 });
  await waitFor(browser, `Boolean(document.querySelector('input[autocomplete="name"]')) && Boolean(document.querySelector('input[type="password"]'))`, {
    timeoutMs: 30_000,
    label: "self-host owner signup form",
  });
  // 2026-08-09: email-first sign-up copy drops singleOrgName (auth-panel.tsx:365) — org-aware copy exists only on the landing title and the non-email-first sign-up branch. If a later change makes this step org-aware, tighten this assertion.
  const authPanelText = await evalIn(browser, "document.body.innerText");
  expect(authPanelText).toEqual(expect.any(String));
  expect(authPanelText).toContain("Create your account.");
  expect(authPanelText).toContain("Sign up");
  await fill(browser, 'input[autocomplete="name"]', "Morgan Owner", { timeoutMs: 30_000 });
  await fill(browser, 'input[type="password"]', PASSWORD, { timeoutMs: 30_000 });
  await clickButton(browser, "Sign up", { timeoutMs: 30_000 });
  await waitFor(browser, `location.pathname.startsWith("/dashboard")`, {
    timeoutMs: 60_000,
    label: "Bluefin dashboard after first-owner signup",
  });
  evidence.recordAssertionEvidence(
    "The configured owner completed real browser onboarding",
    `The email-first account flow completed and the browser landed at the ${ORGANIZATION_NAME} dashboard after submitting the signup form.`,
    true,
  );
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      `The signed-in dashboard is visible for ${ORGANIZATION_NAME}`,
      "The first-owner account form is no longer visible",
      "No error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const owner = await signIn(den.ref, { email: OWNER_EMAIL, password: PASSWORD });
  cleanupOwner = owner;
  const ownerOrgsResult = await denFetch(owner, "/v1/me/orgs", {
    headers: auth(owner),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(ownerOrgsResult.response.status).toBe(200);
  const ownerOrgs = recordList(ownerOrgsResult.body, "orgs", "owner organization list");
  expect(ownerOrgs).toHaveLength(1);
  expect(ownerOrgs[0]).toMatchObject({ slug: ORGANIZATION_SLUG, role: "owner" });
  const organizationId = typeof ownerOrgs[0]?.id === "string" ? ownerOrgs[0].id : "";
  expect(organizationId).toMatch(/^org_/);

  const secondOrg = await denFetch(owner, "/v1/org", {
    method: "POST",
    headers: auth(owner),
    body: JSON.stringify({ name: "Forbidden Second Organization" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(secondOrg.response.status).toBe(409);
  expect(secondOrg.body).toMatchObject({ error: "single_org_mode" });
  evidence.recordAssertionEvidence(
    "The first eligible account owns exactly the configured organization",
    `GET /v1/me/orgs returned one ${ORGANIZATION_SLUG} membership with role owner; POST /v1/org returned HTTP 409 single_org_mode.`,
    ownerOrgs.length === 1 && ownerOrgs[0]?.role === "owner" && secondOrg.response.status === 409,
  );

  const memberSignup = await denFetch(den.ref, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER_EMAIL, name: "Riley Member", password: PASSWORD }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(memberSignup.response.ok).toBe(true);
  const member = await signIn(den.ref, { email: MEMBER_EMAIL, password: PASSWORD });
  const memberOrgsResult = await denFetch(member, "/v1/me/orgs", {
    headers: auth(member),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(memberOrgsResult.response.status).toBe(200);
  const memberOrgs = recordList(memberOrgsResult.body, "orgs", "member organization list");
  expect(memberOrgs).toHaveLength(1);
  expect(memberOrgs[0]).toMatchObject({ id: organizationId, slug: ORGANIZATION_SLUG, role: "member" });
  expect(memberOrgs[0]?.role).not.toBe("owner");
  evidence.recordAssertionEvidence(
    "Later public signups join as members without creating another organization",
    `Riley signup returned HTTP ${memberSignup.response.status}; /v1/me/orgs returned only ${ORGANIZATION_SLUG} with role member.`,
    memberSignup.response.ok && memberOrgs.length === 1 && memberOrgs[0]?.role === "member",
  );

  const providerResult = await denFetch(owner, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(owner), "x-openwork-org-id": organizationId },
    body: JSON.stringify({
      name: "Self-host Proof Provider",
      source: "custom",
      customConfig: {
        id: "selfhost-proof-provider",
        name: "Self-host Proof Provider",
        npm: "@ai-sdk/openai-compatible",
        env: ["SELFHOST_PROOF_API_KEY"],
        models: [{ id: MODEL_ID, name: "Self-host Proof Model" }],
      },
      apiKey: "sk-selfhost-proof-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(providerResult.response.status).toBe(201);
  const provider = isRecord(providerResult.body) && isRecord(providerResult.body.llmProvider)
    ? providerResult.body.llmProvider
    : null;
  providerId = provider && typeof provider.id === "string" ? provider.id : "";
  expect(providerId).toMatch(/^lpr_/);

  const memberProviders = await denFetch(member, "/v1/llm-providers", {
    headers: { ...auth(member), "x-openwork-org-id": organizationId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(memberProviders.response.status).toBe(200);
  const visibleProviderIds = recordList(memberProviders.body, "llmProviders", "member LLM provider list")
    .flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
  expect(visibleProviderIds).toContain(providerId);
  evidence.recordAssertionEvidence(
    "The owner can publish an org-wide model provider",
    `POST /v1/llm-providers returned HTTP 201 and Riley's provider list includes ${MODEL_ID}'s provider ${providerId}.`,
    visibleProviderIds.includes(providerId),
  );

  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const nonce = `bluefin-skill-proof-${stamp}`;
  const skillName = `selfhost-skill-${stamp}`;
  const plugin = await createPluginWithSkill(owner, {
    name: `Self-host Skill Plugin ${stamp}`,
    skillName,
    skillBody: `Return this exact self-host proof nonce: ${nonce}`,
    orgWide: false,
  });
  pluginId = plugin.id;
  const marketplace = await createMarketplace(owner, { name: `Bluefin Marketplace ${stamp}` });
  marketplaceId = marketplace.id;
  await assignPluginToMarketplace(owner, marketplace.id, plugin.id);

  const memberId = await organizationMemberIdByEmail(owner, organizationId, MEMBER_EMAIL);
  const ownerMcpToken = await mintMcpToken(owner, organizationId);
  const memberMcpToken = await mintMcpToken(member, organizationId);
  const ownerSearch = await callTool(den.ref, ownerMcpToken, "search_capabilities", {
    query: skillName,
    limit: 20,
    type: "skills",
  });
  const ownerMatch = searchMatches(ownerSearch)
    .find((entry) => typeof entry.name === "string" && entry.name.startsWith(`plugin:${plugin.id}:`));
  const capabilityName = ownerMatch && typeof ownerMatch.name === "string" ? ownerMatch.name : "";
  expect(capabilityName).toMatch(new RegExp(`^plugin:${plugin.id}:`));

  const beforeGrantSearch = await callTool(den.ref, memberMcpToken, "search_capabilities", {
    query: skillName,
    limit: 20,
    type: "skills",
  });
  expect(matchNamed(beforeGrantSearch, capabilityName)).toBeUndefined();
  const beforeGrantExecution = requireRecord(
    await callTool(den.ref, memberMcpToken, "execute_capability", { name: capabilityName }),
    "pre-grant execute_capability result",
  );
  expect(beforeGrantExecution.isError).toBe(true);
  expect(toolJson(beforeGrantExecution)).toEqual({
    error: "forbidden",
    message: "You have not been granted access to this plugin capability.",
  });
  evidence.recordAssertionEvidence(
    "An assigned marketplace does not leak its skill before a personal grant",
    `Riley's search omitted ${capabilityName}, and direct execution returned forbidden before marketplace access was granted.`,
    matchNamed(beforeGrantSearch, capabilityName) === undefined && beforeGrantExecution.isError === true,
  );

  await grantMarketplaceAccess(owner, marketplace.id, { orgMembershipId: memberId });
  const resolved = await readResolvedMarketplace(member, marketplace.id);
  expect(resolved.pluginNames).toContain(plugin.name);
  expect(resolved.skillNames).toContain(skillName);

  const afterGrantSearch = await callTool(den.ref, memberMcpToken, "search_capabilities", {
    query: skillName,
    limit: 20,
    type: "skills",
  });
  expect(matchNamed(afterGrantSearch, capabilityName)).toBeDefined();
  const afterGrantExecution = requireRecord(
    await callTool(den.ref, memberMcpToken, "execute_capability", { name: capabilityName }),
    "post-grant execute_capability result",
  );
  expect(afterGrantExecution.isError).not.toBe(true);
  const executedPayload = requireRecord(toolJson(afterGrantExecution), "post-grant skill payload");
  expect(typeof executedPayload.content === "string" && executedPayload.content.includes(nonce)).toBe(true);
  evidence.recordAssertionEvidence(
    "A personal marketplace grant serves the shared skill over REST and MCP",
    `Resolved marketplace contains ${plugin.name}/${skillName}; search found ${capabilityName}, and execution returned nonce ${nonce}.`,
    resolved.pluginNames.includes(plugin.name)
      && resolved.skillNames.includes(skillName)
      && matchNamed(afterGrantSearch, capabilityName) !== undefined
      && typeof executedPayload.content === "string"
      && executedPayload.content.includes(nonce),
  );
}, 600_000);
