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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/first-connection.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("first-connection");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const INSTALLER_BIN = process.env.OPENWORK_EVAL_INSTALLER_BIN?.trim() ?? "";
const ARTIFACTS_DIR = process.env.OPENWORK_EVAL_ARTIFACTS_DIR?.trim() ?? "";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const RUN_TAG = Date.now().toString(36);
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || `riley.first.connection+${RUN_TAG}@acme.test`;
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const INSTALL_SIDECAR_FILENAME = "openwork-installer.json";
const MAC_ARTIFACT_FILENAME = "openwork-installer-mac-arm64.zip";
const BOOTSTRAP_PATH = process.env.OPENWORK_EVAL_BOOTSTRAP_PATH?.trim()
  || path.join(makeTempDir("openwork-first-connection-bootstrap-"), "desktop-bootstrap.json");

const state = {
  desktopClient: null,
  originalDesktopBootstrapConfig: null,
  adminToken: null,
  orgId: null,
  installLink: null,
  installPageUrl: null,
  installToken: null,
  installConfig: null,
  sidecarJson: null,
  sidecarConfig: null,
  installPageTargetId: null,
  installerUiTargetId: null,
  authTargetId: null,
  frame3InstallerRun: null,
  frame3Ui: null,
  frame4Ui: null,
  frame4BareRuns: null,
  expiredResolve: null,
  memberSetup: null,
  browserSignInUrl: null,
  copiedDesktopUrl: null,
  copiedDesktopGrant: null,
  usedInstallPageReload: false,
};

export default {
  id: "first-connection",
  title: "An invited teammate follows one Acme install link from dashboard copy to verified desktop connection",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_INSTALLER_BIN",
    "OPENWORK_EVAL_ARTIFACTS_DIR",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        rememberDesktopClient(ctx);
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Alex copies a workspace install link from the dashboard and the token resolves to Acme's required sign-in config", {
            voiceover: vo[0],
            // "On the OpenWork dashboard home, the admin clicks Download for this workspace"
            action: async () => {
              await ensureAdminToken(ctx);
              await ensureOrgId(ctx);
              await signInToDenWeb(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard");
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"workspace-install-card\"]'))", {
                timeoutMs: 45_000,
                label: "workspace install card",
              });
              await stubInstallLinkClipboardCapture(ctx);
              await clickSelector(ctx, '[data-testid="workspace-install-copy"]', "workspace install copy button");
              state.installLink = await ctx.waitFor(
                "typeof window.__capturedInstallLink === 'string' && window.__capturedInstallLink.includes('/install?token=') && window.__capturedInstallLink",
                { timeoutMs: 30_000, label: "captured dashboard install link" },
              );
              await ctx.waitFor(
                "document.querySelector('[data-testid=\"workspace-install-copy\"]')?.textContent?.trim() === 'Copy install link'",
                { timeoutMs: 8_000, label: "workspace copy button restored" },
              );
              state.installPageUrl = installPageUrlForBrowser(requireStateValue(state.installLink, "install link"));
              state.installToken = extractInstallToken(requireStateValue(state.installLink, "install link"), ctx);
            },
            assert: async () => {
              const installLink = requireStateValue(state.installLink, "install link");
              const parsed = new URL(installLink);
              witness(ctx, parsed.pathname === "/install" && Boolean(parsed.searchParams.get("token")), "The copied link is an /install?token= URL", installLink);

              const config = await fetchInstallConfig(ctx, requireStateValue(state.installToken, "install token"));
              witness(ctx, config.clientName === "Acme Robotics", "The install token resolves to Acme Robotics", config);
              witness(ctx, config.requireSignin === true, "The install token requires normal sign-in", config);
              state.installConfig = config;
              ctx.output("dashboard-install-link", JSON.stringify({ installLink, browserInstallPageUrl: state.installPageUrl, config }, null, 2));

              await ctx.expectText("Download for this workspace");
              await ctx.expectText("Copy install link");
            },
            screenshot: {
              name: "dashboard-workspace-install-card",
              requireText: ["Download for this workspace", "Copy install link"],
              rejectText: ["Could not copy the workspace install link"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        state.installPageTargetId = state.installPageTargetId ?? (await newPageTarget(INVITEE_CDP_URL)).id;
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("Riley opens the install link and sees Acme's three-step checklist with the same link pinned for installer fallback", {
            voiceover: vo[1],
            // "The invitee opens that link and sees a three-step checklist — download, open"
            action: async () => {
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.installPageUrl, "install page URL"));
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-page\"]'))", {
                timeoutMs: 45_000,
                label: "install page",
              });
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-guide\"]'))", {
                timeoutMs: 45_000,
                label: "install guide checklist",
              });
            },
            assert: async () => {
              await ctx.expectText("Download OpenWork for Acme Robotics");
              await ctx.expectText("Download for");
              await ctx.expectText("Open the installer");
              await ctx.expectText("Sign in");
              await ctx.expectText("Waiting for sign-in");
              const checklist = await ctx.eval(`(() => ({
                download: Boolean(document.querySelector('[data-testid="install-guide-step-download"]')),
                open: Boolean(document.querySelector('[data-testid="install-guide-step-open"]')),
                signin: Boolean(document.querySelector('[data-testid="install-guide-step-signin"]')),
                copyValue: document.querySelector('[data-testid="install-copy-link"] input')?.value ?? '',
                heading: document.querySelector('h1')?.textContent ?? '',
                waiting: document.querySelector('[data-testid="install-guide-step-signin"]')?.textContent ?? '',
              }))()`);
              witness(ctx, checklist.download && checklist.open && checklist.signin, "The install page renders all three checklist steps", checklist);
              witness(ctx, checklist.copyValue === requireStateValue(state.installPageUrl, "install page URL"), "The copy box pins the current install page URL", checklist.copyValue);
              witness(ctx, String(checklist.heading).includes("Acme Robotics"), "The install page heading names Acme Robotics", checklist.heading);
              witness(ctx, String(checklist.waiting).includes("Waiting for sign-in"), "Step three starts in the waiting-for-sign-in state", checklist.waiting);
            },
            screenshot: {
              name: "invitee-acme-install-checklist",
              requireText: ["Download OpenWork for Acme Robotics", "Open the installer", "Waiting for sign-in"],
            },
          });
        }, { targetId: state.installPageTargetId });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        state.installerUiTargetId = state.installerUiTargetId ?? (await newPageTarget(INVITEE_CDP_URL)).id;
        try {
          await withClient(ctx, INVITEE_CDP_URL, async () => {
            await ctx.prove("The stamped macOS installer download keeps the binary byte-identical, carries Acme in its sidecar, and writes Acme's bootstrap in a dry run", {
              voiceover: vo[2],
              // "They download and open the installer, and it already knows the team: \"This s"
              action: async () => {
                const witnessResult = await fetchAndVerifyStampedMacInstaller(ctx);
                state.sidecarJson = witnessResult.sidecarJson;
                state.sidecarConfig = witnessResult.sidecarConfig;
                ctx.output("stamped-mac-installer", JSON.stringify(witnessResult.output, null, 2));

                state.frame3InstallerRun = runHeadlessInstallerWithSidecar();
                state.frame3Ui = await startInstallerUi("openwork-first-connection-sidecar-ui-", {
                  sidecarJson: requireStateValue(state.sidecarJson, "installer sidecar JSON"),
                });
                await navigateToAbsolute(ctx, state.frame3Ui.url);
                await ctx.waitForText("This sets up OpenWork for Acme Robotics", { timeoutMs: 30_000 });
              },
              assert: async () => {
                const run = requireInstallerRun(state.frame3InstallerRun, "frame 3 installer run");
                witness(ctx, run.status === 0, "The real installer dry-run exited successfully", run.combined);
                witness(ctx, run.stdout.includes("OpenWork Installer — Acme Robotics"), "Installer stdout names Acme Robotics", run.stdout);
                witness(ctx, run.stdout.includes("Configured via install link"), "Installer stdout explains it was configured by an install link", run.stdout);
                witness(ctx, run.stdout.includes("Dry run ok"), "Installer stdout reports Dry run ok", run.stdout);
                const bootstrap = readBootstrapConfig(ctx, BOOTSTRAP_PATH);
                witness(ctx, cleanBaseUrl(bootstrap.parsed.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "The dry-run bootstrap baseUrl matches Acme's web URL", bootstrap.parsed);
                witness(ctx, cleanBaseUrl(bootstrap.parsed.apiBaseUrl) === cleanBaseUrl(state.installConfig.apiUrl), "The dry-run bootstrap apiBaseUrl matches Acme's API URL", bootstrap.parsed);
                witness(ctx, bootstrap.parsed.requireSignin === true, "The dry-run bootstrap requires sign-in", bootstrap.parsed);
                ctx.output("headless-installer-dry-run", run.combined);

                await ctx.expectText("This sets up OpenWork for Acme Robotics");
                await ctx.expectText("Configured via install link");
                await ctx.expectText("Install");
              },
              screenshot: {
                name: "stamped-installer-announces-acme",
                requireText: ["This sets up OpenWork for Acme Robotics", "Configured via install link", "Install"],
              },
            });
          }, { targetId: state.installerUiTargetId });
        } finally {
          await closeTarget(INVITEE_CDP_URL, state.installerUiTargetId);
          state.installerUiTargetId = null;
          state.frame3Ui?.kill();
          state.frame3Ui = null;
        }
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        state.installerUiTargetId = state.installerUiTargetId ?? (await newPageTarget(INVITEE_CDP_URL)).id;
        try {
          await withClient(ctx, INVITEE_CDP_URL, async () => {
            await ctx.prove("A bare renamed installer asks for the install link from the checklist, accepts Acme's link, and rejects an expired replacement", {
              voiceover: vo[3],
              // "And if the installer ever can't read its stamp — say the file got renamed — "
              action: async () => {
                state.frame4BareRuns = runBareInstallerFallback();
                state.frame4Ui = await startInstallerUi("openwork-first-connection-bare-ui-", { binaryName: "OpenWork-Renamed" });
                await navigateToAbsolute(ctx, state.frame4Ui.url);
                await ctx.waitForText("Paste your install link", { timeoutMs: 30_000 });
                await ctx.waitForText("It's in the copy box on your team's install page", { timeoutMs: 30_000 });
              },
              assert: async () => {
                const runs = requireBareRuns(state.frame4BareRuns);
                witness(ctx, runs.missing.status === 2, "The bare installer exits with setup-required status when no link is supplied", runs.missing.combined);
                witness(ctx, runs.missing.combined.includes("Paste an OpenWork install link"), "The bare installer asks for an OpenWork install link", runs.missing.combined);
                witness(ctx, runs.withLink.status === 0, "The bare installer dry-run succeeds when Acme's install link is supplied", runs.withLink.combined);
                witness(ctx, runs.withLink.stdout.includes("OpenWork Installer — Acme Robotics"), "The --install-link dry-run resolves to Acme Robotics", runs.withLink.stdout);
                const secondBootstrap = readBootstrapConfig(ctx, runs.secondBootstrapPath);
                witness(ctx, secondBootstrap.parsed.requireSignin === true, "The --install-link dry-run writes a required sign-in bootstrap", secondBootstrap.parsed);

                await ctx.expectText("Paste your install link");
                await ctx.expectText("It's in the copy box on your team's install page");
                await ctx.screenshot("bare-installer-paste-link-fallback", {
                  claim: "A bare renamed installer asks for the install link from the checklist before resolving Acme's setup.",
                  voiceover: vo[3],
                  requireText: ["Paste your install link", "It's in the copy box on your team's install page"],
                });
                await ctx.fill("#install-link", requireStateValue(state.installPageUrl, "install page URL"));
                await clickExactText(ctx, "Continue", "button");
                await ctx.waitForText("This sets up OpenWork for Acme Robotics", { timeoutMs: 30_000 });

                const expired = await prepareExpiredInstallLink(ctx);
                state.expiredResolve = await resolveLinkInInstallerUi(ctx, expired.expiredInstallLink);
                witness(ctx, expired.configStatus === 404, "The expired install token no longer resolves from Den", expired);
                witness(ctx, state.expiredResolve.status === 400, "The installer resolve-link API rejects the expired link", state.expiredResolve);
                witness(
                  ctx,
                  String(state.expiredResolve.body?.message ?? "").includes("This install link has expired or was replaced"),
                  "The installer explains that the install link expired or was replaced",
                  state.expiredResolve,
                );
                ctx.output("bare-installer-fallback-and-expired-link", JSON.stringify({ runs, secondBootstrap: secondBootstrap.parsed, expired, resolveLink: state.expiredResolve }, null, 2));
              },
            });
          }, { targetId: state.installerUiTargetId });
        } finally {
          await closeTarget(INVITEE_CDP_URL, state.installerUiTargetId);
          state.installerUiTargetId = null;
          state.frame4Ui?.kill();
          state.frame4Ui = null;
        }
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        useDesktopClient(ctx);
        await ctx.prove("A plain first-run desktop asks whether to use OpenWork Cloud or join an organization, and pasting Acme's link binds it to Acme's server", {
          voiceover: vo[4],
          // "Suppose someone skips all that and installs the plain OpenWork app instead: "
          action: async () => {
            await ensureDesktopReady(ctx);
            await captureOriginalDesktopBootstrap(ctx);
            await resetDesktopToDefaultBootstrap(ctx);
            await ctx.eval(`(() => {
              const raw = localStorage.getItem('openwork.preferences');
              const prefs = raw ? JSON.parse(raw) : {};
              prefs.hasCompletedOnboarding = false;
              localStorage.setItem('openwork.preferences', JSON.stringify(prefs));
              location.hash = '#/welcome';
              location.reload();
              return true;
            })()`);
            await ensureDesktopReady(ctx);
            await ctx.waitForText("Use OpenWork Cloud", { timeoutMs: 45_000 });
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"welcome-join-org\"]'))", {
              timeoutMs: 30_000,
              label: "welcome join organization fork",
            });
            await ctx.expectText("Use OpenWork Cloud");
            await ctx.expectText("Join your organization");
            await clickSelector(ctx, '[data-testid="welcome-join-org"]', "join organization fork");
            await ctx.waitForText("Join your organization", { timeoutMs: 20_000 });
            await ctx.fill("#join-organization-input", requireStateValue(state.installPageUrl, "install page URL"));
            await clickExactText(ctx, "Connect", "button");
            await ctx.waitForText(`Connected to ${new URL(state.installConfig.webUrl).host}`, { timeoutMs: 30_000 });
            await ctx.waitForText("Sign in to OpenWork", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText("Sign in to OpenWork");
            const bootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, bootstrap?.requireSignin === true, "Pasting the install link writes a required sign-in bootstrap", bootstrap);
            witness(ctx, cleanBaseUrl(bootstrap?.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "The desktop bootstrap points at Acme's web server", bootstrap);
            const serverHost = new URL(state.installConfig.webUrl).host;
            const serverText = await ctx.eval("document.body.innerText");
            witness(ctx, String(serverText).includes(serverHost), "The forced sign-in surface shows Acme's organization server", serverText);
            ctx.output("desktop-bootstrap-after-welcome-paste", JSON.stringify(bootstrap, null, 2));
            await ctx.screenshot("plain-desktop-join-org-paste-forced-signin", {
              claim: "A plain first-run desktop asks whether to use OpenWork Cloud or join an organization, and pasting Acme's link binds it to Acme's server.",
              voiceover: vo[4],
              requireText: ["Welcome to OpenWork", "Sign in to OpenWork", `Connected to ${serverHost}`],
              rejectText: ["Pick a folder"],
            });
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        useDesktopClient(ctx);
        await ctx.prove("Desktop sign-in completes through Acme's browser handoff, while a later sign-in link for another server asks before switching", {
          voiceover: vo[5],
          // "The desktop opens sign-in for Acme Robotics with the browser handling the ha"
          action: async () => {
            await ensureDesktopReady(ctx);
            await ctx.waitForText("Sign in to OpenWork", { timeoutMs: 60_000 });
            await stubDesktopExternalOpenCapture(ctx);
            await clickExactText(ctx, "Sign in to OpenWork", "button");
            state.browserSignInUrl = await ctx.waitFor(
              `(() => {
                const captured = typeof window.__capturedBrowserSigninUrl === 'string'
                  ? window.__capturedBrowserSigninUrl
                  : '';
                if (captured.includes('desktopAuth=1')) return captured;
                return Array.from(document.querySelectorAll('a[href*="desktopAuth=1"]'))
                  .map((link) => link.href)
                  .find(Boolean) || '';
              })()`,
              { timeoutMs: 20_000, label: "captured or visible desktop browser sign-in URL" },
            );

            await ensureMemberAccount(ctx);
            state.authTargetId = state.authTargetId ?? (await newPageTarget(INVITEE_CDP_URL)).id;
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.browserSignInUrl, "browser sign-in URL"));
              await signInOnCurrentDenWebPage(ctx, MEMBER_EMAIL, MEMBER_PASSWORD, { captureDesktopHandoff: true });
              state.copiedDesktopUrl = await ctx.waitFor(
                "typeof window.__capturedSignin === 'string' && window.__capturedSignin.startsWith('openwork://den-auth') && window.__capturedSignin",
                { timeoutMs: 45_000, label: "captured browser-minted OpenWork sign-in link" },
              );
              state.copiedDesktopGrant = new URL(state.copiedDesktopUrl).searchParams.get("grant") ?? "";
              witness(ctx, state.copiedDesktopGrant.length > 0, "The browser-minted OpenWork URL carries a handoff grant", redactUrlParam(state.copiedDesktopUrl, "grant"));
            }, { targetId: state.authTargetId });

            useDesktopClient(ctx);
            await deliverDeepLinkToDesktop(ctx, requireStateValue(state.copiedDesktopUrl, "browser-minted OpenWork sign-in URL"));
            await ctx.waitFor("(localStorage.getItem('openwork.den.activeOrgName') ?? '').includes('Acme Robotics')", {
              timeoutMs: 60_000,
              label: "desktop signed into Acme",
            });
            await completeDesktopSignedInJourney(ctx);

            const beforeMismatchBootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            const mismatchUrl = buildMismatchedDenAuthUrl();
            await deliverDeepLinkToDesktop(ctx, mismatchUrl);
            await ctx.waitForText("Switch organization server?", { timeoutMs: 20_000 });
            state.beforeMismatchBootstrap = beforeMismatchBootstrap;
          },
          assert: async () => {
            await ctx.expectText("Switch organization server?");
            await ctx.expectText("other-server.example");
            await ctx.expectText("Cancel");
            await ctx.expectText("Switch & sign in");
            const bootstrapWhilePrompted = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, cleanBaseUrl(bootstrapWhilePrompted?.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "The mismatched link prompts before changing the Acme bootstrap", bootstrapWhilePrompted);
            await ctx.screenshot("desktop-server-switch-confirmation", {
              claim: "A mismatched sign-in link asks before switching organization servers.",
              voiceover: vo[5],
              requireText: ["Switch organization server?", "other-server.example", "Cancel"],
            });
            await clickExactText(ctx, "Cancel", "button");
            await ctx.waitFor("!document.body.innerText.includes('Switch organization server?')", {
              timeoutMs: 10_000,
              label: "server switch dialog dismissed",
            });
            const afterMismatchBootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, cleanBaseUrl(afterMismatchBootstrap?.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "Cancel leaves the desktop bootstrap on Acme's server", afterMismatchBootstrap);
            witness(ctx, (await ctx.eval("localStorage.getItem('openwork.den.activeOrgName') ?? ''")).includes("Acme Robotics"), "Cancel leaves the active organization as Acme Robotics", await ctx.eval("localStorage.getItem('openwork.den.activeOrgName') ?? ''"));
            ctx.output("desktop-signin-and-mismatch-guard", JSON.stringify({
              browserSignInUrl: state.browserSignInUrl,
              copiedDesktopUrl: redactUrlParam(state.copiedDesktopUrl, "grant"),
              beforeMismatchBootstrap: state.beforeMismatchBootstrap,
              afterMismatchBootstrap,
            }, null, 2));
          },
          screenshot: {
            name: "desktop-stays-on-acme-after-cancel",
            requireText: ["OpenWork Cloud", "Acme Robotics", "Sign out"],
            rejectText: ["Switch organization server?", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("The browser handoff and original install page both flip to Connected for Acme Robotics", {
            voiceover: vo[6],
            // "Back on the install page, step three flips to Connected — OpenWork is set up"
            action: async () => {
              await withClient(ctx, INVITEE_CDP_URL, async () => {
                await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"desktop-connected\"]'))", {
                  timeoutMs: 60_000,
                  label: "browser handoff connected state",
                });
                await ctx.waitForText("Connected", { timeoutMs: 10_000 });
              }, { targetId: state.authTargetId });

              await waitForInstallPageConnected(ctx);
            },
            assert: async () => {
              await ctx.expectText("Connected");
              await ctx.expectText("OpenWork is set up for Acme Robotics");
              const connected = await ctx.eval("document.querySelector('[data-testid=\"install-connected\"]')?.textContent ?? ''");
              witness(ctx, String(connected).includes("Connected") && String(connected).includes("Acme Robotics"), "Step three on the install page reports Connected for Acme Robotics", connected);
              ctx.output("desktop-handoff-status", JSON.stringify({ grant: state.copiedDesktopGrant ? "[captured]" : "", installPageReloaded: state.usedInstallPageReload }, null, 2));
            },
            screenshot: {
              name: "install-page-connected-to-acme",
              requireText: ["Connected", "OpenWork is set up for Acme Robotics"],
            },
          });
        }, { targetId: state.installPageTargetId });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual.slice(0, 900) : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
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

function requireBareRuns(value) {
  if (value && typeof value === "object" && value.missing && value.withLink && typeof value.secondBootstrapPath === "string") {
    return value;
  }
  throw new Error("Bare installer runs were not prepared.");
}

async function withClient(ctx, cdpBaseUrl, fn, options = {}) {
  const previous = ctx.client;
  const target = options.targetId
    ? await targetById(cdpBaseUrl, options.targetId)
    : options.newPage
      ? await newPageTarget(cdpBaseUrl)
      : await firstPageTarget(cdpBaseUrl);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  await client.send("Page.enable").catch(() => undefined);
  await activateTarget(cdpBaseUrl, target.id);
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
  if (page) return page;
  return newPageTarget(cdpBaseUrl);
}

async function targetById(cdpBaseUrl, targetId) {
  const targets = await listTargets(cdpBaseUrl);
  const target = targets.find((entry) => entry.id === targetId && entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) {
    throw new Error(`No page target ${targetId} available at ${cdpBaseUrl}.`);
  }
  return target;
}

async function newPageTarget(cdpBaseUrl, url = "about:blank") {
  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`);
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

async function activateTarget(cdpBaseUrl, targetId) {
  if (!targetId) return;
  const base = cdpBaseUrl.replace(/\/+$/, "");
  await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

async function closeTarget(cdpBaseUrl, targetId) {
  if (!targetId) return;
  const base = cdpBaseUrl.replace(/\/+$/, "");
  await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

async function denApiFetch(pathname, options = {}) {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    ...options,
    headers: {
      accept: "application/json",
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
  if (state.adminToken) return state.adminToken;
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
  if (state.orgId) return state.orgId;
  const token = await ensureAdminToken(ctx);
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

async function mintInstallLink(ctx, { rotate = false } = {}) {
  const token = await ensureAdminToken(ctx);
  const orgId = await ensureOrgId(ctx);
  const result = await denApiFetch(`/v1/orgs/${orgId}/install-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ rotate }),
  });
  ctx.assert(result.response.ok, `Install-link mint failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  ctx.assert(typeof result.body?.installPageUrl === "string", "Install-link mint did not return installPageUrl.");
  ctx.assert(typeof result.body?.token === "string", "Install-link mint did not return token.");
  return { installPageUrl: result.body.installPageUrl, token: result.body.token };
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
  if (state.memberSetup) return state.memberSetup;

  const invitation = await createInvitation(ctx, MEMBER_EMAIL);
  const signup = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Riley First Connection", email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
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
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label: `load ${url}` });
}

async function signInToDenWeb(ctx, email, password) {
  await clearDenWebSession(ctx);
  await goToDenWeb(ctx, "/");
  await signInOnCurrentDenWebPage(ctx, email, password);
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
}

async function signInOnCurrentDenWebPage(ctx, email, password, { captureDesktopHandoff = false } = {}) {
  await ctx.waitFor(
    `document.body.innerText.includes('Sign in')
      || document.body.innerText.includes('Start using OpenWork')
      || Boolean(document.querySelector('input[type="email"], input[name="email"]'))`,
    { timeoutMs: 45_000, label: "sign-in screen" },
  );
  const hasInitialAuthInput = await ctx.eval(
    `Boolean(document.querySelector('input[type="email"], input[name="email"]'))
      || Boolean(document.querySelector('input[type="password"]'))`,
  );
  if (!hasInitialAuthInput) {
    await clickTextIfPresent(ctx, "Sign in", "button, a");
  }
  await ctx.waitFor(
    `Boolean(document.querySelector('input[type="email"], input[name="email"]'))
      || Boolean(document.querySelector('input[type="password"]'))`,
    { timeoutMs: 30_000, label: "auth input" },
  );
  const hasEmailInput = await ctx.eval("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))");
  const hasPasswordInput = await ctx.eval("Boolean(document.querySelector('input[type=\"password\"]'))");
  if (hasEmailInput) {
    await ctx.fill('input[type="email"], input[name="email"]', email);
  }
  if (hasEmailInput && !hasPasswordInput) {
    await clickLastExactText(ctx, "Next", "button");
    await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "password input" });
  }
  await ctx.fill('input[type="password"]', password);
  if (captureDesktopHandoff) {
    await stubDesktopHandoffFetchCapture(ctx);
  }
  await clickLastExactText(ctx, "Sign in", "button");
  if (captureDesktopHandoff) {
    await ctx.waitFor(
      "typeof window.__capturedSignin === 'string' && window.__capturedSignin.startsWith('openwork://den-auth')",
      { timeoutMs: 45_000, label: "desktop handoff URL captured" },
    );
  }
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `Promise.allSettled([
      fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ]).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
  await ctx.client.send("Network.clearBrowserCookies", {});
}

async function clickTextIfPresent(ctx, text, selector) {
  await ctx.eval(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return true;
  })()`);
}

async function clickExactText(ctx, text, selector) {
  return ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
}

async function clickLastExactText(ctx, text, selector) {
  return ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
}

async function clickSelector(ctx, selector, label) {
  await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element instanceof HTMLButtonElement && element.disabled) return false;
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

async function stubDesktopHandoffFetchCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedSignin = '';
    window.__capturedSigninPayload = null;
    window.__locationAssignPatchError = '';
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const requestUrl = typeof input === 'string' ? input : input?.url ?? String(input);
      if (requestUrl.includes('/v1/auth/desktop-handoff')) {
        try {
          const payload = await response.clone().json();
          window.__capturedSigninPayload = payload;
          if (typeof payload?.openworkUrl === 'string') window.__capturedSignin = payload.openworkUrl;
        } catch {}
      }
      return response;
    };
    try {
      const originalAssign = window.location.assign.bind(window.location);
      Object.defineProperty(window.location, 'assign', {
        configurable: true,
        value(url) {
          if (String(url).startsWith('openwork://')) {
            window.__capturedSignin = String(url);
            return undefined;
          }
          return originalAssign(url);
        },
      });
    } catch (error) {
      window.__locationAssignPatchError = error instanceof Error ? error.message : String(error);
    }
    return true;
  })()`);
}

async function ensureDesktopReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API" });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 60_000, label: "desktop bridge" });
}

async function invokeDesktop(ctx, command, input) {
  await ensureDesktopReady(ctx);
  return ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop(${JSON.stringify(command)}, ${JSON.stringify(input ?? null)})`, { awaitPromise: true });
}

async function captureOriginalDesktopBootstrap(ctx) {
  if (state.originalDesktopBootstrapConfig) return;
  state.originalDesktopBootstrapConfig = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
}

async function resetDesktopToDefaultBootstrap(ctx) {
  await invokeDesktop(ctx, "clearDesktopBootstrapConfig");
  await resetDesktopDenSession(ctx);
  await ctx.eval("location.reload(); true");
  await ensureDesktopReady(ctx);
  const bootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
  witness(ctx, bootstrap?.fromFile === false, "The plain desktop run starts with default bootstrap settings, not an organization file", bootstrap);
}

async function resetDesktopDenSession(ctx) {
  await ctx.eval(`(() => {
    document.querySelector('[role="alertdialog"] button')?.click();
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

async function stubDesktopExternalOpenCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedBrowserSigninUrl = '';
    window.__OPENWORK_ELECTRON__ = window.__OPENWORK_ELECTRON__ || {};
    window.__OPENWORK_ELECTRON__.shell = window.__OPENWORK_ELECTRON__.shell || {};
    window.__OPENWORK_ELECTRON__.shell.openExternal = async (url) => {
      window.__capturedBrowserSigninUrl = String(url);
      return { ok: true };
    };
    return true;
  })()`);
}

async function deliverDeepLinkToDesktop(ctx, openworkUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    const pending = window.__OPENWORK__.deepLinks || [];
    window.__OPENWORK__.deepLinks = [...pending, url];
    window.dispatchEvent(new CustomEvent('openwork:deep-link-native', { detail: [url] }));
    window.dispatchEvent(new CustomEvent('openwork:deep-link', { detail: { urls: [url] } }));
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
  await ctx.expectText("Acme Robotics", { timeoutMs: 45_000 });
  await ctx.expectText(MEMBER_EMAIL, { timeoutMs: 45_000 });
}

function extractInstallToken(installLink, ctx) {
  const parsed = new URL(installLink);
  const token = parsed.searchParams.get("token")?.trim() ?? "";
  ctx.assert(token.length > 0, `Install link did not include a token: ${installLink}`);
  return token;
}

function installPageUrlForBrowser(installLink) {
  const parsed = new URL(installLink, DEN_WEB_URL);
  const web = new URL(DEN_WEB_URL);
  if (parsed.origin === web.origin) return parsed.toString();
  return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, DEN_WEB_URL).toString();
}

async function fetchAndVerifyStampedMacInstaller(ctx) {
  const token = requireStateValue(state.installToken, "install token");
  const downloadUrl = `${DEN_API_URL}/v1/install/mac-arm64?token=${encodeURIComponent(token)}`;
  const response = await fetch(downloadUrl, { headers: { accept: "application/zip" } });
  const bytes = Buffer.from(await response.arrayBuffer());
  ctx.assert(response.ok, `Stamped macOS installer download failed: ${response.status} ${bytes.toString("utf8", 0, Math.min(bytes.length, 300))}`);

  const tempDir = makeTempDir("openwork-first-connection-download-");
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
  witness(ctx, sidecarConfig.clientName === "Acme Robotics", "The stamped sidecar names Acme Robotics", sidecarConfig);
  witness(ctx, sidecarConfig.requireSignin === true, "The stamped sidecar requires sign-in", sidecarConfig);

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
      contentType: response.headers.get("content-type"),
      contentDisposition: response.headers.get("content-disposition"),
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

async function startInstallerUi(tempPrefix, { sidecarJson = null, binaryName = "openwork-installer" } = {}) {
  const tempDir = makeTempDir(tempPrefix);
  const installerPath = copyInstallerTo(tempDir, binaryName);
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
  const tempDir = makeTempDir("openwork-first-connection-sidecar-");
  const installerPath = copyInstallerTo(tempDir);
  writeFileSync(path.join(tempDir, INSTALL_SIDECAR_FILENAME), sidecarJson, "utf8");
  rmSync(BOOTSTRAP_PATH, { force: true });
  return runInstaller(installerPath, ["--headless", "--dry-run"], sanitizedInstallerEnv({ OPENWORK_DESKTOP_BOOTSTRAP_PATH: BOOTSTRAP_PATH }), tempDir);
}

function runBareInstallerFallback() {
  const installLink = requireStateValue(state.installPageUrl, "install page URL");
  const tempDir = makeTempDir("openwork-first-connection-bare-");
  const installerPath = copyInstallerTo(tempDir, "OpenWork-Renamed");
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

function copyInstallerTo(directory, binaryName = "openwork-installer") {
  const installerPath = path.join(directory, binaryName);
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

async function prepareExpiredInstallLink(ctx) {
  const expired = await mintInstallLink(ctx, { rotate: false });
  revokeInstallLinkToken(ctx, expired.token);
  const config = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(expired.token)}`, { method: "GET" });
  return {
    expiredInstallLink: installPageUrlForBrowser(expired.installPageUrl),
    configStatus: config.response.status,
    configBody: config.body,
  };
}

function revokeInstallLinkToken(ctx, token) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const sql = "UPDATE install_link SET revoked_at = CURRENT_TIMESTAMP(3) WHERE token_hash = "
    + JSON.stringify(tokenHash);
  const commands = [
    ["mysql", ["-uroot", "-ppassword", "openwork_den", "-e", sql]],
    ["docker", ["exec", "openwork-web-local-mysql", "mysql", "-uroot", "-ppassword", "openwork_den", "-e", sql]],
  ];
  const attempts = commands.map(([command, args]) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    return { command: `${command} ${args.join(" ")}`, status: result.status, stderr: result.stderr ?? "", error: result.error?.message ?? "" };
  });
  if (attempts.some((attempt) => attempt.status === 0)) {
    return;
  }
  ctx.assert(false, `Could not revoke throwaway install link for expired-link coverage: ${JSON.stringify(attempts).slice(0, 900)}`);
}

async function resolveLinkInInstallerUi(ctx, installLink) {
  return ctx.eval(`fetch('/api/resolve-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-installer-token': TOKEN },
    body: JSON.stringify({ installLink: ${JSON.stringify(installLink)} }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))`, { awaitPromise: true });
}

function buildMismatchedDenAuthUrl() {
  const url = new URL("openwork://den-auth");
  url.searchParams.set("grant", `bogus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  url.searchParams.set("denBaseUrl", "https://other-server.example/api/den");
  return url.toString();
}

async function waitForInstallPageConnected(ctx) {
  try {
    await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-connected\"]'))", {
      timeoutMs: 30_000,
      label: "install page live connected state",
    });
    return;
  } catch (error) {
    state.usedInstallPageReload = true;
    ctx.output("install-page-connected-reload", `Live storage/polling did not flip before timeout (${error instanceof Error ? error.message : String(error)}). Reloading the still-open install tab to re-read the handoff grant from localStorage.`);
    await ctx.eval("location.reload(); true");
    await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-connected\"]'))", {
      timeoutMs: 45_000,
      label: "install page connected state after reload",
    });
  }
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

function redactUrlParam(rawUrl, param) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has(param)) {
      url.searchParams.set(param, "[redacted]");
    }
    return url.toString();
  } catch {
    return "invalid URL";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
