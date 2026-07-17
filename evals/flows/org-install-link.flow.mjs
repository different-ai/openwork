import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-install-link.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-install-link");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const INSTALLER_BIN = process.env.OPENWORK_EVAL_INSTALLER_BIN?.trim() ?? "";
const ARTIFACTS_DIR = process.env.OPENWORK_EVAL_ARTIFACTS_DIR?.trim() ?? "";
const BOOTSTRAP_PATH = process.env.OPENWORK_EVAL_BOOTSTRAP_PATH?.trim() ?? "";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const RUN_TAG = Date.now().toString(36);
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || `riley.install+${RUN_TAG}@acme.test`;
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const INSTALL_SIDECAR_FILENAME = "openwork-installer.json";
const MAC_ARTIFACT_FILENAME = "openwork-installer-mac-arm64.zip";

const state = {
  desktopClient: null,
  adminToken: null,
  platformAdminToken: null,
  orgId: null,
  installLink: null,
  installToken: null,
  installConfig: null,
  sidecarJson: null,
  sidecarConfig: null,
  frame3InstallerRun: null,
  memberSetup: null,
  copiedDesktopUrl: null,
  frame6InstallerRuns: null,
};

export default {
  id: "org-install-link",
  title: "Organization install links stamp Acme into the download, installer, and first desktop sign-in",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_INSTALLER_BIN",
    "OPENWORK_EVAL_ARTIFACTS_DIR",
    "OPENWORK_EVAL_BOOTSTRAP_PATH",
    "OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL",
    "OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        rememberDesktopClient(ctx);
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Alex copies an Acme install link and the token resolves to Acme's required sign-in config", {
            voiceover: vo[0],
            // "Alex wants the whole team on OpenWork, so from the team page he copies Acme'"
            action: async () => {
              await ensureAdminToken(ctx);
              await ensureOrgId(ctx);
              // Capability affordances (setup, not demo): install links are
              // default-on, but a platform admin can kill-switch one org. Force
              // that kill switch on first, witness the mint API refuse, then
              // clear it so Alex mints through the default-on path.
              await ensurePlatformAdmin(ctx);
              await setCapabilityViaAdminApi(ctx, { installLinks: false });
              const refused = await attemptMintInstallLink(ctx);
              ctx.assert(
                refused.response.status === 403,
                `Mint with the install-link kill switch on returned ${refused.response.status}, expected 403.`,
              );
              ctx.assert(
                refused.body?.error === "capability_disabled" && refused.body?.capability === "installLinks",
                `Mint refusal body was ${JSON.stringify(refused.body).slice(0, 300)}, expected capability_disabled/installLinks.`,
              );
              ctx.output(
                "mint-refused-while-kill-switch-on",
                JSON.stringify({ status: refused.response.status, body: refused.body }, null, 2),
              );
              await setCapabilityViaAdminApi(ctx, { installLinks: null });
              ctx.output(
                "install-link-kill-switch-cleared",
                `${PLATFORM_ADMIN_EMAIL} cleared Acme's installLinks override via PUT /v1/admin/organizations/:id/capabilities — with no stored false kill switch, install links are on by default.`,
              );
              await signInToDenWeb(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard/members");
              await stubInstallLinkClipboardCapture(ctx);
              await clickSelector(ctx, '[data-testid="copy-install-link"]', "copy install link button");
              state.installLink = await ctx.waitFor(
                "typeof window.__capturedInstallLink === 'string' && window.__capturedInstallLink.includes('/install?token=') && window.__capturedInstallLink",
                { timeoutMs: 30_000, label: "captured Acme install link" },
              );
              state.installToken = extractInstallToken(requireStateValue(state.installLink, "install link"), ctx);
              await ctx.waitFor(
                "document.querySelector('[data-testid=\"copy-install-link\"]')?.textContent?.trim() === 'Copy install link'",
                { timeoutMs: 6_000, label: "copy install link label restored" },
              );
            },
            assert: async () => {
              const installLink = requireStateValue(state.installLink, "install link");
              const expectedPrefix = `${DEN_WEB_URL}/install?token=`;
              ctx.assert(installLink.startsWith(expectedPrefix), `Install link ${installLink} did not start with ${expectedPrefix}.`);
              const token = extractInstallToken(installLink, ctx);
              state.installToken = token;

              const config = await fetchInstallConfig(ctx, token);
              ctx.assert(config.clientName === "Acme Robotics", `Install config clientName was ${config.clientName}.`);
              ctx.assert(config.requireSignin === true, "Install config did not require sign-in.");
              state.installConfig = config;
              ctx.output("install-config", JSON.stringify({ installLink, token, config }, null, 2));

              await ctx.expectText("Copy install link");
            },
            screenshot: {
              name: "alex-copy-install-link",
              requireText: ["Copy install link"],
              rejectText: ["Could not create install link"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("The install page and stamped macOS download both carry Acme's required sign-in configuration", {
            voiceover: vo[1],
            // "A new teammate opens the link and the download that arrives isn't a generic "
            action: async () => {
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.installLink, "install link"));
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-page\"]'))", {
                timeoutMs: 30_000,
                label: "install page",
              });
              await ctx.waitForText("Acme Robotics", { timeoutMs: 30_000 });
            },
            assert: async () => {
              await ctx.expectText("Acme Robotics");
              await ctx.expectText("Download");

              const witness = await fetchAndVerifyStampedMacInstaller(ctx);
              state.sidecarJson = witness.sidecarJson;
              state.sidecarConfig = witness.sidecarConfig;
              ctx.output("mac-download-byte-identity", JSON.stringify(witness.output, null, 2));
            },
            screenshot: { name: "acme-install-page", requireText: ["Acme Robotics", "Download"] },
          });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        try {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("The real installer dry-run names Acme and explains it was configured by an install link", {
            voiceover: vo[2],
            // "They run it, and before touching anything it says exactly what it's about to"
            action: async () => {
              state.frame3InstallerRun = runHeadlessInstallerWithSidecar();
              // Show the real installer UI (manual mode: served over local
              // HTTP, no native window) in the invitee's browser.
              state.frame3Ui = await startInstallerUi("openwork-install-link-ui-", {
                sidecarJson: requireStateValue(state.sidecarJson, "installer sidecar JSON"),
              });
              await navigateToAbsolute(ctx, state.frame3Ui.url);
              await ctx.waitForText("This sets up OpenWork for Acme Robotics", { timeoutMs: 20_000 });
            },
            assert: async () => {
              const run = requireInstallerRun(state.frame3InstallerRun, "frame 3 installer run");
              ctx.assert(run.status === 0, `Installer dry-run exited ${run.status}: ${run.stderr || run.stdout}`);
              ctx.assert(run.stdout.includes("OpenWork Installer — Acme Robotics"), "Installer stdout did not name Acme Robotics.");
              ctx.assert(run.stdout.includes("Configured via install link"), "Installer stdout did not say it was configured via install link.");
              ctx.assert(run.stdout.includes("Dry run ok"), "Installer stdout did not report Dry run ok.");
              ctx.output("headless-installer-dry-run", run.combined);

              await ctx.expectText("This sets up OpenWork for Acme Robotics");
              await ctx.expectText("Configured via install link");
              await ctx.expectText("Install");
            },
            screenshot: {
              name: "installer-announces-acme",
              requireText: ["This sets up OpenWork for Acme Robotics", "Configured via install link", "Install"],
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
        await ctx.prove("First desktop boot is Acme's Cloud sign-in gate, not the empty local setup", {
          voiceover: vo[3],
          // "The installer fetches the right app version and writes Acme's configuration,"
          action: async () => {
            useDesktopClient(ctx);
            await ensureDesktopReady(ctx);
            await resetDesktopDenSession(ctx);
            await ctx.eval("(() => { location.hash = '#/signin'; location.reload(); return true; })()");
            await ensureDesktopReady(ctx);
            await ctx.waitForText("Sign in with OpenWork Cloud", { timeoutMs: 45_000 });
            // Let the gate's fade-in transition finish so the frame shows the
            // fully rendered sign-in surface, not a mid-animation ghost.
            await ctx.eval("new Promise((resolve) => setTimeout(() => resolve(true), 1200))", { awaitPromise: true });
          },
          assert: async () => {
            useDesktopClient(ctx);
            const bootstrap = readBootstrapConfig(ctx, BOOTSTRAP_PATH);
            ctx.assert(bootstrap.parsed.requireSignin === true, "Desktop bootstrap file did not require sign-in.");
            ctx.assert(
              cleanBaseUrl(bootstrap.parsed.baseUrl) === DEN_WEB_URL,
              `Desktop bootstrap baseUrl ${bootstrap.parsed.baseUrl} did not match ${DEN_WEB_URL}.`,
            );
            ctx.output("desktop-bootstrap-after-installer", bootstrap.raw);

            await ctx.expectText("Welcome to OpenWork");
            await ctx.expectText("Sign in with OpenWork Cloud");
            const hash = await ctx.eval("location.hash");
            ctx.assert(typeof hash === "string" && hash.includes("/signin"), `Expected /signin route, got ${hash}.`);
            await ctx.expectNoText("Pick a folder");
          },
          screenshot: {
            name: "desktop-forced-acme-signin",
            requireText: ["Welcome to OpenWork", "Sign in with OpenWork Cloud"],
            rejectText: ["Pick a folder"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Riley signs in with one copied handoff link and lands in Acme on the desktop", {
          voiceover: vo[4],
          // "One click on Sign in with OpenWork Cloud, a browser flash, and they're stand"
          action: async () => {
            await ensureMemberAccount(ctx);
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await signInToDenWeb(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
              await navigateToAbsolute(ctx, `${DEN_WEB_URL}/?desktopAuth=1&desktopScheme=openwork`);
              await ctx.waitForText("Open OpenWork", { timeoutMs: 45_000 });
              await ctx.waitForText("Copy sign-in link", { timeoutMs: 45_000 });
              // Stub the clipboard only after the navigation settles — a new
              // document would wipe a stub installed any earlier.
              await stubClipboardCapture(ctx);
              await ctx.clickText("Copy sign-in link", { selector: "button", timeoutMs: 20_000 });
              state.copiedDesktopUrl = await ctx.waitFor(
                "typeof window.__capturedSignin === 'string' && window.__capturedSignin.startsWith('openwork://den-auth') && window.__capturedSignin",
                { timeoutMs: 30_000, label: "captured OpenWork sign-in link" },
              );
            });

            useDesktopClient(ctx);
            await ensureDesktopReady(ctx);
            await resetDesktopDenSession(ctx);
            await ctx.eval("(() => { location.hash = '#/signin'; return true; })()");
            await deliverDeepLinkToDesktop(ctx, requireStateValue(state.copiedDesktopUrl, "copied desktop sign-in URL"));
            ctx.output(
              "desktop-deep-link-delivery",
              "Dev Electron does not register the OS openwork:// handler in evals, so this flow dispatches openwork:deep-link with the copied openwork://den-auth URL — the same renderer event DenAuthProvider consumes.",
            );
          },
          assert: async () => {
            useDesktopClient(ctx);
            await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
              timeoutMs: 60_000,
              label: "persisted Den auth token",
            });
            await ctx.waitFor("(localStorage.getItem('openwork.den.activeOrgName') ?? '').includes('Acme Robotics')", {
              timeoutMs: 60_000,
              label: "Acme active org",
            });
            await ctx.waitFor("!document.body.innerText.includes('Sign in with OpenWork Cloud')", {
              timeoutMs: 45_000,
              label: "forced sign-in gate gone",
            });
            await ctx.expectNoText("Sign in with OpenWork Cloud");
            await completeDesktopSignedInJourney(ctx);
            await ctx.expectText("Acme Robotics", { timeoutMs: 45_000 });
            await ctx.expectText(MEMBER_EMAIL, { timeoutMs: 45_000 });
          },
          screenshot: {
            name: "desktop-signed-into-acme-from-install-link",
            requireText: ["Acme Robotics", "Sign out"],
            rejectText: ["Sign in with OpenWork Cloud", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        try {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("A bare installer asks for an install link, then succeeds once Riley pastes Acme's link", {
            voiceover: vo[5],
            // "And if someone ends up with the bare installer instead — forwarded file, ren"
            action: async () => {
              state.frame6InstallerRuns = runBareInstallerFallback();
              // A completely bare installer (no sidecar, no filename tag, no
              // build constants): its UI must ask for the install link.
              state.frame6Ui = await startInstallerUi("openwork-install-link-bare-ui-");
              await navigateToAbsolute(ctx, state.frame6Ui.url);
              await ctx.waitForText("Paste your OpenWork install link", { timeoutMs: 20_000 });
            },
            assert: async () => {
              const runs = requireFrame6Runs(state.frame6InstallerRuns);
              ctx.assert(runs.missing.status === 2, `Bare installer without link exited ${runs.missing.status}, expected 2.`);
              ctx.assert(
                runs.missing.combined.includes("Paste an OpenWork install link"),
                "Bare installer did not ask for an OpenWork install link.",
              );
              ctx.assert(runs.withLink.status === 0, `Bare installer with --install-link exited ${runs.withLink.status}.`);
              ctx.assert(runs.withLink.stdout.includes("Configured via install link"), "--install-link stdout did not report install-link config.");
              ctx.assert(runs.withLink.stdout.includes("Dry run ok"), "--install-link stdout did not report Dry run ok.");
              const bootstrap = readBootstrapConfig(ctx, runs.secondBootstrapPath);
              ctx.assert(bootstrap.parsed.requireSignin === true, "Second bootstrap file did not require sign-in.");
              ctx.output(
                "bare-installer-fallback",
                JSON.stringify(
                  {
                    withoutInstallLink: runs.missing,
                    withInstallLink: runs.withLink,
                    secondBootstrapPath: runs.secondBootstrapPath,
                    secondBootstrap: bootstrap.parsed,
                  },
                  null,
                  2,
                ),
              );
              // Drive the real paste fallback: enter the install link into
              // the installer's own UI and watch it become Acme's installer.
              await ctx.expectText("Paste your OpenWork install link");
              await ctx.fill("#install-link", requireStateValue(state.installLink, "install link"));
              await clickExactText(ctx, "Continue", "button");
              await ctx.waitForText("This sets up OpenWork for Acme Robotics", { timeoutMs: 20_000 });
            },
            screenshot: {
              name: "bare-installer-install-link-fallback",
              requireText: ["This sets up OpenWork for Acme Robotics", "Configured via install link"],
            },
          });
        });
        } finally {
          state.frame6Ui?.kill();
          state.frame6Ui = null;
        }
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function rememberDesktopClient(ctx) {
  if (!state.desktopClient) {
    state.desktopClient = ctx.client;
  }
}

function useDesktopClient(ctx) {
  rememberDesktopClient(ctx);
  ctx.client = state.desktopClient;
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

function requireInstallerRun(value, label) {
  if (value && typeof value === "object" && typeof value.status === "number") {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

function requireFrame6Runs(value) {
  if (value && typeof value === "object" && value.missing && value.withLink && typeof value.secondBootstrapPath === "string") {
    return value;
  }
  throw new Error("Frame 6 installer runs were not prepared.");
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
    // Close the extra websocket so the runner process can exit cleanly.
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
 * allowlist. The account is created here (idempotently); allowlist membership
 * comes from DEN_BOOTSTRAP_ADMIN_EMAILS on the den-api under test, which
 * upserts the email into admin_allowlist on boot.
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
    `${PLATFORM_ADMIN_EMAIL} is not a platform admin (overview probe ${probe.response.status}). Start den-api with DEN_BOOTSTRAP_ADMIN_EMAILS=${PLATFORM_ADMIN_EMAIL} or insert the email into admin_allowlist.`,
  );
  return state.platformAdminToken;
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

async function attemptMintInstallLink(ctx) {
  const token = requireStateValue(state.adminToken, "org admin token");
  const orgId = requireStateValue(state.orgId, "organization id");
  return denApiFetch(`/v1/orgs/${orgId}/install-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
}

async function createInvitation(ctx, email) {
  const token = await ensureAdminToken(ctx);
  const invitation = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, role: "member" }),
  });
  ctx.assert(
    invitation.response.ok,
    `Invitation failed for ${email}: ${invitation.response.status} ${JSON.stringify(invitation.body).slice(0, 300)}`,
  );
  ctx.assert(typeof invitation.body?.invitationId === "string", `Invitation response for ${email} did not include invitationId.`);
  return invitation.body;
}

async function ensureMemberAccount(ctx) {
  if (state.memberSetup) {
    return state.memberSetup;
  }

  const invitation = await createInvitation(ctx, MEMBER_EMAIL);
  const signup = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Riley Install", email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
  });
  const signupAccepted = signup.response.ok || [400, 403, 409, 422].includes(signup.response.status);
  ctx.assert(signupAccepted, `Sign-up failed for ${MEMBER_EMAIL}: ${signup.response.status} ${signup.text.slice(0, 300)}`);
  markEmailVerified(ctx, MEMBER_EMAIL);

  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
  });
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Member sign-in failed for ${MEMBER_EMAIL}: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );

  const accepted = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${signedIn.body.token}` },
    body: JSON.stringify({ id: invitation.invitationId }),
  });
  ctx.assert(
    accepted.response.ok,
    `Invitation accept failed for ${MEMBER_EMAIL}: ${accepted.response.status} ${accepted.text.slice(0, 300)}`,
  );

  state.memberSetup = {
    email: MEMBER_EMAIL,
    invitationId: invitation.invitationId,
    inviteToken: invitation.inviteToken ?? null,
    signupStatus: signup.response.status,
    acceptStatus: accepted.response.status,
    organizationSlug: accepted.body?.organizationSlug ?? null,
  };
  ctx.output("teammate-account-setup", JSON.stringify(state.memberSetup, null, 2));
  return state.memberSetup;
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Invitation acceptance requires a verified email; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function fetchInstallConfig(ctx, token) {
  const configResult = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(token)}`, { method: "GET" });
  ctx.assert(configResult.response.ok, `Install config fetch failed: ${configResult.response.status} ${configResult.text.slice(0, 300)}`);
  ctx.assert(isRecord(configResult.body), "Install config response was not a JSON object.");
  return configResult.body;
}

async function goToDenWeb(ctx, pathname) {
  await navigateToAbsolute(ctx, `${DEN_WEB_URL}${pathname}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

async function signInToDenWeb(ctx, email, password) {
  await clearDenWebSession(ctx);
  await goToDenWeb(ctx, "/");
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "sign-in screen" });
  await clickExactText(ctx, "Sign in", "button, a");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });
  await ctx.fill('input[type="email"], input[name="email"]', email);
  await ctx.fill('input[type="password"]', password);
  await clickLastExactText(ctx, "Sign in", "button");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
  // Sign out via the den-web proxy path (den-api sits behind /api/den) and
  // clear browser cookies so stale profile sessions from previous runs can
  // never leak into this one.
  await ctx.eval(
    `fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
  await ctx.client.send("Network.clearBrowserCookies", {});
}

async function clickExactText(ctx, text, selector) {
  const clicked = await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
  return clicked;
}

async function clickLastExactText(ctx, text, selector) {
  const clicked = await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
  return clicked;
}

async function clickSelector(ctx, selector, label) {
  await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label });
}

async function hasText(ctx, text) {
  return Boolean(await ctx.eval(`document.body.innerText.includes(${JSON.stringify(text)})`));
}

async function stubInstallLinkClipboardCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedInstallLink = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__capturedInstallLink = String(value);
          return Promise.resolve();
        },
      },
    });
    return true;
  })()`);
}

async function stubClipboardCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedSignin = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__capturedSignin = String(value);
          return Promise.resolve();
        },
      },
    });
    return true;
  })()`);
}

async function ensureDesktopReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API" });
}

async function deliverDeepLinkToDesktop(ctx, openworkUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    const pending = window.__OPENWORK__.deepLinks || [];
    window.__OPENWORK__.deepLinks = [...pending, url];
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function resetDesktopDenSession(ctx) {
  await ctx.eval(`(() => {
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
    ]) {
      localStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { status: 'signed_out' } }));
    return true;
  })()`);
}

async function completeDesktopSignedInJourney(ctx) {
  await ctx.waitFor(
    `document.body.innerText.includes("Choose your organization")
      || document.body.innerText.includes("You have access to the following resources.")
      || document.body.innerText.includes("No resources have been configured for this organization yet.")
      || location.hash.includes('/session')
      || location.hash.includes('/workspace/')
      || document.body.innerText.includes("OpenWork Cloud")`,
    { timeoutMs: 60_000, label: "post-sign-in desktop surface" },
  );

  if (await hasText(ctx, "Choose your organization")) {
    await ctx.expectText("Acme Robotics");
    await clickExactText(ctx, "Continue with organization", "button");
    await ctx.waitFor(
      `document.body.innerText.includes("You have access to the following resources.")
        || document.body.innerText.includes("No resources have been configured for this organization yet.")`,
      { timeoutMs: 45_000, label: "organization resources step" },
    );
  }

  if (await hasText(ctx, "You have access to the following resources.")) {
    await clickExactText(ctx, "Continue to workspace", "button");
    await ctx.waitFor("location.hash.includes('/session') || location.hash.includes('/workspace/')", { timeoutMs: 45_000, label: "workspace route" });
  } else if (await hasText(ctx, "No resources have been configured for this organization yet.")) {
    await clickExactText(ctx, "Continue", "button");
    await ctx.waitFor("location.hash.includes('/session') || location.hash.includes('/workspace/')", { timeoutMs: 45_000, label: "workspace route" });
  }

  await ctx.navigateHash("/settings/cloud-account");
  await ctx.waitForText("OpenWork Cloud", { timeoutMs: 45_000 });
  await ctx.waitForText("Sign out", { timeoutMs: 45_000 });
}

function extractInstallToken(installLink, ctx) {
  const parsed = new URL(installLink);
  const token = parsed.searchParams.get("token")?.trim() ?? "";
  ctx.assert(token.length > 0, `Install link did not include a token: ${installLink}`);
  return token;
}

async function fetchAndVerifyStampedMacInstaller(ctx) {
  const token = requireStateValue(state.installToken, "install token");
  const downloadUrl = `${DEN_API_URL}/v1/install/mac-arm64?token=${encodeURIComponent(token)}`;
  const response = await fetch(downloadUrl, { headers: { accept: "application/zip" } });
  const bytes = Buffer.from(await response.arrayBuffer());
  ctx.assert(response.ok, `Stamped macOS installer download failed: ${response.status} ${bytes.toString("utf8", 0, Math.min(bytes.length, 300))}`);

  const tempDir = makeTempDir("openwork-install-link-download-");
  const stampedZipPath = path.join(tempDir, "stamped.zip");
  const stampedDir = path.join(tempDir, "stamped");
  const sourceDir = path.join(tempDir, "source");
  mkdirSync(stampedDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(stampedZipPath, bytes);
  unzip(stampedZipPath, stampedDir);

  const sidecarPath = findExtractedFile(stampedDir, INSTALL_SIDECAR_FILENAME, ctx);
  const sidecarJson = readFileSync(sidecarPath, "utf8");
  const sidecarConfig = JSON.parse(sidecarJson);
  ctx.assert(sidecarConfig.clientName === "Acme Robotics", `Sidecar clientName was ${sidecarConfig.clientName}.`);
  ctx.assert(sidecarConfig.requireSignin === true, "Sidecar did not require sign-in.");

  const sourceZipPath = path.join(ARTIFACTS_DIR, MAC_ARTIFACT_FILENAME);
  ctx.assert(existsSync(sourceZipPath), `Source macOS artifact was missing: ${sourceZipPath}`);
  unzip(sourceZipPath, sourceDir);

  const stampedRecords = fileRecords(stampedDir).filter((record) => path.basename(record.relativePath) !== INSTALL_SIDECAR_FILENAME);
  const sourceRecords = fileRecords(sourceDir);
  ctx.assert(stampedRecords.length > 0, "Stamped zip did not contain an installer payload.");
  const sourceByRelativePath = new Map(sourceRecords.map((record) => [record.relativePath, record]));
  for (const stampedRecord of stampedRecords) {
    const sourceRecord = sourceByRelativePath.get(stampedRecord.relativePath);
    ctx.assert(Boolean(sourceRecord), `Source artifact did not include ${stampedRecord.relativePath}.`);
    ctx.assert(sourceRecord.sha256 === stampedRecord.sha256, `Extracted ${stampedRecord.relativePath} changed between source and stamped zip.`);
  }

  const installerRecord = chooseInstallerRecord(stampedRecords);
  const sourceInstallerRecord = sourceByRelativePath.get(installerRecord.relativePath);
  ctx.assert(Boolean(sourceInstallerRecord), `Source artifact did not include installer ${installerRecord.relativePath}.`);
  ctx.assert(sourceInstallerRecord.sha256 === installerRecord.sha256, "Extracted installer binary hash did not match the source artifact.");

  return {
    sidecarJson,
    sidecarConfig,
    output: {
      downloadUrl,
      stampedZipPath,
      sourceZipPath,
      sidecar: sidecarConfig,
      comparedFiles: stampedRecords.map((record) => ({ relativePath: record.relativePath, sha256: record.sha256, bytes: record.bytes })),
      installerBinary: {
        relativePath: installerRecord.relativePath,
        stampedSha256: installerRecord.sha256,
        sourceSha256: sourceInstallerRecord.sha256,
        byteIdentical: sourceInstallerRecord.sha256 === installerRecord.sha256,
      },
    },
  };
}

/**
 * Starts the real installer in manual UI mode (serves its UI over local HTTP
 * without opening a window) and resolves the served URL from stdout. The
 * caller must kill() the returned child.
 */
async function startInstallerUi(tempPrefix, { sidecarJson = null } = {}) {
  const tempDir = makeTempDir(tempPrefix);
  const installerPath = copyInstallerTo(tempDir);
  if (sidecarJson) {
    writeFileSync(path.join(tempDir, INSTALL_SIDECAR_FILENAME), sidecarJson, "utf8");
  }
  const child = spawn(installerPath, [], {
    cwd: tempDir,
    env: sanitizedInstallerEnv({ OPENWORK_INSTALLER_UI: "manual" }),
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

function runHeadlessInstallerWithSidecar() {
  const sidecarJson = requireStateValue(state.sidecarJson, "installer sidecar JSON");
  const tempDir = makeTempDir("openwork-install-link-sidecar-");
  const installerPath = copyInstallerTo(tempDir);
  writeFileSync(path.join(tempDir, INSTALL_SIDECAR_FILENAME), sidecarJson, "utf8");
  return runInstaller(installerPath, ["--headless", "--dry-run"], sanitizedInstallerEnv({ OPENWORK_DESKTOP_BOOTSTRAP_PATH: BOOTSTRAP_PATH }), tempDir);
}

function runBareInstallerFallback() {
  const installLink = requireStateValue(state.installLink, "install link");
  const tempDir = makeTempDir("openwork-install-link-bare-");
  const installerPath = copyInstallerTo(tempDir);
  const missing = runInstaller(installerPath, ["--headless", "--dry-run"], sanitizedInstallerEnv(), tempDir);
  const secondBootstrapPath = path.join(tempDir, "second-desktop-bootstrap.json");
  const withLink = runInstaller(
    installerPath,
    ["--headless", "--dry-run", "--install-link", installLink],
    sanitizedInstallerEnv({ OPENWORK_DESKTOP_BOOTSTRAP_PATH: secondBootstrapPath }),
    tempDir,
  );
  return { missing, withLink, secondBootstrapPath };
}

function runInstaller(installerPath, args, env, cwd) {
  const result = spawnSync(installerPath, args, { cwd, env, encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const error = result.error instanceof Error ? result.error.message : "";
  return {
    command: `${installerPath} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    status: result.status ?? 1,
    stdout,
    stderr,
    error,
    combined: [stdout, stderr, error].filter(Boolean).join("\n"),
  };
}

function sanitizedInstallerEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENWORK_INSTALLER_") || key === "OPENWORK_DESKTOP_BOOTSTRAP_PATH") {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function copyInstallerTo(directory) {
  const installerPath = path.join(directory, "openwork-installer");
  copyFileSync(INSTALLER_BIN, installerPath);
  chmodSync(installerPath, 0o755);
  return installerPath;
}

function readBootstrapConfig(ctx, bootstrapPath) {
  ctx.assert(existsSync(bootstrapPath), `Desktop bootstrap file does not exist: ${bootstrapPath}`);
  const raw = readFileSync(bootstrapPath, "utf8");
  const parsed = JSON.parse(raw);
  ctx.assert(isRecord(parsed), `Desktop bootstrap file was not a JSON object: ${bootstrapPath}`);
  return { raw, parsed };
}

function makeTempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function unzip(zipPath, outputDir) {
  execFileSync("unzip", ["-oq", zipPath, "-d", outputDir], { stdio: "pipe" });
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listFilesRecursive(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function fileRecords(rootDir) {
  return listFilesRecursive(rootDir)
    .map((filePath) => ({
      absolutePath: filePath,
      relativePath: path.relative(rootDir, filePath).split(path.sep).join("/"),
      sha256: sha256File(filePath),
      bytes: statSync(filePath).size,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function findExtractedFile(rootDir, basename, ctx) {
  const matches = fileRecords(rootDir).filter((record) => path.basename(record.relativePath) === basename);
  ctx.assert(matches.length === 1, `Expected exactly one ${basename} in ${rootDir}, found ${matches.length}.`);
  return matches[0].absolutePath;
}

function chooseInstallerRecord(records) {
  const exact = records.find((record) => path.basename(record.relativePath) === "openwork-installer");
  if (exact) return exact;
  const likely = records.find((record) => path.basename(record.relativePath).toLowerCase().includes("installer"));
  return likely ?? records[0];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
