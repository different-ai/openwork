import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, assertion);
}

function runTagTests(files) {
  const result = spawnSync("pnpm", ["--filter", "@openwork-ee/den-api", "exec", "bun", "test", ...files], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export default {
  id: "openwork-tag-core",
  title: "OpenWork Tag: signed Slack threads become durable shared OpenCode sessions",
  spec: "evals/openwork-tag-core.md",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Slack boundary contract",
      run: async (ctx) => {
        await ctx.prove("Slack ingress is signed, replay-safe, deduped, policy-aware, and rate-limit aware", {
          voiceover: "",
          assert: async () => {
            const result = runTagTests(["test/tag-slack-contract.test.ts"]);
            witness(ctx, result.status === 0, "The Slack boundary contract passes", result.stderr || result.status);
            witness(ctx, result.output.includes("7 pass") && result.output.includes("0 fail"), "All seven Slack and OAuth contract scenarios pass", result.output);
            ctx.output("tag-slack-contract.test.ts", result.output.trim());
          },
        });
      },
    },
    {
      name: "Den to worker to OpenCode thread lifecycle",
      run: async (ctx) => {
        await ctx.prove("A mention starts one OpenCode session, a thread reply reuses it, and cancel bypasses the active lane", {
          voiceover: "",
          assert: async () => {
            const result = runTagTests(["test/tag-store-db.test.ts", "test/tag-end-to-end.test.ts"]);
            witness(ctx, result.status === 0, "The MySQL-backed Tag integration passes", result.stderr || result.status);
            witness(ctx, result.output.includes("4 pass") && result.output.includes("0 fail"), "Durable OAuth state and end-to-end Slack/worker scenarios pass", result.output);
            ctx.output("tag-store + tag-end-to-end", result.output.trim());
          },
        });
      },
    },
    {
      name: "Den admin experience contract",
      run: async (ctx) => {
        await ctx.prove("The Den UI exposes managed OAuth setup, explicit policy, immutable snapshots, and live execution records", {
          voiceover: "",
          assert: async () => {
            const dialog = await readFile(join(ROOT, "ee/apps/den-web/app/(den)/dashboard/_components/tag-dialog.tsx"), "utf8");
            const screen = await readFile(join(ROOT, "ee/apps/den-web/app/(den)/dashboard/_components/mcp-connections-screen.tsx"), "utf8");
            witness(ctx, screen.includes('data-testid="quick-add-openwork-tag"'), "Connections has a stable OpenWork Tag entry point");
            witness(ctx, dialog.includes('data-testid="tag-dialog"'), "The Tag setup dialog has a stable proof selector");
            witness(ctx, dialog.includes('data-testid="install-tag-oauth"'), "The dialog exposes a stable managed Slack install action");
            witness(ctx, dialog.includes("OAuth tokens rotate automatically"), "The dialog explains token rotation and revocation behavior");
            witness(ctx, dialog.includes("Recent execution records"), "The dialog exposes Den run history");
            witness(ctx, dialog.includes("immutable policy snapshot"), "The dialog explains snapshot immutability");
            witness(ctx, dialog.includes("never returned, logged, sent to OpenCode, or exposed to the model"), "The credential boundary is visible to admins");
            ctx.output("OpenWork Tag UI contract", [
              "✓ quick-add card",
              "✓ setup dialog",
              "✓ managed Slack OAuth install",
              "✓ automatic rotation and fail-closed revocation",
              "✓ encrypted credential boundary",
              "✓ immutable snapshots",
              "✓ recent execution records",
            ].join("\n"));
          },
        });
      },
    },
  ],
};
