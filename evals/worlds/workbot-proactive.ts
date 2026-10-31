import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** A fixed, valid TypeID for the seeded connection. */
export const SLACK_CONNECTION_ID = "emc_01k8z5wq0s0000000000000000";
/** This world's Den encrypts columns with its own key, so the fixture can write the Slack app's synthetic secrets. */
export const ENCRYPTION_KEY = "workbot-agent-world-encryption-key-synthetic-0001";

/** Den's column encryption (ee/packages/den-db/src/columns.ts), for synthetic fixture values only. */
export function encryptForDen(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", new Uint8Array(createHash("sha256").update(ENCRYPTION_KEY).digest()), new Uint8Array(iv));
  const encrypted = cipher.update(value, "utf8", "base64") + cipher.final("base64");
  return `enc:v1:${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Den with Workbot deployed here (DEN_WORKBOT_URL), a configured headless runner (the readiness fixture: it answers
 * health checks and nothing else), `workbotProactive` on for one organization, and the Workbot Slack app on a Slack
 * connection in Connectors, with synthetic credentials and nobody linked. No calendar, model or Slack is reached:
 * `installSlackApp` turns the app on, so the admin page shows the lock first and then the ready state. Nothing is sent.
 */
export async function workbotProactiveWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Agent settings",
        admin: { name: "Workspace Owner" },
        members: { member: { name: "Workspace Member" } },
      },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_DB_ENCRYPTION_KEY: ENCRYPTION_KEY,
      },
    });
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { workbotProactive: true });
    const context = await seed.api(den.admin, "/v1/org");
    const currentMember = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
    const ownerMemberId = typeof currentMember?.id === "string" ? currentMember.id : "";
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_") || !ownerMemberId) throw new Error("The Slack connection fixture needs a disposable testkit database and the owner's membership.");
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO external_mcp_connection (id, organization_id, name, url, auth_type, credential_mode, created_by_org_membership_id) VALUES (?, ?, 'Slack', 'https://mcp.slack.com/mcp', 'oauth', 'per_member', ?)",
      [SLACK_CONNECTION_ID, organizationId, ownerMemberId],
    );
    /** The Workbot Slack app, installed and on (synthetic workspace, token and signing secret). */
    const installSlackApp = () => queryDenDatabase(
      databaseUrl,
      "INSERT INTO slack_assistant_installation (connection_id, organization_id, enabled, signing_secret, team_id, app_id, bot_user_id, bot_token) VALUES (?, ?, 1, ?, 'T0FIXTURE', 'A0FIXTURE', 'U0WORKBOT', ?)",
      [SLACK_CONNECTION_ID, organizationId, encryptForDen("synthetic-signing-secret"), encryptForDen("xoxb-synthetic-not-a-token")],
    );
    const viewport = { width: 1280, height: 1400, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport });
    return { den, owner, member, installSlackApp, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
