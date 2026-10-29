import { isolatedRedis } from "./isolated-redis.ts";
import { personDefaults, queryDenDatabase, type Seed } from "@openwork/env";
import { denFetch } from "../packages/behaviors/src/den.ts";
import { bootWorkbot } from "../../worlds/lib/workbot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Real Workbot, Den OAuth and verification. The Acme owner invites a teammate who has never signed up. */
export async function workbotInvitedTeammate(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const redis = resources.use(await isolatedRedis());
    const world = await bootWorkbot(resources, undefined, {
      live: false,
      denEnv: { DATABASE_REDIS_URL: redis.url, DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "true" },
    });
    const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    // Acme only admits its own domain.
    const person = personDefaults("invited-teammate", { email: `invited-teammate+${runId}@acme.test`, name: "Invited Teammate" }, runId);
    const headers = { authorization: `Bearer ${world.den.admin.token}` };
    const invited = await denFetch(world.den.admin, "/v1/invitations", { method: "POST", headers, body: JSON.stringify({ email: person.email, role: "member" }) });
    if (!invited.response.ok) throw new Error(`Invite the teammate: HTTP ${invited.response.status} ${invited.text.slice(0, 300)}`);
    const org = await denFetch(world.den.admin, "/v1/org", { headers });
    const organization = isRecord(org.body) && isRecord(org.body.organization) ? org.body.organization : {};
    const workspaceName = typeof organization.name === "string" ? organization.name : "";
    const web = await seed.web({ den: world.den, headless: true, viewport: { width: 1440, height: 1000 } });
    const database = world.den.database;
    if (!database) throw new Error("Email verification needs the disposable local database");
    return {
      web, person, workspaceName, url: world.workbotUrl,
      async otp() {
        const rows = await queryDenDatabase(database.url, "SELECT value FROM verification WHERE identifier = ? ORDER BY created_at DESC LIMIT 1", [`email-verification-otp-${person.email}`]);
        return isRecord(rows[0]) && typeof rows[0].value === "string" ? rows[0].value.split(":")[0] : "";
      },
      async workspaces() {
        const rows = await queryDenDatabase(database.url, "SELECT o.name AS name FROM member m JOIN user u ON u.id = m.user_id JOIN organization o ON o.id = m.organization_id WHERE u.email = ? AND m.removed_at IS NULL", [person.email]);
        return rows.map((row) => (isRecord(row) ? String(row.name) : ""));
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
