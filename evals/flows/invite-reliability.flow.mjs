import { journeys } from "../runner/journeys/index.mjs";
import { denApiFetch, denWebUrl } from "../runner/journeys/den.mjs";
import { defineScenario } from "../runner/scenario.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "invite-reliability";
const REQUIRED_DEN_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"];

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const { den } = journeys;
const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";

function safeJson(value) {
  try {
    return JSON.stringify(value).slice(0, 1_200);
  } catch {
    return String(value).slice(0, 1_200);
  }
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${safeJson(actual)}`}`);
}

function cleanStamp(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
}

function uniqueOrgName(ctx) {
  const stamp = ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || new Date().toISOString();
  return `Invite Reliability ${cleanStamp(stamp)}`;
}

function stateString(ctx, key) {
  const value = ctx.state[key];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Scenario state ${key} was not set.`);
}

function stateInvite(ctx) {
  const value = ctx.state.invite;
  if (value && typeof value === "object") return value;
  throw new Error("Scenario state invite was not set.");
}

function stateReinvite(ctx) {
  const value = ctx.state.reinvite;
  if (value && typeof value === "object") return value;
  throw new Error("Scenario state reinvite was not set.");
}

function normalizedEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function authHeaders(token, organizationId) {
  return {
    authorization: `Bearer ${token}`,
    "x-openwork-org-id": organizationId,
  };
}

function membersFromOrg(body) {
  return Array.isArray(body?.members) ? body.members : [];
}

function memberEmail(member) {
  return normalizedEmail(member?.user?.email ?? member?.email ?? "");
}

function memberId(member) {
  return typeof member?.id === "string" ? member.id : typeof member?.memberId === "string" ? member.memberId : "";
}

function memberRole(member) {
  return typeof member?.role === "string" ? member.role.trim().toLowerCase() : "";
}

function memberHasRole(member, role) {
  const target = role.trim().toLowerCase();
  return memberRole(member).split(",").map((entry) => entry.trim()).includes(target);
}

function matchingMembers(body, email) {
  const target = normalizedEmail(email);
  return membersFromOrg(body).filter((member) => memberEmail(member) === target);
}

async function loadOrg(ctx) {
  const token = await den.apiSignIn(ctx, { actor: ctx.actors.alex });
  const organizationId = stateString(ctx, "orgId");
  const loaded = await denApiFetch(ctx, "/v1/org", { headers: authHeaders(token, organizationId) });
  witness(ctx, loaded.response.ok, "Admin can load the active organization", { status: loaded.response.status, body: loaded.body });
  return loaded.body;
}

async function navigateDen(ctx, path) {
  const url = new URL(path, `${denWebUrl(ctx)}/`).toString();
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(url)}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete' || document.body.innerText.length > 0", {
    timeoutMs: 60_000,
    label: `load ${path}`,
  });
}

async function navigateUrl(ctx, url, label) {
  const safeUrl = new URL(url).toString();
  const target = new URL(safeUrl);
  const navigated = ctx.client
    ? await ctx.client.send("Page.navigate", { url: safeUrl }).then(() => true).catch(() => false)
    : false;
  if (!navigated) await ctx.eval(`(() => { window.location.href = ${JSON.stringify(safeUrl)}; return true; })()`);
  await ctx.waitFor(`window.location.pathname === ${JSON.stringify(target.pathname)} && window.location.search === ${JSON.stringify(target.search)}`, {
    timeoutMs: 60_000,
    label: `route ${label}`,
  });
  await ctx.waitFor("document.readyState === 'complete' || document.body.innerText.length > 0", {
    timeoutMs: 60_000,
    label,
  });
}

async function openInvite(ctx, invite, label) {
  const inviteUrl = typeof invite?.inviteUrl === "string" && invite.inviteUrl.trim()
    ? invite.inviteUrl
    : typeof invite?.token === "string" && invite.token.trim()
      ? new URL(`/join-org?invite=${encodeURIComponent(invite.token)}`, `${denWebUrl(ctx)}/`).toString()
      : "";
  witness(ctx, Boolean(inviteUrl), `${label} has an invite URL`, invite);
  await navigateUrl(ctx, inviteUrl, label);
}

async function clickJoinInvite(ctx, orgName) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const button = [...document.querySelectorAll('button')]
      .find((entry) => normalize(entry.textContent).startsWith('Join ') && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: `join ${orgName}` });
}

async function acceptSignedInInvite(ctx, actor, invite) {
  const token = await den.apiSignIn(ctx, { actor });
  await ctx.eval(`(() => {
    window.localStorage.setItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)}, ${JSON.stringify(token)});
    return true;
  })()`);
  await openInvite(ctx, invite, "signed-in re-invite");
  await ctx.waitFor(`document.body.innerText.includes("You're one click away")
    || document.body.innerText.includes(${JSON.stringify(`Join ${stateString(ctx, "orgName")}`)})
    || document.body.innerText.includes('Dashboard')`, {
    timeoutMs: 60_000,
    label: "signed-in invite ready",
  });
  if (!await ctx.hasText("Dashboard")) {
    await clickJoinInvite(ctx, stateString(ctx, "orgName"));
  }
  await ctx.waitFor(`Boolean(document.querySelector('[data-testid="join-org-success"]'))
    || document.body.innerText.includes("You're in")
    || document.body.innerText.includes('Dashboard')
    || location.pathname.startsWith('/dashboard')`, {
    timeoutMs: 60_000,
    label: "signed-in invite accepted",
  });
}

async function showMembers(ctx) {
  await navigateDen(ctx, "/dashboard/members");
  await ctx.waitFor("document.body.innerText.includes('Members') || document.body.innerText.includes('Add member')", {
    timeoutMs: 60_000,
    label: "Members page",
  });
}

async function removeMemberIfPresent(ctx, email) {
  const token = await den.apiSignIn(ctx, { actor: ctx.actors.alex });
  const organizationId = stateString(ctx, "orgId");
  const org = await denApiFetch(ctx, "/v1/org", { headers: authHeaders(token, organizationId) });
  witness(ctx, org.response.ok, "Admin can reload the organization before cleanup", { status: org.response.status, body: org.body });
  for (const member of matchingMembers(org.body, email)) {
    const id = memberId(member);
    witness(ctx, Boolean(id), "Matched member has a removable member id", member);
    const removed = await denApiFetch(ctx, `/v1/members/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(token, organizationId),
    });
    witness(ctx, removed.response.ok || removed.response.status === 204, "Admin can remove the invited teammate", { status: removed.response.status, body: removed.body });
  }
}

export default defineScenario({
  id: FLOW_ID,
  title: "Cloud invite reliability: one admin invite creates one removable teammate",
  kind: "user-facing",
  requiresApp: false,
  stage: { den: { orgMode: "multi_org" } },
  actors: {
    alex: "owner",
    jamie: { persona: "fresh", prefix: "jamie-invite" },
  },
  requiredEnv: REQUIRED_DEN_ENV,
  steps: [
    {
      name: "Alex creates an isolated invite workspace",
      run: async (ctx) => {
        const alexWeb = await ctx.surfaces.chrome("invite-admin-web", { startUrl: denWebUrl(ctx), headless: true });
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Alex creates and opens a fresh Den workspace before sending invites", {
            voiceover: vo[0],
            action: async () => {
              const orgName = uniqueOrgName(ctx);
              const created = await den.createOrg(ctx, { surface: alexWeb, actor: ctx.actors.alex, name: orgName });
              witness(ctx, Boolean(created.orgId), "Created organization has an id", created);
              ctx.state.orgId = created.orgId;
              ctx.state.orgName = created.name;
              await showMembers(ctx);
            },
            assert: async () => {
              await ctx.expectText("Members", { timeoutMs: 60_000 });
              witness(ctx, stateString(ctx, "orgName").startsWith("Invite Reliability"), "The run uses an isolated invite reliability org", stateString(ctx, "orgName"));
            },
            screenshot: { name: "admin-members", requireText: ["Members"], rejectText: ["Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Alex sends Jamie a real invite",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("invite-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("The Members screen sends a real invitation and shows Jamie pending", {
            voiceover: vo[1],
            action: async () => {
              const invite = await den.inviteMember(ctx, {
                surface: alexWeb,
                actor: ctx.actors.alex,
                email: ctx.actors.jamie.email,
                organizationId: stateString(ctx, "orgId"),
              });
              witness(ctx, Boolean(invite.token), "Invite token was resolved for Jamie", invite);
              ctx.state.invite = invite;
              await showMembers(ctx);
            },
            assert: async () => {
              await ctx.expectText(ctx.actors.jamie.email, { timeoutMs: 60_000 });
              const org = await loadOrg(ctx);
              const pending = Array.isArray(org?.invitations) ? org.invitations.filter((invite) => normalizedEmail(invite?.email) === normalizedEmail(ctx.actors.jamie.email)) : [];
              witness(ctx, pending.length === 1, "Exactly one pending invitation exists for Jamie", pending);
            },
            screenshot: { name: "jamie-pending", requireText: [ctx.actors.jamie.email], rejectText: ["Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Jamie accepts in a separate Chrome profile",
      run: async (ctx) => {
        const jamieWeb = await ctx.surfaces.chrome("invite-member-web", { startUrl: denWebUrl(ctx), headless: true });
        await ctx.on(jamieWeb, async () => {
          await ctx.prove("Jamie accepts the invite from her own browser and reaches the workspace", {
            voiceover: vo[2],
            action: async () => {
              await den.acceptInvite(ctx, { surface: jamieWeb, actor: ctx.actors.jamie, invite: stateInvite(ctx) });
              await navigateDen(ctx, "/dashboard");
            },
            assert: async () => {
              await ctx.expectText("Dashboard", { timeoutMs: 60_000 });
              await ctx.expectNoText("Could not join");
            },
            screenshot: { name: "jamie-dashboard", requireText: ["Dashboard"], rejectText: ["Could not join", "Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Jamie reopens the consumed invite link",
      run: async (ctx) => {
        const jamieWeb = ctx.surfaces.get("invite-member-web");
        await ctx.on(jamieWeb, async () => {
          await ctx.prove("Reopening the same accepted invite lands Jamie in a coherent already-member state", {
            voiceover: vo[3],
            action: async () => {
              await openInvite(ctx, stateInvite(ctx), "reopen accepted invite");
              await ctx.waitFor(`document.body.innerText.includes('Dashboard')
                || document.body.innerText.includes("You've already joined")
                || document.body.innerText.includes('This invite has already been used.')`, {
                timeoutMs: 60_000,
                label: "accepted invite already-member state",
              });
            },
            assert: async () => {
              await ctx.expectNoText("This invite can't be opened.");
              await ctx.expectNoText("Could not join");
              const bodyText = await ctx.eval("document.body?.innerText ?? ''");
              witness(ctx, String(bodyText).includes("Dashboard") || String(bodyText).includes("already joined") || String(bodyText).includes("already been used"), "Consumed invite renders a coherent already-member state", String(bodyText).slice(0, 500));
            },
            screenshot: { name: "jamie-double-accept", requireText: ["Dashboard"], rejectText: ["This invite can't be opened", "Could not join", "Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Alex sees exactly one accepted teammate",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("invite-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("The accepted teammate appears once in the admin member list", {
            voiceover: vo[4],
            action: async () => {
              await showMembers(ctx);
            },
            assert: async () => {
              await ctx.expectText(ctx.actors.jamie.email, { timeoutMs: 60_000 });
              const org = await loadOrg(ctx);
              const matches = matchingMembers(org, ctx.actors.jamie.email);
              witness(ctx, matches.length === 1, "Exactly one accepted member exists for Jamie", matches);
            },
            screenshot: { name: "jamie-member-row", requireText: [ctx.actors.jamie.email], rejectText: ["Something went wrong"] },
          });
        });
      },
    },
    {
      name: "An invalid invite token shows a real error state",
      run: async (ctx) => {
        const invalidWeb = await ctx.surfaces.chrome("invite-invalid-web", { startUrl: denWebUrl(ctx), headless: true });
        await ctx.on(invalidWeb, async () => {
          await ctx.prove("A garbage invite token renders a clear product error instead of a blank loop", {
            voiceover: vo[5],
            action: async () => {
              const invalidUrl = new URL("/join-org", `${denWebUrl(ctx)}/`);
              invalidUrl.searchParams.set("invite", `invalid-${cleanStamp(ctx.env.OPENWORK_EVAL_RUNSTAMP)}-token`);
              await navigateUrl(ctx, invalidUrl.toString(), "invalid invite token");
            },
            assert: async () => {
              await ctx.expectText("This invite can't be opened.", { timeoutMs: 60_000 });
              await ctx.expectText("Back to OpenWork Cloud", { timeoutMs: 60_000 });
              await ctx.expectNoText("Dashboard");
            },
            screenshot: { name: "invalid-invite-token", requireText: ["This invite can't be opened.", "Back to OpenWork Cloud"], rejectText: ["Dashboard", "Could not join", "Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Alex removes Jamie, re-invites her, and Jamie accepts again",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("invite-admin-web");
        const jamieWeb = ctx.surfaces.get("invite-member-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("An admin can remove Jamie, re-invite the same email with an admin role, and Jamie can accept again", {
            voiceover: vo[6],
            action: async () => {
              await removeMemberIfPresent(ctx, ctx.actors.jamie.email);
              const afterRemoval = await loadOrg(ctx);
              witness(ctx, matchingMembers(afterRemoval, ctx.actors.jamie.email).length === 0, "Jamie is absent after removal before re-invite", matchingMembers(afterRemoval, ctx.actors.jamie.email));
              const invite = await den.inviteMember(ctx, {
                actor: ctx.actors.alex,
                email: ctx.actors.jamie.email,
                role: "admin",
                organizationId: stateString(ctx, "orgId"),
              });
              witness(ctx, Boolean(invite.token), "Re-invite token was resolved for Jamie", invite);
              ctx.state.reinvite = invite;
              await ctx.on(jamieWeb, async () => {
                await acceptSignedInInvite(ctx, ctx.actors.jamie, stateReinvite(ctx));
                await navigateDen(ctx, "/dashboard");
              });
              await showMembers(ctx);
            },
            assert: async () => {
              await ctx.expectText(ctx.actors.jamie.email, { timeoutMs: 60_000 });
              const org = await loadOrg(ctx);
              const matches = matchingMembers(org, ctx.actors.jamie.email);
              witness(ctx, matches.length === 1, "Exactly one accepted member exists for Jamie after re-invite", matches);
            },
            screenshot: { name: "jamie-reinvited-member-row", requireText: [ctx.actors.jamie.email], rejectText: ["Pending", "Could not join", "Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Jamie keeps the invited admin role",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("invite-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("The accepted re-invite preserves Jamie's explicit admin role", {
            voiceover: vo[7],
            action: async () => {
              await showMembers(ctx);
            },
            assert: async () => {
              await ctx.expectText(ctx.actors.jamie.email, { timeoutMs: 60_000 });
              await ctx.expectText("Admin", { timeoutMs: 60_000 });
              const org = await loadOrg(ctx);
              const matches = matchingMembers(org, ctx.actors.jamie.email);
              witness(ctx, matches.length === 1 && memberHasRole(matches[0], "admin"), "Jamie has exactly one admin membership after the explicit-role invite", matches);
            },
            screenshot: { name: "jamie-admin-role", requireText: [ctx.actors.jamie.email, "Admin"], rejectText: ["Pending", "Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Cleanup and desktop gate",
      run: async (ctx) => {
        await ctx.prove("Cleanup removes Jamie and the desktop cell is explicitly skipped", {
          voiceover: vo[8],
          action: async () => {
            await removeMemberIfPresent(ctx, ctx.actors.jamie.email);
            const desktopGate = ctx.env.OPENWORK_EVAL_DESKTOP_SURFACE?.trim() ? "requested" : "not requested";
            ctx.skip(`Electron desktop surface ${desktopGate}; ${FLOW_ID} is intentionally web-only.`);
            ctx.output("desktop-surface-gate", `OPENWORK_EVAL_DESKTOP_SURFACE=${ctx.env.OPENWORK_EVAL_DESKTOP_SURFACE ?? ""}`);
          },
          assert: async () => {
            const org = await loadOrg(ctx);
            witness(ctx, matchingMembers(org, ctx.actors.jamie.email).length === 0, "Jamie is removed during cleanup", matchingMembers(org, ctx.actors.jamie.email));
          },
        });
      },
    },
  ],
});
