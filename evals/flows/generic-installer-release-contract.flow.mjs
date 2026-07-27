import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "generic-installer-release-contract";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = process.env.OPENWORK_EVAL_RELEASE_REPO?.trim() || "different-ai/openwork";
const UNIQUE_TAG = process.env.OPENWORK_EVAL_RELEASE_TAG?.trim() || "";
const MAC_ARM_ASSET = "OpenWork-Installer-mac-arm64.dmg";
const MAC_X64_ASSET = "OpenWork-Installer-mac-x64.dmg";
const WIN_ASSET = "OpenWork-Installer-win-x64.exe";
const APP_NAME = "Install OpenWork.app";
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

// The URL den-api redirects to when an organization has no pinned installer release.
function latestAssetUrl(asset = MAC_ARM_ASSET) {
  return `https://github.com/${REPO}/releases/latest/download/${asset}`;
}

// A UDIF disk image ends with a 512-byte "koly" trailer. Checking it proves the
// download is a real disk image on runners without hdiutil.
function hasDiskImageTrailer(bytes) {
  return bytes.length > 512 && bytes.subarray(bytes.length - 512, bytes.length - 508).toString("latin1") === "koly";
}

function validateMountedApp(ctx, appPath, label, { expectStampedVersion }) {
  const plist = run("plutil", ["-p", path.join(appPath, "Contents", "Info.plist")]);
  witness(ctx, plist.status === 0, `${label} carries a readable Info.plist`, plist.output);
  // The installer shipped a hardcoded 1.0.0 up to and including v0.18.1; the release
  // workflow now stamps the tag. Only artifacts built after that fix can be held to it,
  // so releases published earlier are not asserted against.
  if (expectStampedVersion) {
    witness(ctx, !plist.output.includes('"CFBundleShortVersionString" => "1.0.0"'), `${label} reports a real version rather than the 1.0.0 placeholder`, plist.output);
  }

  const codesign = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  const stapler = run("xcrun", ["stapler", "validate", appPath]);
  witness(ctx, codesign.status === 0, `${label} has a valid deep code signature`, codesign.output);
  witness(ctx, gatekeeper.status === 0 && gatekeeper.output.includes("accepted"), `${label} is accepted by Gatekeeper`, gatekeeper.output);
  witness(ctx, stapler.status === 0, `${label} carries a valid notarization ticket`, stapler.output);

  return [
    `$ plutil -p "${appPath}/Contents/Info.plist"`,
    plist.output,
    `$ codesign --verify --deep --strict --verbose=2 "${appPath}"`,
    codesign.output,
    `$ spctl --assess --type execute --verbose=2 "${appPath}"`,
    gatekeeper.output,
    `$ xcrun stapler validate "${appPath}"`,
    stapler.output,
  ].join("\n");
}

async function downloadAndValidateMacInstaller(ctx, url, label, { expectStampedVersion = false } = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ow-installer-release-contract-"));
  const dmgPath = path.join(tempDir, MAC_ARM_ASSET);
  const mountPoint = path.join(tempDir, "mnt");

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "openwork-release-contract-eval" },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    witness(ctx, response.status === 200, `${label} returns HTTP 200 anonymously`, String(response.status));
    witness(ctx, bytes.length > 1_000_000, `${label} returns a real installer rather than an error body`, `${bytes.length} bytes`);
    writeFileSync(dmgPath, bytes);
    witness(ctx, hasDiskImageTrailer(bytes), `${label} is a UDIF disk image`);

    let trustEvidence = "Gatekeeper validation requires macOS; disk image validation completed cross-platform.";
    if (process.platform === "darwin") {
      const verify = run("hdiutil", ["verify", dmgPath]);
      witness(ctx, verify.status === 0, `${label} passes disk image integrity`, verify.output.split("\n").slice(-2).join("\n"));

      const attach = run("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
      witness(ctx, attach.status === 0, `${label} mounts successfully`, attach.output);
      try {
        const appPath = path.join(mountPoint, APP_NAME);
        witness(ctx, existsSync(appPath), `${APP_NAME} is at the disk image root`);
        witness(ctx, !existsSync(path.join(mountPoint, "openwork-installer.json")), "The generic artifact has no organization sidecar");
        trustEvidence = validateMountedApp(ctx, appPath, label, { expectStampedVersion });
      } finally {
        run("hdiutil", ["detach", mountPoint, "-force"]);
      }
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    ctx.output(
      `${label}-anonymous-download`,
      [
        `requested=${url}`,
        `resolved=${response.url}`,
        `status=${response.status}`,
        `bytes=${statSync(dmgPath).size}`,
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
            await downloadAndValidateMacInstaller(ctx, assetUrl(UNIQUE_TAG), "unique release asset", { expectStampedVersion: true });
          },
        });
      },
    },
    {
      name: "The published stable installer is downloadable at the URL den-api hands out",
      run: async (ctx) => {
        await ctx.prove("The releases/latest URL den-api redirects to downloads a trusted installer", {
          voiceover: vo[1],
          assert: async () => {
            await downloadAndValidateMacInstaller(ctx, latestAssetUrl(), "latest stable asset");
          },
        });
      },
    },
    {
      name: "The stable release pipeline and the download route agree on the asset names",
      run: async (ctx) => {
        await ctx.prove("Stable publication builds every generic asset and den-api redirects to those exact names", {
          voiceover: vo[2],
          assert: async () => {
            const genericWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "release-generic-installer.yml"), "utf8");
            const releaseWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "release-macos-aarch64.yml"), "utf8");
            const e2eWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "eval-generic-installer-release.yml"), "utf8");
            const resolver = readFileSync(path.join(ROOT, "ee", "apps", "den-api", "src", "utils", "installer-artifacts.ts"), "utf8");
            const downloadRoute = readFileSync(path.join(ROOT, "ee", "apps", "den-api", "src", "routes", "org", "install-links.ts"), "utf8");

            witness(ctx, genericWorkflow.includes("workflow_call:"), "The generic installer workflow is reusable by the release workflow");
            witness(ctx, genericWorkflow.includes("inputs.release_tag"), "A reusable call publishes against the caller's release tag");
            // The stable release no longer builds the retired OpenWork-Installer-*
            // helper artifacts; Den links directly to the signed enterprise app.
            witness(ctx, !releaseWorkflow.includes("publish-installers:"), "The stable release workflow no longer publishes the retired helper installers");
            witness(ctx, releaseWorkflow.includes("openwork-enterprise"), "The stable release workflow publishes the enterprise desktop artifacts");
            witness(ctx, releaseWorkflow.includes("--draft $PRERELEASE_FLAG"), "Every newly created release begins as a draft");
            witness(ctx, genericWorkflow.includes(MAC_ARM_ASSET), "Stable publication builds the ARM64 generic asset", MAC_ARM_ASSET);
            witness(ctx, genericWorkflow.includes(MAC_X64_ASSET), "Stable publication builds the x64 generic asset", MAC_X64_ASSET);
            witness(ctx, genericWorkflow.includes(WIN_ASSET), "Stable publication builds the Windows generic asset", WIN_ASSET);
            // The installer version is stamped from the tag, and the smoke test fails the
            // build on a mismatch, so an unversioned artifact cannot be published.
            witness(ctx, genericWorkflow.includes("INSTALLER_VERSION"), "Publication stamps the release version into every artifact");
            witness(ctx, e2eWorkflow.includes('branches:\n      - "installer-release-e2e/**"'), "A collision-proof push caller exercises the reusable workflow end to end");
            witness(ctx, e2eWorkflow.includes("--cleanup-tag --yes"), "The isolated E2E release and tag are always cleaned up");
            witness(ctx, resolver.includes("releases/latest/download"), "The resolver can address an unpinned release by its latest asset URL");
            witness(ctx, downloadRoute.includes("enterpriseDesktopReleaseAssetName"), "The download route selects the enterprise desktop artifact");
            witness(ctx, downloadRoute.includes("installerReleaseAssetUrl"), "The download route honours an organization's pinned installer release");

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
