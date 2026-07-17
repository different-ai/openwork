import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "standard-dmg-bootstrap-zip";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEN_WEB_URL = cleanUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const INSTALL_TOKEN = process.env.OPENWORK_EVAL_INSTALL_TOKEN?.trim() ?? "";
const BUNDLE_ZIP = process.env.OPENWORK_EVAL_BUNDLE_ZIP?.trim() ?? "";
const BUNDLE_DIR = process.env.OPENWORK_EVAL_BUNDLE_DIR?.trim() ?? "";
const BOOTSTRAP_PATH = process.env.OPENWORK_EVAL_BOOTSTRAP_PATH?.trim() ?? "";
const DESKTOP_CDP_URL = cleanUrl(process.env.OPENWORK_EVAL_DESKTOP_CDP_URL);

function cleanUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

async function navigate(ctx, url) {
  await ctx.client.send("Page.navigate", { url });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${url}` });
}

async function withClient(ctx, cdpBaseUrl, callback) {
  const previous = ctx.client;
  const targets = await listTargets(cdpBaseUrl);
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) throw new Error(`No page target available at ${cdpBaseUrl}`);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  ctx.client = client;
  try {
    return await callback();
  } finally {
    ctx.client = previous;
    client.close();
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function zipEntries() {
  const result = spawnSync("unzip", ["-Z1", BUNDLE_ZIP], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`unzip -Z1 failed: ${result.stderr || result.stdout}`);
  return result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

export default {
  id: FLOW_ID,
  title: "Organization downloads reuse the standard signed installer and configure OpenWork on first launch",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_INSTALL_TOKEN",
    "OPENWORK_EVAL_BUNDLE_ZIP",
    "OPENWORK_EVAL_BUNDLE_DIR",
    "OPENWORK_EVAL_BOOTSTRAP_PATH",
    "OPENWORK_EVAL_DESKTOP_CDP_URL",
  ],
  steps: [
    {
      name: "Organization download is available under deployment policy",
      run: async (ctx) => {
        await ctx.prove("The enabled organization has a branded download page", {
          voiceover: vo[0],
          action: async () => {
            await navigate(ctx, `${DEN_WEB_URL}/install?token=${encodeURIComponent(INSTALL_TOKEN)}`);
            await ctx.waitForText("Acme Work", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Download Acme Work");
            await ctx.expectText("Acme Robotics");
          },
          screenshot: { name: "organization-download-enabled", requireText: ["Download Acme Work", "Acme Robotics"] },
        });
      },
    },
    {
      name: "Member sees the organization download",
      run: async (ctx) => {
        await ctx.prove("The member sees the standard platform choices for Acme", {
          voiceover: vo[1],
          action: async () => {
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
            await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
            await ctx.waitFor("document.activeElement?.matches('[data-testid=install-download-primary]')", {
              timeoutMs: 5_000,
              label: "keyboard focus on primary organization download",
            });
          },
          assert: async () => {
            await ctx.expectText("Mac (Apple silicon)");
            await ctx.expectText("Windows");
            const href = await ctx.eval("document.querySelector('[data-testid=install-download-primary]')?.href");
            witness(ctx, typeof href === "string" && href.includes(`/v1/install/`) && href.includes("token="), "The primary button targets the organization install endpoint", href);
          },
          screenshot: { name: "organization-platform-downloads", requireText: ["Mac (Apple silicon)", "Windows"] },
        });
      },
    },
    {
      name: "ZIP contains the normal installer and bootstrap only",
      run: async (ctx) => {
        await ctx.prove("The downloaded ZIP has exactly the standard DMG and desktop-bootstrap.json", {
          voiceover: vo[2],
          assert: async () => {
            const entries = zipEntries();
            witness(ctx, entries.length === 2, "The organization ZIP has exactly two top-level files", entries);
            witness(ctx, entries.some((entry) => /^openwork-mac-arm64-.+\.dmg$/.test(entry)), "The ZIP contains the normal versioned macOS DMG", entries);
            witness(ctx, entries.includes("desktop-bootstrap.json"), "The ZIP contains desktop-bootstrap.json", entries);
            witness(ctx, !entries.some((entry) => entry.includes("openwork-installer")), "The ZIP contains no separate installer application", entries);
            ctx.output("organization-download.zip", `${entries.join("\n")}\n\n${statSync(BUNDLE_ZIP).size} bytes`);
          },
        });
      },
    },
    {
      name: "First launch imports the adjacent bootstrap",
      run: async (ctx) => {
        await withClient(ctx, DESKTOP_CDP_URL, async () => {
          await ctx.prove("The standard desktop imported the bootstrap before showing sign-in", {
            voiceover: vo[3],
            action: async () => {
              await ctx.waitForText("Welcome to Acme Work", { timeoutMs: 45_000 });
            },
            assert: async () => {
              const bundled = readJson(path.join(BUNDLE_DIR, "desktop-bootstrap.json"));
              const canonical = readJson(BOOTSTRAP_PATH);
              witness(ctx, JSON.stringify(canonical) === JSON.stringify(bundled), "The adjacent bundle bootstrap was copied byte-for-value to the canonical desktop config", { bundled, canonical });
              await ctx.expectText("Sign in to Acme Work");
              await ctx.expectText(new URL(bundled.baseUrl).host);
              ctx.output("canonical-desktop-bootstrap.json", JSON.stringify(canonical, null, 2));
            },
            screenshot: { name: "standard-desktop-imported-bootstrap", requireText: ["Welcome to Acme Work", "Sign in to Acme Work"] },
          });
        });
      },
    },
    {
      name: "Configured name and wordmark appear without changing sign-in",
      run: async (ctx) => {
        await withClient(ctx, DESKTOP_CDP_URL, async () => {
          await ctx.prove("The first-run screen uses Acme's name and loaded wordmark while preserving normal sign-in", {
            voiceover: vo[4],
            action: async () => {
              await ctx.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
              await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
              await ctx.waitFor("document.activeElement?.tagName === 'BUTTON'", {
                timeoutMs: 5_000,
                label: "keyboard focus on normal sign-in controls",
              });
            },
            assert: async () => {
              const logo = await ctx.eval(`(() => {
                const image = [...document.images].find((entry) => entry.alt === "Acme Work logo");
                return image ? { src: image.src, complete: image.complete, naturalWidth: image.naturalWidth } : null;
              })()`);
              witness(ctx, logo?.complete === true && logo.naturalWidth > 0, "The configured Acme wordmark loaded successfully", logo);
              await ctx.expectText("Sign in to Acme Work");
              await ctx.expectText("Paste sign-in code");
            },
            screenshot: { name: "acme-branding-normal-signin", requireText: ["Welcome to Acme Work", "Paste sign-in code"] },
          });
        });
      },
    },
    {
      name: "Default-on and kill-switch contract remains explicit",
      run: async (ctx) => {
        await ctx.prove("Install links are default-on for every deployment, with an org kill switch", {
          voiceover: vo[5],
          assert: async () => {
            const result = spawnSync(
              "pnpm",
              ["exec", "bun", "test", "ee/apps/den-api/test/install-links-rollout.test.ts"],
              { cwd: ROOT, encoding: "utf8", env: process.env },
            );
            witness(ctx, result.status === 0, "The default-on kill-switch contract passes in the exact branch sandbox", result.stdout + result.stderr);
            ctx.output("install-links rollout contract", (result.stdout + result.stderr).trim());
            const releaseWorkflow = readFileSync(path.join(ROOT, ".github", "workflows", "release-macos-aarch64.yml"), "utf8");
            witness(ctx, !releaseWorkflow.includes("publish-generic-installer:"), "Stable releases no longer build the separate generic installer", "publish-generic-installer job absent");
          },
        });
      },
    },
  ],
};
