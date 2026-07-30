/**
 * User-facing proof for org-delete-danger-zone: owners can explicitly delete an
 * organization from den-web Settings > General, and platform admins can delete
 * real usr_ user accounts from the den-web admin panel.
 *
 * Local runbook:
 *   1. pnpm evals --stack-down
 *   2. OPENWORK_EVAL_DEN_WEB_URL=http://127.0.0.1:3005 OPENWORK_EVAL_WEB_CDP_ADMIN=http://127.0.0.1:9855 pnpm fraimz --flow org-delete-danger-zone --stack den
 *      (the stack exports OPENWORK_EVAL_DEN_API_URL and OPENWORK_EVAL_DEN_TOKEN)
 *   3. In another shell, run den-web against the stack API:
 *      DEN_WEB_PORT=3005 DEN_API_BASE=http://127.0.0.1:8790 DEN_AUTH_ORIGIN=http://127.0.0.1:3005 DEN_AUTH_FALLBACK_BASE=http://127.0.0.1:8790 pnpm --filter @openwork-ee/den-web dev:local
 *   4. In another shell, run Chrome for screenshots:
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9855 --user-data-dir="$(mktemp -d)" --window-size=1440,1100 about:blank
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { denWebUrl } from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "org-delete-danger-zone";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = denWebUrl();
const ADMIN_CDP_URL = (process.env.OPENWORK_EVAL_WEB_CDP_ADMIN ?? "").trim().replace(/\/+$/, "");
const MYSQL_CONTAINER = "openwork-web-local-mysql";
const MYSQL_ARGS = ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-ppassword", "openwork_den", "-N", "-e"];
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const TYPE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TYPE_ID_PREFIXES = {
  adminAllowlist: "aal",
};
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const OWNER_EMAIL = `delete-org-owner+${RUN_TAG}@acme.test`;
const OWNER_PASSWORD = `OpenWork-${RUN_TAG}!`;
const ORG_NAME = `Orbit Test Lab ${RUN_TAG}`;
const TARGET_EMAIL = `delete-me+${RUN_TAG}@acme.test`;

const state = {
  ownerSignUp: null,
  ownerToken: null,
  organization: null,
  ownerBrowserSession: null,
  deleteDialogBeforeTyping: null,
  deleteDialogTyped: null,
  deleteDialogAfterTyping: null,
  adminAllowlist: null,
  targetSignUp: null,
  targetUserId: null,
  adminBrowserSession: null,
  targetRowsAfterDelete: null,
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function createDenTypeId(name) {
  const prefix = TYPE_ID_PREFIXES[name];
  let value = BigInt(`0x${randomUUID().replace(/-/g, "")}`);
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    suffix = TYPE_ID_ALPHABET[Number(value % 32n)] + suffix;
    value /= 32n;
  }
  return `${prefix}_${suffix}`;
}

function mysqlQuery(sql) {
  return execFileSync("docker", [...MYSQL_ARGS, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
}

function mysqlCount(sql) {
  const output = mysqlQuery(sql);
  const value = Number(output.split(/\s+/).filter(Boolean)[0] ?? Number.NaN);
  return { sql, output, value };
}

function adminAuthOrigins() {
  const origins = [];
  if (DEN_WEB_URL) {
    origins.push(new URL(DEN_WEB_URL).origin);
  }
  if (DEN_API_URL) {
    const apiUrl = new URL(DEN_API_URL);
    if (apiUrl.hostname === "127.0.0.1") {
      const localhostUrl = new URL(apiUrl.toString());
      localhostUrl.hostname = "localhost";
      origins.push(localhostUrl.origin);
    }
    origins.push(apiUrl.origin);
  }
  return [...new Set(origins)];
}

function sessionCookiePair(setCookie) {
  const match = String(setCookie ?? "").match(/better-auth\.session_token=([^;,\s]+)/);
  return match ? `better-auth.session_token=${match[1]}` : "";
}

async function createBrowserSession(ctx, email, password, label) {
  let last = null;
  for (const origin of adminAuthOrigins()) {
    const response = await fetch(`${DEN_API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password }),
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    const cookie = sessionCookiePair(response.headers.get("set-cookie"));
    last = { origin, status: response.status, body, cookie: cookie ? "<present>" : null };
    if (response.ok && typeof body?.token === "string" && cookie) {
      witness(ctx, true, `${label} API sign-in minted a den-web browser session`, { origin, status: response.status, token: "<present>", cookie: "<present>" });
      return { token: body.token, cookie };
    }
  }
  witness(ctx, false, `${label} API sign-in minted a den-web browser session`, last);
  return null;
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
    } catch {}
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

async function goToDenWeb(ctx, path) {
  const url = path.startsWith("http") ? path : `${DEN_WEB_URL}${path}`;
  await ctx.eval(`location.assign(${JSON.stringify(url)})`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `den-web loaded ${path}` });
}

async function signInBrowser(ctx, email, password, label) {
  const session = await createBrowserSession(ctx, email, password, label);
  await goToDenWeb(ctx, "/");
  await ctx.eval(`(() => {
    document.cookie = 'better-auth.session_token=; Max-Age=0; Path=/';
    document.cookie = ${JSON.stringify(`${session.cookie}; Path=/; SameSite=Lax`)};
    localStorage.setItem('openwork:web:auth-token', ${JSON.stringify(session.token)});
    sessionStorage.clear();
    return true;
  })()`);
  await goToDenWeb(ctx, "/");
  await ctx.waitFor(`localStorage.getItem('openwork:web:auth-token') === ${JSON.stringify(session.token)}`, { timeoutMs: 30_000, label: `${label} den-web token persisted` });
  return session;
}

async function settle(ctx, ms = 300) {
  await ctx.eval(`new Promise((resolve) => setTimeout(resolve, ${ms}))`, { awaitPromise: true });
}

async function denFetch(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}${path}`, {
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
  } catch {}
  return { response, body, text };
}

async function denAuthFetch(path, options = {}) {
  let last = null;
  for (const origin of adminAuthOrigins()) {
    const result = await denFetch(path, {
      ...options,
      headers: {
        origin,
        ...(options.headers ?? {}),
      },
    });
    last = result;
    if (!(result.response.status === 403 && result.body?.code === "INVALID_ORIGIN")) {
      return result;
    }
  }
  return last;
}

function redactAuthResult(result) {
  const body = result.body && typeof result.body === "object" ? result.body : null;
  return {
    status: result.response.status,
    ok: result.response.ok,
    token: typeof body?.token === "string" ? "<present>" : undefined,
    user: body?.user
      ? {
          id: body.user.id,
          email: body.user.email,
          name: body.user.name,
          emailVerified: body.user.emailVerified,
        }
      : undefined,
    session: body?.session
      ? {
          id: body.session.id,
          activeOrganizationId: body.session.activeOrganizationId,
        }
      : undefined,
    body: body && !body.token ? body : undefined,
  };
}

async function signUpEmail(ctx, email, password, name) {
  const result = await denAuthFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name, password }),
  });
  witness(ctx, result.response.ok, `Sign-up succeeds for ${email}`, redactAuthResult(result));
  return result;
}

async function signInEmail(ctx, email, password, label) {
  const result = await denAuthFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  witness(ctx, result.response.ok && typeof result.body?.token === "string", `${label} sign-in returns a bearer token`, redactAuthResult(result));
  return result;
}

async function createOwnerOrganization(ctx) {
  const created = await denFetch("/v1/org", {
    method: "POST",
    headers: { authorization: `Bearer ${state.ownerToken}` },
    body: JSON.stringify({ name: ORG_NAME }),
  });
  ctx.assert(
    created.response.ok,
    `Creating the organization delete eval org failed (${created.response.status}): ${JSON.stringify(created.body)} — this flow needs DEN_ORG_MODE=multi_org.`,
  );
  state.organization = created.body?.organization ?? null;
  witness(ctx, typeof state.organization?.id === "string", "Created organization response includes an org id", { status: created.response.status, organization: state.organization });
  witness(ctx, state.organization?.name === ORG_NAME, "Created organization response includes the requested org name", state.organization);
  return created;
}

function ownerOrgId(ctx) {
  const orgId = state.organization?.id ?? null;
  witness(ctx, typeof orgId === "string", "The delete flow captured the organization id before confirmation", state.organization);
  return orgId;
}

async function setInputValue(ctx, selector, value) {
  return ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) {
      return { found: false, value: null };
    }
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!nativeInputValueSetter) {
      return { found: true, value: input.value, setter: false };
    }
    nativeInputValueSetter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { found: true, value: input.value, setter: true };
  })()`);
}

function pageTextAssertionsExpression() {
  return `(() => document.body?.innerText ?? '')()`;
}

function adminUserRowsExpression(email) {
  return `(() => {
    const email = ${JSON.stringify(email)};
    return [...document.querySelectorAll('[data-testid^="admin-user-row-"]')]
      .filter((row) => (row.innerText ?? '').includes(email))
      .map((row) => ({
        testId: row.getAttribute('data-testid'),
        text: (row.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      }));
  })()`;
}

async function adminUserRows(ctx, email) {
  return ctx.eval(adminUserRowsExpression(email));
}

function userIdForEmail(ctx, email) {
  const sql = `SELECT id FROM user WHERE email = ${sqlString(normalizeEmail(email))} LIMIT 1;`;
  const userId = mysqlQuery(sql).split(/\s+/).filter(Boolean)[0] ?? "";
  witness(ctx, userId.startsWith("usr_"), `User id exists for ${email}`, { sql, userId });
  return userId;
}

function ensureAdminAllowlist(ctx) {
  const id = createDenTypeId("adminAllowlist");
  const email = normalizeEmail(ADMIN_EMAIL);
  const sql = `INSERT IGNORE INTO admin_allowlist (id, email, note, created_at, updated_at) VALUES (${sqlString(id)}, ${sqlString(email)}, ${sqlString("org-delete-danger-zone eval admin")}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));`;
  const output = mysqlQuery(sql);
  state.adminAllowlist = { id, email, sql, output };
  witness(ctx, true, `${email} is present in admin_allowlist for the admin panel`, state.adminAllowlist);
}

async function waitForAdminPanel(ctx) {
  await ctx.waitFor(
    `(() => {
      const text = (document.body?.innerText ?? '').toLowerCase();
      return text.includes('den admin')
        && text.includes('user backoffice')
        && text.includes('users')
        && Boolean(document.querySelector('input[placeholder="Email, name, user id, provider, organization"]'));
    })()`,
    { timeoutMs: 45_000, label: "admin panel users search" },
  );
  await ctx.waitForText("Snapshot generated", { timeoutMs: 45_000 });
}

export default {
  id: FLOW_ID,
  title: "Owners can delete an organization and admins can delete real user accounts",
  kind: "user-facing",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WEB_CDP_ADMIN"],
  steps: [
    {
      name: "Frame 1 — The owner finds the danger zone at the bottom of General settings",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The owner sees the organization delete danger zone at the bottom of General settings", {
            voiceover: vo[0],
            action: async () => {
              state.ownerSignUp = await signUpEmail(ctx, OWNER_EMAIL, OWNER_PASSWORD, "Delete Org Owner");
              const signedIn = await signInEmail(ctx, OWNER_EMAIL, OWNER_PASSWORD, "Owner");
              state.ownerToken = signedIn.body.token;
              await createOwnerOrganization(ctx);
              state.ownerBrowserSession = await signInBrowser(ctx, OWNER_EMAIL, OWNER_PASSWORD, "Owner");
              await goToDenWeb(ctx, "/dashboard/org-settings");
              await ctx.waitForText("Org settings", { timeoutMs: 45_000 });
              await ctx.waitFor(`document.body.innerText.includes(${JSON.stringify(ORG_NAME)})`, { timeoutMs: 45_000, label: "org settings loaded the owner organization" });
              // The settings page scrolls inside an inner container, so
              // window.scrollTo is a no-op; bring the danger zone itself
              // into view so the frame shows what the claim describes.
              await ctx.waitFor(`(() => {
                const heading = [...document.querySelectorAll('h2')].find((el) => el.innerText.trim() === 'Danger zone');
                if (!heading) return false;
                heading.scrollIntoView({ block: 'center' });
                return true;
              })()`, { timeoutMs: 15_000, label: "danger zone scrolled into view" });
              await settle(ctx);
              await ctx.waitFor(`(() => {
                const heading = [...document.querySelectorAll('h2')].find((el) => el.innerText.trim() === 'Danger zone');
                if (!heading) return false;
                const rect = heading.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= window.innerHeight;
              })()`, { timeoutMs: 15_000, label: "danger zone visible in viewport" });
            },
            assert: async () => {
              const text = await ctx.eval(pageTextAssertionsExpression());
              witness(ctx, text.includes("Danger zone"), "General settings contains the Danger zone section", { text: text.slice(-1200) });
              witness(ctx, text.includes("Delete organization"), "General settings contains the Delete organization action", { text: text.slice(-1200) });
              witness(ctx, text.includes(ORG_NAME), "General settings names the organization being deleted", { orgName: ORG_NAME, text: text.slice(0, 1200) });
            },
            screenshot: {
              name: "org-settings-danger-zone",
              requireText: ["Danger zone", "Delete organization"],
              rejectText: ["Something went wrong"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2 — Typing the organization name arms the delete",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The delete dialog stays locked until the owner types the exact organization name", {
            voiceover: vo[1],
            action: async () => {
              const clicked = await ctx.eval(`(() => {
                const button = [...document.querySelectorAll('button')]
                  .find((entry) => entry.innerText.trim() === 'Delete organization');
                button?.click();
                return { clicked: Boolean(button), text: button?.innerText.trim() ?? null };
              })()`);
              witness(ctx, clicked.clicked, "Owner clicked the visible Delete organization button", clicked);
              await ctx.waitFor(
                `(() => {
                  const dialog = document.querySelector('[role="alertdialog"]');
                  return Boolean(dialog) && (dialog.innerText ?? '').includes(${JSON.stringify(`Delete ${ORG_NAME}?`)});
                })()`,
                { timeoutMs: 15_000, label: "delete organization alertdialog" },
              );
              state.deleteDialogBeforeTyping = await ctx.eval(`(() => {
                const dialog = document.querySelector('[role="alertdialog"]');
                const submit = dialog?.querySelector('button[type="submit"]');
                return {
                  visible: Boolean(dialog),
                  titleVisible: (dialog?.innerText ?? '').includes(${JSON.stringify(`Delete ${ORG_NAME}?`)}),
                  submitDisabled: submit?.disabled ?? null,
                  text: dialog?.innerText ?? '',
                };
              })()`);
              state.deleteDialogTyped = await setInputValue(ctx, "[role=\"alertdialog\"] input", ORG_NAME);
              await ctx.waitFor(
                `(() => {
                  const dialog = document.querySelector('[role="alertdialog"]');
                  const submit = dialog?.querySelector('button[type="submit"]');
                  return Boolean(submit) && !submit.disabled;
                })()`,
                { timeoutMs: 10_000, label: "delete organization confirm enabled" },
              );
              state.deleteDialogAfterTyping = await ctx.eval(`(() => {
                const dialog = document.querySelector('[role="alertdialog"]');
                const submit = dialog?.querySelector('button[type="submit"]');
                return { submitDisabled: submit?.disabled ?? null, text: dialog?.innerText ?? '' };
              })()`);
            },
            assert: async () => {
              witness(ctx, state.deleteDialogBeforeTyping?.visible && state.deleteDialogBeforeTyping?.titleVisible, `Dialog title is Delete ${ORG_NAME}?`, state.deleteDialogBeforeTyping);
              witness(ctx, state.deleteDialogBeforeTyping?.submitDisabled === true, "Delete organization confirm button is disabled before typing", state.deleteDialogBeforeTyping);
              witness(ctx, state.deleteDialogTyped?.found && state.deleteDialogTyped?.value === ORG_NAME, "Owner typed the exact organization name into the confirmation field", state.deleteDialogTyped);
              witness(ctx, state.deleteDialogAfterTyping?.submitDisabled === false, "Delete organization confirm button is enabled after the name matches", state.deleteDialogAfterTyping);
            },
            screenshot: {
              name: "delete-dialog-armed",
              requireText: [`Delete ${ORG_NAME}?`, "Delete organization"],
              rejectText: ["Something went wrong"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3 — Confirming permanently deletes the organization",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Confirming the dialog deletes the organization and sends the owner back to organization creation", {
            voiceover: vo[2],
            action: async () => {
              ownerOrgId(ctx);
              const clicked = await ctx.eval(`(() => {
                const dialog = document.querySelector('[role="alertdialog"]');
                const submit = dialog?.querySelector('button[type="submit"]');
                if (!submit || submit.disabled) {
                  return { clicked: false, disabled: submit?.disabled ?? null };
                }
                submit.click();
                return { clicked: true, disabled: submit.disabled };
              })()`);
              witness(ctx, clicked.clicked, "Owner clicked the enabled delete confirmation", clicked);
              await ctx.waitFor("location.pathname === '/organization'", { timeoutMs: 45_000, label: "owner routed to organization creation after delete" });
            },
            assert: async () => {
              const orgId = ownerOrgId(ctx);
              const gone = await denFetch("/v1/org", {
                headers: {
                  authorization: `Bearer ${state.ownerToken}`,
                  "x-openwork-org-id": orgId,
                },
              });
              witness(ctx, gone.response.status === 404 && gone.body?.error === "organization_not_found", "Deleted organization no longer loads from the Den API", { status: gone.response.status, body: gone.body });

              const organizationCount = mysqlCount(`SELECT COUNT(*) FROM organization WHERE id = ${sqlString(orgId)};`);
              const memberCount = mysqlCount(`SELECT COUNT(*) FROM member WHERE organization_id = ${sqlString(orgId)};`);
              const invitationCount = mysqlCount(`SELECT COUNT(*) FROM invitation WHERE organization_id = ${sqlString(orgId)};`);
              witness(ctx, organizationCount.value === 0, "Deleted organization row count is 0", organizationCount);
              witness(ctx, memberCount.value === 0, "Deleted organization member row count is 0", memberCount);
              witness(ctx, invitationCount.value === 0, "Deleted organization invitation row count is 0", invitationCount);

              const pathname = await ctx.eval("location.pathname");
              witness(ctx, pathname === "/organization", "Browser is on the organization creation page", pathname);
              await ctx.waitForText("Name your team.", { timeoutMs: 30_000 });
            },
            screenshot: {
              name: "org-gone-create-page",
              requireText: ["Name your team.", "Organization name"],
              rejectText: ["Something went wrong", ORG_NAME],
            },
          });
        });
      },
    },
    {
      name: "Frame 4 — The platform admin's Delete user button works now",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The platform admin can delete a real usr_ user from the admin panel", {
            voiceover: vo[3],
            action: async () => {
              ensureAdminAllowlist(ctx);
              state.targetSignUp = await signUpEmail(ctx, TARGET_EMAIL, OWNER_PASSWORD, "Delete Me Eval");
              state.targetUserId = userIdForEmail(ctx, TARGET_EMAIL);
              state.adminBrowserSession = await signInBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD, "Platform admin");
              await goToDenWeb(ctx, "/admin?adminClearCache=1");
              await waitForAdminPanel(ctx);

              const typed = await setInputValue(ctx, 'input[placeholder="Email, name, user id, provider, organization"]', TARGET_EMAIL);
              witness(ctx, typed.found && typed.value === TARGET_EMAIL, "Platform admin typed the target user into Users search", typed);
              await ctx.waitFor(
                `(() => ${adminUserRowsExpression(TARGET_EMAIL)}.length > 0)()`,
                { timeoutMs: 30_000, label: "target user row appears in admin search" },
              );

              const clickedRow = await ctx.eval(`(() => {
                const rows = [...document.querySelectorAll('[data-testid^="admin-user-row-"]')];
                const row = rows.find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(TARGET_EMAIL)}));
                const button = row?.querySelector('button');
                button?.click();
                return { found: Boolean(row), clicked: Boolean(button), testId: row?.getAttribute('data-testid') ?? null };
              })()`);
              witness(ctx, clickedRow.clicked, "Platform admin selected the target user row", clickedRow);
              await ctx.waitFor(
                `(() => {
                  const row = [...document.querySelectorAll('[data-testid^="admin-user-row-"]')]
                    .find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(TARGET_EMAIL)}));
                  return Boolean(row && [...row.querySelectorAll('button')].some((button) => (button.innerText ?? '').includes('Delete user')));
                })()`,
                { timeoutMs: 10_000, label: "expanded admin user row delete action" },
              );

              const clickedDelete = await ctx.eval(`(() => {
                const row = [...document.querySelectorAll('[data-testid^="admin-user-row-"]')]
                  .find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(TARGET_EMAIL)}));
                const button = row ? [...row.querySelectorAll('button')].find((entry) => (entry.innerText ?? '').includes('Delete user')) : null;
                button?.click();
                return { found: Boolean(row), clicked: Boolean(button), buttonText: button?.innerText.trim() ?? null };
              })()`);
              witness(ctx, clickedDelete.clicked, "Platform admin clicked Delete user inside the expanded row", clickedDelete);
              await ctx.waitFor(
                `(() => {
                  const dialog = document.querySelector('[role="dialog"]');
                  return Boolean(dialog) && (dialog.innerText ?? '').includes(${JSON.stringify(`Delete ${TARGET_EMAIL}?`)});
                })()`,
                { timeoutMs: 10_000, label: "delete user confirm dialog" },
              );

              const clickedConfirm = await ctx.eval(`(() => {
                const dialog = document.querySelector('[role="dialog"]');
                const button = dialog ? [...dialog.querySelectorAll('button')].find((entry) => entry.innerText.trim() === 'Delete user') : null;
                button?.click();
                return { clicked: Boolean(button), text: button?.innerText.trim() ?? null };
              })()`);
              witness(ctx, clickedConfirm.clicked, "Platform admin confirmed Delete user in the dialog", clickedConfirm);
              await ctx.waitFor(
                `(() => ${adminUserRowsExpression(TARGET_EMAIL)}.length === 0)()`,
                { timeoutMs: 30_000, label: "target admin user row removed" },
              );
              state.targetRowsAfterDelete = await adminUserRows(ctx, TARGET_EMAIL);
              const cleared = await setInputValue(ctx, 'input[placeholder="Email, name, user id, provider, organization"]', "");
              witness(ctx, cleared.found && cleared.value === "", "Platform admin search is cleared for the final screenshot", cleared);
              await settle(ctx);
            },
            assert: async () => {
              witness(ctx, Array.isArray(state.targetRowsAfterDelete) && state.targetRowsAfterDelete.length === 0, `${TARGET_EMAIL} is gone from the admin user rows after deletion`, state.targetRowsAfterDelete);
              const targetCount = mysqlCount(`SELECT COUNT(*) FROM user WHERE email = ${sqlString(normalizeEmail(TARGET_EMAIL))};`);
              witness(ctx, targetCount.value === 0, `${TARGET_EMAIL} user row count is 0`, targetCount);
            },
            screenshot: {
              name: "admin-user-deleted",
              requireText: ["Users"],
              rejectText: [TARGET_EMAIL, "Invalid user id.", "Could not delete"],
            },
          });
        });
      },
    },
  ],
};
