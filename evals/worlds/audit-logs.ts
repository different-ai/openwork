import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePort, evaluateOnSurface } from "@openwork/cdp";
import { createAdmin, localMysqlIsRunning, localRedisIsRunning, queryDenDatabase, SkipError, type Den, type Place, type Seed } from "@openwork/env";
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

// Synthetic token for this disposable Den's maintenance endpoint (not a secret).
const MAINTENANCE_TOKEN = "eval-maintenance-token-0123456789abcdef";

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
      DEN_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN,
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
  const teammateOrg = await seed.api(teammate, "/v1/org");
  if (!teammateOrg.response.ok) throw new Error(`Synthetic teammate lookup failed: ${teammateOrg.response.status}`);
  const teammateUserId = identifier(record(record(teammateOrg.body).currentMember).userId);
  // A platform administrator who is not a member of the audited organization,
  // so its admin change is attributed to "Platform administrator", not a member name.
  const platformAdminEmail = "audit-platform-admin@example.test";
  const granted = await seed.api(den.admin, "/v1/admin/admins", { method: "POST", body: JSON.stringify({ email: platformAdminEmail, note: "Synthetic audit proof admin" }) });
  if (!granted.response.ok) throw new Error(`Synthetic platform admin grant failed: ${granted.response.status}`);
  const owner = den.admin;
  const platformAdmin = await createAdmin(den, { name: "Audit Platform Admin", email: platformAdminEmail });
  // createAdmin also replaces den.admin; the organization owner stays the primary session.
  den.admin = owner;
  // Seed only the auditLogs feature override, leaving every other feature alone.
  // Provider setup predates the grant; browser/API traffic initializes the real
  // default policy and records access events before the user's provider save.
  // Custom roles were removed; the audited access change is now a team's
  // permission set, which needs the Permissions feature and a team. Both are
  // arranged before audit capture starts, so the journey's own team creation
  // stays the only team operation in the history.
  const reviewersTeamName = "Audit reviewers";
  const reviewers = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name: reviewersTeamName, memberIds: [] }) });
  if (reviewers.response.status !== 201) throw new Error(`Synthetic team setup failed: ${reviewers.response.status}`);
  const reviewersTeamId = identifier(record(record(reviewers.body).team).id);
  await seedAuditDatabase(den, "INSERT INTO organization_feature (organization_id, feature_key, enabled, source) VALUES (?, 'permissions', TRUE, 'platform') ON DUPLICATE KEY UPDATE enabled = TRUE", [orgId]);
  await seedAuditDatabase(den, "INSERT INTO organization_feature (organization_id, feature_key, enabled, source) VALUES (?, 'auditLogs', TRUE, 'platform') ON DUPLICATE KEY UPDATE enabled = TRUE", [orgId]);
  const viewport = { width: 1440, height: 1100 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/audit-logs", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard/audit-logs", headless: true, viewport });
  const unflaggedWeb = await seed.web({ den, signedInAs: unflaggedOwner, startPath: "/dashboard", headless: true, viewport });
  // Audit writes never update usage totals; the scheduled refresh does
  // (POST /internal/audit/usage/refresh, the den-audit-usage cron). Run it on demand.
  async function refreshAuditUsage() {
    const response = await fetch(`${den.ref.apiUrl.replace(/\/+$/, "")}/internal/audit/usage/refresh`, {
      method: "POST", headers: { authorization: `Bearer ${MAINTENANCE_TOKEN}` }, signal: AbortSignal.timeout(60_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Audit usage refresh failed: ${response.status}`);
  }
  // Read-only rendered-label witness: probe.dom exposes option text/geometry but
  // not line-clamp or text overflow. A DOM string alone also passes when every
  // distinguishing suffix is ellipsized. Read real glyph ranges and computed CSS;
  // never import product source, change styles or dispatch input from the world.
  function eventOptionLayout() {
    return evaluateOnSurface(web, () => Array.from(document.querySelectorAll('[role="listbox"] [role="option"]'), (option) => {
      const label = option.querySelector("span:first-child");
      if (!label) throw new Error("Event type option has no label");
      const style = getComputedStyle(label);
      const box = label.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      const fragments = Array.from(range.getClientRects());
      const fullTextFits = fragments.length > 0
        && label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1
        && fragments.every((fragment) => fragment.left >= box.left - 1 && fragment.right <= box.right + 1
          && fragment.top >= box.top - 1 && fragment.bottom <= box.bottom + 1);
      return {
        text: label.textContent?.trim() ?? "",
        fullTextFits,
        lineClamp: style.webkitLineClamp,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        width: box.width,
        height: box.height,
        lines: new Set(fragments.map((fragment) => Math.round(fragment.top))).size,
      };
    }));
  }
  // Read-only color witness: a request with no final result must use the same
  // neutral ink as a successful event, not the failure color. DOM text alone
  // cannot prove this presentation boundary.
  function outcomeColors() {
    return evaluateOnSurface(web, () => Array.from(document.querySelectorAll("[data-audit-outcome]"))
      .filter((element) => element.checkVisibility())
      .map((element) => ({ outcome: element.getAttribute("data-audit-outcome"), color: getComputedStyle(element).color })));
  }
  return { den, refreshAuditUsage, eventOptionLayout, outcomeColors, web, memberWeb, unflaggedWeb, unflaggedOwner, unflaggedOrgId, teammate, teammateUserId, platformAdmin, orgId, providerId, originalCredential, replacementCredential, reviewersTeamId, reviewersTeamName, viewport };
}
