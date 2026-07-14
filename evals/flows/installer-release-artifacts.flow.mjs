import { spawn, spawnSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/installer-release-artifacts.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("installer-release-artifacts");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const RELEASE_TAG = process.env.OPENWORK_EVAL_RELEASE_TAG?.trim() || "";
const RELEASE_REPO = process.env.OPENWORK_EVAL_RELEASE_REPO?.trim() || "different-ai/openwork";
const DEN_API_LOG = process.env.OPENWORK_EVAL_DEN_API_LOG?.trim() || "/tmp/ow-rel-den-api.log";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const MAC_ASSET = "openwork-installer-mac-arm64.zip";
const WIN_ASSET = "openwork-installer-win-x64.exe";
const INSTALL_SIDECAR_FILENAME = "openwork-installer.json";
const APP_BUNDLE_NAME = "OpenWork Installer.app";
// Must match den-api's default OPENWORK_INSTALLER_CACHE_DIR (env.installerCacheDir).
const INSTALLER_CACHE_DIR = path.join(os.tmpdir(), "openwork-installer-artifacts");

const state = {
  adminToken: null,
  platformAdminToken: null,
  orgId: null,
  installToken: null,
  installPageUrl: null,
  stampedZipPath: null,
  extractedDir: null,
  frame3Ui: null,
};

export default {
  id: "installer-release-artifacts",
  title: "One published release feeds every stamped install: the Mac download stays signed and notarized",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
    "OPENWORK_EVAL_RELEASE_TAG",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The public GitHub release carries the generic installer next to the app builds", {
            voiceover: vo[0],
            // "Every OpenWork release now ships one more thing: the generic installer..."
            action: async () => {
              await navigateToAbsolute(ctx, `https://github.com/${RELEASE_REPO}/releases/tag/${RELEASE_TAG}`);
              await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label: "release page load" });
              // The assets list lazy-loads (and can render collapsed); expand it if needed.
              const deadline = Date.now() + 45_000;
              while (Date.now() < deadline) {
                if (await hasText(ctx, MAC_ASSET)) break;
                await ctx.eval(`(() => {
                  for (const summary of document.querySelectorAll("summary")) {
                    if ((summary.textContent ?? "").includes("Assets")) { summary.click(); return true; }
                  }
                  return false;
                })()`);
                await ctx.eval("new Promise((resolve) => setTimeout(() => resolve(true), 500))", { awaitPromise: true });
              }
              await ctx.waitForText(MAC_ASSET, { timeoutMs: 15_000 });
            },
            assert: async () => {
              const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`, {
                headers: { accept: "application/vnd.github+json" },
              });
              ctx.assert(response.ok, `GitHub release lookup failed: ${response.status}`);
              const release = await response.json();
              const assets = Array.isArray(release.assets) ? release.assets : [];
              const published = {};
              for (const name of [MAC_ASSET, "openwork-installer-mac-x64.zip", WIN_ASSET]) {
                const asset = assets.find((entry) => entry.name === name);
                ctx.assert(Boolean(asset), `Release ${RELEASE_TAG} is missing public asset ${name}.`);
                published[name] = { size: asset.size, downloadUrl: asset.browser_download_url, updatedAt: asset.updated_at };
              }
              ctx.output("published-release-assets", JSON.stringify({ releaseTag: RELEASE_TAG, assets: published }, null, 2));
              await ctx.expectText(MAC_ASSET);
            },
            screenshot: { name: "release-ships-generic-installer", requireText: [MAC_ASSET] },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("den-api with no artifacts directory serves the stamped Mac download from the published release, then from cache", {
          voiceover: vo[1],
          // "A production-shaped server with no local files configured serves the Mac download anyway..."
          action: async () => {
            // Setup affordances: platform-admin provisioning, capability ON, mint a link.
            await ensureAdminToken(ctx);
            await ensureOrgId(ctx);
            await ensurePlatformAdmin(ctx);
            await setCapabilityViaAdminApi(ctx, { installLinks: true });
            ctx.output(
              "capability-enabled-by-platform-admin",
              `${PLATFORM_ADMIN_EMAIL} enabled installLinks for Acme via PUT /v1/admin/organizations/:id/capabilities.`,
            );
            const minted = await mintInstallLink(ctx);
            state.installToken = minted.token;
            state.installPageUrl = minted.installPageUrl;
            ctx.output("install-link-minted", JSON.stringify({ installPageUrl: minted.installPageUrl }, null, 2));

            // Reset the release cache so this run always witnesses the
            // download -> cache transition (keeps the flow idempotent).
            rmSync(path.join(INSTALLER_CACHE_DIR, RELEASE_TAG), { recursive: true, force: true });
            const logOffset = denApiLogSize();

            const first = await timedInstallDownload(ctx, "mac-arm64");
            const second = await timedInstallDownload(ctx, "mac-arm64");

            const tempDir = mkdtempSync(path.join(os.tmpdir(), "ow-release-stamped-"));
            state.stampedZipPath = path.join(tempDir, "stamped.zip");
            writeFileSync(state.stampedZipPath, first.bytes);

            const logSlice = readFileSync(DEN_API_LOG, "utf8").slice(logOffset);
            const downloadLines = logSlice.split("\n").filter((line) => line.includes(`[installer-artifacts] downloading ${MAC_ASSET} from ${RELEASE_TAG}`));
            const cacheHitLines = logSlice.split("\n").filter((line) => line.includes(`[installer-artifacts] cache hit ${MAC_ASSET}`));
            ctx.assert(downloadLines.length === 1, `Expected exactly one release download in den-api log, saw ${downloadLines.length}.`);
            ctx.assert(cacheHitLines.length >= 1, `Expected a cache-hit line in den-api log, saw ${cacheHitLines.length}.`);
            ctx.assert(first.bytes.length === second.bytes.length, `Stamped downloads differ in size: ${first.bytes.length} vs ${second.bytes.length}.`);
            ctx.assert(second.durationMs < first.durationMs, `Cache-served download (${second.durationMs}ms) was not faster than the first (${first.durationMs}ms).`);
            ctx.output(
              "prod-shaped-serve-then-cache",
              JSON.stringify(
                {
                  denApi: DEN_API_URL,
                  artifactsDirConfigured: false,
                  releaseTag: RELEASE_TAG,
                  firstDownload: { status: first.status, bytes: first.bytes.length, durationMs: first.durationMs },
                  secondDownload: { status: second.status, bytes: second.bytes.length, durationMs: second.durationMs },
                  denApiLogLines: [...downloadLines, ...cacheHitLines],
                },
                null,
                2,
              ),
            );
          },
          assert: async () => {
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await navigateToAbsolute(ctx, requireStateValue(state.installPageUrl, "install page URL"));
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-page\"]'))", { timeoutMs: 30_000, label: "install page" });
              await ctx.waitForText("Download OpenWork for Acme Robotics", { timeoutMs: 30_000 });
              await ctx.expectText("Download OpenWork for Acme Robotics");
              await ctx.screenshot("install-page-serves-real-downloads", {
                claim: "The install page now genuinely serves downloads backed by the published release",
                voiceover: vo[1],
                requireText: ["Download OpenWork for Acme Robotics"],
              });
            });
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        try {
          await withClient(ctx, INVITEE_CDP_URL, async () => {
            await ctx.prove("The stamped download keeps the notarized .app untouched and announces Acme before touching anything", {
              voiceover: vo[2],
              // "The download that arrives still opens like it came straight from Apple..."
              action: async () => {
                const stampedZipPath = requireStateValue(state.stampedZipPath, "stamped zip path");
                const workDir = mkdtempSync(path.join(os.tmpdir(), "ow-release-gatekeeper-"));
                const stampedDir = path.join(workDir, "stamped");
                const sourceDir = path.join(workDir, "source");
                mkdirSync(stampedDir);
                mkdirSync(sourceDir);
                unzip(stampedZipPath, stampedDir);
                state.extractedDir = stampedDir;

                const appPath = path.join(stampedDir, APP_BUNDLE_NAME);
                ctx.assert(existsSync(appPath), `Stamped zip did not contain ${APP_BUNDLE_NAME} at its root.`);

                const codesignResult = runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
                const spctlResult = runCommand("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
                const staplerResult = runCommand("xcrun", ["stapler", "validate", appPath]);
                ctx.assert(codesignResult.status === 0, `codesign --verify failed (${codesignResult.status}): ${codesignResult.combined}`);
                ctx.assert(spctlResult.status === 0, `spctl --assess failed (${spctlResult.status}): ${spctlResult.combined}`);
                ctx.assert(spctlResult.combined.includes("accepted"), `spctl did not accept the app: ${spctlResult.combined}`);
                ctx.assert(staplerResult.status === 0, `stapler validate failed (${staplerResult.status}): ${staplerResult.combined}`);
                ctx.output(
                  "gatekeeper-verdict",
                  [
                    `$ codesign --verify --deep --strict --verbose=2 "${appPath}"`,
                    codesignResult.combined.trim(),
                    "",
                    `$ spctl --assess --type execute --verbose=2 "${appPath}"`,
                    spctlResult.combined.trim(),
                    "",
                    `$ xcrun stapler validate "${appPath}"`,
                    staplerResult.combined.trim(),
                  ].join("\n"),
                );

                // Byte-identity: the .app's main binary matches the published
                // (unstamped) artifact den-api cached from the release.
                const cachedSourceZip = path.join(INSTALLER_CACHE_DIR, RELEASE_TAG, MAC_ASSET);
                ctx.assert(existsSync(cachedSourceZip), `den-api release cache is missing ${cachedSourceZip}.`);
                unzip(cachedSourceZip, sourceDir);
                const binaryRelPath = path.join(APP_BUNDLE_NAME, "Contents", "MacOS", "openwork-installer");
                const stampedSha = sha256File(path.join(stampedDir, binaryRelPath));
                const sourceSha = sha256File(path.join(sourceDir, binaryRelPath));
                ctx.assert(stampedSha === sourceSha, `Installer binary changed between published asset (${sourceSha}) and stamped download (${stampedSha}).`);

                // The sidecar sits at the zip root next to the .app and carries Acme's config.
                const sidecarPath = path.join(stampedDir, INSTALL_SIDECAR_FILENAME);
                ctx.assert(existsSync(sidecarPath), "Stamped zip did not contain the sidecar next to the .app.");
                const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
                ctx.assert(sidecar.clientName === "Acme Robotics", `Sidecar clientName was ${sidecar.clientName}.`);
                ctx.assert(sidecar.requireSignin === true, "Sidecar did not require sign-in.");
                ctx.output(
                  "stamped-app-byte-identity",
                  JSON.stringify(
                    {
                      binary: binaryRelPath,
                      publishedSha256: sourceSha,
                      stampedSha256: stampedSha,
                      byteIdentical: stampedSha === sourceSha,
                      sidecar,
                    },
                    null,
                    2,
                  ),
                );

                // Run the extracted installer binary itself (manual UI mode):
                // the .app-bundle sidecar resolution finds Acme's config next
                // to the bundle, exactly as a real unzip would lay it out.
                state.frame3Ui = await startExtractedInstallerUi(path.join(stampedDir, APP_BUNDLE_NAME, "Contents", "MacOS", "openwork-installer"), stampedDir);
                await navigateToAbsolute(ctx, state.frame3Ui.url);
                await ctx.waitForText("This sets up OpenWork for Acme Robotics", { timeoutMs: 20_000 });
              },
              assert: async () => {
                await ctx.expectText("This sets up OpenWork for Acme Robotics");
                await ctx.expectText("Configured via install link");
              },
              screenshot: {
                name: "downloaded-installer-announces-acme",
                requireText: ["This sets up OpenWork for Acme Robotics", "Configured via install link"],
              },
            });
          });
        } finally {
          state.frame3Ui?.kill();
          state.frame3Ui = null;
        }
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("The same install link serves Windows the tagged exe and Linux the org setup script, all from one release", {
            voiceover: vo[3],
            // "And the very same link keeps working for the whole fleet..."
            action: async () => {
              const token = requireStateValue(state.installToken, "install token");

              const win = await timedInstallDownload(ctx, "win-x64");
              const disposition = win.contentDisposition;
              const expectedFilename = new RegExp(`^attachment; filename="OpenWork-Installer--127\\.0\\.0\\.1_8790--${token}\\.exe"$`);
              ctx.assert(win.status === 200, `Windows install download returned ${win.status}.`);
              ctx.assert(expectedFilename.test(disposition), `Windows Content-Disposition was ${disposition}.`);

              const linuxResponse = await fetch(`${DEN_API_URL}/v1/install/linux-x64?token=${encodeURIComponent(token)}`);
              const linuxScript = await linuxResponse.text();
              ctx.assert(linuxResponse.status === 200, `Linux install download returned ${linuxResponse.status}.`);
              ctx.assert(linuxScript.includes("Acme Robotics"), "Linux setup script did not mention the org name.");

              ctx.output(
                "fleet-downloads-from-one-release",
                JSON.stringify(
                  {
                    windows: { status: win.status, bytes: win.bytes.length, contentDisposition: disposition },
                    linux: {
                      status: linuxResponse.status,
                      contentDisposition: linuxResponse.headers.get("content-disposition"),
                      scriptPreview: linuxScript.split("\n").slice(0, 6).join("\n"),
                    },
                  },
                  null,
                  2,
                ),
              );

              // Back on the install page, reach the platform list as a
              // keyboard user: a real Tab keypress switches Chrome into
              // keyboard modality (macOS Tab skips <a> elements entirely), so
              // focusing the Windows link then draws its :focus-visible ring
              // and keeps this frame visually distinct from frame 2.
              await navigateToAbsolute(ctx, requireStateValue(state.installPageUrl, "install page URL"));
              await ctx.waitForText("Download OpenWork for Acme Robotics", { timeoutMs: 30_000 });
              await ctx.waitForText("Windows", { timeoutMs: 15_000 });
              await ctx.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              const focusRing = await ctx.eval(`(() => {
                const link = [...document.querySelectorAll("a")].find((candidate) => (candidate.textContent ?? "").trim() === "Windows");
                if (!link) return "missing";
                link.scrollIntoView({ block: "center" });
                link.focus();
                return link.matches(":focus-visible") ? "focus-visible" : "focused";
              })()`);
              ctx.assert(focusRing === "focus-visible", `Windows platform link did not get a keyboard focus ring (${focusRing}).`);
            },
            assert: async () => {
              await ctx.expectText("Windows");
              await ctx.expectText("Linux (x64)");
            },
            screenshot: {
              name: "one-link-whole-fleet",
              requireText: ["Windows", "Linux (x64)"],
            },
          });
        });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

async function withClient(ctx, cdpBaseUrl, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(cdpBaseUrl);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  ctx.client = client;
  try {
    return await fn();
  } finally {
    ctx.client = previous;
    try {
      client.close();
    } catch {
      // Socket already gone.
    }
  }
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) {
    return page;
  }
  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${base}/json/new?about:blank`);
  }
  if (!response.ok) {
    throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);
  }
  const created = await response.json();
  if (created?.type === "page" && created.webSocketDebuggerUrl) {
    return created;
  }
  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) {
    throw new Error(`No page target available at ${cdpBaseUrl}.`);
  }
  return nextPage;
}

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

async function hasText(ctx, text) {
  return Boolean(await ctx.eval(`document.body.innerText.includes(${JSON.stringify(text)})`));
}

async function denApiFetch(pathname, options = {}) {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: DEN_WEB_URL || DEN_API_URL,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function ensureAdminToken(ctx) {
  if (state.adminToken) {
    return state.adminToken;
  }
  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (signedIn.response.ok && typeof signedIn.body?.token === "string") {
    state.adminToken = signedIn.body.token;
    return state.adminToken;
  }
  const token = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? "";
  ctx.assert(token.length > 0, `Admin sign-in failed and OPENWORK_EVAL_DEN_TOKEN is missing: ${signedIn.response.status}`);
  state.adminToken = token;
  return token;
}

async function ensureOrgId(ctx) {
  if (state.orgId) {
    return state.orgId;
  }
  const token = requireStateValue(state.adminToken, "org admin token");
  const org = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(org.response.ok, `Could not load ${ADMIN_EMAIL}'s organization: ${org.response.status} ${org.text.slice(0, 300)}`);
  const organization = org.body?.organization;
  ctx.assert(typeof organization?.id === "string", "Organization payload was missing id.");
  state.orgId = organization.id;
  return state.orgId;
}

/**
 * The platform admin is an ordinary account whose email is on the Den admin
 * allowlist (DEN_BOOTSTRAP_ADMIN_EMAILS on the den-api under test).
 */
async function ensurePlatformAdmin(ctx) {
  if (state.platformAdminToken) {
    return state.platformAdminToken;
  }
  const signup = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Priya Platform", email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
  });
  const signupAccepted = signup.response.ok || [400, 403, 409, 422].includes(signup.response.status);
  ctx.assert(signupAccepted, `Platform admin sign-up failed: ${signup.response.status} ${signup.text.slice(0, 300)}`);
  markEmailVerified(ctx, PLATFORM_ADMIN_EMAIL);

  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
  });
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Platform admin sign-in failed: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );
  state.platformAdminToken = signedIn.body.token;

  const probe = await denApiFetch("/v1/admin/overview", {
    method: "GET",
    headers: { authorization: `Bearer ${state.platformAdminToken}` },
  });
  ctx.assert(
    probe.response.ok,
    `${PLATFORM_ADMIN_EMAIL} is not a platform admin (overview probe ${probe.response.status}). Start den-api with DEN_BOOTSTRAP_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAIL}.`,
  );
  return state.platformAdminToken;
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Platform-admin provisioning requires a verified email; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function setCapabilityViaAdminApi(ctx, capabilities) {
  const token = requireStateValue(state.platformAdminToken, "platform admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const updated = await denApiFetch(`/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ capabilities }),
  });
  ctx.assert(updated.response.ok, `Admin capability update failed: ${updated.response.status} ${updated.text.slice(0, 300)}`);
}

async function mintInstallLink(ctx) {
  const token = requireStateValue(state.adminToken, "org admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  const minted = await denApiFetch(`/v1/orgs/${orgId}/install-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  ctx.assert(minted.response.ok, `Install-link mint failed: ${minted.response.status} ${minted.text.slice(0, 300)}`);
  ctx.assert(typeof minted.body?.token === "string" && typeof minted.body?.installPageUrl === "string", "Install-link mint response was incomplete.");
  // The install page URL is minted against den-api's own origin; the demo
  // walks it through the den-web deployment under test.
  const pageUrl = new URL(minted.body.installPageUrl);
  return { token: minted.body.token, installPageUrl: `${DEN_WEB_URL}${pageUrl.pathname}${pageUrl.search}` };
}

function denApiLogSize() {
  try {
    return statSync(DEN_API_LOG).size;
  } catch {
    return 0;
  }
}

async function timedInstallDownload(ctx, platform) {
  const token = requireStateValue(state.installToken, "install token");
  const startedAt = Date.now();
  const response = await fetch(`${DEN_API_URL}/v1/install/${platform}?token=${encodeURIComponent(token)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const durationMs = Date.now() - startedAt;
  ctx.assert(
    response.status === 200,
    `${platform} install download failed: ${response.status} ${bytes.toString("utf8", 0, Math.min(bytes.length, 300))}`,
  );
  return { status: response.status, bytes, durationMs, contentDisposition: response.headers.get("content-disposition") ?? "" };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    combined: [stdout, stderr].filter(Boolean).join("\n"),
  };
}

function unzip(zipPath, outputDir) {
  const result = spawnSync("unzip", ["-oq", zipPath, "-d", outputDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`unzip failed: ${result.stderr || result.stdout}`);
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Runs the extracted installer binary in manual UI mode (serves its UI over
 * local HTTP without opening a window) and resolves the served URL from
 * stdout. The caller must kill() the returned child.
 */
async function startExtractedInstallerUi(binaryPath, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENWORK_INSTALLER_") || key === "OPENWORK_DESKTOP_BOOTSTRAP_PATH") {
      delete env[key];
    }
  }
  const child = spawn(binaryPath, [], {
    cwd,
    env: { ...env, OPENWORK_INSTALLER_UI: "manual" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const match = output.match(/UI ready at (http:\/\/127\.0\.0\.1:\d+\/?)/);
    if (match) {
      return { child, url: match[1], kill: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    }
    if (child.exitCode !== null) {
      throw new Error(`Installer UI exited early (${child.exitCode}): ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  throw new Error(`Installer UI did not print a ready URL in time: ${output}`);
}
