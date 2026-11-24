import { isolatedRedis } from "./isolated-redis.ts";
import { personDefaults, queryDenDatabase, type Seed } from "@openwork/env";
import { bootWorkbot } from "../../worlds/lib/workbot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Real Workbot, Den OAuth, verification and runner. All services and provider fixtures are disposable and local. */
export async function workbotFirstRun(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const redis = resources.use(await isolatedRedis());
    const world = await bootWorkbot(resources, undefined, {
      live: false,
      // Deployment cache keys cannot be shared across other local worlds' disposable MySQL databases.
      denEnv: { DATABASE_REDIS_URL: redis.url, DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "true" },
    });
    const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const person = personDefaults("first-workbot", undefined, runId);
    const web = await seed.web({ den: world.den, headless: true, viewport: { width: 1440, height: 1000 } });
    const database = world.den.database;
    if (!database) throw new Error("Email verification needs the disposable local database");
    return {
      web, person, url: world.workbotUrl, workspaceName: `Example studio ${runId}`,
      async otp() {
        const rows = await queryDenDatabase(database.url, "SELECT value FROM verification WHERE identifier = ? ORDER BY created_at DESC LIMIT 1", [`email-verification-otp-${person.email}`]);
        return isRecord(rows[0]) && typeof rows[0].value === "string" ? rows[0].value.split(":")[0] : "";
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
