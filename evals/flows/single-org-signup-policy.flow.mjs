import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "single-org-signup-policy";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEN_API = join(ROOT, "ee", "apps", "den-api");

// Narration is loaded from the approved script (evals/voiceovers/single-org-signup-policy.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

function runDenApiTest(file, pattern) {
  return spawnSync("bun", ["--conditions=development", "test", file, "--test-name-pattern", pattern], {
    cwd: DEN_API,
    encoding: "utf8",
    timeout: 60_000,
    env: process.env,
  });
}

function runDenWebTest(pattern) {
  return spawnSync("pnpm", ["--filter", "@openwork-ee/den-web", "exec", "bun", "test", "tests/single-org-signup-ui.test.ts", "--test-name-pattern", pattern], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: process.env,
  });
}

export default {
  id: FLOW_ID,
  title: "Single-org deployments block private email signup and enforce singleton email domains before account creation",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Private single-org UI is sign-in only",
      run: async (ctx) => {
        let result;
        await ctx.prove("With single-org public signup disabled, the Den Web auth policy resolves sign-up requests to sign-in", {
          voiceover: vo[0],
          action: async () => {
            result = runDenWebTest("private single-org UI resolves sign-up requests to sign-in");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The focused Den Web private-signup UI policy test passes", output);
            witness(ctx, output.includes("1 pass"), "Exactly one focused UI test covered the hidden signup behavior", output);
            ctx.output("$ pnpm --filter @openwork-ee/den-web exec bun test tests/single-org-signup-ui.test.ts --test-name-pattern private", output);
          },
        });
      },
    },
    {
      name: "Private email signup is rejected before Better Auth",
      run: async (ctx) => {
        let result;
        await ctx.prove("An anonymous email signup request receives the private-signup 403 before Better Auth validation or persistence", {
          voiceover: vo[1],
          action: async () => {
            result = runDenApiTest("test/single-org-route-guards.test.ts", "raw Better Auth email signup is blocked");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The focused route guard test passes", output);
            witness(ctx, output.includes("1 pass"), "Exactly one focused route test hit POST /api/auth/sign-up/email and received the signup-policy 403", output);
            ctx.output("$ bun --conditions=development test test/single-org-route-guards.test.ts --test-name-pattern raw Better Auth email signup is blocked", output);
          },
        });
      },
    },
    {
      name: "Matching singleton domains are allowed",
      run: async (ctx) => {
        let result;
        await ctx.prove("With public signup enabled and acme.com configured, an acme.com signup passes the pre-creation policy", {
          voiceover: vo[2],
          action: async () => {
            result = runDenApiTest("test/single-org-mode.test.ts", "allows matching domains");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The matching-domain policy test passes", output);
            witness(ctx, output.includes("1 pass"), "Exactly one focused policy test returned no violation for User@Acme.com", output);
            ctx.output("$ bun --conditions=development test test/single-org-mode.test.ts --test-name-pattern allows matching domains", output);
          },
        });
      },
    },
    {
      name: "Out-of-domain singleton signup is rejected",
      run: async (ctx) => {
        let result;
        await ctx.prove("With public signup enabled and acme.com configured, an outside.com signup is rejected by the pre-creation policy", {
          voiceover: vo[3],
          action: async () => {
            result = runDenApiTest("test/single-org-mode.test.ts", "rejects outside domains");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The out-of-domain policy test passes", output);
            witness(ctx, output.includes("1 pass"), "Exactly one focused policy test asserted the email_domain_restricted violation for outside.com", output);
            ctx.output("$ bun --conditions=development test test/single-org-mode.test.ts --test-name-pattern rejects outside domains", output);
          },
        });
      },
    },
    {
      name: "Multi-org auth discovery is unchanged",
      run: async (ctx) => {
        let result;
        await ctx.prove("Multi-organization login discovery still returns account creation for unknown users", {
          voiceover: vo[4],
          action: async () => {
            result = runDenApiTest("test/auth-login-options.test.ts", "returns new account");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The multi-org/default login option test passes", output);
            witness(ctx, output.includes("1 pass"), "Exactly one focused login-discovery test kept unknown users resolving to new_account when account creation is allowed", output);
            ctx.output("$ bun --conditions=development test test/auth-login-options.test.ts --test-name-pattern returns new account", output);
          },
        });
      },
    },
  ],
};
