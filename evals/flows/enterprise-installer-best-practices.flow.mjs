import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "enterprise-installer-best-practices";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

export default {
  id: FLOW_ID,
  title: "Enterprise installers use one immutable-binary configuration model across setup bundles and managed fleets",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The repository exposes a supported organization-bundle command",
      run: async (ctx) => {
        await ctx.prove("An administrator has one documented command for exact-version organization bundles", {
          voiceover: vo[0],
          assert: async () => {
            const help = run("pnpm", ["enterprise-installer:build", "--", "--help"]);
            witness(ctx, help.status === 0, "The enterprise installer command exits successfully", help.output.split("\n").slice(-12).join("\n"));
            witness(ctx, help.output.includes("--artifacts-dir"), "The command documents zero-egress local artifacts");
            witness(ctx, help.output.includes("--dry-run"), "The command documents non-mutating validation");
            ctx.output("enterprise-installer-help", help.output);
          },
        });
      },
    },
    {
      name: "Mac and Windows bundles preserve exact input bytes",
      run: async (ctx) => {
        await ctx.prove("The shared builder packages unchanged platform artifacts and emits audit hashes", {
          voiceover: vo[1],
          assert: async () => {
            const result = run("bun", ["test", "test/organization-installer-command.test.ts", "test/zip-append.test.ts"], path.join(ROOT, "ee/apps/den-api"));
            witness(ctx, result.status === 0, "Mac, Windows, ZIP, checksum, and dry-run tests pass", result.output.split("\n").slice(-16).join("\n"));
            witness(ctx, result.output.includes("packages unchanged Windows installer and desktop bytes"), "Windows byte preservation is exercised");
            witness(ctx, result.output.includes("builds the same deterministic organization bundle"), "macOS byte preservation is exercised");
            ctx.output("organization-bundle-tests", result.output);
          },
        });
      },
    },
    {
      name: "Installer state changes are transactional",
      run: async (ctx) => {
        await ctx.prove("Validation is non-mutating and bootstrap state is written only after installation", {
          voiceover: vo[2],
          assert: async () => {
            const result = run("pnpm", ["--filter", "@openwork/installer", "test"]);
            witness(ctx, result.status === 0, "The focused installer suite passes", result.output.split("\n").slice(-14).join("\n"));
            const implementation = readFileSync(path.join(ROOT, "apps/installer/src/install.ts"), "utf8");
            const installIndex = implementation.indexOf("const installedPath =");
            const writeIndex = implementation.indexOf("const bootstrapPath = writeBootstrapConfig(config)", installIndex);
            witness(ctx, installIndex >= 0 && writeIndex > installIndex, "Bootstrap configuration is written after the application install succeeds");
            witness(ctx, implementation.includes("no changes made"), "Dry-run explicitly reports that no state changed");
            ctx.output("installer-transaction-tests", result.output);
          },
        });
      },
    },
    {
      name: "The PR explains conventional managed deployment separately",
      run: async (ctx) => {
        await ctx.prove("MDM and setup bundles share configuration without introducing a second installer architecture", {
          voiceover: vo[3],
          assert: async () => {
            const workflow = readFileSync(path.join(ROOT, ".github/workflows/build-client-installer.yml"), "utf8");
            const guide = readFileSync(path.join(ROOT, "docs/org-install-links.md"), "utf8");
            const imagePath = path.join(ROOT, "docs/images/deterministic-enterprise-installer.png");
            witness(ctx, !workflow.includes("Write client build config"), "The workflow no longer bakes client values into a compiled executable");
            witness(ctx, workflow.includes("pnpm enterprise-installer:build"), "The workflow calls the same supported bundle command");
            witness(ctx, guide.includes("## MDM deployment"), "The operator guide explains the managed-fleet lane");
            witness(ctx, guide.includes("does not rebuild or resign"), "The guide makes immutable binaries explicit");
            witness(ctx, existsSync(imagePath) && statSync(imagePath).size > 100_000, "The enterprise architecture explainer is present", imagePath);
            ctx.output("enterprise-pattern-evidence", `${imagePath}\n${workflow.split("\n").slice(0, 12).join("\n")}`);
          },
        });
      },
    },
  ],
};
