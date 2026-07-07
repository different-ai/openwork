import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// This flow intentionally opens and then replaces an OAuth popup. Launch Chromium
// with --disable-popup-blocking so the synthetic completion page can reuse the
// named popup exactly like the provider redirect would.
// Sign-in route: ee/apps/den-web/app/(den)/page.tsx:1-5 renders AuthScreen;
// ?mode=sign-in is consumed in den-flow-provider.tsx:1765-1769. The robust
// selectors below come from auth-panel.tsx:485-508 and :550-556.
// Members route: ee/apps/den-web/app/(den)/dashboard/(admin)/members/page.tsx:1-5;
// the copy button is manage-members-screen.tsx:731-740.
// /v1/me derives authProviders from account rows at den-api/src/routes/me/index.ts:151-156.

const FLOW_ID = "den-reauth-popup-social";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const MYSQL_CONTAINER = process.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim() ?? "";
const DEMO_EMAIL = "alex@acme.test";
const DEMO_PASSWORD = "OpenWorkDemo123!";
const GOOGLE_ACCOUNT_ID = "acc_01kwx81tc6f208pn04555rws17";

// AuthAccountTable.id is denTypeIdColumn("account", "id")
// (ee/packages/den-db/src/schema/auth.ts:41-45). denTypeIdColumn stores a
// TypeID string (ee/packages/den-db/src/columns.ts:109-123); account IDs must
// be acc_<26-char TypeID suffix> per ee/packages/utils/src/typeid.ts:6-15,110-127.
const INSERT_GOOGLE_ACCOUNT_SQL = `
INSERT INTO account (id, user_id, account_id, provider_id, created_at, updated_at)
SELECT '${GOOGLE_ACCOUNT_ID}', u.id, 'eval-google-account', 'google', NOW(3), NOW(3)
FROM \`user\` u
WHERE u.email='${DEMO_EMAIL}'
  AND NOT EXISTS (
    SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id='google'
  );
`;

const state = {
  nonce: null,
  clipboardText: null,
};

export default {
  id: FLOW_ID,
  title: "Den social reauth completes in a popup and retries the queued action",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MYSQL_CONTAINER"],
  steps: [
    {
      name: "Sign in; stage a stale session and a Google-linked account",
      run: async (ctx) => {
        await ctx.prove("Alex signs in, then the eval stages a stale Google-linked session", {
          voiceover: vo[0],
          action: async () => {
            await applyDesktopViewport(ctx);
            await signInViaDenUi(ctx);
            await runSql("UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR);");
            await runSql(INSERT_GOOGLE_ACCOUNT_SQL);
            await goToDenWeb(ctx, "/dashboard/members");
          },
          assert: async () => {
            const actual = await ctx.eval(`fetch('/api/den/v1/me', { credentials: 'include' }).then((response) => response.json())`, { awaitPromise: true });
            recordAssertion(
              ctx,
              "/api/den/v1/me reports the seeded Google auth provider for Alex",
              Array.isArray(actual?.user?.authProviders) && actual.user.authProviders.includes("google"),
              actual?.user?.authProviders ?? actual,
            );
            await ctx.expectText("Members", { timeoutMs: 30_000 });
            await ctx.expectText("Copy install link", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "den-reauth-popup-staged-members",
            requireText: ["Members", "Copy install link"],
          },
        });
      },
    },
    {
      name: "The privileged click queues the action and offers Continue with Google",
      run: async (ctx) => {
        await ctx.prove("The stale privileged action opens the reauth dialog with Google available", {
          voiceover: vo[1],
          action: async () => {
            await goToDenWeb(ctx, "/dashboard/members");
            await grantClipboardPermissions(ctx);
            await realClickSelector(ctx, '[data-testid="copy-install-link"]', "copy install link button");
            state.nonce = await ctx.waitFor(
              `(() => {
                const dialog = document.querySelector('[role="dialog"][data-reauth-nonce]');
                const nonce = dialog?.getAttribute('data-reauth-nonce') ?? '';
                return nonce || false;
              })()`,
              { timeoutMs: 30_000, label: "reauth dialog nonce" },
            );
            await ctx.waitFor(
              `(() => {
                const buttons = [...document.querySelectorAll('button')];
                return buttons.some((button) => button.textContent?.includes('Continue with Google') && button.getClientRects().length > 0);
              })()`,
              { timeoutMs: 10_000, label: "Continue with Google button" },
            );
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => {
              const dialog = document.querySelector('[role="dialog"][data-reauth-nonce]');
              const bodyText = document.body.innerText;
              return {
                dialogOpen: Boolean(dialog),
                nonce: dialog?.getAttribute('data-reauth-nonce') ?? '',
                hasTitle: bodyText.includes("Confirm it's you to continue"),
                hasGoogle: bodyText.includes('Continue with Google'),
              };
            })()`);
            recordAssertion(
              ctx,
              "The reauth dialog is open, has a nonce, and offers Continue with Google",
              actual.dialogOpen === true && actual.nonce === state.nonce && actual.hasTitle === true && actual.hasGoogle === true,
              actual,
            );
          },
          screenshot: {
            name: "den-reauth-popup-google-offered",
            requireText: ["Confirm it's you to continue", "Continue with Google"],
          },
        });
      },
    },
    {
      name: "OAuth completes in a popup; the queued action then finishes by itself",
      run: async (ctx) => {
        await ctx.prove("The popup completion message retries the queued action without reloading the opener", {
          voiceover: vo[2],
          action: async () => {
            const nonce = requireStateValue(state.nonce, "reauth nonce");
            await runSql("UPDATE session SET created_at = NOW(3);");
            await realClickExactText(ctx, "Continue with Google", "button", "Continue with Google button");
            await sleep(1000);
            const completionUrl = routeUrl(`/reauth/complete?nonce=${encodeURIComponent(nonce)}`);
            await ctx.eval(`(() => { window.open(${JSON.stringify(completionUrl)}, 'openwork-reauth'); return true; })()`);
            await ctx.waitFor(
              `!document.querySelector('[role="dialog"][data-reauth-nonce]')`,
              { timeoutMs: 30_000, label: "reauth dialog closed" },
            );
            await ctx.waitFor(
              `document.querySelector('[data-testid="copy-install-link"]')?.textContent?.includes('Copied')`,
              { timeoutMs: 30_000, label: "copy install link retried to Copied" },
            );
            state.clipboardText = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
          },
          assert: async () => {
            const actual = await ctx.eval(`(() => ({
              dialogOpen: Boolean(document.querySelector('[role="dialog"][data-reauth-nonce]')),
              buttonText: document.querySelector('[data-testid="copy-install-link"]')?.textContent?.trim() ?? '',
            }))()`);
            recordAssertion(
              ctx,
              "The reauth dialog closed and the original copy action reached the Copied state without another copy click",
              actual.dialogOpen === false && actual.buttonText.includes("Copied"),
              actual,
            );
            recordAssertion(
              ctx,
              "The clipboard contains the retried install link token",
              typeof state.clipboardText === "string" && state.clipboardText.includes("/install?token="),
              { clipboardText: state.clipboardText },
            );
          },
          screenshot: {
            name: "den-reauth-popup-copied-after-social",
            requireText: ["Copied"],
          },
        });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function routeUrl(pathname) {
  return new URL(pathname, DEN_WEB_URL).toString();
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runSql(sql) {
  return execFileAsync("docker", ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-ppassword", "openwork_den", "-e", sql], {
    maxBuffer: 2_000_000,
  });
}

async function goToDenWeb(ctx, pathname) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(routeUrl(pathname))}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function signInViaDenUi(ctx) {
  await clearDenWebSession(ctx);
  await goToDenWeb(ctx, "/?mode=sign-in");
  await ctx.waitFor(
    `Boolean(document.querySelector('input[type="email"]'))
      && Boolean(document.querySelector('input[type="password"]'))
      && [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Sign in')`,
    { timeoutMs: 30_000, label: "sign-in form" },
  );
  await ctx.fill('input[type="email"]', DEMO_EMAIL);
  await ctx.fill('input[type="password"]', DEMO_PASSWORD);
  await realClickLastExactText(ctx, "Sign in", "button", "sign in submit button");
  await ctx.waitFor("window.location.pathname.startsWith('/dashboard')", {
    timeoutMs: 45_000,
    label: "dashboard after sign-in",
  });
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .catch(() => null)
      .then(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      })`,
    { awaitPromise: true },
  );
  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch(() => {});
  }
}

async function grantClipboardPermissions(ctx) {
  if (!ctx.client?.send) {
    ctx.log("Clipboard permission grant skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Browser.grantPermissions", {
    origin: new URL(DEN_WEB_URL).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch((error) => {
    ctx.log(`Clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
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

async function realClickSelector(ctx, selector, label) {
  const point = await ctx.waitFor(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return false;
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    { timeoutMs: 20_000, label },
  );
  await dispatchRealClick(ctx, point, `${selector} click fallback`);
}

async function realClickExactText(ctx, text, selector, label) {
  const point = await textClickPoint(ctx, text, selector, label, false);
  await dispatchRealClick(ctx, point, `${text} click fallback`);
}

async function realClickLastExactText(ctx, text, selector, label) {
  const point = await textClickPoint(ctx, text, selector, label, true);
  await dispatchRealClick(ctx, point, `${text} click fallback`);
}

async function textClickPoint(ctx, text, selector, label, last) {
  return ctx.waitFor(
    `(() => {
      const matches = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((element) => (element.textContent ?? '').trim() === ${JSON.stringify(text)} && !element.disabled);
      const element = ${last ? "matches[matches.length - 1]" : "matches[0]"};
      if (!element) return false;
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    { timeoutMs: 20_000, label },
  );
}

async function dispatchRealClick(ctx, point, fallbackLabel) {
  if (!ctx.client?.send) {
    await ctx.eval(`(() => {
      const element = document.elementFromPoint(${Number(point.x)}, ${Number(point.y)});
      element?.click();
      return true;
    })()`);
    return;
  }

  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
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
  }).catch(async () => {
    await ctx.eval(`(() => {
      const element = document.elementFromPoint(${Number(point.x)}, ${Number(point.y)});
      element?.click();
      return true;
    })()`);
    ctx.log(`Fell back to DOM click for ${fallbackLabel}.`);
  });
}
