import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-cloud-sync-identity";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(ROOT, "apps", "app");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
let testRun;

function runTests() {
  testRun ??= spawnSync("bun", ["test", "scripts/desktop-cloud-sync.test.ts"], {
    cwd: APP,
    encoding: "utf8",
    timeout: 60_000,
  });
  return testRun;
}

function output() {
  const run = runTests();
  return `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
}

export default {
  id: FLOW_ID,
  title: "Den cloud sync keeps organization identity stable",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "A stale organization snapshot is discarded",
      run: async (ctx) => {
        await ctx.prove("A delayed organization A snapshot cannot reach workspace sync after switching to organization B", {
          claim: "The identity-bound sync discards the loaded snapshot before apply when the active Den organization changes.",
          voiceover: vo[0],
          action: async () => runTests(),
          assert: async () => {
            const run = runTests();
            const result = output();
            ctx.assert(run.status === 0, `Desktop cloud sync tests failed:\n${result}`);
            ctx.assert(result.includes("does not apply a snapshot after the active organization changes"), "The stale-response regression did not run.");
            ctx.output("desktop-cloud-sync-tests.txt", result);
          },
        });
      },
    },
    {
      name: "An organization switch invalidates the in-flight response",
      run: async (ctx) => {
        await ctx.prove("Switching organizations invalidates the earlier response before apply", {
          claim: "The regression test changes the current identity while the first snapshot promise is unresolved and observes no apply call.",
          voiceover: vo[1],
          assert: async () => {
            ctx.assert(output().includes("does not apply a snapshot after the active organization changes"), "The organization-switch assertion is missing.");
          },
        });
      },
    },
    {
      name: "The current identity still applies its snapshot",
      run: async (ctx) => {
        await ctx.prove("The matching organization snapshot continues to sync normally", {
          claim: "The same guard allows apply when Den base URL, credential identity, and organization remain unchanged.",
          voiceover: vo[2],
          assert: async () => {
            const result = output();
            ctx.assert(result.includes("applies a snapshot while the exact Den identity remains current"), "The current-identity regression did not run.");
            ctx.assert(result.includes("11 pass") && result.includes("0 fail"), "The focused suite did not pass completely.");
          },
        });
      },
    },
    {
      name: "Authentication absence and identity changes fail closed",
      run: async (ctx) => {
        await ctx.prove("The identity guard fails closed without exposing credentials", {
          claim: "Base URL, credential, organization, and missing-auth changes are compared only in memory and reject a stale apply.",
          voiceover: vo[3],
          assert: async () => {
            ctx.assert(output().includes("treats base URL, token, organization, and missing auth as identity changes"), "The full identity comparison assertion is missing.");
          },
        });
      },
    },
  ],
};
