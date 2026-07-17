import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "scim-groups-to-teams";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const ADMIN_CDP_URL = (process.env.OPENWORK_EVAL_WEB_CDP_ADMIN ?? "").trim().replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MYSQL_CONTAINER = process.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim() || "openwork-web-local-mysql";
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const MAYA_EMAIL = `maya.scim+${RUN_TAG}@acme.test`;
const JORDAN_EMAIL = `jordan.scim+${RUN_TAG}@acme.test`;
const TYPE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TYPE_ID_PREFIXES = { organization: "org", member: "om", ssoConnection: "ssc" };

const state = {
  browserSignedIn: false,
  browserSession: null,
  orgId: null,
  orgSlug: null,
  scimToken: null,
  maya: null,
  jordan: null,
  engineering: null,
  design: null,
  manualTeam: null,
  secondOrgId: createDenTypeId("organization"),
  secondMemberId: createDenTypeId("member"),
  ssoConnectionId: createDenTypeId("ssoConnection"),
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 1000),
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
  return execFileSync("docker", ["exec", MYSQL_CONTAINER, "mysql", "-uroot", "-ppassword", "openwork_den", "-N", "-e", sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: DEN_WEB_URL || DEN_API_URL,
      authorization: `Bearer ${ADMIN_TOKEN}`,
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

async function scimFetch(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}/api/auth/scim/v2${path}`, {
    ...options,
    headers: {
      "content-type": "application/scim+json",
      authorization: `Bearer ${state.scimToken}`,
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

function sessionCookiePair(setCookie) {
  const match = String(setCookie ?? "").match(/better-auth\.session_token=([^;,\s]+)/);
  return match ? `better-auth.session_token=${match[1]}` : "";
}

async function createAdminBrowserSession(ctx) {
  const origins = [...new Set([
    "http://localhost:3005",
    "http://localhost:8790",
    DEN_WEB_URL && new URL(DEN_WEB_URL).origin,
    DEN_API_URL && new URL(DEN_API_URL).origin,
  ].filter(Boolean))];
  let last = null;
  for (const origin of origins) {
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
    last = { origin, status: response.status, cookie: Boolean(cookie) };
    if (response.ok && typeof body?.token === "string" && cookie) {
      return { token: body.token, cookie };
    }
  }
  witness(ctx, false, "Admin browser session can be created", last);
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;
  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) response = await fetch(`${base}/json/new?about:blank`);
  if (!response.ok) throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);
  return response.json();
}

async function withAdminBrowser(ctx, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(ADMIN_CDP_URL);
  const client = await connect(debuggerUrlFor(ADMIN_CDP_URL, target));
  ctx.client = client;
  try {
    if (!state.browserSignedIn) {
      const session = state.browserSession ?? await createAdminBrowserSession(ctx);
      state.browserSession = session;
      await ctx.eval(`location.assign(${JSON.stringify(DEN_WEB_URL)})`);
      await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "den-web root" });
      await ctx.eval(`(() => {
        document.cookie = 'better-auth.session_token=; Max-Age=0; Path=/';
        document.cookie = ${JSON.stringify(`${session.cookie}; Path=/; SameSite=Lax`)};
        localStorage.setItem('openwork:web:auth-token', ${JSON.stringify(session.token)});
        sessionStorage.clear();
        return true;
      })()`);
      await ctx.eval(`location.assign(${JSON.stringify(`${DEN_WEB_URL}/dashboard`)})`);
      await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "admin dashboard" });
      state.browserSignedIn = true;
    }
    return await fn();
  } finally {
    ctx.client = previous;
    try { client.close(); } catch {}
  }
}

async function navigate(ctx, path, requiredText) {
  await ctx.eval(`location.assign(${JSON.stringify(`${DEN_WEB_URL}${path}`)})`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: path });
  if (requiredText) await ctx.waitForText(requiredText, { timeoutMs: 30_000 });
}

async function clickButton(ctx, label) {
  const clicked = await ctx.eval(`(() => {
    const label = ${JSON.stringify(label)};
    const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim().startsWith(label));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  witness(ctx, clicked, `The ${label} action is available`, clicked);
}

async function openTeams(ctx) {
  await navigate(ctx, "/dashboard/members", "Members");
  await clickButton(ctx, "Teams");
  await ctx.waitForText("Manage teams and their members.", { timeoutMs: 30_000 });
}

async function scrollTextIntoView(ctx, text) {
  await ctx.eval(`(() => {
    const text = ${JSON.stringify(text)};
    const elements = [...document.querySelectorAll('div, span, p')]
      .filter((entry) => (entry.textContent ?? '').includes(text))
      .sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0));
    elements[0]?.scrollIntoView({ block: 'center' });
    return elements.length;
  })()`);
}

async function setup(ctx) {
  const org = await apiFetch("/v1/org");
  witness(ctx, org.response.ok, "The seeded admin can load the organization", {
    status: org.response.status,
    body: org.body,
    tokenPresent: Boolean(ADMIN_TOKEN),
    apiUrl: DEN_API_URL,
  });
  state.orgId = org.body?.organization?.id ?? null;
  state.orgSlug = org.body?.organization?.slug ?? null;
  witness(ctx, Boolean(state.orgId), "The eval organization has an id", state.orgId);
  state.browserSession = await createAdminBrowserSession(ctx);

  mysqlQuery("DELETE tm FROM team_member tm INNER JOIN scim_group_member sgm ON sgm.team_member_id=tm.id; DELETE t FROM team t INNER JOIN scim_group sg ON sg.team_id=t.id; DELETE FROM scim_group_member; DELETE FROM scim_group; DELETE FROM scim_user_tombstone; DELETE FROM sso_connection; DELETE FROM account WHERE provider_id LIKE 'openwork-scim-%'; DELETE FROM scim_provider;");

  mysqlQuery(`INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path, created_at, updated_at)
    VALUES (${sqlString(state.ssoConnectionId)}, ${sqlString(state.orgId)}, ${sqlString(`eval-saml-${RUN_TAG}`)}, 'saml', 'https://idp.example.test', 'saml.example.test', 'enabled', ${sqlString(`/sso/${state.orgSlug}`)}, NOW(3), NOW(3))
    ON DUPLICATE KEY UPDATE domain='saml.example.test', status='enabled', updated_at=NOW(3)`);

  const rotated = await apiFetch("/v1/scim/token", {
    method: "POST",
    body: "{}",
    headers: { cookie: state.browserSession.cookie },
  });
  witness(ctx, rotated.response.ok && typeof rotated.body?.scimToken === "string", "A SCIM connector token is available", {
    status: rotated.response.status,
    token: rotated.body?.scimToken ? "<present>" : null,
  });
  state.scimToken = rotated.body.scimToken;

  const metadataOnly = await apiFetch("/v1/scim", {
    method: "PATCH",
    body: JSON.stringify({ groupMappingMode: "metadata_only" }),
  });
  witness(ctx, metadataOnly.response.ok, "SCIM group mapping starts disabled", metadataOnly.body?.connection?.groupMappingMode);

  state.maya = await createScimUser(ctx, "Maya Chen", MAYA_EMAIL);
  state.jordan = await createScimUser(ctx, "Jordan Lee", JORDAN_EMAIL);
}

async function createScimUser(ctx, name, email) {
  const result = await scimFetch("/Users", {
    method: "POST",
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: `eval-${RUN_TAG}-${email}`,
      userName: email,
      displayName: name,
      name: { formatted: name },
      emails: [{ value: email, primary: true }],
      active: true,
    }),
  });
  witness(ctx, result.response.ok && typeof result.body?.id === "string", `${name} is provisioned through SCIM`, {
    status: result.response.status,
    id: result.body?.id,
    detail: result.body?.detail,
  });
  const memberId = mysqlQuery(`SELECT id FROM member WHERE organization_id=${sqlString(state.orgId)} AND user_id=${sqlString(result.body.id)} AND removed_at IS NULL LIMIT 1`);
  witness(ctx, Boolean(memberId), `${name} has an active organization member`, memberId);
  return { userId: result.body.id, memberId, email, name };
}

async function createGroup(ctx, displayName, members) {
  const result = await scimFetch("/Groups", {
    method: "POST",
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      externalId: `eval-${RUN_TAG}-${displayName.toLowerCase()}`,
      displayName,
      members: members.map((user) => ({ value: user.userId, display: user.name })),
    }),
  });
  witness(ctx, result.response.ok && typeof result.body?.id === "string", `${displayName} is provisioned as a SCIM group`, {
    status: result.response.status,
    id: result.body?.id,
    detail: result.body?.detail,
  });
  return { id: result.body.id, displayName };
}

async function patchGroup(ctx, group, operations) {
  const result = await scimFetch(`/Groups/${encodeURIComponent(group.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: operations,
    }),
  });
  witness(ctx, result.response.ok, `${group.displayName} accepts its SCIM membership update`, {
    status: result.response.status,
    members: result.body?.members,
    detail: result.body?.detail,
  });
}

async function openMembers(ctx) {
  await navigate(ctx, "/dashboard/members", "Invite teammates, adjust roles, and keep access clean.");
}

function activeUserCount(email) {
  return Number(mysqlQuery(`SELECT COUNT(*) FROM user WHERE email=${sqlString(email)}`) || "0");
}

function removedMemberState(memberId) {
  const row = mysqlQuery(`SELECT IF(user_id IS NULL, 'null', user_id), IF(removed_at IS NULL, 'active', 'removed') FROM member WHERE id=${sqlString(memberId)} LIMIT 1`);
  const [userId, status] = row.split("\t");
  return { userId, status };
}

export default {
  id: FLOW_ID,
  title: "SCIM groups create and safely manage OpenWork teams alongside SAML",
  kind: "user-facing",
  requiresApp: false,
  preserveTheme: true,
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
  ],
  steps: [
    {
      name: "setup",
      run: async (ctx) => setup(ctx),
    },
    {
      name: "Frame 1",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("The SCIM administration screen shows SAML/SSO and SCIM active together", {
          voiceover: vo[0],
          action: async () => navigate(ctx, "/dashboard/scim", "SCIM base URL"),
          assert: async () => {
            await ctx.expectText("SAML/SSO active");
            await ctx.expectText("SCIM connected");
            await ctx.expectText("Create teams from SCIM groups");
          },
          screenshot: { name: "scim-and-saml-active", requireText: ["SAML/SSO active", "SCIM connected", "Create teams from SCIM groups"] },
        });
      }),
    },
    {
      name: "Frame 2",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("An administrator can enable identity-provider-managed team synchronization", {
          voiceover: vo[1],
          action: async () => {
            await navigate(ctx, "/dashboard/scim", "Create teams from SCIM groups");
            await clickButton(ctx, "Enable team sync");
            await ctx.waitForText("Enabled", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const config = await apiFetch("/v1/scim");
            witness(ctx, config.body?.connection?.groupMappingMode === "create_teams", "The server persists create-teams mapping mode", config.body?.connection);
            await ctx.expectText("identity provider");
          },
          screenshot: { name: "enable-scim-team-sync", requireText: ["Create teams from SCIM groups", "Enabled", "identity provider"] },
        });
      }),
    },
    {
      name: "Frame 3",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("Provisioned SCIM groups appear as matching managed teams", {
          voiceover: vo[2],
          action: async () => {
            state.engineering = await createGroup(ctx, "Engineering", [state.maya, state.jordan]);
            state.design = await createGroup(ctx, "Design", []);
            await openTeams(ctx);
          },
          assert: async () => {
            await ctx.expectText("Engineering");
            await ctx.expectText("Design");
            await ctx.expectText("MANAGED BY SCIM");
            await scrollTextIntoView(ctx, "Engineering");
          },
          screenshot: { name: "scim-managed-teams", requireText: ["Engineering", "Design", "MANAGED BY SCIM"] },
        });
      }),
    },
    {
      name: "Frame 4",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("The SAML-linked user arrives with the team membership SCIM provisioned in advance", {
          voiceover: vo[3],
          action: async () => {
            mysqlQuery(`UPDATE external_identity SET source='scim+sso', sso_provider_id=${sqlString(`eval-saml-${RUN_TAG}`)}, last_sso_login_at=NOW(3) WHERE organization_id=${sqlString(state.orgId)} AND user_id=${sqlString(state.maya.userId)}`);
            await openTeams(ctx);
          },
          assert: async () => {
            const linked = Number(mysqlQuery(`SELECT COUNT(*) FROM external_identity WHERE organization_id=${sqlString(state.orgId)} AND user_id=${sqlString(state.maya.userId)} AND last_sso_login_at IS NOT NULL`) || "0");
            witness(ctx, linked === 1, "Maya has a recorded SSO login linked to her SCIM identity", linked);
            const org = await apiFetch("/v1/org");
            const engineering = org.body?.teams?.find((team) => team.name === "Engineering");
            witness(ctx, engineering?.memberIds?.includes(state.maya.memberId), "Maya is already assigned to Engineering", engineering);
            await ctx.expectText("Maya Chen");
            await scrollTextIntoView(ctx, "Engineering");
          },
          screenshot: { name: "saml-user-in-scim-team", requireText: ["Engineering", "Maya Chen", "MANAGED BY SCIM"] },
        });
      }),
    },
    {
      name: "Frame 5",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("A SCIM membership move updates OpenWork teams without another user login", {
          voiceover: vo[4],
          action: async () => {
            await patchGroup(ctx, state.engineering, [{ op: "remove", path: `members[value eq \"${state.maya.userId}\"]` }]);
            await patchGroup(ctx, state.design, [{ op: "add", path: "members", value: [{ value: state.maya.userId }] }]);
            await openTeams(ctx);
          },
          assert: async () => {
            const org = await apiFetch("/v1/org");
            const engineering = org.body?.teams?.find((team) => team.name === "Engineering");
            const design = org.body?.teams?.find((team) => team.name === "Design");
            witness(ctx, !engineering?.memberIds?.includes(state.maya.memberId), "Maya is removed from Engineering", engineering);
            witness(ctx, design?.memberIds?.includes(state.maya.memberId), "Maya is added to Design", design);
            await ctx.expectText("Design");
            await ctx.expectText("Maya Chen");
            await scrollTextIntoView(ctx, "Design");
          },
          screenshot: { name: "scim-moves-user-to-design", requireText: ["Engineering", "Design", "Maya Chen"] },
        });
      }),
    },
    {
      name: "Frame 6",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("SCIM removes only the membership it owns and preserves manual teams", {
          voiceover: vo[5],
          action: async () => {
            const created = await apiFetch("/v1/teams", {
              method: "POST",
              body: JSON.stringify({ name: `Mentors ${RUN_TAG}`, memberIds: [state.maya.memberId] }),
            });
            witness(ctx, created.response.ok, "An administrator creates Maya's manual Mentors team", created.body);
            state.manualTeam = created.body?.team;
            await patchGroup(ctx, state.design, [{ op: "remove", path: `members[value eq \"${state.maya.userId}\"]` }]);
            await openTeams(ctx);
          },
          assert: async () => {
            const org = await apiFetch("/v1/org");
            const design = org.body?.teams?.find((team) => team.name === "Design");
            const mentors = org.body?.teams?.find((team) => team.id === state.manualTeam?.id);
            witness(ctx, !design?.memberIds?.includes(state.maya.memberId), "Maya's SCIM-managed Design membership is removed", design);
            witness(ctx, mentors?.memberIds?.includes(state.maya.memberId) && !mentors?.managedByScim, "Maya's manual team membership is preserved", mentors);
            await ctx.expectText(`Mentors ${RUN_TAG}`);
            await scrollTextIntoView(ctx, `Mentors ${RUN_TAG}`);
          },
          screenshot: { name: "manual-team-membership-preserved", requireText: ["Design", `Mentors ${RUN_TAG}`, "Maya Chen"] },
        });
      }),
    },
    {
      name: "Frame 7",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("Deprovisioning one organization preserves a user who still belongs elsewhere", {
          voiceover: vo[6],
          action: async () => {
            mysqlQuery(`INSERT INTO organization (id, name, slug, created_at, updated_at) VALUES (${sqlString(state.secondOrgId)}, 'Partner Workspace', ${sqlString(`partner-${RUN_TAG}`)}, NOW(3), NOW(3))`);
            mysqlQuery(`INSERT INTO member (id, organization_id, user_id, role, joined_at, created_at) VALUES (${sqlString(state.secondMemberId)}, ${sqlString(state.secondOrgId)}, ${sqlString(state.jordan.userId)}, 'member', NOW(3), NOW(3))`);
            const removed = await scimFetch(`/Users/${encodeURIComponent(state.jordan.userId)}`, { method: "DELETE" });
            witness(ctx, removed.response.status === 204, "Jordan is deprovisioned from the SCIM organization", removed.response.status);
            await openMembers(ctx);
          },
          assert: async () => {
            witness(ctx, activeUserCount(JORDAN_EMAIL) === 1, "Jordan's global user remains because another active membership exists", activeUserCount(JORDAN_EMAIL));
            const memberState = removedMemberState(state.jordan.memberId);
            witness(ctx, memberState.userId === "null" && memberState.status === "removed", "Jordan's original member is retained as a disconnected removed record", memberState);
            await ctx.expectNoText(JORDAN_EMAIL);
          },
          screenshot: { name: "multi-org-user-preserved", requireText: ["Members"], rejectText: [JORDAN_EMAIL] },
        });
      }),
    },
    {
      name: "Frame 8",
      run: async (ctx) => withAdminBrowser(ctx, async () => {
        await ctx.prove("Final-organization deprovisioning deletes the global user but retains history and blocks SAML restoration", {
          voiceover: vo[7],
          action: async () => {
            const removed = await scimFetch(`/Users/${encodeURIComponent(state.maya.userId)}`, { method: "DELETE" });
            witness(ctx, removed.response.status === 204, "Maya is deprovisioned from her final organization", removed.response.status);
            await openMembers(ctx);
          },
          assert: async () => {
            witness(ctx, activeUserCount(MAYA_EMAIL) === 0, "Maya's global user is deleted after her final active membership", activeUserCount(MAYA_EMAIL));
            const memberState = removedMemberState(state.maya.memberId);
            witness(ctx, memberState.userId === "null" && memberState.status === "removed", "Maya's member history remains disconnected", memberState);
            const tombstones = Number(mysqlQuery(`SELECT COUNT(*) FROM scim_user_tombstone WHERE organization_id=${sqlString(state.orgId)} AND email=${sqlString(MAYA_EMAIL.toLowerCase())}`) || "0");
            witness(ctx, tombstones === 1, "A SCIM tombstone prevents SAML JIT from silently restoring Maya", tombstones);
            await ctx.expectNoText(MAYA_EMAIL);
          },
          screenshot: { name: "final-org-user-deprovisioned", requireText: ["Members"], rejectText: [MAYA_EMAIL] },
        });
      }),
    },
    {
      name: "cleanup",
      run: async () => {
        mysqlQuery("DELETE FROM sso_connection; DELETE FROM account WHERE provider_id LIKE 'openwork-scim-%'; DELETE FROM scim_provider;");
      },
    },
  ],
};
