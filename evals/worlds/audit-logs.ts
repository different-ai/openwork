import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePort } from "@openwork/cdp";
import { localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, SkipError, type Den, type Place, type Seed } from "@openwork/env";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

async function requireCurrentRemoteSource(place: Place) {
  if (place.kind !== "daytona") return;
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal", "--", "ee/apps/den-api", "ee/apps/den-web", "ee/packages/den-db", "ee/packages/utils", "packages/types", "packages/sdk"], { cwd: root, timeout: 10_000 });
  if (stdout.trim()) throw new SkipError("a pushed audit implementation selected by OPENWORK_EVAL_REF; Daytona fetches a Git ref and cannot run this dirty app/API/schema checkout (no local placement fallback)");
}

async function seedAuditDatabase(den: Den, statement: string, values: string[]) {
  if (den.placement?.kind === "daytona") {
    if (den.placement.sandboxId === process.env.OPENWORK_EVAL_DAYTONA_DEN_SANDBOX?.trim()) throw new Error("Refusing audit release-flag writes to a prewarmed Den sandbox");
    const script = `
      import { createRequire } from "node:module";
      const { createConnection } = createRequire("/workspace/ee/packages/den-db/package.json")("mysql2/promise");
      const connection = await createConnection("mysql://root:password@127.0.0.1:3306/openwork_den");
      try {
        const [result] = await connection.execute(${JSON.stringify(statement)}, ${JSON.stringify(values)});
        if (result.affectedRows !== 1) throw new Error("Expected one organization-scoped audit seed write");
        console.log("audit-seeded");
      } finally {
        await connection.end();
      }
    `;
    const encoded = Buffer.from(script).toString("base64");
    const result = await execInSandbox(defaultDaytonaExec, den.placement.sandboxId, `printf %s ${encoded} | base64 -d | node --input-type=module`, { timeoutMs: 30_000, context: "Seed audit release flag in the journey-owned Den sandbox" });
    if (!result.stdout.includes("audit-seeded")) throw new Error("The owned sandbox did not confirm its audit seed");
    return;
  }
  const databaseUrl = den.database?.url;
  if (den.placement?.kind !== "local" || !databaseUrl) throw new Error("Audit journey requires a testkit-owned scratch database");
  const database = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || !database.pathname.startsWith("/openwork_eval_")) throw new Error("Refusing audit release-flag writes outside a disposable loopback testkit database");
  await queryDenDatabase(databaseUrl, statement, values);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a synthetic Den response object");
  return Object.fromEntries(Object.entries(value));
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected an identifier from the synthetic Den");
  return value;
}

export async function auditLogs(seed: Seed, { place }: { place: Place }) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim() || process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim()) throw new Error("Audit journey requires a fresh disposable Den, never an attached service");
  await requireCurrentRemoteSource(place);
  if (place.kind === "local" && (!await localMysqlIsRunning() || !await localRedisIsRunning())) throw new SkipError("local MySQL and Redis; run pnpm dev:den:mysql");
  const gatewayUrl = `http://127.0.0.1:${place.kind === "daytona" ? 8791 : await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      DEN_PLAN_GATING_ENABLED: "false", GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
      // Remove inherited overrides from the child process: prove the deployment defaults.
      DEN_AUDIT_CAPTURE_ENABLED: undefined, DEN_AUDIT_VISIBILITY_ENABLED: undefined,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: "Audit proof workspace",
      admin: { name: "Audit Owner", email: "audit-owner@example.test" },
      members: {
        teammate: { name: "Audit Teammate", email: "audit-teammate@example.test" },
        unflaggedOwner: { name: "Unflagged Owner", email: "unflagged-owner@example.test" },
      },
    },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Expected a synthetic teammate session");
  const org = await seed.api(den.admin, "/v1/org");
  if (!org.response.ok) throw new Error(`Synthetic organization lookup failed: ${org.response.status}`);
  const orgId = identifier(record(record(org.body).organization).id);
  const unflaggedOwner = den.members.unflaggedOwner;
  if (!unflaggedOwner) throw new Error("Expected a separate synthetic unflagged owner session");
  const unflagged = await seed.api(unflaggedOwner, "/v1/org", {
    method: "POST", body: JSON.stringify({ name: "Unflagged audit workspace" }),
  });
  if (!unflagged.response.ok) throw new Error(`Unflagged organization setup failed: ${unflagged.response.status}`);
  const unflaggedOrgId = identifier(record(record(unflagged.body).organization).id);
  const catalog = await seed.api(den.admin, "/v1/llm-provider-catalog/anthropic");
  if (!catalog.response.ok) throw new Error(`Provider catalog unavailable: ${catalog.response.status}`);
  const models = record(record(catalog.body).provider).models;
  if (!Array.isArray(models) || !models.length) throw new Error("Provider catalog contains no testable models");
  const modelId = identifier(record(models[0]).id);
  const originalCredential = "audit-fixture-original-not-a-real-key";
  const replacementCredential = "audit-fixture-replacement-not-a-real-key";
  const created = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Team models", providerId: "anthropic", modelIds: [modelId], credentialMode: "org", credential: { kind: "api_key", secret: originalCredential }, allMembers: true }),
  });
  if (!created.response.ok) throw new Error(`Synthetic provider setup failed: ${created.response.status}`);
  const providerId = identifier(record(record(created.body).inferenceProvider).id);
  const warmed = await seed.api(den.admin, `/v1/inference-providers/${encodeURIComponent(providerId)}/models`);
  if (!warmed.response.ok) throw new Error(`Synthetic model setup failed: ${warmed.response.status}`);
  // Seed only the release flag, preserving all existing metadata and sibling capabilities.
  // Provider setup predates the grant; browser/API traffic initializes the real
  // default policy and records access events before the user's provider save.
  await seedAuditDatabase(den, "UPDATE organization SET metadata = JSON_SET(JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.capabilities', COALESCE(JSON_EXTRACT(metadata, '$.capabilities'), JSON_OBJECT())), '$.capabilities.auditLogs', CAST('true' AS JSON)) WHERE id = ?", [orgId]);
  // Privileged Core actions taken after the release flag: the Core AuditSink
  // records them under their stable action strings. The unflagged organization
  // takes the same action and must leave no audit record.
  const orgHeaders = (id: string) => ({ "x-openwork-org-id": id });
  const apiKey = await seed.api(den.admin, "/v1/api-keys", { method: "POST", headers: orgHeaders(orgId), body: JSON.stringify({ name: "Audit sink witness" }) });
  if (apiKey.response.status !== 201) throw new Error(`Audited API key setup failed: ${apiKey.response.status}`);
  const auditedApiKeyId = identifier(record(record(apiKey.body).apiKey).id);
  const webOrigin = await seed.api(den.admin, "/v1/org/web-origins", { method: "POST", headers: orgHeaders(orgId), body: JSON.stringify({ origin: "https://audit-witness.example.test" }) });
  if (webOrigin.response.status !== 201) throw new Error(`Audited web origin setup failed: ${webOrigin.response.status}`);
  const auditedWebOriginId = identifier(record(webOrigin.body).id);
  const context = await seed.api(den.admin, "/v1/org", { headers: orgHeaders(orgId) });
  const members = record(context.body).members;
  if (!Array.isArray(members)) throw new Error("Expected organization members");
  // Promote, never demote: a demotion revokes the member's live sessions.
  const promotedMemberId = identifier(members.map(record).find((member) => record(member.user).email === unflaggedOwner.email)?.id);
  const promoted = await seed.api(den.admin, `/v1/members/${encodeURIComponent(promotedMemberId)}/role`, { method: "POST", headers: orgHeaders(orgId), body: JSON.stringify({ role: "admin" }) });
  if (!promoted.response.ok) throw new Error(`Audited role change failed: ${promoted.response.status}`);
  const unflaggedKey = await seed.api(unflaggedOwner, "/v1/api-keys", { method: "POST", headers: orgHeaders(unflaggedOrgId), body: JSON.stringify({ name: "Unaudited witness" }) });
  if (unflaggedKey.response.status !== 201) throw new Error(`Unflagged API key setup failed: ${unflaggedKey.response.status}`);
  const viewport = { width: 1440, height: 1100 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/audit-logs", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard/audit-logs", headless: true, viewport });
  const unflaggedWeb = await seed.web({ den, signedInAs: unflaggedOwner, startPath: "/dashboard", headless: true, viewport });
  return { den, web, memberWeb, unflaggedWeb, unflaggedOwner, unflaggedOrgId, teammate, promotedMemberId, orgId, providerId, auditedApiKeyId, auditedWebOriginId, originalCredential, replacementCredential, viewport };
}
