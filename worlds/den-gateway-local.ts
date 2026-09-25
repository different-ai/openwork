export const supportedTargets = ["local/host"];

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { server } from "../evals/packages/env/src/den.ts";
import { DEFAULT_MYSQL_URL, resolvePlace } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { seedGatewayUsage } from "./lib/den-gateway-local.ts";

export function lifetimeMinutes(argv: readonly string[]): number {
  if (argv.length === 0) return 120;
  if (argv.length === 2 && argv[0] === "--lifetime" && /^\d+$/.test(argv[1] ?? "")) {
    const minutes = Number(argv[1]);
    if (minutes >= 1 && minutes <= 1440) return minutes;
  }
  throw new Error("Use --lifetime <1-1440 minutes>; default 120.");
}

export function localEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (resolvePlace(source).kind !== "local") throw new Error("den-gateway-local requires --place local.");
  if (Object.keys(source).some((key) => /^(OPENWORK_EVAL_DEN_(API_URL|WEB_URL|RUNTIME_PREPARED)|OPENWORK_EVAL_DAYTONA.*)$/.test(key) && source[key]?.trim())) {
    throw new Error("Remove Den reuse, prepared-runtime and Daytona overrides; this world owns a fresh local Den.");
  }
  const mysql = source.OPENWORK_EVAL_MYSQL_URL?.trim() || DEFAULT_MYSQL_URL;
  const redis = source.DATABASE_REDIS_URL?.trim() || "redis://127.0.0.1:6379";
  for (const [value, protocol] of [[mysql, "mysql:"], [redis, "redis:"]]) {
    const url = new URL(value);
    if (url.protocol !== protocol || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search || url.hash) {
      throw new Error("MySQL and Redis must use loopback URLs without query parameters or fragments; never supply production credentials.");
    }
  }
  const retained = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "PNPM_HOME"]);
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => retained.has(key) || key.startsWith("OPENWORK_WORLD_"))),
    OPENWORK_WORLD_PLACE: "local",
    OPENWORK_EVAL_MYSQL_URL: mysql,
    DATABASE_REDIS_URL: redis,
    OPENWORK_DEN_DB_ENV_PATH: "/dev/null",
    NODE_ENV: "development",
    TZ: "UTC",
    OPENWORK_DEV_MODE: "1",
    DEN_DEMO_SEED_FETCH_GITHUB: "0",
    RESEND_API_KEY: "",
    SMTP_HOST: "",
    LOOPS_API_KEY: "",
    LOOPS_MARKETING_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    DEN_AUTOMATIONS_ENABLED: "false",
    DEN_AUTOMATIONS_RUNTIME_ENABLED: "false",
    GATEWAY_ENABLED: "true",
    GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1",
    GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1",
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const minutes = lifetimeMinutes(argv);
  const environment = localEnvironment(process.env);
  for (const directory of ["ee/apps/den-api", "ee/apps/den-web", "ee/packages/den-db"]) {
    for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
      if (existsSync(new URL(`../${directory}/${name}`, import.meta.url))) {
        throw new Error(`Refusing to load ${directory}/${name}; use a checkout without service dotenv files to keep this synthetic world credential-free.`);
      }
    }
  }
  const original = process.env;
  process.env = environment;
  try {
    await using stack = new AsyncDisposableStack();
    const den = stack.use(await server({ place: resolvePlace(), web: true, seedProfile: "demo-org", env: environment }));
    const fixture = await seedGatewayUsage(den);
    const expires = new Date(Date.now() + minutes * 60_000);
    const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), minutes * 60_000);
    try {
      await hold({
        name: "den-gateway-local",
        outputs: {
          preview: output(`${den.ref.webUrl}/dashboard/ai-gateway`, { group: "URLs" }),
          denWeb: output(den.ref.webUrl, { group: "URLs" }),
          denApi: output(den.ref.apiUrl, { group: "URLs" }),
          email: output(den.admin.email, { group: "Synthetic account", note: "Demo owner; other seeded people are display fixtures" }),
          password: secret(den.admin.password, { group: "Synthetic account" }),
          database: output(fixture.database, { group: "World" }),
          source: output(fileURLToPath(new URL("..", import.meta.url)), { group: "World" }),
          expires: output(expires.toISOString(), { group: "World", note: "Lifetime from readiness, not idle time" }),
          usage: output(`${fixture.requests} requests across 31 UTC days, ${fixture.people} people, ${fixture.teams} teams, 4 models`, { group: "Synthetic data" }),
          verification: output("Usage, limit policies and reset-request APIs responded successfully", { group: "Synthetic data" }),
          inference: output("Synthetic chart data only; no provider credentials or running gateway. Live inference is unavailable.", { group: "Synthetic data" }),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    process.env = original;
  }
}

if (import.meta.main) await main();
