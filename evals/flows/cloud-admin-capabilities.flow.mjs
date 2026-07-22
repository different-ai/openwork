import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "cloud-admin-capabilities";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_FILE = "ee/apps/den-api/test/mcp-admin-capabilities.test.ts";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function runFocusedTest(name) {
  return spawnSync("pnpm", ["exec", "bun", "test", TEST_FILE, "--test-name-pattern", name], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
}

export default {
  id: FLOW_ID,
  title: "Platform admins use Den admin tools through the existing OpenWork Cloud connection",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Admin tools are discoverable through Cloud capability search",
      run: async (ctx) => {
        await ctx.prove("An allowlisted admin search returns admin:den_overview", {
          voiceover: vo[0],
          assert: async () => {
            const test = runFocusedTest("admin capability search returns namespaced MCP tools");
            witness(ctx, test.status === 0, "The real admin capability search test passes", test.stderr.trim());
            witness(ctx, test.stderr.includes("admin capability search returns namespaced MCP tools"), "The passing test exercised namespaced admin discovery");
            ctx.output("$ pnpm exec bun test (admin discovery)", `${test.stdout}${test.stderr}`.trim());
          },
        });
      },
    },
    {
      name: "The Cloud rail executes the existing admin toolset",
      run: async (ctx) => {
        await ctx.prove("The namespaced admin version capability executes and identifies den-admin", {
          voiceover: vo[1],
          assert: async () => {
            const test = runFocusedTest("admin capability execution reuses the existing admin toolset");
            witness(ctx, test.status === 0, "The real admin capability execution test passes", test.stderr.trim());
            witness(ctx, test.stderr.includes("admin capability execution reuses the existing admin toolset"), "The passing test executed the existing den-admin toolset");
            ctx.output("$ pnpm exec bun test (admin execution)", `${test.stdout}${test.stderr}`.trim());
          },
        });
      },
    },
    {
      name: "Ordinary members cannot discover or execute admin tools",
      run: async (ctx) => {
        await ctx.prove("The same Cloud rail hides admin tools and rejects direct calls for non-admins", {
          voiceover: vo[2],
          assert: async () => {
            const test = runFocusedTest("ordinary members cannot discover or directly execute admin capabilities");
            witness(ctx, test.status === 0, "The ordinary-member security test passes", test.stderr.trim());
            witness(ctx, test.stderr.includes("ordinary members cannot discover or directly execute admin capabilities"), "The passing test covered both nondiscovery and direct execution rejection");
            ctx.output("$ pnpm exec bun test (ordinary-member boundary)", `${test.stdout}${test.stderr}`.trim());
          },
        });
      },
    },
    {
      name: "The desktop keeps Cloud and removes the separate admin connector",
      run: async (ctx) => {
        await ctx.prove("The desktop catalog contains openwork-cloud but no openwork-admin entry", {
          voiceover: vo[3],
          assert: async () => {
            const constants = await readFile(join(ROOT, "apps/app/src/app/constants.ts"), "utf8");
            const store = await readFile(join(ROOT, "apps/app/src/react-app/domains/connections/store.ts"), "utf8");
            witness(ctx, constants.includes('serverName: "openwork-cloud"'), "OpenWork Cloud remains in the desktop catalog");
            witness(ctx, !constants.includes('serverName: "openwork-admin"'), "The separate OpenWork Admin catalog entry is absent");
            witness(ctx, !store.includes('entry.serverName === "openwork-admin"'), "Desktop token injection no longer special-cases a local admin connection");
            ctx.output("Desktop connection catalog", "openwork-cloud: present\nopenwork-admin: absent\nadmin token special-case: absent");
          },
        });
      },
    },
  ],
};
