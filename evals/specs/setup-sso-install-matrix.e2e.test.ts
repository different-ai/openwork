import { afterAll, describe, expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { spec } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import {
  bootSetupSsoInstallMatrix,
  readSetupSsoManifest,
  runSetupSsoSql,
  SETUP_SSO_PRODUCT_SOURCE_FILES,
  setupSsoCurrentCommit,
  setupSsoInstallMatrixManifestPath,
  setupSsoProductSourceFingerprint,
} from "../worlds/setup-sso-install-matrix";

const providedManifestPath = process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST?.trim();
const requestedColumns = new Set(
  (process.env.OPENWORK_SETUP_SSO_MATRIX_COLUMNS?.split(",") ?? (providedManifestPath ? ["0.18.43", "0.18.48", "dev", "pending"] : ["dev", "pending"]))
    .map((value) => value.trim())
    .filter(Boolean),
);
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  commands: ["docker"],
  placement: "local",
};
let ownedMatrixStack: AsyncDisposableStack | undefined;
let ownedManifestReady: Promise<void> | undefined;

async function ensureMatrixManifest(): Promise<void> {
  if (providedManifestPath) return;
  ownedManifestReady ??= (async () => {
    const stack = new AsyncDisposableStack();
    try {
      await bootSetupSsoInstallMatrix(stack, { hostWeb: true, columns: [...requestedColumns] });
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
  try {
    await ownedMatrixStack?.disposeAsync();
  } finally {
    if (!providedManifestPath) delete process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST;
  }
});

const test = spec.world(async () => {
  await ensureMatrixManifest();
  return {};
}, {
  needs: requirements,
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

interface MatrixContext {
  enterprise: boolean;
  requireSso: boolean;
  ssoStatus: string;
  domainVerified: boolean;
  singletonConfigured: boolean;
  scimReady: boolean;
  scimUsersStatus: number;
  scimUsers: number;
  passwordSignInStatus: number;
  passwordSignInError: string;
}

interface MatrixColumn {
  id: string;
  apiVersion: string;
  apiImage: string;
  webImage: string;
  apiImageId: string;
  webImageId: string;
  apiUrl: string;
  webUrl: string;
  idpOrigin: string;
  project: string;
  context: MatrixContext;
  control: {
    organizationId: string;
    adminToken: string;
    adminCookie: string;
    ownerEmail: string;
    ownerPassword: string;
    installPath: string;
  };
}

interface MatrixPendingColumn {
  id: "pending";
  apiVersion: string;
  apiImage: string;
  webImage: string;
  apiImageId: string;
  webImageId: string;
  apiUrl: string;
  webUrl: string;
  project: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || !value[key]) throw new Error(`Matrix manifest is missing ${key}.`);
  return value[key];
}

function requiredBoolean(value: unknown, key: string): boolean {
  if (!isRecord(value) || typeof value[key] !== "boolean") throw new Error(`Matrix manifest is missing ${key}.`);
  return value[key];
}

function requiredNumber(value: unknown, key: string): number {
  if (!isRecord(value) || typeof value[key] !== "number") throw new Error(`Matrix manifest is missing ${key}.`);
  return value[key];
}

function requiredStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
    throw new Error(`Matrix manifest is missing ${key}.`);
  }
  return value[key];
}

function nullableString(value: unknown, key: string): string | null {
  if (!isRecord(value) || (value[key] !== null && typeof value[key] !== "string")) {
    throw new Error(`Matrix manifest has an invalid ${key}.`);
  }
  return value[key];
}

async function verifyManifestSource(payload: unknown): Promise<void> {
  if (!isRecord(payload)) throw new Error("Matrix manifest is invalid.");
  const source = payload.source;
  const fingerprint = requiredString(source, "fingerprint");
  expect(requiredStringArray(source, "productFiles")).toEqual(SETUP_SSO_PRODUCT_SOURCE_FILES);
  requiredStringArray(source, "dirtyProductFiles");
  expect(fingerprint).toBe(await setupSsoProductSourceFingerprint());
  const currentCommit = await setupSsoCurrentCommit();
  expect(requiredString(payload, "commit")).toBe(currentCommit);
  if (requiredString(source, "webMode") === "host-production") {
    expect(requiredString(source, "hostWebFingerprint")).toBe(fingerprint);
    expect(requiredString(source, "hostWebCommit")).toBe(currentCommit);
    expect(nullableString(source, "apiImageFingerprint")).toBeNull();
    expect(nullableString(source, "webImageFingerprint")).toBeNull();
    return;
  }
  expect(requiredString(source, "apiImageFingerprint")).toBe(fingerprint);
  expect(requiredString(source, "webImageFingerprint")).toBe(fingerprint);
}

function parseColumn(value: unknown): MatrixColumn {
  if (!isRecord(value)) throw new Error("Matrix manifest contains an invalid column.");
  const contextValue = value.context;
  return {
    id: requiredString(value, "id"),
    apiVersion: requiredString(value, "apiVersion"),
    apiImage: requiredString(value, "apiImage"),
    webImage: requiredString(value, "webImage"),
    apiImageId: requiredString(value, "apiImageId"),
    webImageId: requiredString(value, "webImageId"),
    apiUrl: requiredString(value, "apiUrl"),
    webUrl: requiredString(value, "webUrl"),
    idpOrigin: requiredString(value, "idpOrigin"),
    project: requiredString(value, "project"),
    context: {
      enterprise: requiredBoolean(contextValue, "enterprise"),
      requireSso: requiredBoolean(contextValue, "requireSso"),
      ssoStatus: requiredString(contextValue, "ssoStatus"),
      domainVerified: requiredBoolean(contextValue, "domainVerified"),
      singletonConfigured: requiredBoolean(contextValue, "singletonConfigured"),
      scimReady: requiredBoolean(contextValue, "scimReady"),
      scimUsersStatus: requiredNumber(contextValue, "scimUsersStatus"),
      scimUsers: requiredNumber(contextValue, "scimUsers"),
      passwordSignInStatus: requiredNumber(contextValue, "passwordSignInStatus"),
      passwordSignInError: requiredString(contextValue, "passwordSignInError"),
    },
    control: {
      organizationId: requiredString(value.control, "organizationId"),
      adminToken: requiredString(value.control, "adminToken"),
      adminCookie: requiredString(value.control, "adminCookie"),
      ownerEmail: requiredString(value.control, "ownerEmail"),
      ownerPassword: requiredString(value.control, "ownerPassword"),
      installPath: requiredString(value.control, "installPath"),
    },
  };
}

async function matrixColumn(id: string): Promise<MatrixColumn> {
  const path = process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST?.trim();
  if (!path) throw new Error("OPENWORK_SETUP_SSO_MATRIX_MANIFEST is required.");
  const payload = await readSetupSsoManifest(path);
  if (!isRecord(payload) || !Array.isArray(payload.columns)) throw new Error("Matrix manifest has no columns.");
  await verifyManifestSource(payload);
  const column = payload.columns.map(parseColumn).find((candidate) => candidate.id === id);
  if (!column) throw new Error(`Matrix manifest has no ${id} column.`);
  return column;
}

async function pendingColumn(): Promise<MatrixPendingColumn> {
  const path = process.env.OPENWORK_SETUP_SSO_MATRIX_MANIFEST?.trim();
  if (!path) throw new Error("OPENWORK_SETUP_SSO_MATRIX_MANIFEST is required.");
  const payload = await readSetupSsoManifest(path);
  if (!isRecord(payload) || !isRecord(payload.pending)) throw new Error("Matrix manifest has no pending column.");
  await verifyManifestSource(payload);
  return {
    id: "pending",
    apiVersion: requiredString(payload.pending, "apiVersion"),
    apiImage: requiredString(payload.pending, "apiImage"),
    webImage: requiredString(payload.pending, "webImage"),
    apiImageId: requiredString(payload.pending, "apiImageId"),
    webImageId: requiredString(payload.pending, "webImageId"),
    apiUrl: requiredString(payload.pending, "apiUrl"),
    webUrl: requiredString(payload.pending, "webUrl"),
    project: requiredString(payload.pending, "project"),
  };
}

function expectEnterpriseSsoScimContext(column: MatrixColumn): void {
  expect(column.context).toEqual({
    enterprise: true,
    requireSso: false,
    ssoStatus: "enabled",
    domainVerified: true,
    singletonConfigured: true,
    scimReady: true,
    scimUsersStatus: 200,
    scimUsers: 1,
    passwordSignInStatus: 403,
    passwordSignInError: "single_org_sso_required",
  });
}

async function documentResponse(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
}

async function arrangeEnforcement(column: MatrixColumn, requireSso: boolean): Promise<void> {
  const serialized = requireSso ? "true" : "false";
  const sql = `DELETE FROM rate_limit; UPDATE organization SET metadata=JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.requireSso', CAST('${serialized}' AS JSON)) WHERE id='${column.control.organizationId.replaceAll("'", "''")}'; SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.requireSso')) FROM organization WHERE id='${column.control.organizationId.replaceAll("'", "''")}';`;
  expect(await runSetupSsoSql(column.project, sql)).toBe(serialized);
  const passwordSignIn = await fetch(`${column.apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: column.webUrl, "content-type": "application/json" },
    body: JSON.stringify({ email: column.control.ownerEmail, password: column.control.ownerPassword }),
    signal: AbortSignal.timeout(30_000),
  });
  const passwordPayload: unknown = await passwordSignIn.json();
  expect(passwordSignIn.status).toBe(403);
  expect(requiredString(passwordPayload, "error")).toBe("single_org_sso_required");
}

async function setSsoEnabled(column: MatrixColumn, enabled: boolean): Promise<void> {
  const status = enabled ? "enabled" : "disabled";
  const sql = `UPDATE sso_connection SET status='${status}' WHERE organization_id='${column.control.organizationId.replaceAll("'", "''")}'; SELECT status FROM sso_connection WHERE organization_id='${column.control.organizationId.replaceAll("'", "''")}';`;
  expect(await runSetupSsoSql(column.project, sql)).toBe(status);
  const singleton = await fetch(`${column.apiUrl}/v1/orgs/sso/singleton`, { signal: AbortSignal.timeout(30_000) });
  const payload: unknown = await singleton.json();
  expect(singleton.status).toBe(200);
  expect(requiredBoolean(payload, "configured")).toBe(enabled);
}

async function setSsoDomainVerified(column: MatrixColumn, verified: boolean): Promise<void> {
  const serialized = verified ? "1" : "0";
  const sql = `UPDATE sso_provider SET domain_verified=${serialized} WHERE organization_id='${column.control.organizationId.replaceAll("'", "''")}'; SELECT CONCAT(c.status, ':', p.domain_verified) FROM sso_connection c INNER JOIN sso_provider p ON c.provider_id=p.provider_id AND c.organization_id=p.organization_id WHERE c.organization_id='${column.control.organizationId.replaceAll("'", "''")}' LIMIT 1;`;
  expect(await runSetupSsoSql(column.project, sql)).toBe(`enabled:${serialized}`);
  const singleton = await fetch(`${column.apiUrl}/v1/orgs/sso/singleton`, { signal: AbortSignal.timeout(30_000) });
  const payload: unknown = await singleton.json();
  expect(singleton.status).toBe(200);
  expect(requiredBoolean(payload, "configured")).toBe(verified);
}

type MatrixBrowser = Awaited<ReturnType<typeof chrome>>;

async function installSingleFetchFault(browser: MatrixBrowser, pathname: string, kind: "network" | "http-500"): Promise<void> {
  const source = `(() => {
    const originalFetch = window.fetch.bind(window);
    window.__openworkSetupSsoFetchFaultEnabled = true;
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, window.location.origin);
      if (window.__openworkSetupSsoFetchFaultEnabled && (url.pathname === ${JSON.stringify(pathname)} || url.pathname === ${JSON.stringify(`/api/browser${pathname}`)})) {
        if (${JSON.stringify(kind)} === "network") return Promise.reject(new TypeError("Synthetic network failure"));
        return Promise.resolve(new Response(JSON.stringify({ error: "synthetic_failure" }), { status: 500, headers: { "content-type": "application/json" } }));
      }
      return originalFetch(input, init);
    };
  })();`;
  await browser.client.send("Page.addScriptToEvaluateOnNewDocument", { source });
}

const enforcementCases: Array<{ label: string; slug: string; requireSso: boolean }> = [
  { label: "enforcement OFF + password disabled", slug: "off", requireSso: false },
  { label: "enforcement ON + password disabled", slug: "on", requireSso: true },
];
const requestedReleaseColumns = ["0.18.43", "0.18.48"].filter((id) => requestedColumns.has(id));

if (requestedReleaseColumns.length > 0) describe.sequential("setup SSO install route matrix", () => {
for (const columnId of requestedReleaseColumns) {
  for (const enforcement of enforcementCases) {
    test(`candidate bare /install renders the sign-in dead end (${columnId}, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn(columnId);
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, enforcement.requireSso);
      const installUrl = `${column.webUrl}/install`;
      const documentResult = await documentResponse(installUrl);
      expect(documentResult.status).toBe(200);
      expect(documentResult.headers.get("location")).toBeNull();
      const config = await fetch(`${column.apiUrl}/v1/me/install-config`, { headers: { origin: column.webUrl }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      expect(config.status).toBe(401);
      expect(config.headers.get("location")).toBeNull();

      await using browser = await chrome({ host: place.host(), name: `setup-sso-install-${columnId}-${enforcement.slug}`, startUrl: "about:blank", headless: true });
      const person = user.on(browser);
      await person.navigate(installUrl);
      await person.see({ text: "OpenWork Desktop" }, { timeoutMs: 90_000 });
      await person.see({ role: "heading", label: "This install link can't be opened." });
      await person.see({ text: "Sign in to your Den portal to install OpenWork." });
      await person.notSee({ role: "button", label: "Continue with SSO" });
      const eyebrow = await seed.evalIn(browser, () => {
        const element = document.querySelector(".den-eyebrow");
        return { text: element?.textContent?.trim() ?? null, textTransform: element ? getComputedStyle(element).textTransform : null };
      });
      expect(eyebrow).toEqual({ text: "OpenWork Desktop", textTransform: "uppercase" });
      expect(await seed.evalIn(browser, () => location.href)).toBe(installUrl);
      await person.screenshot();
      evidence.recordAssertionEvidence(
        `Screenshot text matches on the candidate bare /install route for ${columnId}, ${enforcement.label}`,
        `GET /install returned 200 without Location, GET /v1/me/install-config returned 401 without Location, password sign-in returned 403 single_org_sso_required, and the browser stayed on /install. The screenshot renders “OPENWORK DESKTOP”, “This install link can't be opened.”, and “Sign in to your Den portal to install OpenWork.” with no Continue with SSO action. This is a screenshot-text match and candidate-route reproduction; the originally reported link remains unknown.`,
        true,
      );
    });

    test(`valid install token is a successful control (${columnId}, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn(columnId);
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, enforcement.requireSso);
      const installUrl = new URL(column.control.installPath, column.webUrl).toString();
      const documentResult = await documentResponse(installUrl);
      expect(documentResult.status).toBe(200);
      expect(documentResult.headers.get("location")).toBeNull();
      const token = new URL(installUrl).searchParams.get("token");
      expect(token).toBeTruthy();
      const config = await fetch(`${column.apiUrl}/v1/install-config?token=${encodeURIComponent(token ?? "")}`, { headers: { origin: column.webUrl }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      expect(config.status).toBe(200);
      expect(config.headers.get("location")).toBeNull();

      await using browser = await chrome({ host: place.host(), name: `setup-sso-install-valid-${columnId}-${enforcement.slug}`, startUrl: "about:blank", headless: true });
      const person = user.on(browser);
      await person.navigate(installUrl);
      await person.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
      await person.notSee({ role: "heading", label: "This install link can't be opened." });
      const finalUrl = new URL(await seed.evalIn(browser, () => location.href));
      expect(finalUrl.pathname).toBe("/install");
      expect(finalUrl.searchParams.has("token")).toBe(true);
      await person.screenshot();
      evidence.recordAssertionEvidence(
        `Valid install-token control succeeds on ${columnId}, ${enforcement.label}`,
        `GET /install?token=<valid> and GET /v1/install-config?token=<valid> both returned 200 without Location; the browser stayed on token-bearing /install and showed “Set up OpenWork Enterprise” instead of the dead-end error. The token value was intentionally withheld from evidence.`,
        true,
      );
    });

    test(`post-bootstrap /setup requires a manual generic sign-in (${columnId}, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn(columnId);
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, enforcement.requireSso);
      const setupUrl = `${column.webUrl}/setup`;
      const documentResult = await documentResponse(setupUrl);
      expect(documentResult.status).toBe(200);
      expect(documentResult.headers.get("location")).toBeNull();

      await using browser = await chrome({ host: place.host(), name: `setup-sso-complete-${columnId}-${enforcement.slug}`, startUrl: "about:blank", headless: true });
      const person = user.on(browser);
      await person.navigate(setupUrl);
      await person.see({ role: "heading", label: "Setup is complete" }, { timeoutMs: 90_000 });
      await person.see({ role: "button", label: "Sign in" });
      await person.notSee({ role: "button", label: "Continue with SSO" });
      expect(await seed.evalIn(browser, () => location.href)).toBe(setupUrl);
      await person.screenshot();
      evidence.recordAssertionEvidence(
        `Post-bootstrap /setup has no automatic or explicit SSO handoff on ${columnId}, ${enforcement.label}`,
        `GET /setup returned 200 without Location; password sign-in was disabled, yet the browser stayed on /setup, showed “Setup is complete” plus only a generic “Sign in” button, and exposed no Continue with SSO action.`,
        true,
      );
    });

    test(`home exposes configured SSO only after a click (${columnId}, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn(columnId);
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, enforcement.requireSso);
      const homeUrl = `${column.webUrl}/`;
      const documentResult = await documentResponse(homeUrl);
      expect(documentResult.status).toBe(200);
      expect(documentResult.headers.get("location")).toBeNull();

      await using browser = await chrome({ host: place.host(), name: `setup-sso-home-${columnId}-${enforcement.slug}`, startUrl: "about:blank", headless: true });
      const person = user.on(browser);
      await person.navigate(homeUrl);
      await person.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 90_000 });
      expect(new URL(await seed.evalIn(browser, () => location.href)).pathname).toBe("/");
      await person.screenshot();
      await person.click({ role: "button", label: "Continue with SSO" });
      await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
      const identityProviderUrl = new URL(await seed.evalIn(browser, () => location.href));
      expect(identityProviderUrl.origin).toBe(column.idpOrigin);
      expect(identityProviderUrl.pathname).toBe("/authorize");
      expect([...identityProviderUrl.searchParams.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"].sort());
      await person.screenshot();
      evidence.recordAssertionEvidence(
        `Configured singleton SSO is manual on home for ${columnId}, ${enforcement.label}`,
        `GET / returned 200 without Location and stayed on / until the person clicked Continue with SSO; only then did the browser reach the synthetic provider /authorize endpoint with the expected OIDC parameter names.`,
        true,
      );
    });
  }
}
});

describe.sequential("setup SSO member route handoff", () => {
  if (requestedColumns.has("dev")) {
    for (const enforcement of enforcementCases) {
      test(`bare /install automatically completes SSO and returns to /install (dev, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
        const column = await matrixColumn("dev");
        expectEnterpriseSsoScimContext(column);
        await arrangeEnforcement(column, enforcement.requireSso);
        const installUrl = `${column.webUrl}/install`;

        await using browser = await chrome({ host: place.host(), name: `setup-sso-fixed-install-${enforcement.slug}`, startUrl: "about:blank", headless: true });
        const person = user.on(browser);
        await person.navigate(installUrl);
        await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
        const identityProviderUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(identityProviderUrl.origin).toBe(column.idpOrigin);
        expect(identityProviderUrl.pathname).toBe("/authorize");
        expect([...identityProviderUrl.searchParams.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"].sort());
        expect(identityProviderUrl.searchParams.has("token")).toBe(false);

        await person.click({ role: "button", label: "Approve sign-in" });
        await person.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
        const finalUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(finalUrl.origin).toBe(column.webUrl);
        expect(finalUrl.pathname).toBe("/install");
        expect(finalUrl.search).toBe("");
        await person.notSee({ role: "heading", label: "This install link can't be opened." });
        await person.screenshot();
        evidence.recordAssertionEvidence(
          `Signed-out bare /install completes organization SSO and returns to /install with ${enforcement.label}`,
          "The browser reached the synthetic identity provider without a click on Den, exposed only the expected OIDC parameters and no token parameter, then returned to token-free /install and rendered the authenticated enterprise install guide.",
          true,
        );
      });

      test(`completed /setup automatically completes SSO without a redirect loop (dev, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
        const column = await matrixColumn("dev");
        expectEnterpriseSsoScimContext(column);
        await arrangeEnforcement(column, enforcement.requireSso);
        const setupUrl = `${column.webUrl}/setup`;

        await using browser = await chrome({ host: place.host(), name: `setup-sso-fixed-setup-${enforcement.slug}`, startUrl: "about:blank", headless: true });
        const person = user.on(browser);
        await person.navigate(setupUrl);
        await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
        const identityProviderUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(identityProviderUrl.origin).toBe(column.idpOrigin);
        expect(identityProviderUrl.pathname).toBe("/authorize");
        expect(identityProviderUrl.searchParams.has("token")).toBe(false);
        await person.click({ role: "button", label: "Approve sign-in" });
        await person.see({ role: "heading", label: "Setup is complete" }, { timeoutMs: 90_000 });
        const finalUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(finalUrl.origin).toBe(column.webUrl);
        expect(finalUrl.pathname).toBe("/setup");
        expect(finalUrl.search).toBe("");
        await person.notSee({ role: "button", label: "Approve sign-in" });
        await person.screenshot();
        evidence.recordAssertionEvidence(
          `Signed-out completed /setup returns after organization SSO and stays rendered with ${enforcement.label}`,
          "The browser automatically reached the synthetic identity provider, then returned to token-free /setup where the signed-in completed state remained visible without another identity-provider handoff.",
          true,
        );
      });

      test(`valid install token remains public (dev, ${enforcement.label})`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
        const column = await matrixColumn("dev");
        expectEnterpriseSsoScimContext(column);
        await arrangeEnforcement(column, enforcement.requireSso);
        const installUrl = new URL(column.control.installPath, column.webUrl).toString();

        await using browser = await chrome({ host: place.host(), name: `setup-sso-fixed-token-${enforcement.slug}`, startUrl: "about:blank", headless: true });
        const person = user.on(browser);
        await person.navigate(installUrl);
        await person.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
        const finalUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(finalUrl.origin).toBe(column.webUrl);
        expect(finalUrl.pathname).toBe("/install");
        expect(finalUrl.searchParams.has("token")).toBe(true);
        await person.notSee({ role: "button", label: "Approve sign-in" });
        await person.screenshot();
        evidence.recordAssertionEvidence(
          `Valid install token remains public with ${enforcement.label}`,
          "The token-bearing install link stayed on Den and rendered the enterprise install guide without visiting the identity provider. The token value was intentionally withheld from evidence.",
          true,
        );
      });
    }

    test("generic member sign-in preserves web handoff context without copying arbitrary parameters (dev)", { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn("dev");
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, false);
      await setSsoEnabled(column, false);
      try {
        const installUrl = new URL("/install", column.webUrl);
        installUrl.searchParams.set("token", "");
        installUrl.searchParams.set("webAuth", "1");
        installUrl.searchParams.set("webAuthReturn", "https://web.openworklabs.com/auth/callback");
        installUrl.searchParams.set("arbitrary", "drop-me");
        await using browser = await chrome({ host: place.host(), name: "setup-sso-fixed-generic-context", startUrl: "about:blank", headless: true });
        const person = user.on(browser);
        await person.navigate(installUrl.toString());
        await person.see({ role: "heading", label: "Start using OpenWork" }, { timeoutMs: 90_000 });
        const signInUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(signInUrl.pathname).toBe("/");
        expect(signInUrl.searchParams.get("mode")).toBe("sign-in");
        expect(signInUrl.searchParams.get("returnTo")).toBe("/install");
        expect(signInUrl.searchParams.get("webAuth")).toBe("1");
        expect(signInUrl.searchParams.get("webAuthReturn")).toBe("https://web.openworklabs.com/auth/callback");
        expect(signInUrl.searchParams.has("token")).toBe(false);
        expect(signInUrl.searchParams.has("arbitrary")).toBe(false);
        await person.screenshot();
        evidence.recordAssertionEvidence(
          "Generic member sign-in preserves only allowlisted handoff context",
          "The automatic generic sign-in redirect retained mode, the allowlisted /install return target, webAuth and webAuthReturn, while dropping token and an arbitrary query parameter.",
          true,
        );
      } finally {
        await setSsoEnabled(column, true);
      }
    });

    test("generic password sign-in retains the bare /install return target when SSO is disabled (dev)", { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn("dev");
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, false);
      await setSsoEnabled(column, false);
      try {
        await using browser = await chrome({ host: place.host(), name: "setup-sso-fixed-generic", startUrl: "about:blank", headless: true });
        const person = user.on(browser);
        await person.navigate(`${column.webUrl}/install`);
        await person.see({ role: "heading", label: "Start using OpenWork" }, { timeoutMs: 90_000 });
        const signInUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(signInUrl.pathname).toBe("/");
        expect(signInUrl.searchParams.get("mode")).toBe("sign-in");
        expect(signInUrl.searchParams.get("returnTo")).toBe("/install");
        await person.type({ role: "textbox", label: "Email" }, column.control.ownerEmail);
        await person.click({ role: "button", label: "Next" });
        await person.see({ role: "heading", label: "Enter your password." }, { timeoutMs: 90_000 });
        await person.type({ role: "textbox", label: "Password" }, column.control.ownerPassword, { sensitive: true });
        await person.click({ role: "button", label: "Sign in" });
        await person.see({ role: "heading", label: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
        const finalUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(finalUrl.pathname).toBe("/install");
        expect(finalUrl.search).toBe("");
        await person.screenshot();
        evidence.recordAssertionEvidence(
          "Generic password sign-in retains the member route",
          "With organization SSO disabled, bare /install redirected to generic sign-in with an allowlisted /install return target; successful password authentication returned to token-free /install.",
          true,
        );
      } finally {
        await setSsoEnabled(column, true);
      }
    });

    test("completed /setup uses generic sign-in when the enabled provider is unverified (dev)", { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await matrixColumn("dev");
      expectEnterpriseSsoScimContext(column);
      await arrangeEnforcement(column, false);
      await setSsoDomainVerified(column, false);
      try {
        await using browser = await chrome({ host: place.host(), name: "setup-sso-fixed-unverified-setup", startUrl: "about:blank", headless: true });
        const person = user.on(browser);
        await person.navigate(`${column.webUrl}/setup`);
        await person.see({ role: "heading", label: "Start using OpenWork" }, { timeoutMs: 90_000 });
        const signInUrl = new URL(await seed.evalIn(browser, () => location.href));
        expect(signInUrl.pathname).toBe("/");
        expect(signInUrl.searchParams.get("mode")).toBe("sign-in");
        expect(signInUrl.searchParams.get("returnTo")).toBe("/setup");
        await person.type({ role: "textbox", label: "Email" }, column.control.ownerEmail);
        await person.click({ role: "button", label: "Next" });
        await person.see({ role: "heading", label: "Enter your password." }, { timeoutMs: 90_000 });
        await person.type({ role: "textbox", label: "Password" }, column.control.ownerPassword, { sensitive: true });
        await person.click({ role: "button", label: "Sign in" });
        await person.see({ role: "heading", label: "Setup is complete" }, { timeoutMs: 90_000 });
        expect(new URL(await seed.evalIn(browser, () => location.href)).pathname).toBe("/setup");
        await person.screenshot();
        evidence.recordAssertionEvidence(
          "An enabled but unverified provider uses generic sign-in for completed setup",
          "The live SSO connection remained enabled while its provider domain was unverified; singleton discovery reported unconfigured, completed /setup used generic password sign-in, and authentication returned to /setup.",
          true,
        );
      } finally {
        await setSsoDomainVerified(column, true);
      }
    });

    const faults: Array<{ label: string; pathname: string; kind: "network" | "http-500" }> = [
      { label: "runtime configuration network failure", pathname: "/api/runtime-config", kind: "network" },
      { label: "session API HTTP 500", pathname: "/v1/me", kind: "http-500" },
    ];
    for (const fault of faults) {
      test(`${fault.label} shows retry without automatic authentication navigation (dev)`, { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
        const column = await matrixColumn("dev");
        expectEnterpriseSsoScimContext(column);
        await arrangeEnforcement(column, false);
        await using browser = await chrome({ host: place.host(), name: `setup-sso-fixed-fault-${fault.kind}`, startUrl: "about:blank", headless: true });
        await installSingleFetchFault(browser, fault.pathname, fault.kind);
        const person = user.on(browser);
        const installUrl = `${column.webUrl}/install`;
        await person.navigate(installUrl);
        await person.see({ role: "heading", label: "Sign-in check unavailable" }, { timeoutMs: 90_000 });
        await person.see({ role: "button", label: "Try again" });
        expect(await seed.evalIn(browser, () => location.href)).toBe(installUrl);
        await person.notSee({ role: "button", label: "Approve sign-in" });
        await person.screenshot();
        await browser.client.send("Runtime.evaluate", { expression: "window.__openworkSetupSsoFetchFaultEnabled = false" });
        await person.click({ role: "button", label: "Try again" });
        await person.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
        evidence.recordAssertionEvidence(
          `${fault.label} is fail-closed and recoverable`,
          "The member route stayed on /install, rendered an explicit sign-in-check error with Try again, did not navigate to generic or organization authentication while the check failed, and reached SSO only after an explicit successful retry.",
          true,
        );
      });
    }
  }

  if (requestedColumns.has("pending")) {
    test("pending first-administrator bootstrap remains public (dev)", { timeout: 180_000 }, async ({ place, user, seed, evidence }) => {
      const column = await pendingColumn();
      const setupUrl = `${column.webUrl}/setup`;
      const documentResult = await documentResponse(setupUrl);
      expect(documentResult.status).toBe(200);
      expect(documentResult.headers.get("location")).toBeNull();

      await using browser = await chrome({ host: place.host(), name: "setup-sso-fixed-pending", startUrl: "about:blank", headless: true });
      const person = user.on(browser);
      await person.navigate(setupUrl);
      await person.see({ role: "heading", label: "Set up your administrator account" }, { timeoutMs: 90_000 });
      expect(await seed.evalIn(browser, () => location.href)).toBe(setupUrl);
      await person.notSee({ role: "button", label: "Continue with SSO" });
      await person.screenshot();
      evidence.recordAssertionEvidence(
        "Pending first-administrator bootstrap remains public",
        "A fresh deployment returned HTTP 200 for /setup and kept the browser on the public administrator bootstrap form without an SSO or generic sign-in redirect.",
        true,
      );
    });
  }
});
