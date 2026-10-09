import { afterAll, describe, expect } from "vitest";
import { z } from "zod";
import { captureBrowserEvidence, spec } from "@openwork/testkit";
import type { Step, TestNeeds } from "@openwork/testkit";
import {
  bootSetupSsoInstallMatrix,
  clearSetupSsoFetchFault,
  captureSetupSsoDesktopHandoff,
  composeSetupSsoStep,
  exchangeSetupSsoDesktopHandoff,
  readSetupSsoBrowserUrl,
  installSetupSsoFetchFault,
  openSetupSsoBrowser,
  observeSetupSsoNavigation,
  readSetupSsoManifest,
  runSetupSsoSql,
  sanitizedSetupSsoUrl,
  setupSsoCurrentCommit,
  setupSsoInstallMatrixManifestPath,
  setupSsoProductSourceFingerprint,
} from "../worlds/setup-sso-install-matrix";

const providedManifestPath = process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST?.trim();
const columnId = process.env.OPENWORK_SETUP_SSO_MATRIX_COLUMNS?.trim() || "dev";
const positiveControl = process.env.OPENWORK_SETUP_SSO_POSITIVE_CONTROL === "1";
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["docker"], placement: "local",
};
let ownedMatrixStack: AsyncDisposableStack | undefined;
let ownedManifestReady: Promise<void> | undefined;

async function ensureMatrixManifest(): Promise<void> {
  if (providedManifestPath) return;
  ownedManifestReady ??= (async () => {
    const stack = new AsyncDisposableStack();
    try {
      await bootSetupSsoInstallMatrix(stack, { hostWeb: false, columns: [columnId] });
      ownedMatrixStack = stack;
      process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST = setupSsoInstallMatrixManifestPath();
    } catch (error) {
      await stack.disposeAsync();
      throw error;
    }
  })();
  await ownedManifestReady;
}

afterAll(async () => {
  try { await ownedMatrixStack?.disposeAsync(); }
  finally { if (!providedManifestPath) delete process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST; }
});

const test = spec.world(async () => {
  await ensureMatrixManifest();
  return {};
}, { needs: requirements, resources: { surfaces: ["web"], services: ["den"] }, timeout: 3_600_000 });

const baseColumnSchema = z.object({
  id: z.string(), apiVersion: z.string(), apiImage: z.string(), webImage: z.string(),
  apiImageId: z.string(), webImageId: z.string(), apiUrl: z.string(), webUrl: z.string(), project: z.string(),
});
const columnSchema = baseColumnSchema.extend({
  idpOrigin: z.string(),
  context: z.object({
    enterprise: z.boolean(), requireSso: z.boolean(), ssoStatus: z.string(), domainVerified: z.boolean(),
    singletonConfigured: z.boolean(), scimReady: z.boolean(), scimUsersStatus: z.number(), scimUsers: z.number(),
    passwordSignInStatus: z.number(), passwordSignInError: z.string(),
  }),
  control: z.object({
    organizationId: z.string(), adminToken: z.string(), adminCookie: z.string(), ownerEmail: z.string(),
    ownerPassword: z.string(), installPath: z.string(),
  }),
});
const manifestSchema = z.object({
  commit: z.string(),
  source: z.object({
    fingerprint: z.string(), dirtyProductFiles: z.array(z.string()), webMode: z.string(),
    apiImageFingerprint: z.string().nullable(), webImageFingerprint: z.string().nullable(),
  }),
  columns: z.array(columnSchema), pending: baseColumnSchema.extend({ control: z.object({ ownerEmail: z.string(), ownerPassword: z.string(), bootstrapCode: z.string() }) }).nullable(),
});
type MatrixColumn = z.infer<typeof columnSchema>;

async function manifest() {
  const path = process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST;
  if (!path) throw new Error("Matrix manifest is required.");
  const parsed = manifestSchema.safeParse(await readSetupSsoManifest(path));
  // Do not print parser inputs: the private manifest contains synthetic credentials.
  if (!parsed.success) throw new Error("Matrix manifest failed schema validation (private inputs withheld).");
  const result = parsed.data;
  expect(result.source.webMode).toBe("image");
  if (["dev", "control", "pending"].includes(columnId)) {
    expect(result.commit).toBe(await setupSsoCurrentCommit());
    expect(result.source.fingerprint).toBe(await setupSsoProductSourceFingerprint());
    expect(result.source.apiImageFingerprint).toBe(result.source.fingerprint);
    expect(result.source.webImageFingerprint).toBe(result.source.fingerprint);
    if (columnId === "control") expect(result.source.dirtyProductFiles).toEqual([]);
  } else {
    expect(result.source.apiImageFingerprint).toBeNull();
    expect(result.source.webImageFingerprint).toBeNull();
  }
  return result;
}

async function matrixColumn(): Promise<MatrixColumn> {
  const result = await manifest();
  const column = result.columns.find((candidate) => candidate.id === columnId);
  if (!column) throw new Error(`Matrix manifest has no ${columnId} column.`);
  expect(column.context).toEqual({
    enterprise: true, requireSso: false, ssoStatus: "enabled", domainVerified: true,
    singletonConfigured: true, scimReady: true, scimUsersStatus: 200, scimUsers: 1,
    passwordSignInStatus: 403, passwordSignInError: "single_org_sso_required",
  });
  expect(column.apiImageId).toMatch(/^sha256:/);
  expect(column.webImageId).toMatch(/^sha256:/);
  if (columnId.startsWith("0.")) {
    expect(column.apiImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(column.webImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(column.apiVersion).toBe(columnId);
  } else expect(column.apiVersion).toBe(result.commit);
  return column;
}

async function documentResponse(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
}

async function arrangeEnforcement(column: MatrixColumn, requireSso: boolean): Promise<void> {
  const serialized = requireSso ? "true" : "false";
  const sql = `DELETE FROM rate_limit; UPDATE organization SET metadata=JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.requireSso', CAST('${serialized}' AS JSON)) WHERE id='${column.control.organizationId.replaceAll("'", "''")}'; SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.requireSso')) FROM organization WHERE id='${column.control.organizationId.replaceAll("'", "''")}';`;
  expect(await runSetupSsoSql(column.project, sql)).toBe(serialized);
  const response = await fetch(`${column.apiUrl}/api/auth/sign-in/email`, {
    method: "POST", headers: { origin: column.webUrl, "content-type": "application/json" },
    body: JSON.stringify({ email: column.control.ownerEmail, password: column.control.ownerPassword }), signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json();
  expect(response.status).toBe(403);
  expect(z.object({ error: z.string() }).parse(payload).error).toBe("single_org_sso_required");
}

async function setSsoEnabled(column: MatrixColumn, enabled: boolean): Promise<void> {
  const status = enabled ? "enabled" : "disabled";
  const sql = `UPDATE sso_connection SET status='${status}' WHERE organization_id='${column.control.organizationId.replaceAll("'", "''")}'; SELECT status FROM sso_connection WHERE organization_id='${column.control.organizationId.replaceAll("'", "''")}';`;
  expect(await runSetupSsoSql(column.project, sql)).toBe(status);
  const singleton = await fetch(`${column.apiUrl}/v1/orgs/sso/singleton`, { signal: AbortSignal.timeout(30_000) });
  expect(singleton.status).toBe(200);
  expect(z.object({ configured: z.boolean() }).parse(await singleton.json()).configured).toBe(enabled);
}

async function setSsoDomainVerified(column: MatrixColumn, verified: boolean): Promise<void> {
  const serialized = verified ? "1" : "0";
  const sql = `UPDATE sso_provider SET domain_verified=${serialized} WHERE organization_id='${column.control.organizationId.replaceAll("'", "''")}'; SELECT CONCAT(c.status, ':', p.domain_verified) FROM sso_connection c INNER JOIN sso_provider p ON c.provider_id=p.provider_id AND c.organization_id=p.organization_id WHERE c.organization_id='${column.control.organizationId.replaceAll("'", "''")}' LIMIT 1;`;
  expect(await runSetupSsoSql(column.project, sql)).toBe(`enabled:${serialized}`);
  const singleton = await fetch(`${column.apiUrl}/v1/orgs/sso/singleton`, { signal: AbortSignal.timeout(30_000) });
  expect(singleton.status).toBe(200);
  expect(z.object({ configured: z.boolean() }).parse(await singleton.json()).configured).toBe(verified);
}

function journeyCapture(browser: Awaited<ReturnType<typeof openSetupSsoBrowser>>, step: Step, subject: string) {
  let number = 0;
  const column = columnId === "0.18.54" ? "A" : columnId === "0.18.57" ? "B" : columnId === "control" ? "C" : columnId === "pending" ? "D-pending" : "D";
  return async (action: string, expectation: string, callback?: string) => {
    number += 1;
    const caption = `Column ${column} (${columnId}), ${subject} | Step ${number}: ${action}`;
    await step(caption, async () => {
      const captured = await captureBrowserEvidence(browser, { caption, expectations: [expectation], redactUrl: sanitizedSetupSsoUrl });
      const presentation = await composeSetupSsoStep(browser, captured.artifact, {
        column, step: number, action, caption, callback, observedUrl: captured.observedUrl,
        sourceTestRunDir: captured.sourceTestRunDir, expectations: captured.expectations,
      });
      expect(presentation.original).not.toBe(presentation.annotated);
      expect(presentation.original.endsWith("/original.png")).toBe(true);
      expect(presentation.annotated.endsWith("/annotated.png")).toBe(true);
      expect(presentation.observedUrl).toBe(captured.observedUrl);
    });
  };
}

const enforcementCases = [
  { label: "enforcement ON + password disabled", slug: "on", requireSso: true },
  { label: "enforcement OFF + password disabled", slug: "off", requireSso: false },
];
const routes = ["/", "/install", "token", "/setup"];

describe.sequential("setup SSO full API and Web matrix", () => {
  if (columnId !== "pending") for (const enforcement of enforcementCases) for (const route of routes) {
    test(`${columnId}: ${route} (${enforcement.label})${positiveControl ? " positive control" : ""}`, { timeout: 180_000 }, async ({ place, user, step, evidence }) => {
      const column = await matrixColumn();
      await arrangeEnforcement(column, enforcement.requireSso);
      const original = new URL(route === "token" ? column.control.installPath : route, column.webUrl);
      const response = await documentResponse(original.toString());
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      await using browser = await openSetupSsoBrowser({ host: place.host(), name: `setup-sso-${columnId}-${route.replaceAll("/", "-")}-${enforcement.slug}` });
      using navigation = await observeSetupSsoNavigation(browser.client.webSocketDebuggerUrl);
      const person = user.on(browser);
      const shot = journeyCapture(browser, step, `${route}, ${enforcement.label}`);
      await person.navigate(original.toString());
      let offered = false;
      let authenticated = false;
      try {
        if (route === "token") {
          await person.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
          const finalUrl = await readSetupSsoBrowserUrl(browser);
          // Compare without printing a bearer URL on assertion failure.
          expect(finalUrl === original.toString(), "The issued install token and URL must remain unchanged").toBe(true);
          expect(navigation.entries.some((entry) => new URL(entry.url).origin === column.idpOrigin)).toBe(false);
          expect(navigation.entries.every((entry) => {
            const target = new URL(entry.url);
            return target.origin === column.webUrl && target.pathname === "/install";
          }), "Public token links must not navigate through generic sign-in or SSO").toBe(true);
          await person.notSee({ role: "button", label: "Approve sign-in" });
          await shot("Open the UI-copied public install link", "The page shows Set up OpenWork Enterprise and desktop download options.");
          await shot("Verify the token link works without authentication", "The page shows Set up OpenWork Enterprise and desktop download options.");
        } else if (route === "/") {
          await person.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 90_000 });
          offered = true;
          await shot("Open home while signed out", "The sign-in page offers Continue with SSO.");
          await person.click({ role: "button", label: "Continue with SSO" });
          await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
          expect(new URL(await readSetupSsoBrowserUrl(browser)).origin).toBe(column.idpOrigin);
          await shot("Choose Continue with SSO", "The synthetic identity provider shows the synthetic user and an Approve sign-in button.");
          await person.click({ role: "button", label: "Approve sign-in" });
          await person.see({ text: "Dashboard" }, { timeoutMs: 90_000 });
          expect(new URL(await readSetupSsoBrowserUrl(browser)).pathname).toBe("/dashboard");
          authenticated = true;
          await shot("Approve sign-in and reach the dashboard", "The authenticated dashboard is visible.");
        } else if (columnId === "dev" || positiveControl) {
          // Exactly the same positive assertion runs on the clean control and the fixed build.
          await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
          offered = true;
          const identityProviderUrl = new URL(await readSetupSsoBrowserUrl(browser));
          expect(identityProviderUrl.origin).toBe(column.idpOrigin);
          expect(identityProviderUrl.pathname).toBe("/authorize");
          expect([...identityProviderUrl.searchParams.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"].sort());
          expect(identityProviderUrl.searchParams.has("token")).toBe(false);
          expect(navigation.entries.some((entry) => entry.kind === "document-request" && entry.url === original.toString())).toBe(true);
          await shot(`Open ${route}; automatic SSO redirect observed`, "The synthetic identity provider shows the synthetic user and an Approve sign-in button.");
          const callback = navigation.ssoCallbacks.find((entry) => entry.origin === column.webUrl && entry.returnTo === route);
          expect(callback, "The real outgoing SSO callback must carry the original member returnTo").toBeDefined();
          await shot("Observe the IdP and verified original return destination", "The synthetic identity provider shows the synthetic user and an Approve sign-in button.", callback?.url);
          await person.click({ role: "button", label: "Approve sign-in" });
          await person.see({ role: "heading", label: route === "/install" ? "Set up OpenWork Enterprise" : "Setup is complete" }, { timeoutMs: 90_000 });
          expect(await readSetupSsoBrowserUrl(browser)).toBe(original.toString());
          await shot(`Approve SSO and return directly to ${route}`, route === "/install" ? "The page shows Set up OpenWork Enterprise and desktop download options." : "The page says Setup is complete.");
          await person.notSee({ role: "button", label: "Approve sign-in" });
          authenticated = true;
          await shot("Verify the exact original page works", route === "/install" ? "The page shows Set up OpenWork Enterprise and desktop download options." : "The page says Setup is complete.");
        } else {
          await person.see({ role: "heading", label: route === "/install" ? "This install link can't be opened." : "Setup is complete" }, { timeoutMs: 90_000 });
          await shot(`Open the original ${route} link while signed out`, route === "/install" ? "The install page asks the person to sign in to the Den portal but has no Continue with SSO button." : "The page says Setup is complete.");
          if (route === "/install") await person.see({ text: "Sign in to your Den portal to install OpenWork." });
          else await person.see({ role: "button", label: "Sign in" });
          await person.notSee({ role: "button", label: "Continue with SSO" });
          expect(await readSetupSsoBrowserUrl(browser)).toBe(original.toString());
          await shot("Observe the missing direct SSO handoff", route === "/install" ? "The install page asks the person to sign in to the Den portal but has no Continue with SSO button." : "The page says Setup is complete.");
          await person.navigate(`${column.webUrl}/`);
          await person.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 90_000 });
          await shot("Manually navigate to home", "The sign-in page offers Continue with SSO.");
          await person.click({ role: "button", label: "Continue with SSO" });
          await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
          await shot("Choose Continue with SSO", "The synthetic identity provider shows the synthetic user and an Approve sign-in button.");
          expect(new URL(await readSetupSsoBrowserUrl(browser)).origin).toBe(column.idpOrigin);
          expect(navigation.ssoCallbacks.every((entry) => entry.returnTo === null)).toBe(true);
          await shot("Observe the organization identity provider", "The synthetic identity provider shows the synthetic user and an Approve sign-in button.");
          await person.click({ role: "button", label: "Approve sign-in" });
          await person.see({ text: "Dashboard" }, { timeoutMs: 90_000 });
          expect(new URL(await readSetupSsoBrowserUrl(browser)).pathname).toBe("/dashboard");
          expect(await readSetupSsoBrowserUrl(browser)).not.toBe(original.toString());
          await shot("Approve SSO; land on dashboard rather than requested page", "The authenticated dashboard is visible.");
          await person.navigate(original.toString());
          await person.see({ role: "heading", label: route === "/install" ? "Set up OpenWork Enterprise" : "Setup is complete" }, { timeoutMs: 90_000 });
          await shot(`Manually reopen the original ${route} link`, route === "/install" ? "The page shows Set up OpenWork Enterprise and desktop download options." : "The page says Setup is complete.");
          expect(await readSetupSsoBrowserUrl(browser)).toBe(original.toString());
          authenticated = true;
          await shot("Verify the original page now works after manual recovery", route === "/install" ? "The page shows Set up OpenWork Enterprise and desktop download options." : "The page says Setup is complete.");
        }
        expect(navigation.entries.some((entry) => entry.kind === "document-response" && entry.status === 200)).toBe(true);
        evidence.recordAssertionEvidence(
          `${columnId} ${route}: document, navigation, SSO and return behavior`,
          JSON.stringify({ documentStatus: response.status, documentLocation: null, finalUrl: sanitizedSetupSsoUrl(await readSetupSsoBrowserUrl(browser)), ssoOffered: offered, authenticated, tokenUnchanged: route === "token" ? true : null, originalRoute: route === "token" ? "/install?token=<redacted>" : route, ssoCallbacks: navigation.ssoCallbacks, navigation: navigation.entries, apiImage: column.apiImage, apiImageId: column.apiImageId, webImage: column.webImage, webImageId: column.webImageId, apiVersion: column.apiVersion, mockOidc: true, freshBrowser: true }),
          true,
        );
      } catch (error) {
        // A failed step closes the step channel; preserve its original error.
        evidence.recordAssertionEvidence(`${columnId} ${route}: observed failed route`, JSON.stringify({ documentStatus: response.status, finalUrl: sanitizedSetupSsoUrl(await readSetupSsoBrowserUrl(browser)), navigation: navigation.entries, mockOidc: true }), false);
        throw error;
      }
    });
  }

  if (columnId === "dev") {
    test("desktop sign-in still creates a single-use desktop activation grant", { timeout: 180_000 }, async ({ place, user, step, evidence }) => {
      const column = await matrixColumn();
      await arrangeEnforcement(column, true);
      await using browser = await openSetupSsoBrowser({ host: place.host(), name: "setup-sso-desktop-continuation" });
      await captureSetupSsoDesktopHandoff(browser);
      const person = user.on(browser);
      const shot = journeyCapture(browser, step, "desktop continuation");
      await person.navigate(`${column.webUrl}/?mode=sign-in&desktopAuth=1&desktopScheme=openwork`);
      await person.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 90_000 });
      await person.click({ role: "button", label: "Continue with SSO" });
      await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
      await person.click({ role: "button", label: "Approve sign-in" });
      const handoff = await exchangeSetupSsoDesktopHandoff(browser, column.webUrl);
      expect(handoff).toEqual({ destinationMatches: true, grantMatches: true, denBaseUrlMatches: true, status: 200, hasToken: true, replayStatus: 404 });
      expect(new URL(await readSetupSsoBrowserUrl(browser)).pathname).toBe("/");
      await shot("Complete SSO and verify the real single-use desktop grant", "The page says You're signed in.");
      evidence.recordAssertionEvidence("Desktop continuation still issues a real single-use activation grant", "Root desktopAuth sign-in completed mock OIDC, created an openwork: grant, exchanged it for a session, and rejected replay. Response delivery paused before OS launch to protect the operator's app. This proves the web/API handoff contract, not a packaged desktop launch.", true);
    });
    test("generic member sign-in preserves web handoff context without copying arbitrary parameters (dev)", { timeout: 180_000 }, async ({ place, user, step, evidence }) => {
      const column = await matrixColumn();
      await arrangeEnforcement(column, false);
      await setSsoEnabled(column, false);
      try {
        const installUrl = new URL("/install", column.webUrl);
        installUrl.searchParams.set("token", "");
        installUrl.searchParams.set("webAuth", "1");
        installUrl.searchParams.set("webAuthReturn", "https://web.openworklabs.com/auth/callback");
        installUrl.searchParams.set("arbitrary", "drop-me");
        await using browser = await openSetupSsoBrowser({ host: place.host(), name: "setup-sso-fixed-generic-context" });
        const person = user.on(browser);
        const shot = journeyCapture(browser, step, "generic web handoff context");
        await person.navigate(installUrl.toString());
        await person.see({ role: "heading", label: "Start using OpenWork" }, { timeoutMs: 90_000 });
        const signInUrl = new URL(await readSetupSsoBrowserUrl(browser));
        expect(signInUrl.pathname).toBe("/");
        expect(signInUrl.searchParams.get("mode")).toBe("sign-in");
        expect(signInUrl.searchParams.get("returnTo")).toBe("/install");
        expect(signInUrl.searchParams.get("webAuth")).toBe("1");
        expect(signInUrl.searchParams.get("webAuthReturn")).toBe("https://web.openworklabs.com/auth/callback");
        expect(signInUrl.searchParams.has("token")).toBe(false);
        expect(signInUrl.searchParams.has("arbitrary")).toBe(false);
        await shot("Open member link with SSO disabled; retain allowlisted context", "The page says Start using OpenWork and shows an Email field and a Next button.");
        evidence.recordAssertionEvidence("Generic member sign-in preserves only allowlisted handoff context", "Retained mode, /install, webAuth and webAuthReturn; dropped token and arbitrary query parameter.", true);
      } finally { await setSsoEnabled(column, true); }
    });

    for (const scenario of [{ route: "/install", unverified: false }, { route: "/setup", unverified: true }]) {
      test(`generic password sign-in returns to ${scenario.route} with SSO ${scenario.unverified ? "unverified" : "disabled"} (dev)`, { timeout: 180_000 }, async ({ place, user, step, evidence }) => {
        const column = await matrixColumn();
        await arrangeEnforcement(column, false);
        if (scenario.unverified) await setSsoDomainVerified(column, false);
        else await setSsoEnabled(column, false);
        try {
          await using browser = await openSetupSsoBrowser({ host: place.host(), name: `setup-sso-generic-${scenario.unverified}` });
          const person = user.on(browser);
          const shot = journeyCapture(browser, step, `generic ${scenario.route}, SSO ${scenario.unverified ? "unverified" : "disabled"}`);
          await person.navigate(`${column.webUrl}${scenario.route}`);
          await person.see({ role: "heading", label: "Start using OpenWork" }, { timeoutMs: 90_000 });
          const signInUrl = new URL(await readSetupSsoBrowserUrl(browser));
          expect(signInUrl.pathname).toBe("/");
          expect(signInUrl.searchParams.get("mode")).toBe("sign-in");
          expect(signInUrl.searchParams.get("returnTo")).toBe(scenario.route);
          await person.notSee({ role: "button", label: "Continue with SSO" });
          await shot("Open the member link; reach generic sign-in with returnTo", "The page offers email sign-in.");
          await person.type({ role: "textbox", label: "Email" }, column.control.ownerEmail);
          await person.click({ role: "button", label: "Next" });
          await person.see({ role: "heading", label: "Enter your password." }, { timeoutMs: 90_000 });
          await shot("Enter the synthetic email and continue", "The page asks the person to enter their password.");
          await person.type({ role: "textbox", label: "Password" }, column.control.ownerPassword, { sensitive: true });
          await person.click({ role: "button", label: "Sign in" });
          await person.see({ role: "heading", label: scenario.route === "/install" ? "Set up OpenWork Enterprise" : "Setup is complete" }, { timeoutMs: 90_000 });
          expect(new URL(await readSetupSsoBrowserUrl(browser)).pathname).toBe(scenario.route);
          expect(new URL(await readSetupSsoBrowserUrl(browser)).search).toBe("");
          await shot("Sign in with password; return to the exact original member page", scenario.route === "/install" ? "The page shows Set up OpenWork Enterprise and desktop download options." : "The page says Setup is complete.");
          evidence.recordAssertionEvidence("Generic authentication preserves original member route", `SSO ${scenario.unverified ? "unverified" : "disabled"}; password sign-in returned to ${scenario.route}.`, true);
        } finally {
          if (scenario.unverified) await setSsoDomainVerified(column, true);
          else await setSsoEnabled(column, true);
        }
      });
    }

    const faults: Array<{ label: string; pathname: string; kind: "network" | "http-500" }> = [
      { label: "runtime configuration network failure", pathname: "/api/runtime-config", kind: "network" },
      { label: "session API HTTP 500", pathname: "/v1/me", kind: "http-500" },
    ];
    for (const fault of faults) for (const route of ["/install", "/", "/?desktopAuth=1", "/?client_id=synthetic-client&response_type=code&scope=mcp%3Aread&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback"]) {
      test(`${fault.label} shows retry and recovers on ${route} (dev)`, { timeout: 180_000 }, async ({ place, user, step, evidence }) => {
        const column = await matrixColumn();
        await arrangeEnforcement(column, false);
        await using browser = await openSetupSsoBrowser({ host: place.host(), name: `setup-sso-fault-${fault.kind}` });
        await installSetupSsoFetchFault(browser, fault.pathname, fault.kind);
        const person = user.on(browser);
        const shot = journeyCapture(browser, step, `${fault.label}, ${route}`);
        const originalUrl = `${column.webUrl}${route}`;
        await person.navigate(originalUrl);
        await person.see({ role: "heading", label: "Sign-in check unavailable" }, { timeoutMs: 90_000 });
        await person.see({ role: "button", label: "Try again" });
        if (route.includes("scope=")) await person.see({ text: "Signing in for" });
        expect(await readSetupSsoBrowserUrl(browser)).toBe(originalUrl);
        await person.notSee({ role: "button", label: "Approve sign-in" });
        await shot("Open the route with a failed authentication check", "The page says Sign-in check unavailable and offers a Try again button.");
        await clearSetupSsoFetchFault(browser);
        await person.click({ role: "button", label: "Try again" });
        await person.see({ role: "button", label: route === "/install" ? "Approve sign-in" : "Continue with SSO" }, { timeoutMs: 90_000 });
        await person.notSee({ role: "heading", label: "Sign-in check unavailable" });
        await shot("Restore service and choose Try again", route === "/install" ? "The synthetic identity provider shows the synthetic user and an Approve sign-in button." : "The sign-in page offers Continue with SSO.");
        evidence.recordAssertionEvidence(`${fault.label} on ${route} is fail-closed and recoverable`, "Kept original URL with a visible error and Try again; successful retry restored sign-in without weakening hydration checks.", true);
      });
    }
  }

  if (columnId === "pending") test("pending first-administrator bootstrap remains public (dev)", { timeout: 180_000 }, async ({ place, user, step, evidence }) => {
    const column = (await manifest()).pending;
    if (!column) throw new Error("Pending column missing.");
    const setupUrl = `${column.webUrl}/setup`;
    const response = await documentResponse(setupUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    await using browser = await openSetupSsoBrowser({ host: place.host(), name: "setup-sso-pending" });
    const person = user.on(browser);
    const shot = journeyCapture(browser, step, "first-administrator public setup");
    await person.navigate(setupUrl);
    await person.see({ role: "heading", label: "Set up your administrator account" }, { timeoutMs: 90_000 });
    expect(await readSetupSsoBrowserUrl(browser)).toBe(setupUrl);
    await person.notSee({ role: "button", label: "Continue with SSO" });
    await shot("Open /setup on a fresh deployment without an administrator", "The public form says Set up your administrator account.");
    await person.type({ role: "textbox", label: /^Administrator email$/i }, column.control.ownerEmail);
    await person.type({ role: "textbox", label: /^One-time setup code$/i }, column.control.bootstrapCode, { sensitive: true });
    await person.click({ role: "button", label: "Continue" });
    await person.see({ role: "button", label: "Create administrator" }, { timeoutMs: 90_000 });
    await shot("Verify the one-time setup code", "The form asks for the administrator name and password.");
    await person.type({ role: "textbox", label: /^Name$/i }, "Synthetic Administrator");
    await person.type({ role: "textbox", label: /^Password$/i }, column.control.ownerPassword, { sensitive: true });
    await person.click({ role: "button", label: "Create administrator" });
    await person.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
    expect(new URL(await readSetupSsoBrowserUrl(browser)).pathname).toBe("/install");
    await shot("Create the first administrator and reach installation", "The page shows Set up OpenWork Enterprise and desktop download options.");
    evidence.recordAssertionEvidence("Pending first-administrator bootstrap remains public", "Fresh database: HTTP 200 /setup stayed public without an auth redirect. The real UI accepted the one-time bootstrap code, created the first administrator, and opened authenticated /install.", true);
  });
});
