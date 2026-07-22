/**
 * Internal + visual proof for PR #2548: pending invitations are adopted without
 * duplicate organization members, and the den-web Members page shows the same
 * states the customer reported.
 *
 * Local runbook:
 *   1. pnpm evals --stack-down
 *   2. OPENWORK_EVAL_DEN_WEB_URL=http://127.0.0.1:3005 OPENWORK_EVAL_WEB_CDP_ADMIN=http://127.0.0.1:9855 pnpm fraimz --flow invite-adoption-no-duplicates --stack den
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

const FLOW_ID = "invite-adoption-no-duplicates";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = denWebUrl();
const ADMIN_CDP_URL = (process.env.OPENWORK_EVAL_WEB_CDP_ADMIN ?? "").trim().replace(/\/+$/, "");
const MYSQL_CONTAINER = "openwork-web-local-mysql";
const MYSQL_ARGS = ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-ppassword", "openwork_den", "-N", "-e"];
const ADMIN_TOKEN = (process.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const TYPE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TYPE_ID_PREFIXES = {
  member: "om",
  orgSubscription: "osub",
};
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const RILEY_EMAIL = `riley+${RUN_TAG}@acme.test`;
const RILEY_JIT_EMAIL = `riley+jit-${RUN_TAG}@acme.test`;
const RILEY_PASSWORD = `OpenWork-${RUN_TAG}!`;

const state = {
  organization: null,
  adminMemberId: null,
  orgMode: null,
  adminBrowserSignedIn: false,
  rileyToken: null,
  rileyUserId: null,
  reconcileEmail: null,
  reconcileUserId: null,
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

function cleanupPriorEvalArtifacts() {
  return mysqlQuery("DELETE FROM org_subscriptions WHERE last_event_id = 'invite-adoption-no-duplicates';");
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

async function assertPendingInviteUi(ctx, email) {
  const rows = await waitForUiRows(
    ctx,
    email,
    "(rows) => rows.length === 1 && rows[0].role.includes('Admin') && rows[0].joined.includes('Pending') && rows[0].text.toLowerCase().includes('invited')",
    `pending invited admin row for ${email}`,
  );
  witness(ctx, rows.length === 1, `${email} is one pending row in den-web`, rows);
  witness(ctx, rows[0]?.role.includes("Admin"), `${email} den-web row shows Admin role`, rows);
  witness(ctx, rows[0]?.joined.includes("Pending"), `${email} den-web row shows Pending`, rows);
  await scrollMemberRowsIntoView(ctx, email);
}

async function assertDuplicateUi(ctx, email) {
  const rows = await waitForUiRows(
    ctx,
    email,
    "(rows) => rows.length === 2 && rows.some((row) => row.role.includes('Member') && !row.joined.includes('Pending')) && rows.some((row) => row.role.includes('Admin') && row.joined.includes('Pending') && row.text.toLowerCase().includes('invited'))",
    `duplicate raw member plus pending invite rows for ${email}`,
  );
  witness(ctx, rows.length === 2, `${email} has two visible den-web rows in the duplicate state`, rows);
  witness(ctx, rows.some((row) => row.role.includes("Member") && !row.joined.includes("Pending")), `${email} den-web duplicate includes the active wrong member role`, rows);
  witness(ctx, rows.some((row) => row.role.includes("Admin") && row.joined.includes("Pending") && row.text.toLowerCase().includes("invited")), `${email} den-web duplicate includes the pending invited admin record`, rows);
  await scrollMemberRowsIntoView(ctx, email);
}

async function assertReconciledUi(ctx, email) {
  const rows = await waitForUiRows(
    ctx,
    email,
    "(rows) => rows.length === 1 && rows[0].role.includes('Admin') && !rows[0].joined.includes('Pending') && !rows[0].text.toLowerCase().includes('invited')",
    `single reconciled admin row for ${email}`,
  );
  witness(ctx, rows.length === 1, `${email} has exactly one visible den-web row after reconcile`, rows);
  witness(ctx, rows[0]?.role.includes("Admin"), `${email} den-web row shows Admin after reconcile`, rows);
  witness(ctx, !rows[0]?.joined.includes("Pending") && !rows[0]?.text.toLowerCase().includes("invited"), `${email} den-web row has no pending/invited ghost after reconcile`, rows);
  await scrollMemberRowsIntoView(ctx, email);
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

async function authed(path, options = {}) {
  return denFetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(options.headers ?? {}),
    },
  });
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

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function membersForEmail(org, email) {
  const normalized = normalizeEmail(email);
  return (org.members ?? []).filter((member) => normalizeEmail(member.user?.email) === normalized);
}

function invitationsForEmail(org, email) {
  const normalized = normalizeEmail(email);
  return (org.invitations ?? []).filter((invitation) => normalizeEmail(invitation.email) === normalized);
}

function activeMembersForEmail(org, email) {
  return membersForEmail(org, email).filter((member) => typeof member.userId === "string" && member.userId.length > 0);
}

function invitedGhostsForEmail(org, email) {
  return membersForEmail(org, email).filter((member) => !member.userId && typeof member.inviteId === "string" && member.inviteId.length > 0);
}

function compactMember(member) {
  return {
    id: member.id,
    email: member.user?.email,
    userId: member.userId,
    inviteId: member.inviteId,
    role: member.role,
    joinedAt: member.joinedAt,
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

function summarizeOrg(org, emails) {
  return {
    organization: {
      id: org.organization?.id,
      name: org.organization?.name,
      slug: org.organization?.slug,
    },
    currentMember: {
      id: org.currentMember?.id,
      role: org.currentMember?.role,
    },
    totalMembers: Array.isArray(org.members) ? org.members.length : null,
    totalInvitations: Array.isArray(org.invitations) ? org.invitations.length : null,
    focus: emails.map((email) => ({
      email,
      members: membersForEmail(org, email).map(compactMember),
      activeMembers: activeMembersForEmail(org, email).map(compactMember),
      invitedPlaceholders: invitedGhostsForEmail(org, email).map(compactMember),
      invitations: invitationsForEmail(org, email).map(compactInvitation),
    })),
  };
}

async function loadOrg(ctx) {
  const result = await authed("/v1/org");
  witness(ctx, result.response.ok, "Admin token can load the active organization", { status: result.response.status, body: result.body });
  state.organization = result.body.organization;
  state.adminMemberId = result.body.currentMember?.id ?? null;
  witness(ctx, typeof state.organization?.id === "string", "Organization id is present", state.organization);
  witness(ctx, typeof state.adminMemberId === "string", "Admin member id is present", result.body.currentMember);
  return result.body;
}

function ensureSeatSubscription(ctx) {
  const orgId = state.organization?.id;
  const memberId = state.adminMemberId;
  witness(ctx, typeof orgId === "string" && typeof memberId === "string", "Seat setup has an organization and admin member id", { orgId, memberId });
  const subscriptionId = createDenTypeId("orgSubscription");
  const quantity = 100;
  const sql = `INSERT INTO org_subscriptions (id, organization_id, created_by_org_membership_id, type, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_subscription_item_id, quantity, current_period_start, current_period_end, cancel_at_period_end, canceled_at, ended_at, last_event_id, created_at, updated_at) VALUES (${sqlString(subscriptionId)}, ${sqlString(orgId)}, ${sqlString(memberId)}, 'seat', 'active', ${sqlString(`cus_eval_${orgId}`)}, ${sqlString(`sub_eval_seats_${orgId}`)}, 'price_eval_seats', NULL, ${quantity}, CURRENT_TIMESTAMP(3), DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY), false, NULL, NULL, 'invite-adoption-no-duplicates', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE status='active', quantity=VALUES(quantity), current_period_end=VALUES(current_period_end), cancel_at_period_end=false, canceled_at=NULL, ended_at=NULL, updated_at=CURRENT_TIMESTAMP(3);`;
  mysqlQuery(sql);
  return sql;
}

async function inviteAsAdmin(ctx, email) {
  let result = await authed("/v1/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role: "admin" }),
  });
  let seatSql = null;
  if (result.response.status === 402 && result.body?.error === "payment_required") {
    seatSql = ensureSeatSubscription(ctx);
    result = await authed("/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email, role: "admin" }),
    });
  }
  const persisted = result.response.ok || (result.response.status === 502 && result.body?.error === "invitation_email_failed");
  witness(ctx, persisted, `Admin invitation is persisted for ${email}`, { status: result.response.status, body: result.body });
  return { result, seatSql };
}

async function signUpEmail(ctx, email, name) {
  const result = await denAuthFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name, password: RILEY_PASSWORD }),
  });
  witness(ctx, result.response.ok, `Sign-up succeeds for ${email}`, redactAuthResult(result));
  return result;
}

async function signInEmail(ctx, email) {
  const result = await denAuthFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: RILEY_PASSWORD }),
  });
  witness(ctx, result.response.ok && typeof result.body?.token === "string", `Sign-in returns a session token for ${email}`, redactAuthResult(result));
  return result;
}

async function loadMe(ctx, token, label) {
  const result = await denFetch("/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  witness(ctx, result.response.ok && typeof result.body?.user?.id === "string", `${label} profile exposes a user id`, { status: result.response.status, body: result.body });
  return result.body;
}

function userIdForEmail(ctx, email) {
  const sql = `SELECT id FROM user WHERE email = ${sqlString(normalizeEmail(email))} LIMIT 1;`;
  const userId = mysqlQuery(sql).split(/\s+/).filter(Boolean)[0] ?? "";
  witness(ctx, userId.startsWith("usr_"), `User id exists for ${email}`, { sql, userId });
  return userId;
}

function insertRawJitMember(ctx, input) {
  const memberId = createDenTypeId("member");
  const sql = `INSERT INTO member (id, organization_id, user_id, role, joined_at, created_at) VALUES (${sqlString(memberId)}, ${sqlString(input.organizationId)}, ${sqlString(input.userId)}, 'member', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));`;
  const output = mysqlQuery(sql);
  witness(ctx, true, `Raw SSO-style member row inserted for ${input.email}`, { memberId, output });
  return { memberId, sql, output };
}

function assertPendingInviteAndGhost(ctx, org, email) {
  const invitations = invitationsForEmail(org, email);
  const ghosts = invitedGhostsForEmail(org, email);
  witness(ctx, invitations.length === 1, `${email} has one invitation`, invitations.map(compactInvitation));
  witness(ctx, invitations[0]?.status === "pending", `${email} invitation is pending`, invitations.map(compactInvitation));
  witness(ctx, invitations[0]?.role === "admin", `${email} invitation carries admin role`, invitations.map(compactInvitation));
  witness(ctx, ghosts.length === 1, `${email} has one invited placeholder member`, ghosts.map(compactMember));
  witness(ctx, ghosts[0]?.role === "admin", `${email} invited placeholder carries admin role`, ghosts.map(compactMember));
}

function assertReconciled(ctx, org, email) {
  const active = activeMembersForEmail(org, email);
  const ghosts = invitedGhostsForEmail(org, email);
  const invitations = invitationsForEmail(org, email);
  witness(ctx, membersForEmail(org, email).length === 1, `${email} has exactly one visible member row`, membersForEmail(org, email).map(compactMember));
  witness(ctx, active.length === 1, `${email} has one active member`, active.map(compactMember));
  witness(ctx, active[0]?.role === "admin", `${email} active member has admin role`, active.map(compactMember));
  witness(ctx, ghosts.length === 0, `${email} has no invited placeholder ghost`, ghosts.map(compactMember));
  witness(ctx, invitations.length === 1, `${email} has one invitation record`, invitations.map(compactInvitation));
  witness(ctx, invitations[0]?.status === "accepted", `${email} invitation is accepted`, invitations.map(compactInvitation));
}

export default {
  id: FLOW_ID,
  title: "Pending invitations are adopted without duplicate organization members",
  kind: "internal",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WEB_CDP_ADMIN"],
  steps: [
    {
      name: "Frame 1 — The admin invites Riley as an admin",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
        await ctx.prove("The admin invite creates one pending admin invitation and one invited placeholder", {
          voiceover: vo[0],
          assert: async () => {
            await loadOrg(ctx);
            const cleanupOutput = cleanupPriorEvalArtifacts();
            const invite = await inviteAsAdmin(ctx, RILEY_EMAIL);
            const org = await loadOrg(ctx);
            assertPendingInviteAndGhost(ctx, org, RILEY_EMAIL);
            ctx.output("invite-response-and-org-listing", JSON.stringify({
              runTag: RUN_TAG,
              email: RILEY_EMAIL,
              cleanup: cleanupOutput || "removed prior eval-only seat rows if present",
              inviteResponse: { status: invite.result.response.status, body: invite.result.body },
              seatSetupApplied: Boolean(invite.seatSql),
              org: summarizeOrg(org, [RILEY_EMAIL]),
            }, null, 2));
            await openMembersPage(ctx);
            await assertPendingInviteUi(ctx, RILEY_EMAIL);
          },
          screenshot: {
            name: "riley-pending-admin-invite",
            requireText: [RILEY_EMAIL, "Pending", "Admin"],
            rejectText: ["Something went wrong"],
          },
        });
        });
      },
    },
    {
      name: "Frame 2 — Riley signs up and the stack's org mode decides the first-sign-in boundary",
      run: async (ctx) => {
        await ctx.prove("Riley's first sign-in either stays outside the org or adopts the invite in single-org mode", {
          voiceover: vo[1],
          action: async () => {
            state.rileySignUp = await signUpEmail(ctx, RILEY_EMAIL, "Riley Shah");
            const signedIn = await signInEmail(ctx, RILEY_EMAIL);
            state.rileyToken = signedIn.body.token;
            const me = await loadMe(ctx, state.rileyToken, "Riley");
            state.rileyUserId = me.user.id;
          },
          assert: async () => {
            const org = await loadOrg(ctx);
            const active = activeMembersForEmail(org, RILEY_EMAIL);
            const invitations = invitationsForEmail(org, RILEY_EMAIL);
            const ghosts = invitedGhostsForEmail(org, RILEY_EMAIL);
            if (active.length === 1 && invitations[0]?.status === "accepted") {
              state.orgMode = "single_org";
              assertReconciled(ctx, org, RILEY_EMAIL);
            } else {
              state.orgMode = "multi_org";
              witness(ctx, active.length === 0, "Riley is not yet an active member of the invited organization", active.map(compactMember));
              witness(ctx, invitations[0]?.status === "pending", "Riley's invitation is still pending", invitations.map(compactInvitation));
              witness(ctx, ghosts.length === 1, "Riley's invited placeholder still exists", ghosts.map(compactMember));
            }
            ctx.output("riley-first-signin-and-org-mode", JSON.stringify({
              runTag: RUN_TAG,
              inferredOrgMode: state.orgMode,
              auth: {
                signUp: redactAuthResult(state.rileySignUp),
                signInToken: state.rileyToken ? "<present>" : null,
                userId: state.rileyUserId,
              },
              org: summarizeOrg(org, [RILEY_EMAIL]),
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Frame 3 — An SSO-style raw membership appears",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
        await ctx.prove("The pre-fix duplicate state is observable before the next session is created", {
          voiceover: vo[2],
          action: async () => {
            if (state.orgMode === "single_org") {
              state.reconcileEmail = RILEY_JIT_EMAIL;
              const invite = await inviteAsAdmin(ctx, state.reconcileEmail);
              const signUp = await signUpEmail(ctx, state.reconcileEmail, "Riley JIT");
              state.reconcileUserId = userIdForEmail(ctx, state.reconcileEmail);
              state.jitSetup = { invite, signUp };
            } else {
              state.reconcileEmail = RILEY_EMAIL;
              state.reconcileUserId = state.rileyUserId;
            }
            const orgId = state.organization?.id;
            witness(ctx, typeof orgId === "string", "Raw member insert has an organization id", state.organization);
            witness(ctx, typeof state.reconcileUserId === "string" && state.reconcileUserId.startsWith("usr_"), "Raw member insert has a Riley user id", state.reconcileUserId);
            state.rawInsert = insertRawJitMember(ctx, {
              email: state.reconcileEmail,
              organizationId: orgId,
              userId: state.reconcileUserId,
            });
            await openMembersPage(ctx);
          },
          assert: async () => {
            const org = await loadOrg(ctx);
            const active = activeMembersForEmail(org, state.reconcileEmail);
            const ghosts = invitedGhostsForEmail(org, state.reconcileEmail);
            const invitations = invitationsForEmail(org, state.reconcileEmail);
            witness(ctx, active.length === 1, `${state.reconcileEmail} has one active raw member`, active.map(compactMember));
            witness(ctx, active[0]?.role === "member", `${state.reconcileEmail} active raw member has the old wrong member role`, active.map(compactMember));
            witness(ctx, ghosts.length === 1, `${state.reconcileEmail} still has one invited placeholder ghost`, ghosts.map(compactMember));
            witness(ctx, invitations[0]?.status === "pending", `${state.reconcileEmail} invitation remains pending before reconcile`, invitations.map(compactInvitation));
            ctx.output("raw-jit-duplicate-state", JSON.stringify({
              inferredOrgMode: state.orgMode,
              email: state.reconcileEmail,
              singleOrgExtraInvite: state.orgMode === "single_org",
              rawInsertSql: state.rawInsert.sql,
              rawInsertOutput: state.rawInsert.output,
              setupInviteResponse: state.jitSetup
                ? { status: state.jitSetup.invite.result.response.status, body: state.jitSetup.invite.result.body }
                : undefined,
              setupSignUp: state.jitSetup ? redactAuthResult(state.jitSetup.signUp) : undefined,
              org: summarizeOrg(org, [state.reconcileEmail]),
            }, null, 2));
            await assertDuplicateUi(ctx, state.reconcileEmail);
          },
          screenshot: {
            name: "riley-duplicate-raw-member-and-pending-invite",
            requireText: ["Member", "Pending", "INVITED", "Admin"],
            rejectText: ["Something went wrong"],
          },
        });
        });
      },
    },
    {
      name: "Frame 4 — Riley signs in again and the app reconciles",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
        await ctx.prove("The next sign-in merges the active member with the invite and deletes the invited ghost", {
          voiceover: vo[3],
          action: async () => {
            const signedIn = await signInEmail(ctx, state.reconcileEmail);
            state.reconciledToken = signedIn.body.token;
            state.reconciledMe = await loadMe(ctx, state.reconciledToken, "Reconciled Riley");
            await openMembersPage(ctx);
          },
          assert: async () => {
            const org = await loadOrg(ctx);
            assertReconciled(ctx, org, state.reconcileEmail);
            ctx.output("reconciled-org-listing", JSON.stringify({
              inferredOrgMode: state.orgMode,
              email: state.reconcileEmail,
              auth: {
                token: state.reconciledToken ? "<present>" : null,
                userId: state.reconciledMe?.user?.id,
                sessionActiveOrganizationId: state.reconciledMe?.session?.activeOrganizationId,
              },
              org: summarizeOrg(org, [state.reconcileEmail]),
            }, null, 2));
            await assertReconciledUi(ctx, state.reconcileEmail);
          },
          screenshot: {
            name: "riley-reconciled-single-admin-row",
            requireText: ["Admin"],
            rejectText: ["Something went wrong"],
          },
        });
        });
      },
    },
  ],
};
