import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "managed-models-empty-recovery";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function witness(ctx: FlowContext, condition: boolean, assertion: string, actual?: string) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, actual ? `${assertion} (actual: ${actual})` : assertion);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

async function readRepoFile(path: string) {
  return readFile(join(ROOT, path), "utf8");
}

export default defineFlow({
  id: FLOW_ID,
  title: "Managed organization models import before restriction checks and recover from empty state",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Dashboard grant is the contract",
      run: async (ctx) => {
        await ctx.prove("The approved script covers the Den dashboard grant and exact GLM-5.2 member outcome", {
          voiceover: vo[0],
          assert: async () => {
            const script = await readRepoFile("evals/voiceovers/managed-models-empty-recovery.md");
            witness(ctx, script.includes("OpenRouter"), "The script names the granted organization provider");
            witness(ctx, script.includes("GLM-5.2"), "The script names the single granted model");
            witness(ctx, script.includes("sees exactly GLM-5.2"), "The script states the exact Den dashboard outcome");
            ctx.output("Approved voiceover", script);
          },
        });
      },
    },
    {
      name: "Import settles before policy reconcile",
      run: async (ctx) => {
        await ctx.prove("The desktop waits for signed-in cloud provider sync before policy reconcile or unavailable-model auto-open", {
          voiceover: vo[1],
          assert: async () => {
            const hook = await readRepoFile("apps/app/src/react-app/domains/connections/provider-auth/use-session-provider-auth.ts");
            const store = await readRepoFile("apps/app/src/react-app/domains/connections/provider-auth/store.ts");
            const sessionRoute = await readRepoFile("apps/app/src/react-app/shell/session-route.tsx");
            witness(ctx, hook.includes("shouldWaitForCloudProviderSyncBeforePolicyReconcile"), "Policy reconcile is gated by cloud sync readiness");
            witness(ctx, hook.includes("cloudProviderSyncReady"), "The hook exposes readiness from the completed sync context");
            witness(ctx, store.includes("cloudProviderSyncTail"), "Cloud provider sync calls are serialized so queued sign-in/manual work is awaited in order");
            witness(ctx, store.indexOf("const syncedProviderList") < store.indexOf("preselectEntitledOrgDefaultModel(syncedProviderList)"), "Default model preselect runs after import and provider refresh");
            witness(ctx, sessionRoute.includes("shouldAutoOpenUnavailableModelPicker"), "Unavailable model auto-open goes through the managed-model gate");
          },
        });
      },
    },
    {
      name: "Empty restricted state is honest",
      run: async (ctx) => {
        await ctx.prove("A settled restricted empty state shows the organization-published-models message and hides Connect a provider", {
          voiceover: vo[2],
          assert: async () => {
            const modal = await readRepoFile("apps/app/src/react-app/domains/session/modals/model-picker-modal.tsx");
            const route = await readRepoFile("apps/app/src/react-app/shell/session-route.tsx");
            const composer = await readRepoFile("apps/app/src/react-app/domains/session/surface/composer/composer.tsx");
            witness(ctx, modal.includes("models.organization_models_empty"), "Model picker uses the honest organization empty-state string");
            witness(ctx, modal.includes("showConnectProvider: !input.restrictToCloud"), "Model picker hides Connect a provider under managed-model restriction");
            witness(ctx, route.includes("!organizationModelsEmpty") && route.includes("showPreparingStatus"), "Session status stops showing preparing for settled managed empty state");
            witness(ctx, composer.includes("modelUnavailableMessage"), "Composer renders the same managed empty-state message");
          },
        });
      },
    },
    {
      name: "Refresh runs recovery",
      run: async (ctx) => {
        let testStatus = 1;
        await ctx.prove("Refresh organization models invokes manual cloud sync, rereads providers, and is covered by targeted tests", {
          voiceover: vo[3],
          action: async () => {
            const result = spawnSync("pnpm", [
              "--filter",
              "@openwork/app",
              "exec",
              "bun",
              "test",
              "src/react-app/domains/connections/provider-auth/managed-models-recovery.test.ts",
              "src/react-app/domains/session/modals/model-picker-modal.test.ts",
            ], {
              cwd: ROOT,
              encoding: "utf8",
              timeout: 120_000,
            });
            ctx.output("Targeted recovery tests", `${result.stdout}\n${result.stderr}`.trim());
            testStatus = result.status ?? 1;
          },
          assert: async () => {
            witness(ctx, testStatus === 0, "Targeted managed-model recovery tests pass", String(testStatus));
          },
        });
      },
    },
  ],
});
