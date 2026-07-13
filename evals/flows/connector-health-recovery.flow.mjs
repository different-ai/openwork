import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "connector-health-recovery";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEN_API = join(ROOT, "ee", "apps", "den-api");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
let testRun;

function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function runEndToEndSuite() {
  testRun ??= spawnSync("bun", [
    "--conditions=development",
    "test",
    "test/external-capabilities-search-divergence.test.ts",
  ], {
    cwd: DEN_API,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_den",
      DEN_DB_ENCRYPTION_KEY: process.env.DEN_DB_ENCRYPTION_KEY ?? "daytona-den-db-encryption-key-please-change-1234567890",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "daytona-den-auth-secret-please-change-1234567890",
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3005",
      CORS_ORIGINS: process.env.CORS_ORIGINS ?? "http://127.0.0.1:3005",
      DEN_ALLOW_PRIVATE_MCP_URLS: "1",
      OPENWORK_EVAL_VERBOSE: "1",
    },
    timeout: 120_000,
  });
  return testRun;
}

function combinedOutput(run) {
  return `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
}

function reportValue(output, prefix) {
  const line = output.split("\n").find((entry) => entry.startsWith(`${prefix} `));
  return line ? JSON.parse(line.slice(prefix.length + 1)) : null;
}

export default {
  id: FLOW_ID,
  title: "OpenWork Cloud identifies and recovers any unhealthy downstream connector",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Capability discovery probes a connected service live",
      run: async (ctx) => {
        await ctx.prove("A real MCP tools/list probe discovers the healthy connector through the Den database", {
          voiceover: vo[0],
          action: async () => {
            runEndToEndSuite();
          },
          assert: async () => {
            const run = runEndToEndSuite();
            const output = combinedOutput(run);
            const healthy = reportValue(output, "E2E_HEALTHY_DISCOVERY");
            witness(ctx, run.status === 0, "The DB-backed live-MCP integration suite exits successfully", String(run.status));
            witness(ctx, healthy?.connectionName === "Slack", "The live probe identifies the requested connector", JSON.stringify(healthy));
            witness(ctx, healthy?.toolCount === 5 && healthy?.status === "available", "The healthy connector returns its five callable tools", JSON.stringify(healthy));
            ctx.output("Daytona — healthy connector discovery", output.split("\n").filter((line) => line.includes("E2E_HEALTHY_DISCOVERY") || line.includes("control-healthy")).join("\n"));
          },
        });
      },
    },
    {
      name: "Invalid refresh tokens name the downstream connector and recovery owner",
      run: async (ctx) => {
        await ctx.prove("A JSON-RPC refresh failure becomes a connector-specific reauthorization action, not an OpenWork Cloud failure", {
          voiceover: vo[1],
          assert: async () => {
            const output = combinedOutput(runEndToEndSuite());
            const status = reportValue(output, "E2E_CONNECTION_STATUS");
            witness(ctx, status?.layer === "downstream_provider", "The failed OAuth layer is explicitly downstream_provider", JSON.stringify(status));
            witness(ctx, status?.connectionName === "Knowledge Hub", "The response names the failing connector", JSON.stringify(status));
            witness(ctx, status?.errorCode === "invalid_refresh_token" && status?.state === "reauth_required", "The refresh-token failure is classified as reauthorization", JSON.stringify(status));
            witness(ctx, status?.actor === "organization_admin", "The response identifies the organization admin as the recovery owner", JSON.stringify(status));
            witness(ctx, status?.action?.type === "reconnect" && status?.action?.surface === "openwork_organization_connections", "The response points to the exact reconnect surface", JSON.stringify(status?.action));
            ctx.output("Daytona — structured connector failure", `E2E_CONNECTION_STATUS ${JSON.stringify(status, null, 2)}`);
          },
        });
      },
    },
    {
      name: "The same discovery path recovers after the connector is fixed",
      run: async (ctx) => {
        await ctx.prove("Updating the connector credential makes live tools discoverable on the next search without reconnecting OpenWork Cloud", {
          voiceover: vo[2],
          assert: async () => {
            const output = combinedOutput(runEndToEndSuite());
            const recovered = reportValue(output, "E2E_RECOVERED_DISCOVERY");
            witness(ctx, recovered?.connectionName === "Team Chat", "The repaired connector is retried by name", JSON.stringify(recovered));
            witness(ctx, recovered?.toolCount === 5 && recovered?.status === "available", "The retry returns real connector tools instead of another status row", JSON.stringify(recovered));
            witness(ctx, output.includes("repairing a connector credential makes its live tools discoverable on retry"), "The recovery path passes in the real DB-backed integration suite");
            ctx.output("Daytona — recovered connector discovery", output.split("\n").filter((line) => line.includes("E2E_RECOVERED_DISCOVERY") || line.includes("repairing a connector credential")).join("\n"));
          },
        });
      },
    },
  ],
};
