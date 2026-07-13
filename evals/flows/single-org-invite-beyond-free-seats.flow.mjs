/**
 * User-facing regression proof: self-hosted single-org deployments can keep
 * inviting members after the hosted free-seat count because seat billing gates
 * only apply to configured multi-org Stripe deployments.
 *
 * Local runbook:
 *   1. pnpm evals --stack-down
 *   2. OPENWORK_EVAL_DEN_WEB_URL=http://127.0.0.1:3005 OPENWORK_EVAL_WEB_CDP_ADMIN=http://127.0.0.1:9855 pnpm fraimz --flow single-org-invite-beyond-free-seats --stack den
 *      (the stack exports OPENWORK_EVAL_DEN_API_URL and OPENWORK_EVAL_DEN_TOKEN)
 *   3. In another shell, run den-web against the stack API:
 *      DEN_WEB_PORT=3005 DEN_API_BASE=http://127.0.0.1:8790 DEN_AUTH_ORIGIN=http://127.0.0.1:3005 DEN_AUTH_FALLBACK_BASE=http://127.0.0.1:8790 pnpm --filter @openwork-ee/den-web dev:local
 *   4. In another shell, run Chrome for screenshots:
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9855 --user-data-dir="$(mktemp -d)" --window-size=1440,1100 about:blank
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denWebUrl } from "./lib/den-web.mjs";

const FLOW_ID = "single-org-invite-beyond-free-seats";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = denWebUrl();
const ADMIN_CDP_URL = (process.env.OPENWORK_EVAL_WEB_CDP_ADMIN ?? "").trim().replace(/\/+$/, "");
const MYSQL_CONTAINER = "openwork-web-local-mysql";
const MYSQL_ARGS = ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-ppassword", "openwork_den", "-N", "-e"];
const ADMIN_TOKEN = (process.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const NEW_HIRE_EMAIL = `newhire+${RUN_TAG}@acme.test`;
const SECOND_HIRE_EMAIL = `secondhire+${RUN_TAG}@acme.test`;

const state = {
  adminBrowserSignedIn: false,
  newHireInvitation: null,
  secondHireInvitation: null,
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

function mysqlQuery(sql) {
  return execFileSync("docker", [...MYSQL_ARGS, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
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

async function createAdminBrowserSession(ctx) {
  let last = null;
  for (const origin of adminAuthOrigins()) {
    const response = await fetch(`${DEN_API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    const cookie = sessionCookiePair(response.headers.get("set-cookie"));
    last = { origin, status: response.status, body, cookie: cookie ? "<present>" : null };
    if (response.ok && typeof body?.token === "string" && cookie) {
      witness(ctx, true, "Admin API sign-in minted a den-web browser session", { origin, status: response.status, token: "<present>", cookie: "<present>" });
      return { token: body.token, cookie };
    }
  }
  witness(ctx, false, "Admin API sign-in minted a den-web browser session", last);
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

async function signInAdminBrowser(ctx) {
  if (state.adminBrowserSignedIn) {
    return;
  }

  const session = await createAdminBrowserSession(ctx);
  await goToDenWeb(ctx, "/");
  await ctx.eval(`(() => {
    document.cookie = 'better-auth.session_token=; Max-Age=0; Path=/';
    document.cookie = ${JSON.stringify(`${session.cookie}; Path=/; SameSite=Lax`)};
    localStorage.setItem('openwork:web:auth-token', ${JSON.stringify(session.token)});
    sessionStorage.clear();
    return true;
  })()`);
  await goToDenWeb(ctx, "/");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "den-web dashboard after admin sign-in" });
  state.adminBrowserSignedIn = true;
}

async function openMembersPage(ctx) {
  await signInAdminBrowser(ctx);
  await goToDenWeb(ctx, "/dashboard/members");
  await ctx.waitFor("location.pathname.includes('/dashboard/members')", { timeoutMs: 30_000, label: "members route" });
  await ctx.waitForText("Invite teammates, adjust roles, and keep access clean.", { timeoutMs: 30_000 });
}

function memberRowsExpression(email) {
  return `(() => {
    const email = ${JSON.stringify(email)};
    return [...document.querySelectorAll('div')]
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.display === 'grid' && style.gridTemplateColumns.includes('180px') && (el.innerText ?? '').includes(email);
      })
      .map((el) => {
        const cells = [...el.children].map((child) => child.innerText.trim());
        return {
          text: el.innerText.trim(),
          role: cells[1] ?? '',
          joined: cells[2] ?? '',
        };
      });
  })()`;
}

async function memberRows(ctx, email) {
  return ctx.eval(memberRowsExpression(email));
}

async function waitForUiRows(ctx, email, predicateSource, label) {
  await ctx.waitFor(`(() => {
    const rows = ${memberRowsExpression(email)};
    const predicate = ${predicateSource};
    return predicate(rows);
  })()`, { timeoutMs: 30_000, label });
  return memberRows(ctx, email);
}

async function scrollMemberRowsIntoView(ctx, email) {
  await ctx.eval(`(() => {
    const rows = [...document.querySelectorAll('div')]
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.display === 'grid' && style.gridTemplateColumns.includes('180px') && (el.innerText ?? '').includes(${JSON.stringify(email)});
      });
    rows[0]?.scrollIntoView({ block: 'center' });
    return rows.length;
  })()`);
  await ctx.eval("new Promise((resolve) => setTimeout(resolve, 250))", { awaitPromise: true });
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

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function activeMembers(org) {
  return (org.members ?? []).filter((member) => typeof member.userId === "string" && member.userId.length > 0);
}

function invitationsForEmail(org, email) {
  const normalized = normalizeEmail(email);
  return (org.invitations ?? []).filter((invitation) => normalizeEmail(invitation.email) === normalized);
}

function pendingInvitationsForEmail(org, email) {
  return invitationsForEmail(org, email).filter((invitation) => invitation.status === "pending");
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

function summarizeInvitations(org, emails) {
  return emails.map((email) => ({
    email,
    pendingInvitations: pendingInvitationsForEmail(org, email).map(compactInvitation),
    allInvitations: invitationsForEmail(org, email).map(compactInvitation),
  }));
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

async function loadOrg(ctx) {
  const result = await authed("/v1/org");
  witness(ctx, result.response.ok, "Admin token can load the active organization", { status: result.response.status, body: result.body });
  witness(ctx, typeof result.body?.organization?.id === "string", "Organization id is present", result.body?.organization);
  return result.body;
}

async function loadBilling(ctx) {
  const result = await authed("/v1/billing");
  witness(ctx, result.response.ok, "Admin token can load the organization billing summary", { status: result.response.status, body: result.body });
  return result.body;
}

async function loadRuntimeConfig(ctx) {
  const response = await fetch(`${DEN_WEB_URL}/api/runtime-config`, { cache: "no-store" });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  witness(ctx, response.ok, "den-web runtime config loads", { status: response.status, body });
  return body;
}

function purgeIntegrityHazards(ctx) {
  const deletedSeatSubscriptions = mysqlQuery("DELETE FROM org_subscriptions WHERE type = 'seat';");
  const activeSeatSubscriptionCount = mysqlQuery("SELECT COUNT(*) FROM org_subscriptions WHERE type = 'seat' AND status IN ('active','trialing');");
  witness(ctx, activeSeatSubscriptionCount === "0", "Zero active seat subscriptions remain", {
    deletedSeatSubscriptions,
    activeSeatSubscriptionCount,
  });

  const newHirePattern = sqlString("newhire+%@acme.test");
  const secondHirePattern = sqlString("secondhire+%@acme.test");
  const canceledPriorInvitations = mysqlQuery(`UPDATE invitation SET status='canceled' WHERE email LIKE ${newHirePattern} OR email LIKE ${secondHirePattern};`);
  const deletedPriorInviteMembers = mysqlQuery(`DELETE FROM member WHERE user_id IS NULL AND invite_id IN (SELECT id FROM invitation WHERE email LIKE ${newHirePattern} OR email LIKE ${secondHirePattern});`);
  witness(ctx, true, "Prior single-org invite eval artifacts are canceled before inviting again", {
    canceledPriorInvitations,
    deletedPriorInviteMembers,
  });
}

async function inviteThroughUi(ctx) {
  await ctx.clickText("Add member");
  await ctx.fill('input[type="email"][placeholder="teammate@example.com"]', NEW_HIRE_EMAIL);
  await ctx.clickText("Send invite");
}

async function cancelInvitation(ctx, invitation, label) {
  const result = await authed(`/v1/invitations/${encodeURIComponent(invitation.id)}/cancel`, { method: "POST" });
  witness(ctx, result.response.ok && result.body?.success === true, `${label} cleanup cancels the pending invitation`, {
    status: result.response.status,
    body: result.body,
    invitation: compactInvitation(invitation),
  });
}

export default {
  id: FLOW_ID,
  title: "Single-org self-hosted deployments can invite members past the hosted free seat count",
  kind: "user-facing",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WEB_CDP_ADMIN"],
  steps: [
    {
      name: "Frame 1 — A crowded single-org workspace with no seat billing",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("A self-hosted single-org workspace already has more active members than the hosted free tier, with no seat billing configured", {
            voiceover: vo[0],
            assert: async () => {
              purgeIntegrityHazards(ctx);
              const org = await loadOrg(ctx);
              const activeMemberCount = activeMembers(org).length;
              witness(ctx, activeMemberCount > 5, "The active member roster is already beyond the hosted free tier", { activeMemberCount });

              const billing = await loadBilling(ctx);
              const seats = billing?.billing?.stripe?.seats;
              witness(ctx, seats?.configured === false, "Deployment has no Stripe seat billing configured", seats);

              const runtimeConfig = await loadRuntimeConfig(ctx);
              witness(ctx, runtimeConfig?.orgMode === "single_org", "den-web runtime config reports single_org mode", runtimeConfig);

              ctx.output("workspace-state", JSON.stringify({
                runTag: RUN_TAG,
                activeMemberCount,
                seatsConfigured: seats?.configured,
                activeSeatSubscriptionCount: "0",
                orgMode: runtimeConfig?.orgMode,
                organization: {
                  id: org.organization.id,
                  name: org.organization.name,
                  slug: org.organization.slug,
                },
              }, null, 2));

              await openMembersPage(ctx);
            },
            screenshot: {
              name: "members-roster",
              requireText: ["Members", "Invite teammates, adjust roles, and keep access clean."],
              rejectText: ["Subscribe to add more users"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2 — Add member past the old cap, no paywall",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The admin invites a new member through the UI and no seat-billing paywall appears — the invite lands as pending", {
            voiceover: vo[1],
            assert: async () => {
              await openMembersPage(ctx);
              await inviteThroughUi(ctx);
              const rows = await waitForUiRows(
                ctx,
                NEW_HIRE_EMAIL,
                "(rows) => rows.length === 1 && rows[0].joined.includes('Pending')",
                `pending invited member row for ${NEW_HIRE_EMAIL}`,
              );
              witness(ctx, rows.length === 1, `${NEW_HIRE_EMAIL} is one pending row in den-web`, rows);
              witness(ctx, rows[0]?.joined.includes("Pending"), `${NEW_HIRE_EMAIL} den-web row shows Pending`, rows);
              const paywallVisible = await ctx.eval("document.body.innerText.includes('Subscribe to add more users')");
              witness(ctx, paywallVisible === false, "The seat-billing subscribe dialog did not appear", { paywallVisible });
              await scrollMemberRowsIntoView(ctx, NEW_HIRE_EMAIL);
            },
            screenshot: {
              name: "invite-lands-pending",
              requireText: [NEW_HIRE_EMAIL],
              rejectText: ["Subscribe to add more users", "payment", "Start seat billing"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3 — The endpoint answers 201, not 402",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Direct invitation calls past the free seat count return 201 Created instead of 402 Payment Required", {
            voiceover: vo[2],
            assert: async () => {
              const result = await authed("/v1/invitations", {
                method: "POST",
                body: JSON.stringify({ email: SECOND_HIRE_EMAIL, role: "member" }),
              });
              witness(ctx, result.response.status === 201, "Direct invitation call returns 201 Created", {
                status: result.response.status,
                body: redactInviteBody(result.body),
              });
              witness(ctx, result.response.status !== 402, "Direct invitation call is not blocked by Payment Required", {
                status: result.response.status,
                body: redactInviteBody(result.body),
              });

              const org = await loadOrg(ctx);
              const newHireInvitations = pendingInvitationsForEmail(org, NEW_HIRE_EMAIL);
              const secondHireInvitations = pendingInvitationsForEmail(org, SECOND_HIRE_EMAIL);
              witness(ctx, newHireInvitations.length === 1, `${NEW_HIRE_EMAIL} has one pending invitation`, newHireInvitations.map(compactInvitation));
              witness(ctx, secondHireInvitations.length === 1, `${SECOND_HIRE_EMAIL} has one pending invitation`, secondHireInvitations.map(compactInvitation));
              state.newHireInvitation = newHireInvitations[0];
              state.secondHireInvitation = secondHireInvitations[0];

              ctx.output("invite-status", JSON.stringify({
                status: result.response.status,
                "body-redacted": redactInviteBody(result.body),
                invitations: summarizeInvitations(org, [NEW_HIRE_EMAIL, SECOND_HIRE_EMAIL]),
              }, null, 2));

              await openMembersPage(ctx);
              const rows = await waitForUiRows(
                ctx,
                SECOND_HIRE_EMAIL,
                "(rows) => rows.length === 1 && rows[0].joined.includes('Pending')",
                `pending invited member row for ${SECOND_HIRE_EMAIL}`,
              );
              witness(ctx, rows.length === 1, `${SECOND_HIRE_EMAIL} is visible as one pending row in den-web`, rows);
              await scrollMemberRowsIntoView(ctx, SECOND_HIRE_EMAIL);
            },
            screenshot: {
              name: "second-invite-visible",
              requireText: [SECOND_HIRE_EMAIL],
              rejectText: ["Subscribe to add more users"],
            },
          });

          await cancelInvitation(ctx, state.newHireInvitation, NEW_HIRE_EMAIL);
          await cancelInvitation(ctx, state.secondHireInvitation, SECOND_HIRE_EMAIL);
        });
      },
    },
  ],
};
