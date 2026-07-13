import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "generic-installer-release-contract";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = process.env.OPENWORK_EVAL_RELEASE_REPO?.trim() || "different-ai/openwork";
const UNIQUE_TAG = process.env.OPENWORK_EVAL_RELEASE_TAG?.trim() || "";
const RECOVERY_TAG = process.env.OPENWORK_EVAL_RECOVERY_TAG?.trim() || "v0.17.19";
const MAC_ARM_ASSET = "openwork-installer-mac-arm64.zip";
const APP_NAME = "OpenWork Installer.app";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual = "") {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function assetUrl(tag, asset = MAC_ARM_ASSET) {
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${asset}`;
}

async function downloadAndValidateMacInstaller(ctx, tag, label) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ow-installer-release-contract-"));
  const zipPath = path.join(tempDir, MAC_ARM_ASSET);
  const extractedPath = path.join(tempDir, "extracted");
  const url = assetUrl(tag);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "openwork-release-contract-eval" },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    witness(ctx, response.status === 200, `${label} returns HTTP 200 anonymously`, String(response.status));
    witness(ctx, bytes.length > 1_000_000, `${label} returns a real installer rather than an error body`, `${bytes.length} bytes`);
    writeFileSync(zipPath, bytes);

    const zipTest = run("unzip", ["-t", zipPath]);
    witness(ctx, zipTest.status === 0, `${label} passes zip integrity`, zipTest.output.split("\n").slice(-2).join("\n"));
    const zipList = run("unzip", ["-Z1", zipPath]);
    witness(ctx, zipList.status === 0, `${label} zip entries can be listed`, String(zipList.status));
    const entries = zipList.output.split("\n").filter(Boolean);
    witness(ctx, entries.some((entry) => entry.startsWith(`${APP_NAME}/`)), `${APP_NAME} is at the zip root`);
    witness(ctx, !entries.includes("openwork-installer.json"), "The generic artifact has no organization sidecar");

    const unzip = run("unzip", ["-q", zipPath, "-d", extractedPath]);
    witness(ctx, unzip.status === 0, `${label} extracts successfully`, unzip.output);
    const appPath = path.join(extractedPath, APP_NAME);

    let trustEvidence = "Gatekeeper validation requires macOS; archive validation completed cross-platform.";
    if (process.platform === "darwin") {
      const codesign = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
      const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
      const stapler = run("xcrun", ["stapler", "validate", appPath]);
      witness(ctx, codesign.status === 0, `${label} has a valid deep code signature`, codesign.output);
      witness(ctx, gatekeeper.status === 0 && gatekeeper.output.includes("accepted"), `${label} is accepted by Gatekeeper`, gatekeeper.output);
      witness(ctx, stapler.status === 0, `${label} carries a valid notarization ticket`, stapler.output);
      trustEvidence = [
        `$ codesign --verify --deep --strict --verbose=2 "${appPath}"`,
        codesign.output,
        `$ spctl --assess --type execute --verbose=2 "${appPath}"`,
        gatekeeper.output,
        `$ xcrun stapler validate "${appPath}"`,
        stapler.output,
      ].join("\n");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    ctx.output(
      `${label}-anonymous-download`,
      [
        `requested=${url}`,
        `resolved=${response.url}`,
        `status=${response.status}`,
        `bytes=${statSync(zipPath).size}`,
        `sha256=${sha256}`,
        "",
        trustEvidence,
      ].join("\n"),
    );
    return { url, bytes: bytes.length, sha256 };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export default {
  id: FLOW_ID,
  title: "Generic installer release links are downloadable before a stable release becomes public",
  kind: "internal",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_RELEASE_TAG"],
  steps: [
    {
      name: "A unique prerelease proves the artifact from this PR",
      run: async (ctx) => {
        await ctx.prove("The exact PR commit produced an anonymously downloadable, trusted Mac installer", {
          voiceover: vo[0],
          assert: async () => {
            witness(ctx, !UNIQUE_TAG.startsWith("v"), "The proof tag is isolated from normal v* release tags", UNIQUE_TAG);
            const releaseResponse = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(UNIQUE_TAG)}`, {
              headers: { accept: "application/vnd.github+json", "user-agent": "openwork-release-contract-eval" },
            });
            witness(ctx, releaseResponse.status === 200, "The unique proof release exists", String(releaseResponse.status));
            const release = await releaseResponse.json();
            witness(ctx, release.prerelease === true, "The unique proof release is marked prerelease", String(release.prerelease));
            await downloadAndValidateMacInstaller(ctx, UNIQUE_TAG, "unique release asset");
          },
        });
      },
    },
    {
      name: "The originally broken production URL is recovered",
      run: async (ctx) => {
        await ctx.prove("The reported v0.17.19 URL now downloads and passes integrity and trust checks", {
          voiceover: vo[1],
          assert: async () => {
            await downloadAndValidateMacInstaller(ctx, RECOVERY_TAG, "recovered v0.17.19 asset");
          },
        });
      },
    },
    {
      name: "The stable release pipeline and runtime fallback both fail safely",
      run: async (ctx) => {
        await ctx.prove("Stable publication is gated on generic assets and legacy fallback URLs are verified", {
          voiceover: vo[2],
          assert: async () => {
            const genericWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "release-generic-installer.yml"), "utf8");
            const releaseWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "release-macos-aarch64.yml"), "utf8");
            const e2eWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "eval-generic-installer-release.yml"), "utf8");
            const resolver = readFileSync(path.join(ROOT, "ee", "apps", "den-api", "src", "utils", "installer-artifacts.ts"), "utf8");
            const constants = readFileSync(path.join(ROOT, "ee", "apps", "den-api", "src", "CONSTS.ts"), "utf8");

            witness(ctx, genericWorkflow.includes("workflow_call:"), "The generic installer workflow is reusable by the release workflow");
            witness(ctx, genericWorkflow.includes("github.event_name != 'release'"), "A reusable call runs even though it retains the caller's push event");
            witness(ctx, releaseWorkflow.includes("publish-generic-installer:"), "The stable release workflow calls the generic installer workflow");
            witness(ctx, releaseWorkflow.includes("--draft $PRERELEASE_FLAG"), "Every newly created release begins as a draft");
            witness(ctx, releaseWorkflow.includes("openwork-installer-mac-arm64.zip"), "Stable publication asserts the ARM64 generic asset");
            witness(ctx, releaseWorkflow.includes("openwork-installer-mac-x64.zip"), "Stable publication asserts the x64 generic asset");
            witness(ctx, releaseWorkflow.includes("openwork-installer-win-x64.exe"), "Stable publication asserts the Windows generic asset");
            witness(ctx, e2eWorkflow.includes('branches:\n      - "installer-release-e2e/**"'), "A collision-proof push caller exercises the reusable workflow end to end");
            witness(ctx, e2eWorkflow.includes("--cleanup-tag --yes"), "The isolated E2E release and tag are always cleaned up");
            witness(ctx, resolver.includes('method: "HEAD"'), "Legacy fallback probes the normal release asset before redirecting");
            witness(ctx, constants.includes("https://openworklabs.com/download"), "A missing normal asset falls back to the stable download page");

            const tests = run("pnpm", [
              "exec",
              "bun",
              "test",
              "ee/apps/den-api/test/installer-artifacts.test.ts",
              "ee/apps/den-api/test/install-link-access.test.ts",
            ]);
            witness(ctx, tests.status === 0, "Focused installer and install-link tests pass", tests.output.split("\n").slice(-12).join("\n"));
            ctx.output("release-gate-and-fallback-tests", tests.output);
          },
        });
      },
    },
  ],
};
