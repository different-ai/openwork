/**
 * User-facing regression proof: clicking an already-accepted organization invite
 * opens the workspace instead of dead-ending on the old used-invite error.
 *
 * Local runbook:
 *   1. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9856 --user-data-dir="$(mktemp -d)" --window-size=1440,1100 about:blank
 *   2. OPENWORK_EVAL_WEB_CDP_MEMBER=http://127.0.0.1:9856 pnpm fraimz --flow join-org-already-joined --stack den
 */
import { randomBytes } from "node:crypto";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denWebUrl } from "./lib/den-web.mjs";

const FLOW_ID = "join-org-already-joined";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = denWebUrl();
const ADMIN_TOKEN = (process.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
const MEMBER_CDP_URL = (process.env.OPENWORK_EVAL_WEB_CDP_MEMBER ?? "").trim().replace(/\/+$/, "");
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const TEAMMATE_EMAIL = `teammate+${RUN_TAG}@acme.test`;
const PASSWORD = "OpenWorkDemo123!";

const state = {
  invitationId: null,
  inviteToken: null,
  memberId: null,
  reinvitationId: null,
  reinviteToken: null,
  // Resolved from the admin token's active organization: in single-org
  // deployments the invite lands in the singleton org, not the seeded one.
  orgName: null,
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

async function authed(path, options = {}) {
  return denFetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(options.headers ?? {}),
    },
  });
}

async function resetBrowserSession(ctx) {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`,
    { awaitPromise: true },
  );
  await ctx.eval(`(() => {
    localStorage.removeItem('openwork:web:auth-token');
    sessionStorage.clear();
    document.cookie = 'better-auth.session_token=; Max-Age=0; Path=/';
    return true;
  })()`);
  await goToDenWeb(ctx, "/");
}

function redactInviteBody(body) {
  if (!body || typeof body !== "object") {
    return body;
  }
  return {
    ...body,
    inviteToken: typeof body.inviteToken === "string" ? "<redacted>" : body.inviteToken,
  };
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function memberEmail(member) {
  if (typeof member?.email === "string") {
    return member.email;
  }
  if (typeof member?.user?.email === "string") {
    return member.user.email;
  }
  return "";
}

function membersForEmail(org, email) {
  const normalized = normalizeEmail(email);
  return (org.members ?? []).filter((member) => normalizeEmail(memberEmail(member)) === normalized);
}

function invitationsForEmail(org, email) {
  const normalized = normalizeEmail(email);
  return (org.invitations ?? []).filter((invitation) => normalizeEmail(invitation.email) === normalized);
}

function compactMember(member) {
  return {
    id: member.id,
    userId: member.userId,
    email: memberEmail(member),
    role: member.role,
    inviteId: member.inviteId,
  };
}

function compactInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
  };
}

async function loadOrg(ctx) {
  const result = await authed("/v1/org");
  witness(ctx, result.response.ok, "Admin token can load the active organization", { status: result.response.status, body: result.body });
  witness(ctx, typeof result.body?.organization?.id === "string", "Organization id is present", result.body?.organization);
  return result.body;
}

function invitePath(ctx) {
  const token = state.inviteToken;
  ctx.assert(typeof token === "string" && token.length > 0, "Invite token is available for link reuse.");
  return `/join-org?invite=${encodeURIComponent(token)}`;
}

async function completeFirstRunProfileDialog(ctx) {
  // Invited signups start with a placeholder name, so the dashboard opens a
  // one-time User Profile dialog. Fill it like a real teammate would so the
  // workspace frames are captured clean; no-op when the dialog is absent.
  // The dialog opens after an async profile fetch; poll briefly so a late
  // arrival cannot race the screenshot in either direction.
  let dialogVisible = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    dialogVisible = await ctx.eval("document.body.innerText.includes('User Profile')");
    if (dialogVisible) break;
    await ctx.eval("new Promise((resolve) => setTimeout(resolve, 500))", { awaitPromise: true });
  }
  if (!dialogVisible) {
    return;
  }
  await ctx.eval(`(() => {
    const setNativeValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')].filter((input) => input.type === 'text' && input.checkVisibility());
    if (inputs.length < 2) return false;
    setNativeValue(inputs[0], 'Taylor');
    setNativeValue(inputs[1], 'Reed');
    const save = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Save');
    save?.click();
    return true;
  })()`);
  await ctx.waitFor("!document.body.innerText.includes('User Profile')", {
    timeoutMs: 15_000,
    label: "first-run profile dialog saved and closed",
  });
}

async function clickSubmitContaining(ctx, label) {
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button[type="submit"]')]
      .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(label)}) && !entry.disabled);
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return (button.textContent ?? '').trim();
  })()`, { timeoutMs: 20_000, label: `enabled submit button containing ${JSON.stringify(label)}` });
}

export default {
  id: FLOW_ID,
  title: "Clicking an invite you already accepted opens your workspace",
  kind: "user-facing",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WEB_CDP_MEMBER"],
  steps: [
    {
      name: "Frame 1 — Invite lands on the redesigned card",
      run: async (ctx) => {
        // Resolve the org name before ctx.prove so the screenshot
        // requireText literals below are built with the real value.
        const orgResult = await authed("/v1/org");
        let orgName = typeof orgResult.body?.organization?.name === "string" ? orgResult.body.organization.name : "";
        ctx.assert(orgName.length > 0, "Admin token resolves the active organization name.");

        // The shared eval volume bootstraps the singleton org with the
        // generic "OpenWork" name, which degenerates every copy line in the
        // demo ("Join OpenWork.", "welcome to OpenWork's OpenWork"). Rename
        // it to a real company so the frames read like the customer story;
        // keep the resolved name on any failure — the flow is name-agnostic.
        if (orgName === "OpenWork") {
          const renamed = await authed("/v1/org", { method: "PATCH", body: JSON.stringify({ name: "Acme Robotics" }) });
          if (renamed.response.ok) {
            orgName = "Acme Robotics";
          }
        }
        state.orgName = orgName;

        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("The invite link lands on a redesigned join card with organization, email, role, and account creation visible", {
            voiceover: vo[0],
            assert: async () => {
              const invite = await authed("/v1/invitations", {
                method: "POST",
                body: JSON.stringify({ email: TEAMMATE_EMAIL, role: "member" }),
              });
              const inviteToken = typeof invite.body?.inviteToken === "string" ? invite.body.inviteToken : "";
              const invitationId = typeof invite.body?.invitationId === "string" ? invite.body.invitationId : "";
              witness(ctx, invite.response.status === 201, "Admin invite API creates the teammate invitation", {
                status: invite.response.status,
                body: redactInviteBody(invite.body),
              });
              witness(ctx, inviteToken.length > 0, "Invitation response includes an invite token", {
                status: invite.response.status,
                body: redactInviteBody(invite.body),
              });
              state.inviteToken = inviteToken;
              state.invitationId = invitationId;

              ctx.output("created-invitation", JSON.stringify({
                status: invite.response.status,
                teammateEmail: TEAMMATE_EMAIL,
                invitationId,
                body: redactInviteBody(invite.body),
              }, null, 2));

              await resetBrowserSession(ctx);
              await goToDenWeb(ctx, invitePath(ctx));
              await ctx.waitForText(`Join ${state.orgName}.`, { timeoutMs: 30_000 });
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-invitation-details\"]'))", {
                timeoutMs: 30_000,
                label: "join-org invitation details",
              });
              await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", {
                timeoutMs: 30_000,
                label: "join-org password field",
              });
              const bodyText = await ctx.eval("document.body.innerText");
              witness(ctx, bodyText.includes(TEAMMATE_EMAIL), "Invite card shows the invited teammate email", { teammateEmail: TEAMMATE_EMAIL, bodyText });
              witness(ctx, bodyText.includes("Create your account."), "Invite card shows inline account creation", { bodyText });
            },
            screenshot: {
              name: "invite-card",
              requireText: [`Join ${state.orgName}.`, "Create your account.", TEAMMATE_EMAIL],
              rejectText: ["This invite has already been used."],
            },
          });
        });
      },
    },
    {
      name: "Frame 2 — The teammate joins once",
      run: async (ctx) => {
        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("The teammate sets a password and joins the workspace once", {
            voiceover: vo[1],
            assert: async () => {
              const joinLabel = `Join ${state.orgName}`;
              await ctx.fill('input[type="password"]', PASSWORD);
              await clickSubmitContaining(ctx, joinLabel);
              // Account creation signs the teammate in but stays on the invite
              // with the one-click join CTA. Click it when it appears; accept
              // the success screen or dashboard directly if the app already
              // resolved the membership.
              await ctx.waitFor(`(() => {
                const text = document.body?.innerText ?? "";
                if (text.includes("You're in, welcome to") || location.pathname.startsWith('/dashboard')) return true;
                if (!text.includes("You're one click away")) return false;
                const button = [...document.querySelectorAll('button[type="button"]')]
                  .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(`Join ${state.orgName}`)}) && !entry.disabled);
                button?.click();
                return false;
              })()`, { timeoutMs: 45_000, label: "teammate invite success screen or dashboard" });

              const org = await loadOrg(ctx);
              const members = membersForEmail(org, TEAMMATE_EMAIL);
              const joinedMember = members.find((member) => typeof member.userId === "string" && member.userId.length > 0);
              const joinedMemberId = typeof joinedMember?.id === "string" ? joinedMember.id : "";
              witness(ctx, joinedMemberId.length > 0, `${TEAMMATE_EMAIL} has joined with a userId`, members.map(compactMember));
              state.memberId = joinedMemberId;

              const invitations = invitationsForEmail(org, TEAMMATE_EMAIL);
              const acceptedInvitation = invitations.find((invitation) => invitation.status === "accepted");
              witness(ctx, Boolean(acceptedInvitation), `${TEAMMATE_EMAIL} invitation is accepted after signup`, invitations.map(compactInvitation));
            },
            screenshot: {
              name: "joined-once",
              requireText: [state.orgName],
              rejectText: ["This invite has already been used."],
            },
          });
        });
      },
    },
    {
      name: "Frame 3 — The same invite link reopens the workspace",
      run: async (ctx) => {
        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("Clicking the same accepted invite link while signed in opens the team workspace instead of the old used-invite dead end", {
            voiceover: vo[2],
            assert: async () => {
              await goToDenWeb(ctx, invitePath(ctx));
              await ctx.waitFor("location.pathname.startsWith('/dashboard')", {
                timeoutMs: 45_000,
                label: "accepted invite redirects signed-in teammate to dashboard",
              });
              await ctx.waitForText("Your workspace", { timeoutMs: 30_000 });
              await completeFirstRunProfileDialog(ctx);

              const pathname = await ctx.eval("location.pathname");
              witness(ctx, pathname.startsWith("/dashboard"), "Accepted invite link lands on the dashboard path", { pathname });
              const bodyText = await ctx.eval("document.body.innerText");
              witness(ctx, !bodyText.includes("This invite has already been used."), "Accepted invite link does not show the old used-invite dead end", { pathname, bodyText });
            },
            screenshot: {
              name: "invite-link-reopens-workspace",
              requireText: ["Your workspace"],
              rejectText: ["This invite has already been used.", "This invite can't be used.", "User Profile"],
            },
          });
        });
      },
    },
    {
      name: "Frame 4 — Fresh session shows already joined sign-in",
      run: async (ctx) => {
        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("In a fresh browser session the same invite says the teammate already joined and asks them to sign in, not an error", {
            voiceover: vo[3],
            assert: async () => {
              await resetBrowserSession(ctx);
              await goToDenWeb(ctx, invitePath(ctx));
              await ctx.waitForText(`You've already joined ${state.orgName}.`, { timeoutMs: 30_000 });
              const bodyText = await ctx.eval("document.body.innerText");
              witness(ctx, bodyText.includes(`Sign in as ${TEAMMATE_EMAIL}`), "Already-joined card tells the teammate which account to use", { teammateEmail: TEAMMATE_EMAIL, bodyText });
              witness(ctx, bodyText.includes("Sign in to open workspace"), "Already-joined card shows a sign-in button to open the workspace", { bodyText });
              witness(ctx, !bodyText.includes("This invite has already been used."), "Already-joined card is not the old used-invite error", { bodyText });
            },
            screenshot: {
              name: "already-joined-sign-in",
              requireText: [`You've already joined ${state.orgName}.`, TEAMMATE_EMAIL],
              rejectText: ["This invite has already been used."],
            },
          });
        });
      },
    },
    {
      name: "Frame 5 — Sign in lands in the workspace",
      run: async (ctx) => {
        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("Signing in from the already-joined invite card lands straight in the team workspace", {
            voiceover: vo[4],
            assert: async () => {
              await ctx.fill('input[type="password"]', PASSWORD);
              await clickSubmitContaining(ctx, "Sign in to open workspace");
              await ctx.waitFor("location.pathname.startsWith('/dashboard')", {
                timeoutMs: 45_000,
                label: "already-joined sign-in redirects to dashboard",
              });
              await ctx.waitForText("Your workspace", { timeoutMs: 30_000 });
              await completeFirstRunProfileDialog(ctx);

              const pathname = await ctx.eval("location.pathname");
              witness(ctx, pathname.startsWith("/dashboard"), "Already-joined sign-in lands on the dashboard path", { pathname });
              const bodyText = await ctx.eval("document.body.innerText");
              witness(ctx, !bodyText.includes("This invite has already been used."), "Signed-in workspace does not show the old used-invite dead end", { pathname, bodyText });
            },
            screenshot: {
              name: "signed-in-workspace",
              requireText: ["Your workspace"],
              rejectText: ["This invite has already been used.", "User Profile"],
            },
          });
        });
      },
    },
    {
      name: "Frame 6 — Removal sticks and the invite says so",
      run: async (ctx) => {
        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("Removing the teammate actually sticks — signing in again does not restore access, and the old invite says access was removed instead of pretending it was used", {
            voiceover: vo[5],
            assert: async () => {
              const orgBeforeRemoval = await loadOrg(ctx);
              const membersBeforeRemoval = membersForEmail(orgBeforeRemoval, TEAMMATE_EMAIL);
              const member = membersBeforeRemoval.find((entry) => typeof entry.userId === "string" && entry.userId.length > 0);
              const memberId = typeof member?.id === "string" ? member.id : "";
              witness(ctx, memberId.length > 0, `${TEAMMATE_EMAIL} is an active member before removal`, membersBeforeRemoval.map(compactMember));
              state.memberId = memberId;

              const remove = await authed(`/v1/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
              witness(ctx, remove.response.status === 204, "Admin removal API soft-removes the teammate membership", {
                status: remove.response.status,
                body: remove.body,
              });

              const orgAfterRemoval = await loadOrg(ctx);
              const membersAfterRemoval = membersForEmail(orgAfterRemoval, TEAMMATE_EMAIL);
              witness(ctx, membersAfterRemoval.length === 0, `${TEAMMATE_EMAIL} has no active member rows after removal`, membersAfterRemoval.map(compactMember));

              await resetBrowserSession(ctx);
              await goToDenWeb(ctx, invitePath(ctx));
              await ctx.waitForText(`You've already joined ${state.orgName}.`, { timeoutMs: 30_000 });
              await ctx.fill('input[type="password"]', PASSWORD);
              await clickSubmitContaining(ctx, "Sign in to open workspace");
              await ctx.waitForText("Your access was removed.", { timeoutMs: 45_000 });

              const bodyText = await ctx.eval("document.body.innerText");
              witness(ctx, bodyText.includes("Ask a workspace admin for a new invite."), "Removed-access card tells the teammate to ask an admin for a new invite", { bodyText });
              witness(ctx, !bodyText.includes("This invite has already been used."), "Removed-access card does not show the old used-invite error", { bodyText });

              const orgAfterSignIn = await loadOrg(ctx);
              const membersAfterSignIn = membersForEmail(orgAfterSignIn, TEAMMATE_EMAIL);
              witness(ctx, membersAfterSignIn.length === 0, `${TEAMMATE_EMAIL} is still not an active member after signing in`, membersAfterSignIn.map(compactMember));
            },
            screenshot: {
              name: "access-removed",
              requireText: ["Your access was removed.", "Ask a workspace admin for a new invite."],
              rejectText: ["This invite has already been used.", "Your workspace"],
            },
          });
        });
      },
    },
    {
      name: "Frame 7 — A fresh invite brings them back",
      run: async (ctx) => {
        await withClient(ctx, MEMBER_CDP_URL, async () => {
          await ctx.prove("A fresh invite from the admin brings the teammate back into the workspace, reviving their original membership", {
            voiceover: vo[6],
            assert: async () => {
              const reinvite = await authed("/v1/invitations", {
                method: "POST",
                body: JSON.stringify({ email: TEAMMATE_EMAIL, role: "member" }),
              });
              const reinviteToken = typeof reinvite.body?.inviteToken === "string" ? reinvite.body.inviteToken : "";
              const reinvitationId = typeof reinvite.body?.invitationId === "string" ? reinvite.body.invitationId : "";
              witness(ctx, reinvite.response.status === 201, "Admin re-invite API creates a fresh teammate invitation", {
                status: reinvite.response.status,
                body: redactInviteBody(reinvite.body),
              });
              witness(ctx, reinviteToken.length > 0, "Admin re-invite response includes an invite token", {
                status: reinvite.response.status,
                body: redactInviteBody(reinvite.body),
              });
              witness(ctx, reinviteToken !== state.inviteToken, "Admin re-invite returns a new invite token", {
                oldInviteToken: "<redacted>",
                newInviteToken: "<redacted>",
              });
              witness(ctx, reinvitationId.length > 0, "Admin re-invite response includes an invitation id", {
                status: reinvite.response.status,
                body: redactInviteBody(reinvite.body),
              });
              state.reinviteToken = reinviteToken;
              state.reinvitationId = reinvitationId;

              await goToDenWeb(ctx, `/join-org?invite=${encodeURIComponent(state.reinviteToken)}`);
              await ctx.waitForText("You're one click away", { timeoutMs: 30_000 });
              await ctx.waitFor(`(() => {
                const button = [...document.querySelectorAll('button[type="button"]')]
                  .find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(`Join ${state.orgName}`)}) && !entry.disabled);
                if (!button) return false;
                button.scrollIntoView({ block: 'center' });
                button.click();
                return true;
              })()`, { timeoutMs: 20_000, label: `enabled button containing ${JSON.stringify(`Join ${state.orgName}`)}` });
              await ctx.waitFor(`document.body.innerText.includes("You're in, welcome to") || location.pathname.startsWith('/dashboard')`, {
                timeoutMs: 45_000,
                label: "re-invited teammate success screen or dashboard",
              });

              const org = await loadOrg(ctx);
              const members = membersForEmail(org, TEAMMATE_EMAIL).filter((entry) => typeof entry.userId === "string" && entry.userId.length > 0);
              witness(ctx, members.length === 1, `${TEAMMATE_EMAIL} has exactly one active member row after rejoining`, members.map(compactMember));
              witness(ctx, members[0]?.id === state.memberId, `${TEAMMATE_EMAIL} rejoined through the original member row`, {
                expectedMemberId: state.memberId,
                members: members.map(compactMember),
              });

              const invitations = invitationsForEmail(org, TEAMMATE_EMAIL);
              const acceptedReinvite = invitations.find((invitation) => invitation.id === state.reinvitationId && invitation.status === "accepted");
              witness(ctx, Boolean(acceptedReinvite), `${TEAMMATE_EMAIL} fresh invitation is accepted after rejoining`, invitations.map(compactInvitation));
            },
            screenshot: {
              name: "rejoined-after-reinvite",
              requireText: [state.orgName],
              rejectText: ["This invite has already been used.", "Your access was removed."],
            },
          });
        });
      },
    },
  ],
};
