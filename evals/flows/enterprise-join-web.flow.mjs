/**
 * Enterprise new-member first run — Den Web invite join + installer handoff.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL: Den API base URL for the enterprise sandbox.
 * - OPENWORK_EVAL_DEN_WEB_URL: Den Web origin opened in the browser CDP target.
 *
 * Optional env:
 * - OPENWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for a headless Chrome page target.
 * - OPENWORK_EVAL_ENTERPRISE_ORG_NAME: organization display name (default Example Organization).
 * - OPENWORK_EVAL_ENTERPRISE_ADMIN_EMAIL: inviter/admin email (default admin@example.com).
 * - OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_EMAIL: invited member email (default new.member@example.com).
 * - OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_DISPLAY_NAME: invited member display name (default Alex).
 * - OPENWORK_EVAL_ENTERPRISE_PASSWORD: account password (default TutorialDemo123!).
 *
 * Runner note: evals/runner/run.mjs selects one CDP page per run. For this web
 * flow, point OPENWORK_EVAL_CDP_URL (or --cdp-url) at a clean headless Chrome
 * endpoint; the runner is otherwise CDP-agnostic and this flow navigates the
 * selected page to Den Web.
 */

import {
  assertEvidence,
  denApiBase,
  denWebBase,
  enterpriseOrgName,
  envText,
  signInByEmail,
} from "./enterprise-gateway-common.mjs";

const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_NEW_MEMBER_EMAIL = "new.member@example.com";
const DEFAULT_NEW_MEMBER_DISPLAY_NAME = "Alex";
const DEFAULT_PASSWORD = "TutorialDemo123!";

const state = {
  adminToken: "",
  inviteToken: "",
  inviteUrl: "",
  installerUrl: "",
  newMemberToken: "",
};

export default {
  id: "enterprise-join-web",
  title: "Enterprise new member joins in Den Web and gets the desktop installer",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "API invite new member to the organization",
      run: async (ctx) => {
        const email = newMemberEmail(ctx);
        state.adminToken = await signInByEmail(ctx, adminEmail(ctx));

        const invite = await denApiFetch(ctx, "/v1/invitations", {
          method: "POST",
          headers: { authorization: `Bearer ${state.adminToken}` },
          body: JSON.stringify({ email, role: "member" }),
        });

        if (invite.response.ok) {
          const token = typeof invite.body?.inviteToken === "string" ? invite.body.inviteToken.trim() : "";
          if (token) state.inviteToken = token;
          ctx.log(`Invitation request for ${email} returned ${invite.response.status}.`);
        } else if (invite.response.status === 400 || invite.response.status === 409) {
          ctx.log(`Invitation request for ${email} returned ${invite.response.status}; looking for an existing pending invitation in /v1/org.`);
        } else {
          failHttp(ctx, `Invitation request failed for ${email}`, invite);
        }

        if (!state.inviteToken) {
          state.inviteToken = await findPendingInviteToken(ctx, state.adminToken, email);
        }
        state.inviteUrl = new URL(`/join-org?invite=${encodeURIComponent(state.inviteToken)}`, denWebBase(ctx)).toString();

        assertEvidence(ctx, Boolean(state.inviteToken), "A pending organization invitation exposes inviteToken", {
          email,
          inviteToken: redactSecret(state.inviteToken),
        });
      },
    },
    {
      name: "Frame: join screen",
      run: async (ctx) => {
        await ctx.prove("New member opens the organization join screen from the invite", {
          action: async () => {
            await clearDenWebSession(ctx);
            await navigateAbsolute(ctx, requireState(state.inviteUrl, "invite URL"));
            await ctx.waitForText(joinTitle(ctx), { timeoutMs: 45_000 });
          },
          assert: async () => {
            await ctx.expectText(joinTitle(ctx));
            await ctx.expectText(newMemberEmail(ctx));
          },
          screenshot: {
            name: "enterprise-join-screen",
            claim: "The brand-new invitee sees the organization invite join screen before creating the account.",
            requireText: [joinTitle(ctx), newMemberEmail(ctx)],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame: joined welcome",
      run: async (ctx) => {
        await ctx.prove("New member joins the organization and lands on the welcome step", {
          action: async () => {
            await fillPasswordAndJoin(ctx, password(ctx));
          },
          assert: async () => {
            await ctx.expectText(joinedWelcomeTitle(ctx), { timeoutMs: 45_000 });
          },
          screenshot: {
            name: "enterprise-joined-welcome",
            claim: "The invite acceptance completes and welcomes the new member to the organization.",
            requireText: [joinedWelcomeTitle(ctx)],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame: installer download",
      run: async (ctx) => {
        await ctx.prove("New member can get the desktop app installer from the welcome screen", {
          action: async () => {
            const cta = await getInstallerCta(ctx);
            assertEvidence(ctx, cta.exists, "The joined welcome screen exposes a Get the desktop app CTA", cta);
            const installer = await captureInstallerTarget(ctx);
            state.installerUrl = installer.url.trim();
            assertEvidence(ctx, state.installerUrl.length > 0, "The installer/download action produced a non-empty URL", installer);
            ctx.output("installer-download-url", JSON.stringify({ url: state.installerUrl, source: installer.source }, null, 2));
            ctx.log(`Installer/download URL: ${state.installerUrl}`);
          },
          assert: async () => {
            assertEvidence(ctx, state.installerUrl.length > 0, "Installer/download URL captured for the desktop app", state.installerUrl);
          },
          screenshot: {
            name: "enterprise-installer-download",
            claim: "The desktop-app CTA yields an installer or guided-install URL for this organization.",
            requireText: ["OpenWork"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "API sanity fixes new member's display name",
      run: async (ctx) => {
        const displayName = newMemberDisplayName(ctx);
        state.newMemberToken = await signInByEmail(ctx, newMemberEmail(ctx));
        const patched = await denApiFetch(ctx, "/v1/me/profile", {
          method: "PATCH",
          headers: { authorization: `Bearer ${state.newMemberToken}` },
          body: JSON.stringify({ firstName: displayName, lastName: "" }),
        });
        assertHttpOk(ctx, "PATCH /v1/me/profile failed for the joined user", patched);

        const me = await denApiFetch(ctx, "/v1/me", {
          headers: { authorization: `Bearer ${state.newMemberToken}` },
        });
        assertHttpOk(ctx, "GET /v1/me failed for the joined user", me);
        const name = typeof me.body?.user?.name === "string" ? me.body.user.name : "";
        assertEvidence(ctx, name.includes(displayName), "GET /v1/me returns the updated display name", {
          email: me.body?.user?.email,
          name,
        });
      },
    },
  ],
};

function adminEmail(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_ADMIN_EMAIL") || DEFAULT_ADMIN_EMAIL;
}

function newMemberEmail(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_EMAIL") || DEFAULT_NEW_MEMBER_EMAIL;
}

function newMemberDisplayName(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_DISPLAY_NAME") || DEFAULT_NEW_MEMBER_DISPLAY_NAME;
}

function password(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_PASSWORD") || DEFAULT_PASSWORD;
}

function joinTitle(ctx) {
  return `Join ${enterpriseOrgName(ctx)}`;
}

function joinedWelcomeTitle(ctx) {
  return `You're in, welcome to ${enterpriseOrgName(ctx)}`;
}

async function denApiFetch(ctx, pathname, init = {}) {
  const url = `${denApiBase(ctx)}${pathname}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      Origin: denWebBase(ctx),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text, url };
}

function httpMessage(label, result) {
  return `${label}: ${result.response.status} ${result.response.statusText} ${result.text.slice(0, 1_000)} (url: ${result.url})`;
}

function assertHttpOk(ctx, label, result) {
  ctx.assert(result.response.ok, httpMessage(label, result));
}

function failHttp(ctx, label, result) {
  ctx.assert(false, httpMessage(label, result));
}

async function findPendingInviteToken(ctx, bearer, email) {
  const org = await denApiFetch(ctx, "/v1/org", {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assertHttpOk(ctx, "GET /v1/org failed while looking for the existing invitation", org);

  const invitations = Array.isArray(org.body?.invitations) ? org.body.invitations : [];
  const match = invitations.find((entry) => {
    const entryEmail = typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : "";
    const inviteToken = typeof entry?.inviteToken === "string" ? entry.inviteToken.trim() : "";
    const status = typeof entry?.status === "string" ? entry.status : "";
    return entryEmail === email.trim().toLowerCase() && inviteToken.length > 0 && status === "pending";
  });
  const inviteToken = typeof match?.inviteToken === "string" ? match.inviteToken.trim() : "";
  ctx.assert(inviteToken.length > 0, `No reusable pending invitation with inviteToken found for ${email} in GET /v1/org. Invitations: ${JSON.stringify(redactInvitations(invitations))}`);
  return inviteToken;
}

function redactInvitations(invitations) {
  return invitations.map((entry) => ({
    email: entry?.email,
    status: entry?.status,
    role: entry?.role,
    inviteToken: typeof entry?.inviteToken === "string" && entry.inviteToken ? "[redacted]" : entry?.inviteToken,
  }));
}

async function clearDenWebSession(ctx) {
  await ctx.client.send("Network.clearBrowserCookies").catch(() => undefined);
  await navigateAbsolute(ctx, denWebBase(ctx));
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Den Web root loaded" });
  await ctx.eval(`(async () => {
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch {}
    localStorage.clear();
    sessionStorage.clear();
    return true;
  })()`, { awaitPromise: true });
}

async function navigateAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

async function fillPasswordAndJoin(ctx, value) {
  const join = joinTitle(ctx);
  const welcome = joinedWelcomeTitle(ctx);
  await fillReactInput(ctx, 'input[type="password"]', value);
  await clickButtonStartingWith(ctx, join, 30_000);
  await ctx.waitFor(`(() => {
    const text = document.body.innerText || "";
    const buttons = [...document.querySelectorAll("button")].map((button) => (button.textContent ?? "").replace(/\\s+/g, " ").trim());
    const passwordVisible = Boolean(document.querySelector('input[type="password"]'));
    return text.includes(${JSON.stringify(welcome)}) || text.includes("You're one click away from the team workspace.") || (!passwordVisible && buttons.some((button) => button.startsWith(${JSON.stringify(join)})));
  })()`, { timeoutMs: 60_000, label: "join success or signed-in confirmation" });
  const clickedConfirm = await clickButtonStartingWithIfVisible(ctx, join);
  if (clickedConfirm) {
    ctx.log("Clicked the signed-in organization join confirmation button.");
  }
  await ctx.waitForText(welcome, { timeoutMs: 60_000 });
}

async function fillReactInput(ctx, selector, value) {
  const result = await ctx.waitFor(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return null;
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor?.set) return { ok: false, reason: 'native value setter missing' };
    descriptor.set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, valueLength: input.value.length };
  })()`, { timeoutMs: 30_000, label: `React-safe fill ${selector}` });
  ctx.assert(result?.ok, `Could not React-fill ${selector}: ${JSON.stringify(result)}`);
}

async function clickButtonStartingWith(ctx, prefix, timeoutMs) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => normalize(entry.textContent).startsWith(${JSON.stringify(prefix)}) && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs, label: `button starting with ${JSON.stringify(prefix)}` });
}

async function clickButtonStartingWithIfVisible(ctx, prefix) {
  return Boolean(await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => normalize(entry.textContent).startsWith(${JSON.stringify(prefix)}) && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`));
}

async function getInstallerCta(ctx) {
  return ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const element = [...document.querySelectorAll('a, button, [role="button"]')]
      .find((entry) => normalize(entry.textContent) === 'Get the desktop app');
    return {
      exists: Boolean(element),
      tagName: element?.tagName ?? '',
      text: element ? normalize(element.textContent) : '',
      href: element instanceof HTMLAnchorElement ? element.href : '',
      testId: element?.getAttribute('data-testid') ?? '',
    };
  })()`);
}

async function captureInstallerTarget(ctx) {
  const before = await ctx.eval("location.href");
  const href = await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const element = [...document.querySelectorAll('a, button, [role="button"]')]
      .find((entry) => normalize(entry.textContent) === 'Get the desktop app');
    const anchor = element instanceof HTMLAnchorElement ? element : element?.closest?.('a[href]') ?? element?.querySelector?.('a[href]') ?? null;
    if (!anchor) return '';
    return anchor.href || anchor.getAttribute('href') || '';
  })()`);
  if (typeof href === "string" && href.trim()) {
    return { url: href.trim(), source: "href", before, after: before };
  }

  await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const element = [...document.querySelectorAll('a, button, [role="button"]')]
      .find((entry) => normalize(entry.textContent) === 'Get the desktop app');
    if (!element) return false;
    window.__enterpriseDownloadCapture = { opened: '', downloadHref: '', before: ${JSON.stringify(before)} };
    if (!window.__enterpriseOriginalOpen) window.__enterpriseOriginalOpen = window.open;
    window.open = function (url, ...rest) {
      window.__enterpriseDownloadCapture.opened = String(url ?? '');
      return window.__enterpriseOriginalOpen.call(window, url, ...rest);
    };
    document.addEventListener('click', (event) => {
      const anchor = event.target?.closest?.('a[download], a[href]');
      if (anchor) window.__enterpriseDownloadCapture.downloadHref = anchor.href || anchor.getAttribute('href') || '';
    }, { capture: true });
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return true;
  })()`);

  const url = await ctx.waitFor(`(() => {
    const capture = window.__enterpriseDownloadCapture;
    if (capture?.opened) return capture.opened;
    if (capture?.downloadHref) return capture.downloadHref;
    if (location.href !== ${JSON.stringify(before)}) return location.href;
    return '';
  })()`, { timeoutMs: 30_000, label: "installer/download URL after Get the desktop app" });
  const after = await ctx.eval("location.href").catch(() => "");
  await ctx.eval(`(() => {
    if (window.__enterpriseOriginalOpen) window.open = window.__enterpriseOriginalOpen;
    return true;
  })()`).catch(() => undefined);
  return { url: String(url), source: after && after !== before ? "navigation" : "click-capture", before, after };
}

function requireState(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} was not prepared by an earlier step.`);
}

function redactSecret(value) {
  return value ? "[redacted]" : "";
}
