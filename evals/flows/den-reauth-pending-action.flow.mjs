import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-reauth-pending-action";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "OpenWorkDemo123!";
const SIGN_IN_ROUTE = "/";
const MEMBERS_ROUTE = "/dashboard/members";
const COPY_INSTALL_LINK_SELECTOR = '[data-testid="copy-install-link"]';
const RAW_REAUTH_MESSAGE = "For security, confirm it's you before changing workspace settings.";

const state = {
  clipboardText: "",
};

function routeUrl(ctx, path) {
  return new URL(path, ctx.env.OPENWORK_EVAL_DEN_WEB_URL).toString();
}

function mysqlContainer(ctx) {
  return ctx.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER || "openwork-web-local-mysql";
}

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function runMysql(ctx, sql) {
  const { stdout, stderr } = await execFileAsync("docker", [
    "exec",
    mysqlContainer(ctx),
    "mysql",
    "-uroot",
    "-ppassword",
    "openwork_den",
    "-e",
    sql,
  ]);

  if (stderr.trim()) {
    ctx.log(`mysql stderr: ${stderr.trim()}`);
  }

  return stdout;
}

async function applyDesktopViewport(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Desktop viewport skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch((error) => {
    ctx.log(`Desktop viewport skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function grantClipboardPermissions(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Clipboard permission grant skipped: no raw CDP send method on context.");
    return;
  }

  const origin = new URL(ctx.env.OPENWORK_EVAL_DEN_WEB_URL).origin;
  await ctx.client.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch((error) => {
    ctx.log(`Clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function denyClipboardPermissions(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Clipboard permission denial skipped: no raw CDP send method on context.");
    return;
  }

  const origin = new URL(ctx.env.OPENWORK_EVAL_DEN_WEB_URL).origin;
  const permissions = [
    { name: "clipboard-write", allowWithoutSanitization: false },
    { name: "clipboard-read" },
  ];

  for (const permission of permissions) {
    await ctx.client.send("Browser.setPermission", {
      origin,
      permission,
      setting: "denied",
    }).catch((error) => {
      ctx.log(`Clipboard permission denial skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function navigateTo(ctx, path) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(routeUrl(ctx, path))}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${path}` });
}

async function clearDenWebSession(ctx) {
  await navigateTo(ctx, SIGN_IN_ROUTE);
  await ctx.eval(
    `fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );

  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch((error) => {
      ctx.log(`Cookie clear skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function clickExactText(ctx, text, selector) {
  await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center', behavior: 'instant' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
}

async function clickLastExactText(ctx, text, selector) {
  await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center', behavior: 'instant' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
}

async function clickSelectorWithMouse(ctx, selector, label) {
  const point = await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);

  ctx.assert(point !== null, `${label} was not found.`);

  if (!ctx.client?.send) {
    await ctx.eval(`(() => {
      document.querySelector(${JSON.stringify(selector)})?.click();
      return true;
    })()`);
    return;
  }

  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function signInToDenWeb(ctx) {
  await clearDenWebSession(ctx);
  await navigateTo(ctx, SIGN_IN_ROUTE);
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "sign-in screen" });
  await clickExactText(ctx, "Sign in", "button, a");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[autocomplete=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });
  await ctx.fill('input[type="email"], input[autocomplete="email"]', DEMO_EMAIL);
  await ctx.fill('input[type="password"], input[autocomplete="current-password"]', DEMO_PASSWORD);
  await clickLastExactText(ctx, "Sign in", "button");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
}

async function stageStaleSessionAndInstallLinks(ctx) {
  // The demo seed does not enable install links by default. Org capabilities are
  // stored in organization.metadata.capabilities.<key>; turn on installLinks so
  // the Members toolbar renders the same copy button a platform admin would enable.
  // The eval database is ephemeral and can hold several orgs (seeded Acme
  // Robotics plus a default bootstrap org); enable the capability everywhere
  // so the flow does not depend on which org is active after sign-in.
  await runMysql(ctx, `
    UPDATE organization
    SET metadata = JSON_SET(
      COALESCE(metadata, JSON_OBJECT()),
      '$.capabilities.installLinks',
      JSON_EXTRACT('true', '$')
    );

    UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR);
  `);

  if (!ctx.client?.send) {
    return;
  }

  const cookieResult = await ctx.client.send("Network.getAllCookies", {});
  const cachedSessionCookies = cookieResult.cookies.filter((cookie) => cookie.name.includes("session_data"));
  for (const cookie of cachedSessionCookies) {
    await ctx.client.send("Network.deleteCookies", {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
    });
  }
}

export {
  applyDesktopViewport,
  clickExactText,
  clickSelectorWithMouse,
  grantClipboardPermissions,
  navigateTo,
  signInToDenWeb,
  stageStaleSessionAndInstallLinks,
};

export default {
  id: FLOW_ID,
  title: "Den reauth keeps the pending install-link action alive",
  kind: "user-facing",
  spec: "evals/README.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MYSQL_CONTAINER"],
  steps: [
    {
      name: "Signing in and staging a stale session",
      run: async (ctx) => {
        await ctx.prove("Alex is signed in with a stale privileged session", {
          voiceover: vo[0],
          action: async () => {
            await applyDesktopViewport(ctx);
            await signInToDenWeb(ctx);
            await stageStaleSessionAndInstallLinks(ctx);
            await navigateTo(ctx, "/dashboard");
            // The dev stack can hold several orgs (the seeded Acme Robotics plus
            // a default bootstrap org), so assert on stable dashboard chrome
            // instead of a specific org name.
            await ctx.waitFor(`document.body.innerText.includes("Dashboard") && document.body.innerText.includes("Members")`, {
              timeoutMs: 45_000,
              label: "signed-in dashboard",
            });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              path: location.pathname,
              hasMembersNav: document.body.innerText.includes("Members"),
              hasDashboard: location.pathname.startsWith('/dashboard'),
            }))()`);
            recordAssertion(
              ctx,
              "The signed-in dashboard is visible",
              actual.hasDashboard === true && actual.hasMembersNav === true,
              actual,
            );
          },
          screenshot: {
            name: "reauth-stale-session-dashboard",
            requireText: ["Dashboard", "Members"],
          },
        });
      },
    },
    {
      name: "A privileged click opens the security check instead of a dead banner",
      run: async (ctx) => {
        await ctx.prove("A stale privileged click opens the security check instead of a dead banner", {
          voiceover: vo[1],
          action: async () => {
            await navigateTo(ctx, MEMBERS_ROUTE);
            await grantClipboardPermissions(ctx);
            await ctx.waitFor(`(() => {
              const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
              return Boolean(button && !button.disabled && button.textContent.includes('Copy install link'));
            })()`, { timeoutMs: 45_000, label: "copy install link button" });
            await clickSelectorWithMouse(ctx, COPY_INSTALL_LINK_SELECTOR, "copy install link button");
            await ctx.waitFor(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              return Boolean(dialog && dialog.textContent.includes(${JSON.stringify(RAW_REAUTH_MESSAGE)}));
            })()`, { timeoutMs: 30_000, label: "reauth dialog" });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const outsideText = [...document.body.querySelectorAll('body *')]
                .filter((element) => !element.closest('[role="dialog"]'))
                .map((element) => element.textContent ?? '')
                .join(' ');
              return {
                dialogVisible: Boolean(dialog),
                dialogText: dialog ? dialog.textContent : '',
                rawMessageOutsideDialog: outsideText.includes(${JSON.stringify(RAW_REAUTH_MESSAGE)}),
              };
            })()`);
            recordAssertion(
              ctx,
              "The reauth dialog appears for the stale privileged action",
              actual.dialogVisible === true && actual.dialogText.includes(RAW_REAUTH_MESSAGE),
              actual,
            );
            recordAssertion(
              ctx,
              "The raw server reauth message is not rendered as a page banner outside the dialog",
              actual.rawMessageOutsideDialog === false,
              actual,
            );
          },
          screenshot: {
            name: "reauth-security-check-dialog",
            requireText: [RAW_REAUTH_MESSAGE],
          },
        });
      },
    },
    {
      name: "Verify password and the queued action completes on its own",
      run: async (ctx) => {
        await ctx.prove("After password verification, the queued copy action completes automatically", {
          voiceover: vo[2],
          action: async () => {
            await ctx.fill('input[autocomplete="current-password"]', DEMO_PASSWORD);
            await clickExactText(ctx, "Verify password", "button");
            await ctx.waitFor(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
              return !dialog && Boolean(button && button.textContent.includes('Copied'));
            })()`, { timeoutMs: 45_000, label: "copied after automatic retry" });
            state.clipboardText = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
              return {
                dialogVisible: Boolean(document.querySelector('[role="dialog"]')),
                buttonText: button ? button.textContent.trim() : '',
                clipboardText: ${JSON.stringify(state.clipboardText)},
              };
            })()`);
            ctx.recordEvidence({
              type: "output",
              name: "Copied install link",
              text: state.clipboardText,
            });
            recordAssertion(
              ctx,
              "The dialog closes and the original copy button enters the Copied state without another click",
              actual.dialogVisible === false && actual.buttonText.includes("Copied"),
              actual,
            );
            recordAssertion(
              ctx,
              "The clipboard contains an install-link token URL",
              typeof state.clipboardText === "string" && state.clipboardText.includes("/install?token="),
              actual,
            );
          },
          screenshot: {
            name: "reauth-copied-after-retry",
            requireText: ["Copied"],
          },
        });
      },
    },
    {
      name: "Even when the browser blocks copying, the link is still usable",
      run: async (ctx) => {
        try {
          await ctx.prove("Even when the browser blocks copying, the link is still usable", {
            voiceover: vo[3],
            action: async () => {
              await ctx.waitFor(`(() => {
                const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
                return Boolean(button && !button.disabled && button.textContent.includes('Copy install link'));
              })()`, { timeoutMs: 10_000, label: "copy install link button reset" });
              await denyClipboardPermissions(ctx);
              await clickSelectorWithMouse(ctx, COPY_INSTALL_LINK_SELECTOR, "copy install link button");
              await ctx.waitFor(`(() => {
                const input = document.querySelector('[data-testid="install-link-share-url"]');
                return input instanceof HTMLInputElement && input.value.includes('/install?token=');
              })()`, { timeoutMs: 45_000, label: "manual install link share row" });
            },
            assert: async () => {
              const actual = await ctx.eval(`(() => {
                const input = document.querySelector('[data-testid="install-link-share-url"]');
                const shareUrl = input instanceof HTMLInputElement ? input.value : '';
                const bodyText = document.body.innerText.toLowerCase();
                const pageErrorTexts = [...document.querySelectorAll('div')]
                  .filter((element) => element.className.includes('mb-6') && element.className.includes('border-red-200') && element.className.includes('bg-red-50'))
                  .map((element) => (element.textContent ?? '').trim())
                  .filter((text) => text.length > 0);
                return {
                  shareRowVisible: input instanceof HTMLInputElement,
                  shareUrl,
                  rawClipboardMessageVisible: bodyText.includes('not allowed by the user agent'),
                  pageErrorTexts,
                  pageErrorHasClipboardFailure: pageErrorTexts.some((text) => {
                    const normalized = text.toLowerCase();
                    return normalized.includes('not allowed by the user agent') ||
                      normalized.includes('notallowederror') ||
                      normalized.includes('could not copy install link');
                  }),
                };
              })()`);
              recordAssertion(
                ctx,
                "The inline manual copy row appears with an install-link token URL",
                actual.shareRowVisible === true && /\/install[?]token=/.test(actual.shareUrl),
                actual,
              );
              recordAssertion(
                ctx,
                "The raw browser clipboard error is not rendered anywhere on the page",
                actual.rawClipboardMessageVisible === false,
                actual,
              );
              recordAssertion(
                ctx,
                "The page error banner stays empty after clipboard denial",
                actual.pageErrorTexts.length === 0 && actual.pageErrorHasClipboardFailure === false,
                actual,
              );
            },
            screenshot: {
              name: "reauth-copy-blocked-manual-install-link",
              requireText: ["Copy blocked by the browser — copy the link manually:"],
            },
          });
        } finally {
          await grantClipboardPermissions(ctx);
        }
      },
    },
  ],
};
