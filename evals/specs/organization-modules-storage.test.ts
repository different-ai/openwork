import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { localMysqlIsRunning, needs, server, SkipError, test } from "@openwork/testkit";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, found);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { found.add(key); keysDeep(child, found); }
  return found;
}

test("organization.modules backfills from organization_feature opt-outs, ignores admin writes and never reaches clients", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ commands: ["pnpm"], placement: "local" });
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306 for an isolated, migrated Den database");
  const organizationName = `Modules Storage ${Date.now()}`;
  await using den = await server({ place, web: false, schema: "migrate", org: { name: organizationName } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("Must cold-boot an owned isolated database, never attach a shared Den");
  if (!new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Refusing direct writes outside a disposable testkit database");

  const authed = { authorization: `Bearer ${den.admin.token}` };
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: authed });
  expect(orgs.response.status, orgs.text).toBe(200);
  const listed = record(orgs.body).orgs;
  if (!Array.isArray(listed)) throw new Error("Expected an org list");
  const orgId = String(record(listed.map(record).find((org) => org.name === organizationName)).id);
  const orgHeaders = { ...authed, "x-openwork-org-id": orgId };

  const column = async (): Promise<Record<string, unknown> | null> => {
    const [row] = await queryDenDatabase(databaseUrl, "SELECT modules FROM organization WHERE id = ?", [orgId]);
    const value = record(row).modules;
    if (value === null) return null;
    return record(typeof value === "string" ? JSON.parse(value) : value);
  };
  const setCapabilities = async (capabilities: Record<string, boolean | null>) => {
    const response = await denFetch(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", headers: authed, body: JSON.stringify({ capabilities }) });
    expect(response.response.status, response.text).toBe(200);
    return record(record(response.body).capabilities);
  };
  const reportDirectory = await mkdtemp(join(tmpdir(), "modules-backfill-"));
  const backfill = async (...flags: string[]) => {
    const reportPath = join(reportDirectory, `report-${Date.now()}.json`);
    const run = await execFileAsync("pnpm", ["--filter", "@openwork-ee/den-api", "exec", "tsx", "--conditions=development", "scripts/backfill-organization-modules.ts", ...flags, "--org", orgId, "--report", reportPath], {
      cwd: repoRoot,
      timeout: 120_000,
      env: {
        ...process.env,
        OPENWORK_DEV_MODE: "1",
        DATABASE_URL: databaseUrl,
        DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
        BETTER_AUTH_SECRET: "local-testkit-secret-not-for-production-use!!",
        BETTER_AUTH_URL: den.ref.webUrl,
      },
    }).then((result) => ({ code: 0, stdout: result.stdout }), (error: unknown) => {
      const failed = record(error);
      return { code: typeof failed.code === "number" ? failed.code : -1, stdout: String(failed.stdout ?? "") };
    });
    return { code: run.code, report: record(JSON.parse(await readFile(reportPath, "utf8"))) };
  };

  // Platform-admin feature overrides go to organization_feature only; they are never mirrored into the column (D43).
  expect(await column()).toBeNull();
  expect(await setCapabilities({ installLinks: false })).toMatchObject({ installLinks: false });
  expect(await column()).toBeNull();

  const dryRun = await backfill("--dry-run");
  expect(dryRun.code).toBe(0);
  expect(dryRun.report).toMatchObject({ mode: "dry-run", scanned: 1, wouldWrite: 1, written: 0, disabledByModule: { "org.installLinks": 1, "library.connectors": 0 } });
  expect(await column()).toBeNull();
  const written = await backfill();
  expect(written.report).toMatchObject({ mode: "write", scanned: 1, written: 1 });
  expect(await column()).toMatchObject({ schemaVersion: 1, revision: 1, disabled: ["org.installLinks"], updatedBy: null });
  const again = await backfill();
  expect(again.report).toMatchObject({ written: 0, alreadyPresent: 1 });
  expect(await column()).toMatchObject({ revision: 1 });
  expect((await backfill("--verify")).code).toBe(0);
  evidence.recordAssertionEvidence("The backfill CLI copies explicit organization_feature opt-outs once", "After an admin installLinks=false override left the column NULL, the dry run reported one write and changed nothing; the real run stored revision 1 with disabled=[org.installLinks]; a second run wrote nothing; --verify exited 0.", true);

  // Once a document exists, admin override writes and grants still leave it alone; --verify reports the drift.
  for (const capabilities of [{ mcpConnections: false }, { auditLogs: true }, { installLinks: null }] as const) {
    await setCapabilities(capabilities);
    expect(await column(), JSON.stringify(capabilities)).toMatchObject({ disabled: ["org.installLinks"], revision: 1 });
  }
  const diverged = await backfill("--verify");
  expect(diverged.code).toBe(1);
  expect(diverged.report.verifyMismatches).toEqual([
    { organizationId: orgId, module: "library.connectors", overrideDisabled: true, columnDisabled: false },
    { organizationId: orgId, module: "org.installLinks", overrideDisabled: false, columnDisabled: true },
  ]);
  await setCapabilities({ mcpConnections: null, auditLogs: null });
  evidence.recordAssertionEvidence("Admin feature overrides never write the column", "PUT /v1/admin/organizations/:id/capabilities changed mcpConnections, auditLogs and installLinks overrides while organization.modules stayed at revision 1 with disabled=[org.installLinks]; --verify exited 1 and named both drifted modules.", true);

  // The stored document is server-only, even when it carries a license-like payload.
  const marker = `license-payload-${Date.now()}`;
  await queryDenDatabase(databaseUrl, "UPDATE organization SET modules = JSON_SET(modules, '$.revision', 9, '$.disabled', JSON_ARRAY('org.installLinks'), '$.entitlement', JSON_OBJECT('marker', ?)) WHERE id = ?", [marker, orgId]);
  const context = await denFetch(den.admin, "/v1/org", { headers: orgHeaders });
  expect(context.response.status, context.text).toBe(200);
  expect(context.text).not.toContain(marker);
  expect(keysDeep(record(context.body).organization).has("modules")).toBe(false);
  // Feature state still comes from organization_feature, not from the stored document.
  expect(record(record(context.body).features)).toMatchObject({ installLinks: true, mcpConnections: true });
  expect(record(record(context.body).capabilities)).toMatchObject({ installLinks: true, mcpConnections: true });
  const renamed = await denFetch(den.admin, "/v1/org", { method: "PATCH", headers: orgHeaders, body: JSON.stringify({ name: `${organizationName} renamed` }) });
  expect(renamed.response.status, renamed.text).toBe(200);
  expect(renamed.text).not.toContain(marker);
  expect(Object.keys(record(record(renamed.body).organization))).not.toContain("modules");
  const created = await denFetch(den.admin, "/v1/org", { method: "POST", headers: authed, body: JSON.stringify({ name: `${organizationName} second` }) });
  expect(created.response.status, created.text).toBe(201);
  expect(Object.keys(record(record(created.body).organization))).not.toContain("modules");
  const betterAuth = await denFetch(den.admin, `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(orgId)}`, { headers: authed });
  expect(betterAuth.text).not.toContain(marker);
  if (betterAuth.response.ok) expect(keysDeep(betterAuth.body).has("modules")).toBe(false);
  evidence.recordAssertionEvidence("The stored document never reaches clients", `With a marker in organization.modules, GET /v1/org kept today's features and capabilities (still derived from organization_feature) and, like PATCH /v1/org and POST /v1/org, returned no modules key and no marker; the Better Auth full-organization endpoint (HTTP ${betterAuth.response.status}) did not return the marker.`, true);
});
