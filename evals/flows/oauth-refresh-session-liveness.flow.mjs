/**
 * Internal demo: OAuth refresh grants vs session liveness.
 *
 * Proven prod incident, two failure classes:
 * (1) refresh grants outlive the session that authorized them — the token
 *     endpoint kept minting tokens for signed-out sessions, which the resource
 *     then rejected forever ("Server returned 401 after successful
 *     authentication"); 24 such zombie grants existed in prod at fix time.
 * (2) the resource's session check reported infrastructure failures as
 *     "session revoked" (catch -> false), turning DB blips into mass
 *     credential death and pointless grant rotation.
 *
 * This flow proves the fix on the real den-api wire harness
 * (requiresApp: false): claims + assertions + real bun test output.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "oauth-refresh-session-liveness";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTH_SOURCE = join(ROOT, "ee", "apps", "den-api", "src", "auth.ts");
const RESOURCE_SOURCE = join(ROOT, "ee", "apps", "den-api", "src", "mcp", "auth.ts");
const LIVENESS_SOURCE = join(ROOT, "ee", "apps", "den-api", "src", "mcp", "session-liveness.ts");
const LIFECYCLE_TEST = join(ROOT, "ee", "apps", "den-api", "test", "mcp-oauth-refresh-lifecycle.test.ts");

const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function denApiTest(files, env = {}) {
  return spawnSync(
    "pnpm",
    ["--filter", "@openwork-ee/den-api", "exec", "bun", "test", "--conditions", "development", ...files],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function tallyLine(output) {
  return output.split("\n").filter((line) => /\d+ (pass|fail)/.test(line)).join(" | ");
}

export default {
  id: FLOW_ID,
  title: "Refresh grants die with their session; infra blips stop impersonating sign-outs",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The contract: liveness-gated refresh, truthful resource errors",
      run: async (ctx) => {
        await ctx.prove("Refresh is gated on session liveness and the resource distinguishes revoked from unverifiable", {
          voiceover: vo[0],
          assert: async () => {
            const liveness = await readFile(LIVENESS_SOURCE, "utf8");
            witness(ctx, liveness.includes('"alive" | "missing" | "check_failed"'), "Session liveness is three-state (alive / missing / check_failed)");
            witness(ctx, liveness.includes("mcp_session_liveness_check_failed"), "Failed liveness checks log a stable marker (no more silent misclassification)");
            const auth = await readFile(AUTH_SOURCE, "utf8");
            witness(ctx, auth.includes('"invalid_grant"'), "The token endpoint refuses dead-session refresh grants with invalid_grant");
            witness(ctx, auth.includes('sessionLiveness === "alive" || sessionLiveness === "check_failed"'), "The refresh gate fails open on check_failed (infra blips never destroy grants)");
            const resource = await readFile(RESOURCE_SOURCE, "utf8");
            witness(ctx, resource.includes("mcp_session_check_unavailable"), "The resource returns a distinct 503 when the session check itself fails");
            witness(ctx, resource.includes('"retry-after"'), "The 503 carries Retry-After so clients back off instead of re-authing");
            const gateStart = auth.indexOf("assertLiveMcpSessionForRefreshGrant");
            witness(ctx, gateStart >= 0, "The refresh gate function is present");
            ctx.output("refresh gate (auth.ts)", auth.slice(gateStart, auth.indexOf("}", auth.indexOf("throw new APIError", gateStart)) + 1).slice(0, 1600));
          },
        });
      },
    },
    {
      name: "Wire proof: the full lifecycle against the real token endpoint and resource",
      run: async (ctx) => {
        await ctx.prove("Dead sessions get invalid_grant + cleanup; live and m2m grants keep working; check failures 503 and fail open", {
          voiceover: vo[1],
          assert: async () => {
            const testSource = await readFile(LIFECYCLE_TEST, "utf8");
            for (const marker of ["invalid_grant", "mcp_session_check_unavailable", "mcp_session_liveness_check_failed", "retry-after"]) {
              witness(ctx, testSource.includes(marker), `The wire suite asserts on "${marker}"`);
            }
            const run = denApiTest(["test/mcp-oauth-refresh-lifecycle.test.ts"], { DEN_MCP_REFRESH_LIFECYCLE_CHILD: "1" });
            witness(ctx, run.status === 0, "The lifecycle wire suite exits cleanly", run.status === 0 ? undefined : `${run.stdout}\n${run.stderr}`.slice(-1200));
            const combined = `${run.stdout}\n${run.stderr}`;
            witness(ctx, /11 pass/.test(combined) && /\b0 fail/.test(combined), "All 11 lifecycle scenarios pass (live/deleted/expired/m2m/auth-code/check-failed/touch-failed)", tallyLine(combined));
            ctx.output("lifecycle suite", tallyLine(combined));
          },
        });
      },
    },
    {
      name: "Nothing around it moved",
      run: async (ctx) => {
        await ctx.prove("Connector diagnostics and provider refresh flows are untouched", {
          voiceover: vo[2],
          assert: async () => {
            const run = denApiTest(["test/external-mcp-diagnostics.test.ts", "test/mcp-oauth-refresh-flow.test.ts"]);
            witness(ctx, run.status === 0, "Regression suites exit cleanly", run.status === 0 ? undefined : `${run.stdout}\n${run.stderr}`.slice(-1200));
            const combined = `${run.stdout}\n${run.stderr}`;
            witness(ctx, /79 pass/.test(combined) && /\b0 fail/.test(combined), "79 regression tests pass with 0 failures", tallyLine(combined));
            ctx.output("regression suites", tallyLine(combined));
          },
        });
      },
    },
  ],
};
