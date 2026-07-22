import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  applyDesktopViewport,
  clickExactText,
  navigateTo,
} from "./den-reauth-pending-action.flow.mjs";
import { denApiFetch, signInApi } from "./lib/den-web.mjs";

const FLOW_ID = "standardized-workspace-reauth";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const ORG_SCOPE_HEADER = "x-openwork-org-id";
const ORG_SETTINGS_PATH = "/dashboard/org-settings";
const API_KEYS_PATH = "/dashboard/api-keys";
const ORG_NAME_INPUT_SELECTOR = 'form input[type="text"]:not([readonly])';
const SECURITY_MESSAGE = "For security, confirm it's you before changing workspace settings.";
const SENTINEL_KEY = "__standardizedWorkspaceReauthSentinel";
const ORG_NAME_PREFIX = "Reauth Proof ";
const API_KEY_PREFIX = "reauth-proof-";
const SECONDARY_ORG_NAME = "Reauth Secondary Eval Org";

const state = {
  adminToken: null,
  org: null,
  originalOrgName: null,
  savedOrgName: null,
  apiKeyName: null,
  sentinelToken: null,
};

function mysqlContainer(ctx) {
  const container = ctx.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim();
  return container ? container : null;
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

async function removeNextDevPortal(ctx) {
  await ctx.eval("document.querySelector('nextjs-portal')?.remove(); true");
}

async function runMysql(ctx, sql) {
  const container = mysqlContainer(ctx);
  const command = container ? "docker" : "mysql";
  const args = container
    ? ["exec", container, "mysql", "-uroot", "-ppassword", "openwork_den", "-e", sql]
    : ["-h127.0.0.1", "-uroot", "-ppassword", "openwork_den", "-e", sql];
  const { stdout, stderr } = await execFileAsync(command, args);

  if (stderr.trim()) {
    ctx.log(`mysql stderr: ${stderr.trim()}`);
  }

  return stdout;
}

function orgScopedHeaders(extra = {}) {
  return { authorization: `Bearer ${state.adminToken}`, [ORG_SCOPE_HEADER]: state.org.id, ...extra };
}

async function refreshAdminToken(ctx) {
  state.adminToken = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(Boolean(state.adminToken), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
  return state.adminToken;
}

async function listOrganizations(ctx) {
  const { response, body } = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  ctx.assert(response.ok, `Listing orgs failed (${response.status}): ${JSON.stringify(body)}`);
  return Array.isArray(body?.orgs) ? body.orgs : [];
}

async function ensureSecondaryOrganization(ctx, orgs) {
  const existingSecondary = orgs.find((org) => org.name === SECONDARY_ORG_NAME) ?? null;
  if (orgs.length > 1 || existingSecondary) {
    return orgs;
  }

  const created = await denApiFetch("/v1/org", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}` },
    body: JSON.stringify({ name: SECONDARY_ORG_NAME }),
  });
  ctx.assert(
    created.response.ok,
    `Creating a secondary eval org failed (${created.response.status}): ${JSON.stringify(created.body)} — this flow needs DEN_ORG_MODE=multi_org.`,
  );

  return listOrganizations(ctx);
}

async function readOrganization(ctx) {
  const { response, body } = await denApiFetch("/v1/org", {
    headers: orgScopedHeaders(),
  });
  ctx.assert(response.ok, `Loading org failed (${response.status}): ${JSON.stringify(body)}`);
  ctx.assert(typeof body?.organization?.name === "string", "Organization response did not include a name.");
  return body.organization;
}

async function renameOrganization(ctx, name) {
  const { response, body } = await denApiFetch("/v1/org", {
    method: "PATCH",
    headers: orgScopedHeaders(),
    body: JSON.stringify({ name }),
  });
  ctx.assert(response.ok, `Renaming org failed (${response.status}): ${JSON.stringify(body)}`);
}

async function cleanupApiKeys(ctx) {
  const listed = await denApiFetch("/v1/api-keys", { headers: orgScopedHeaders() });
  if (!listed.response.ok) {
    ctx.log(`API key cleanup list skipped: ${listed.response.status} ${JSON.stringify(listed.body)}`);
    return;
  }

  const apiKeys = Array.isArray(listed.body?.apiKeys) ? listed.body.apiKeys : [];
  for (const apiKey of apiKeys) {
    if (typeof apiKey?.id !== "string" || typeof apiKey?.name !== "string" || !apiKey.name.startsWith(API_KEY_PREFIX)) {
      continue;
    }

    const deleted = await denApiFetch(`/v1/api-keys/${encodeURIComponent(apiKey.id)}`, {
      method: "DELETE",
      headers: orgScopedHeaders(),
    });
    if (!deleted.response.ok && deleted.response.status !== 404) {
      ctx.log(`API key cleanup delete failed for ${apiKey.id}: ${deleted.response.status} ${JSON.stringify(deleted.body)}`);
    }
  }
}

async function cleanup(ctx) {
  try {
    await refreshAdminToken(ctx);
    if (state.org && state.originalOrgName) {
      await cleanupApiKeys(ctx);
      const current = await readOrganization(ctx);
      if (current.name !== state.originalOrgName) {
        await renameOrganization(ctx, state.originalOrgName);
      }
    }
  } catch (error) {
    ctx.log(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function prepareSeededMultiOrg(ctx) {
  await refreshAdminToken(ctx);
  const orgs = await ensureSecondaryOrganization(ctx, await listOrganizations(ctx));
  ctx.assert(orgs.length >= 2, `Expected a multi-org account for ${ADMIN_EMAIL}; found ${orgs.length}.`);

  state.org = orgs.find((org) => org.name === "Acme Robotics")
    ?? orgs.find((org) => org.slug === "acme-robotics")
    ?? orgs.find((org) => org.name !== SECONDARY_ORG_NAME && org.slug === "default")
    ?? orgs.find((org) => org.name !== SECONDARY_ORG_NAME)
    ?? orgs[0];
  ctx.assert(Boolean(state.org?.id), "Could not choose the primary seeded organization.");

  await cleanupApiKeys(ctx);
  let organization = await readOrganization(ctx);
  if (organization.name.startsWith(ORG_NAME_PREFIX)) {
    const healedName = state.org.slug === "default" ? "OpenWork" : "Acme Robotics";
    await renameOrganization(ctx, healedName);
    organization = await readOrganization(ctx);
  }

  state.originalOrgName = organization.name;
  state.org = { ...state.org, name: organization.name };
  state.savedOrgName = `${ORG_NAME_PREFIX}${Date.now()}`;
  state.apiKeyName = `${API_KEY_PREFIX}${Date.now()}`;
}

async function clearSessionDataCookies(ctx) {
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

async function ageSessions(ctx) {
  await runMysql(ctx, "UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR);");
  await clearSessionDataCookies(ctx);
}

async function setBrowserActiveOrg(ctx) {
  const status = await ctx.eval(`fetch('/api/auth/organization/set-active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: ${JSON.stringify(JSON.stringify({ organizationId: state.org.id }))},
  }).then((response) => response.status)`, { awaitPromise: true });
  ctx.assert(status === 200, `Setting the browser active org failed with status ${status}.`);
}

async function waitForOrgSettings(ctx) {
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      if (text.includes('Organization Identity') && location.pathname === ${JSON.stringify(ORG_SETTINGS_PATH)}) return true;
      if (text.includes('Choose an organization')) {
        const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(state.org.name)}));
        button?.click();
        return false;
      }
      if (location.pathname !== ${JSON.stringify(ORG_SETTINGS_PATH)}) {
        window.location.href = ${JSON.stringify(`${process.env.OPENWORK_EVAL_DEN_WEB_URL?.replace(/\/$/, "") ?? ""}${ORG_SETTINGS_PATH}`)};
      }
      return false;
    })()`,
    { timeoutMs: 60_000, label: "org settings screen" },
  );
}

async function openOrgSettingsAsSeededAdmin(ctx) {
  await applyDesktopViewport(ctx);
  await navigateTo(ctx, "/");
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
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
  await navigateTo(ctx, "/");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"]'))", { timeoutMs: 30_000, label: "email input" });
  const passwordAlreadyVisible = await ctx.eval("Boolean(document.querySelector('input[type=\"password\"]'))");
  if (!passwordAlreadyVisible) {
    await ctx.fill('input[type="email"]', ADMIN_EMAIL);
    const advanced = await ctx.eval(`(() => {
      const form = document.querySelector('input[type="email"]')?.closest('form');
      const button = form?.querySelector('button[type="submit"]');
      button?.click();
      return Boolean(button);
    })()`);
    ctx.assert(advanced, "No Next button found on the email-first sign-in card.");
    await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 20_000, label: "password step" });
  } else {
    const switchedToSignIn = await ctx.eval(`(() => {
      const button = [...document.querySelectorAll('button[type="button"]')]
        .find((entry) => (entry.textContent ?? '').trim() === 'Sign in');
      button?.click();
      return Boolean(button);
    })()`);
    if (switchedToSignIn) {
      await ctx.waitFor(
        `(() => (document.querySelector('button[type="submit"]')?.textContent ?? '').includes('Sign in'))()`,
        { timeoutMs: 10_000, label: "sign-in mode selected" },
      );
    }
    await ctx.waitFor(
      "Boolean(document.querySelector('input[type=\"password\"]'))",
      { timeoutMs: 30_000, label: "password input" },
    );
    await ctx.fill('input[type="email"]', ADMIN_EMAIL);
  }
  await ctx.fill('input[type="password"]', ADMIN_PASSWORD);
  const submitted = await ctx.eval(`(() => {
    const button = document.querySelector('button[type="submit"]');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(submitted, "No submit button found on the sign-in card.");
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      return text.includes('Dashboard') || text.includes('Choose an organization');
    })()`,
    { timeoutMs: 45_000, label: "dashboard or org chooser after sign-in" },
  );
  await ctx.waitFor(
    `(() => {
      const text = document.body?.innerText ?? '';
      if (text.includes('Dashboard') && !text.includes('Choose an organization')) return true;
      if (text.includes('Choose an organization')) {
        const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(state.org.name)}));
        button?.click();
        return false;
      }
      return false;
    })()`,
    { timeoutMs: 60_000, label: "seeded organization selected" },
  );
  await setBrowserActiveOrg(ctx);
  await ctx.eval("window.sessionStorage.removeItem('openwork:web:pending-org-selection'); true");
  await navigateTo(ctx, ORG_SETTINGS_PATH);
  await waitForOrgSettings(ctx);
}

async function setOrgNameDraft(ctx, name) {
  const value = await ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(ORG_NAME_INPUT_SELECTOR)});
    if (!(input instanceof HTMLInputElement)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return null;
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    setter.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  ctx.assert(value === name, `Org name draft is ${value}, expected ${name}.`);
}

async function armNoReloadSentinel(ctx) {
  state.sentinelToken = `sentinel-${Date.now()}`;
  await ctx.eval(`(() => {
    window[${JSON.stringify(SENTINEL_KEY)}] = {
      token: ${JSON.stringify(state.sentinelToken)},
      route: location.pathname,
      draft: document.querySelector(${JSON.stringify(ORG_NAME_INPUT_SELECTOR)})?.value ?? null,
    };
    return true;
  })()`);
}

async function waitForReauthDialog(ctx) {
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && dialog.textContent.includes(${JSON.stringify(SECURITY_MESSAGE)}) && dialog.querySelector('input[autocomplete="current-password"]'));
  })()`, { timeoutMs: 30_000, label: "standardized reauth dialog" });
}

async function fillDialogPassword(ctx, password) {
  await ctx.fill('[role="dialog"] input[autocomplete="current-password"]', password);
}

async function clickDialogButton(ctx, label) {
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const button = [...(dialog?.querySelectorAll('button') ?? [])]
      .find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(label)} && !candidate.disabled);
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: `dialog button ${label}` });
}

async function readBrowserState(ctx) {
  return ctx.eval(`(async () => {
    const orgs = await fetch('/api/den/v1/me/orgs').then((response) => response.json()).catch(() => null);
    const input = document.querySelector(${JSON.stringify(ORG_NAME_INPUT_SELECTOR)});
    const keyInput = [...document.querySelectorAll('form input[type="text"]')].find((entry) => entry.placeholder === 'CI worker') ?? null;
    const dialog = document.querySelector('[role="dialog"]');
    const notice = document.querySelector('[data-notice-tone]');
    const sentinel = window[${JSON.stringify(SENTINEL_KEY)}] ?? null;
    return {
      path: location.pathname,
      activeOrgId: orgs?.activeOrgId ?? null,
      bodyText: document.body.innerText,
      dialogVisible: Boolean(dialog),
      dialogText: dialog?.textContent ?? '',
      draftName: input instanceof HTMLInputElement ? input.value : null,
      keyNameDraft: keyInput instanceof HTMLInputElement ? keyInput.value : null,
      noReloadSentinel: sentinel?.token ?? null,
      noReloadSentinelDraft: sentinel?.draft ?? null,
      noticeText: notice?.textContent?.trim() ?? '',
      noticeTone: notice?.getAttribute('data-notice-tone') ?? '',
      noticeRole: notice?.getAttribute('role') ?? '',
      invalidPasswordAlert: Boolean(dialog?.querySelector('[data-notice-tone="error"][role="alert"]')),
      apiKeyRetryReady: [...document.querySelectorAll('button')].some((button) => (button.textContent ?? '').trim() === 'Create API key' && !button.disabled),
      orgPickerVisible: document.body.innerText.includes('Choose an organization'),
      successVisible: document.body.innerText.includes('Workspace settings updated.'),
    };
  })()`, { awaitPromise: true });
}

async function readOrgFromBrowser(ctx) {
  return ctx.eval("fetch('/api/den/v1/org').then((response) => response.json()).catch((error) => ({ error: String(error) }))", { awaitPromise: true });
}

async function openApiKeysWithFreshSession(ctx) {
  await navigateTo(ctx, API_KEYS_PATH);
  await ctx.waitFor(
    `(() => {
      const text = document.body.innerText;
      return location.pathname === ${JSON.stringify(API_KEYS_PATH)} && text.includes('API Keys') && (text.includes('New key') || text.includes('No API keys') || text.includes('Create a new API key'));
    })()`,
    { timeoutMs: 45_000, label: "API keys screen" },
  );
}

async function prepareApiKeyCreateForm(ctx) {
  await clickExactText(ctx, "New key", "button");
  await ctx.waitFor("document.body.innerText.includes('Issue a new key')", { timeoutMs: 15_000, label: "new API key form" });
  await ctx.fill('form input[type="text"]', state.apiKeyName);
  const draft = await ctx.eval(`document.querySelector('form input[type="text"]')?.value ?? null`);
  ctx.assert(draft === state.apiKeyName, `API key draft is ${draft}, expected ${state.apiKeyName}.`);
}

async function submitApiKeyCreate(ctx) {
  await clickExactText(ctx, "Create API key", "button");
  await waitForReauthDialog(ctx);
}

export default {
  id: FLOW_ID,
  title: "Workspace re-authentication keeps multi-org settings actions on the same route and org",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_MULTI_ORG"],
  steps: [
    {
      name: "Org settings save opens the standardized security dialog",
      run: async (ctx) => {
        await ctx.prove("A stale protected settings save opens the exact standardized dialog", {
          voiceover: vo[0],
          action: async () => {
            await prepareSeededMultiOrg(ctx);
            await openOrgSettingsAsSeededAdmin(ctx);
            await setOrgNameDraft(ctx, state.savedOrgName);
            await armNoReloadSentinel(ctx);
            await ageSessions(ctx);
            await clickExactText(ctx, "Save settings", "button");
            await waitForReauthDialog(ctx);
            await removeNextDevPortal(ctx);
          },
          assert: async () => {
            const actual = await readBrowserState(ctx);
            recordAssertion(ctx, "The dialog uses the approved security sentence", actual.dialogVisible === true && actual.dialogText.includes(SECURITY_MESSAGE), actual);
            recordAssertion(ctx, "The user remains on the same org settings route and org", actual.path === ORG_SETTINGS_PATH && actual.activeOrgId === state.org.id && actual.orgPickerVisible === false, actual);
          },
          screenshot: {
            name: "standardized-dialog-org-settings",
            requireText: ["Org settings", SECURITY_MESSAGE, "Verify password"],
            rejectText: ["Choose an organization"],
          },
        });
      },
    },
    {
      name: "Password confirmation preserves route, org, draft, and no-reload sentinel",
      run: async (ctx) => {
        await ctx.prove("The settings page, selected org, draft name, and no-reload sentinel survive while confirming", {
          voiceover: vo[1],
          action: async () => {
            await fillDialogPassword(ctx, ADMIN_PASSWORD);
            await removeNextDevPortal(ctx);
          },
          assert: async () => {
            const actual = await readBrowserState(ctx);
            recordAssertion(ctx, "The route and active org are unchanged while the dialog is open", actual.path === ORG_SETTINGS_PATH && actual.activeOrgId === state.org.id, actual);
            recordAssertion(ctx, "The unsaved org-name draft and no-reload sentinel are still present", actual.draftName === state.savedOrgName && actual.noReloadSentinel === state.sentinelToken && actual.noReloadSentinelDraft === state.savedOrgName, actual);
          },
          screenshot: {
            name: "standardized-dialog-context-retained",
            requireText: [SECURITY_MESSAGE, "Verify password"],
            rejectText: ["Choose an organization"],
          },
        });
      },
    },
    {
      name: "Successful confirmation retries automatically without org picker or reload",
      run: async (ctx) => {
        await ctx.prove("After confirmation, the queued save retries automatically with no org picker and no reload", {
          voiceover: vo[2],
          action: async () => {
            await clickDialogButton(ctx, "Verify password");
            await ctx.waitFor(`(() => {
              const text = document.body.innerText;
              return !document.querySelector('[role="dialog"]') && text.includes('Workspace settings updated.') && location.pathname === ${JSON.stringify(ORG_SETTINGS_PATH)};
            })()`, { timeoutMs: 45_000, label: "settings save retried after reauth" });
            await removeNextDevPortal(ctx);
          },
          assert: async () => {
            const actual = await readBrowserState(ctx);
            recordAssertion(ctx, "The page never fell into the organization picker", actual.orgPickerVisible === false && actual.activeOrgId === state.org.id, actual);
            recordAssertion(ctx, "The no-reload sentinel survived the confirmation and retry", actual.noReloadSentinel === state.sentinelToken, actual);
          },
          screenshot: {
            name: "standardized-retry-no-picker",
            requireText: ["Org settings", "Workspace settings updated."],
            rejectText: ["Choose an organization"],
          },
        });
      },
    },
    {
      name: "The original settings change persists",
      run: async (ctx) => {
        await ctx.prove("The original workspace settings save is persisted on the selected org", {
          voiceover: vo[3],
          action: async () => {
            const selected = await ctx.eval(`(async () => {
              const input = document.querySelector(${JSON.stringify(ORG_NAME_INPUT_SELECTOR)});
              if (!(input instanceof HTMLInputElement)) {
                return { found: false, value: null, active: false, selectedText: null };
              }

              input.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
              input.focus({ preventScroll: true });
              input.select();

              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

              const selectionStart = input.selectionStart;
              const selectionEnd = input.selectionEnd;
              const selectedText = selectionStart === null || selectionEnd === null
                ? null
                : input.value.slice(selectionStart, selectionEnd);

              return {
                found: true,
                value: input.value,
                active: document.activeElement === input,
                selectedText,
              };
            })()`, { awaitPromise: true });
            recordAssertion(ctx, "The persisted org-name input is focused with its saved value selected", selected.found === true && selected.value === state.savedOrgName && selected.active === true && selected.selectedText === state.savedOrgName, selected);
            await removeNextDevPortal(ctx);
          },
          assert: async () => {
            const organization = await readOrgFromBrowser(ctx);
            const actual = await readBrowserState(ctx);
            recordAssertion(ctx, "The browser API reads the saved org name from the same selected org", organization?.organization?.name === state.savedOrgName && actual.activeOrgId === state.org.id, { organization, actual });
            recordAssertion(ctx, "The success confirmation is visible on the settings page", actual.successVisible === true && actual.path === ORG_SETTINGS_PATH, actual);
          },
          screenshot: {
            name: "standardized-save-persisted",
            requireText: ["Organization Identity", "Name", "Workspace settings updated."],
            rejectText: ["Choose an organization"],
          },
        });
      },
    },
    {
      name: "API key creation uses the same standardized dialog",
      run: async (ctx) => {
        await ctx.prove("A second protected surface opens the same shared reauth dialog", {
          voiceover: vo[4],
          action: async () => {
            await openApiKeysWithFreshSession(ctx);
            await prepareApiKeyCreateForm(ctx);
            await ageSessions(ctx);
            await submitApiKeyCreate(ctx);
            await removeNextDevPortal(ctx);
          },
          assert: async () => {
            const actual = await readBrowserState(ctx);
            recordAssertion(ctx, "API key creation shows the exact same security sentence", actual.dialogVisible === true && actual.dialogText.includes(SECURITY_MESSAGE), actual);
            recordAssertion(ctx, "The API key draft and selected org are still intact", actual.path === API_KEYS_PATH && actual.activeOrgId === state.org.id && actual.keyNameDraft === state.apiKeyName, actual);
          },
          screenshot: {
            name: "standardized-dialog-api-key",
            requireText: ["API Keys", SECURITY_MESSAGE, "Verify password"],
            rejectText: ["Choose an organization"],
          },
        });
      },
    },
    {
      name: "Invalid password and cancel keep the API key draft retryable",
      run: async (ctx) => {
        try {
          await ctx.prove("Invalid confirmation and cancellation keep the same route, org, draft, and retry affordance", {
            voiceover: vo[5],
            action: async () => {
              await fillDialogPassword(ctx, "definitely-not-the-password");
              await clickDialogButton(ctx, "Verify password");
              await ctx.waitFor(`(() => {
                const dialog = document.querySelector('[role="dialog"]');
                return Boolean(dialog?.querySelector('[data-notice-tone="error"][role="alert"]'));
              })()`, { timeoutMs: 30_000, label: "invalid password remains in dialog" });
              const invalidState = await readBrowserState(ctx);
              recordAssertion(ctx, "Invalid password stays in the dialog without losing the API key draft", invalidState.invalidPasswordAlert === true && invalidState.path === API_KEYS_PATH && invalidState.keyNameDraft === state.apiKeyName, invalidState);
              await clickDialogButton(ctx, "Cancel");
              await ctx.waitFor(`(() => {
                const notice = document.querySelector('[data-notice-tone="info"]');
                return !document.querySelector('[role="dialog"]') && Boolean(notice && notice.textContent.includes(${JSON.stringify(SECURITY_MESSAGE)}));
              })()`, { timeoutMs: 20_000, label: "calm cancel notice" });
              await removeNextDevPortal(ctx);
            },
            assert: async () => {
              const actual = await readBrowserState(ctx);
              recordAssertion(ctx, "Cancellation keeps the user on the API key route and selected org", actual.path === API_KEYS_PATH && actual.activeOrgId === state.org.id && actual.orgPickerVisible === false, actual);
              recordAssertion(ctx, "The draft remains visible and the create action can be retried", actual.keyNameDraft === state.apiKeyName && actual.apiKeyRetryReady === true, actual);
              recordAssertion(ctx, "The cancellation feedback is a calm informational notice", actual.noticeTone === "info" && actual.noticeRole === "status" && actual.noticeText.includes(SECURITY_MESSAGE), actual);
            },
            screenshot: {
              name: "standardized-cancel-retryable",
              requireText: ["API Keys", SECURITY_MESSAGE, "Create API key"],
              rejectText: ["Choose an organization"],
            },
          });
        } finally {
          await cleanup(ctx);
        }
      },
    },
  ],
};
