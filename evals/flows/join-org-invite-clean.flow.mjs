import { randomBytes } from "node:crypto";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denWebUrl, signInApi } from "./lib/den-web.mjs";

const FLOW_ID = "join-org-invite-clean";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const DEFAULT_INVITEE_EMAIL = "join-org-invite-clean@acme.test";
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const FALLBACK_INVITEE_EMAIL = `join-org-invite-clean+${RUN_TAG}@acme.test`;
const PENDING_INVITE_STORAGE_KEY = "openwork:web:pending-org-invitation";
const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";

const state = {
  adminToken: "",
  inviteeEmail: process.env.OPENWORK_EVAL_JOIN_ORG_INVITEE_EMAIL?.trim() || DEFAULT_INVITEE_EMAIL,
  invitationId: "",
  inviteToken: "",
  organizationId: "",
  organizationName: "",
  organizationSlug: "",
  role: "member",
  roleLabel: "Member",
};

function authHeaders() {
  return { authorization: `Bearer ${state.adminToken}` };
}

function orgHeaders() {
  const headers = authHeaders();
  if (state.organizationId) {
    headers["x-openwork-org-id"] = state.organizationId;
    headers["x-openwork-legacy-org-id"] = state.organizationId;
  }
  return headers;
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

function roleLabel(role) {
  return String(role)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function denWebRoute(path) {
  return new URL(path, `${denWebUrl()}/`).toString();
}

function cacheBustedJoinUrl(label) {
  const url = new URL(denWebRoute(`/join-org?invite=${encodeURIComponent(state.inviteToken)}`));
  url.searchParams.set("joinOrgInviteClean", `${label}-${Date.now()}`);
  return url.toString();
}

async function applyViewport(ctx, width, height, mobile) {
  if (!ctx.client?.send) {
    ctx.log("Viewport emulation skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  }).catch((error) => {
    ctx.log(`Viewport emulation skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function setReducedMotion(ctx, enabled) {
  if (!ctx.client?.send) {
    ctx.log("Reduced-motion emulation skipped: no raw CDP send method on context.");
    return;
  }

  await ctx.client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: enabled ? "reduce" : "no-preference" }],
  }).catch((error) => {
    ctx.log(`Reduced-motion emulation skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function ensureAdminToken(ctx) {
  if (state.adminToken) return;
  const token = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  witness(ctx, Boolean(token), `Admin API sign-in succeeds for ${ADMIN_EMAIL}`, token ? "<token present>" : "missing token");
  state.adminToken = token;
}

async function listOrgs(ctx) {
  const { response, body } = await denApiFetch("/v1/me/orgs", { headers: authHeaders() });
  witness(ctx, response.ok, "The admin account can list organizations through the local Den API", {
    status: response.status,
    count: Array.isArray(body?.orgs) ? body.orgs.length : null,
  });
  return Array.isArray(body?.orgs) ? body.orgs : [];
}

function chooseInviteOrganization(orgs) {
  return orgs.find((org) => String(org?.name ?? "") === "Acme Robotics")
    ?? orgs.find((org) => String(org?.slug ?? "").toLowerCase().startsWith("acme"))
    ?? orgs[0]
    ?? null;
}

async function setActiveOrganization(ctx) {
  const active = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ organizationId: state.organizationId }),
  });
  witness(ctx, active.response.ok, "The eval sets the selected organization active for the bearer session", {
    status: active.response.status,
    organizationId: state.organizationId,
    body: active.body,
  });
}

async function ensureMultiOrgApi(ctx) {
  await ensureAdminToken(ctx);
  let orgs = await listOrgs(ctx);
  if (orgs.length < 2) {
    const created = await denApiFetch("/v1/org", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Join Org Invite Clean Eval" }),
    });
    witness(ctx, created.response.ok, "The local Den API can create a second organization for the multi-org invite flow", {
      status: created.response.status,
      organization: created.body?.organization,
    });
    orgs = await listOrgs(ctx);
  }
  witness(ctx, orgs.length >= 2, "The invite proof is running against a real multi-org Den account", orgs.map((org) => org?.name ?? org?.slug ?? "unknown"));

  const selected = chooseInviteOrganization(orgs);
  witness(ctx, typeof selected?.id === "string" && selected.id.length > 0, "The eval selected a healthy seeded organization for the invitation", selected);
  state.organizationId = selected.id;
  state.organizationName = typeof selected.name === "string" ? selected.name : "";
  state.organizationSlug = typeof selected.slug === "string" ? selected.slug : "";
  await setActiveOrganization(ctx);
}

async function loadOrgContext(ctx) {
  const org = await denApiFetch("/v1/org", { headers: orgHeaders() });
  witness(ctx, org.response.ok && typeof org.body?.organization?.name === "string", "The active organization context is available", {
    status: org.response.status,
    scopedOrganizationId: state.organizationId,
    organization: org.body?.organization,
  });
  state.organizationName = org.body.organization.name;
  state.organizationId = org.body.organization.id;
  state.organizationSlug = org.body.organization.slug;
  return org.body;
}

function invitationForEmail(orgBody, email) {
  const invitations = Array.isArray(orgBody?.invitations) ? orgBody.invitations : [];
  return invitations.find((entry) => entry?.email === email && entry?.status === "pending" && typeof entry?.inviteToken === "string") ?? null;
}

async function createInvitation(ctx, email) {
  const created = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: orgHeaders(),
    body: JSON.stringify({ email, role: state.role }),
  });

  if (created.response.status === 409 && created.body?.error === "member_exists" && email === DEFAULT_INVITEE_EMAIL) {
    state.inviteeEmail = FALLBACK_INVITEE_EMAIL;
    return createInvitation(ctx, state.inviteeEmail);
  }

  witness(ctx, created.response.ok || created.response.status === 502, "The local Den API creates or refreshes a real pending invitation", {
    status: created.response.status,
    body: created.body,
  });
  return created.body;
}

async function ensureInvitation(ctx) {
  if (state.inviteToken) return;
  await ensureMultiOrgApi(ctx);
  let orgBody = await loadOrgContext(ctx);
  let invitation = invitationForEmail(orgBody, state.inviteeEmail);

  if (!invitation) {
    const created = await createInvitation(ctx, state.inviteeEmail);
    if (typeof created?.inviteToken === "string") {
      state.inviteToken = created.inviteToken;
      state.invitationId = typeof created.invitationId === "string" ? created.invitationId : "";
    }
    orgBody = await loadOrgContext(ctx);
    invitation = invitationForEmail(orgBody, state.inviteeEmail);
  }

  if (invitation) {
    state.invitationId = typeof invitation.id === "string" ? invitation.id : state.invitationId;
    state.inviteToken = invitation.inviteToken;
    state.role = typeof invitation.role === "string" ? invitation.role : state.role;
    state.roleLabel = roleLabel(state.role);
  }

  witness(ctx, Boolean(state.inviteToken), "A valid opaque invite token exists for the join route", {
    email: state.inviteeEmail,
    invitationId: state.invitationId,
    inviteTokenLength: state.inviteToken.length,
  });

  const preview = await denApiFetch(`/v1/orgs/invitations/preview?id=${encodeURIComponent(state.inviteToken)}`);
  witness(ctx, preview.response.ok, "The public invitation preview resolves real organization, email, and role fields", {
    status: preview.response.status,
    preview: preview.body,
  });
  witness(ctx, preview.body?.organization?.name === state.organizationName, "The preview organization name matches the active organization", preview.body?.organization);
  witness(ctx, preview.body?.invitation?.email === state.inviteeEmail, "The preview invited email matches the created invitation", preview.body?.invitation);
  witness(ctx, preview.body?.invitation?.role === state.role, "The preview role matches the created invitation", preview.body?.invitation);
}

async function hardNavigate(ctx, url, label) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(url)}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label });
}

async function clearDenWebSession(ctx) {
  await hardNavigate(ctx, denWebRoute("/"), "den-web root before sign-out");
  await ctx.eval(
    `(() => {
      localStorage.removeItem(${JSON.stringify(AUTH_TOKEN_STORAGE_KEY)});
      sessionStorage.clear();
      return fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'include'
      }).catch(() => null).then(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
    })()`,
    { awaitPromise: true },
  );
  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {}).catch((error) => {
      ctx.log(`Cookie clear skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
    await ctx.client.send("Network.clearBrowserCache", {}).catch((error) => {
      ctx.log(`Cache clear skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function openSignedOutInvite(ctx, label) {
  await hardNavigate(ctx, cacheBustedJoinUrl(label), `signed-out join route ${label}`);
  await ctx.waitFor(
    `(() => {
      const root = document.querySelector('[data-testid="join-org-root"]');
      const text = document.body?.innerText ?? '';
      return root?.getAttribute('data-state') === 'signed-out'
        && text.includes(${JSON.stringify(state.organizationName)})
        && text.includes(${JSON.stringify(state.inviteeEmail)})
        && text.includes(${JSON.stringify(state.roleLabel)})
        && Boolean(document.querySelector('[data-testid="join-org-auth"]'));
    })()`,
    { timeoutMs: 45_000, label: "signed-out invitation screen" },
  );
  await ctx.waitFor(
    "Boolean(document.querySelector('[data-testid=\"join-org-background\"] canvas'))",
    { timeoutMs: 30_000, label: "join invitation Dithering canvas" },
  );
}

async function inviteVisualState(ctx) {
  return ctx.eval(`(() => {
    const root = document.querySelector('[data-testid="join-org-root"]');
    const background = document.querySelector('[data-testid="join-org-background"]');
    const foreground = document.querySelector('[data-testid="join-org-foreground"]');
    const details = document.querySelector('[data-testid="join-org-invitation-details"]');
    const actions = document.querySelector('[data-testid="join-org-actions"]');
    const auth = document.querySelector('[data-testid="join-org-auth"]');
    const rootStyle = root ? getComputedStyle(root) : null;
    const backgroundStyle = background ? getComputedStyle(background) : null;
    const foregroundStyle = foreground ? getComputedStyle(foreground) : null;
    const foregroundRect = foreground?.getBoundingClientRect();
    const detailsRect = details?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const authRect = auth?.getBoundingClientRect();
    const rootFrames = root?.querySelectorAll('.den-frame, .den-frame-inset').length ?? 0;
    const authSubmit = auth?.querySelector('button[type="submit"]');
    const authSubmitRect = authSubmit?.getBoundingClientRect();
    const emailInput = auth?.querySelector('input[type="email"]');
    return {
      path: window.location.pathname,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rootState: root?.getAttribute('data-state') ?? null,
      rootBackgroundColor: rootStyle?.backgroundColor ?? null,
      rootMinHeight: rootStyle?.minHeight ?? null,
      rootOverflowY: rootStyle?.overflowY ?? null,
      backgroundAriaHidden: background?.getAttribute('aria-hidden') ?? null,
      backgroundPointerEvents: backgroundStyle?.pointerEvents ?? null,
      backgroundOpacity: backgroundStyle?.opacity ?? null,
      backgroundPosition: backgroundStyle?.position ?? null,
      backgroundZIndex: backgroundStyle?.zIndex ?? null,
      backgroundShaderSpeed: background?.getAttribute('data-shader-speed') ?? null,
      backgroundMotion: background?.getAttribute('data-motion') ?? null,
      foregroundZIndex: foregroundStyle?.zIndex ?? null,
      foregroundMaxWidth: foregroundStyle?.maxWidth ?? null,
      rootCanvasCount: root?.querySelectorAll('canvas').length ?? 0,
      backgroundCanvasCount: background?.querySelectorAll('canvas').length ?? 0,
      rootFrames,
      foregroundWithinViewport: Boolean(foregroundRect && foregroundRect.left >= 0 && foregroundRect.right <= window.innerWidth + 1),
      detailsWithinViewport: Boolean(detailsRect && detailsRect.left >= 0 && detailsRect.right <= window.innerWidth + 1),
      actionsWithinViewport: Boolean(actionsRect && actionsRect.left >= 0 && actionsRect.right <= window.innerWidth + 1 && actionsRect.top >= 0 && actionsRect.bottom <= window.innerHeight + 1),
      authWithinViewport: Boolean(authRect && authRect.left >= 0 && authRect.right <= window.innerWidth + 1),
      authSubmitWithinViewport: Boolean(authSubmitRect && authSubmitRect.left >= 0 && authSubmitRect.right <= window.innerWidth + 1 && authSubmitRect.top >= 0 && authSubmitRect.bottom <= window.innerHeight + 1),
      foregroundCenterOffset: foregroundRect ? Math.abs((foregroundRect.left + foregroundRect.right) / 2 - window.innerWidth / 2) : null,
      detailsText: details?.innerText ?? '',
      actionsText: actions?.innerText ?? '',
      authText: auth?.innerText ?? '',
      authSubmitText: authSubmit?.textContent?.trim() ?? '',
      emailInputPresent: Boolean(emailInput),
      emailInputValue: emailInput?.value ?? '',
      emailInputDisabled: emailInput instanceof HTMLInputElement ? emailInput.disabled : null,
      bodyText: document.body.innerText,
    };
  })()`);
}

async function clickNotNowAndReturn(ctx) {
  const clicked = await ctx.clickText("Not now", { selector: "button" });
  witness(ctx, clicked === "Not now", "The visible Not now control is clickable", clicked);
  await ctx.waitFor(
    `(() => {
      const pending = sessionStorage.getItem(${JSON.stringify(PENDING_INVITE_STORAGE_KEY)});
      return pending === null && window.location.pathname !== '/join-org';
    })()`,
    { timeoutMs: 30_000, label: "Not now dismissed the invite locally" },
  );
  const dismissed = await ctx.eval(`(() => ({
    path: window.location.pathname,
    pendingInvite: sessionStorage.getItem(${JSON.stringify(PENDING_INVITE_STORAGE_KEY)}),
    text: document.body.innerText,
  }))()`);
  witness(ctx, dismissed.pendingInvite === null, "Not now clears only the local pending invitation marker", dismissed);

  const preview = await denApiFetch(`/v1/orgs/invitations/preview?id=${encodeURIComponent(state.inviteToken)}`);
  witness(ctx, preview.response.ok && preview.body?.invitation?.status === "pending", "Not now does not permanently cancel the server invitation", {
    status: preview.response.status,
    invitation: preview.body?.invitation,
  });

  await openSignedOutInvite(ctx, "after-not-now");
}

export default {
  id: FLOW_ID,
  title: "Organization invitations use a compact light Dithering join experience",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MULTI_ORG"],
  steps: [
    {
      name: "Setup: real multi-org invitation exists",
      run: async (ctx) => {
        witness(ctx, denWebUrl().length > 0, "OPENWORK_EVAL_DEN_WEB_URL points at den-web", denWebUrl());
        await ensureInvitation(ctx);
        ctx.output("join-org-invite-clean-setup", JSON.stringify({
          organizationName: state.organizationName,
          inviteeEmail: state.inviteeEmail,
          role: state.role,
          invitationId: state.invitationId,
          inviteTokenLength: state.inviteToken.length,
        }, null, 2));
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The organization invitation opens as a compact centered light Dithering screen", {
          voiceover: vo[0],
          action: async () => {
            await applyViewport(ctx, 1280, 900, false);
            await setReducedMotion(ctx, false);
            await clearDenWebSession(ctx);
            await openSignedOutInvite(ctx, "desktop");
          },
          assert: async () => {
            const visual = await inviteVisualState(ctx);
            witness(ctx, visual.rootState === "signed-out", "The join route is showing the signed-out invitation state", visual);
            witness(ctx, visual.rootCanvasCount === 1 && visual.backgroundCanvasCount === 1, "The invite screen has exactly one Dithering canvas", visual);
            witness(ctx, visual.backgroundAriaHidden === "true" && visual.backgroundPointerEvents === "none", "The shader background is decorative and non-interactive", visual);
            witness(ctx, visual.backgroundPosition === "fixed" && visual.backgroundZIndex === "0" && visual.foregroundZIndex === "10", "The shader sits behind the foreground hierarchy", visual);
            witness(ctx, visual.backgroundOpacity === "0.09" && visual.rootBackgroundColor === "rgb(248, 251, 255)", "The invitation uses the approved pale light background and low opacity", visual);
            witness(ctx, visual.foregroundMaxWidth === "448px" && visual.foregroundCenterOffset !== null && visual.foregroundCenterOffset < 2, "The invitation content is compact and centered", visual);
            witness(ctx, visual.authSubmitWithinViewport && visual.actionsWithinViewport, "The primary join button and Not now action are visible in the desktop viewport", visual);
          },
          screenshot: {
            name: "join-invite-light-dithering",
            claim: "The organization invitation opens as a compact centered light Dithering experience.",
            requireText: [state.organizationName, state.inviteeEmail, state.roleLabel],
            rejectText: ["Something went wrong", "Inviter", "den-frame"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The invitation fields are real and presented in one compact hierarchy", {
          voiceover: vo[1],
          action: async () => {
            await openSignedOutInvite(ctx, "hierarchy");
          },
          assert: async () => {
            const visual = await inviteVisualState(ctx);
            const detailsText = visual.detailsText.toLowerCase().replace(/\s+/g, " ");
            witness(ctx, visual.rootFrames === 0, "The invitation DOM has no den-frame or den-frame-inset stacked card shells", visual);
            witness(ctx, detailsText.includes("organization") && detailsText.includes(state.organizationName.toLowerCase()), "The hierarchy shows the real organization name", visual.detailsText);
            witness(ctx, detailsText.includes("invited email") && detailsText.includes(state.inviteeEmail.toLowerCase()), "The hierarchy shows the real invited email", visual.detailsText);
            witness(ctx, detailsText.includes("role") && detailsText.includes(state.roleLabel.toLowerCase()), "The hierarchy shows the real invitation role", visual.detailsText);
            witness(ctx, detailsText.includes("account") && detailsText.includes("not signed in"), "The hierarchy shows the signed-out account state without inventing unavailable inviter data", visual.detailsText);
            witness(ctx, !visual.bodyText.toLowerCase().includes("inviter"), "The UI does not fabricate an inviter field that the preview API does not expose", visual.bodyText);
          },
          screenshot: {
            name: "join-invite-real-hierarchy",
            claim: "The real organization, invited email, role, and account state are readable in one compact hierarchy.",
            requireText: ["ORGANIZATION", "INVITED EMAIL", "ROLE", "ACCOUNT", state.organizationName, state.inviteeEmail, state.roleLabel],
            rejectText: ["Inviter", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Primary join auth and non-destructive Not now actions are clear", {
          voiceover: vo[2],
          action: async () => {
            await openSignedOutInvite(ctx, "actions");
          },
          assert: async () => {
            const visual = await inviteVisualState(ctx);
            witness(ctx, visual.authText.includes(`Join ${state.organizationName}`) || visual.authSubmitText.includes(`Join ${state.organizationName}`), "The primary join/auth action is visible", visual);
            witness(ctx, visual.actionsText.includes("Not now"), "The secondary dismissal is labeled Not now", visual.actionsText);
            witness(ctx, visual.emailInputPresent === false && visual.detailsText.includes(state.inviteeEmail), "The auth form hides the duplicate email field while the invitation details show the invited email", visual);
            await clickNotNowAndReturn(ctx);
          },
          screenshot: {
            name: "join-invite-actions",
            claim: "The join action and non-destructive Not now dismissal are clear without extra panels.",
            requireText: [`Join ${state.organizationName}`, "Not now", state.inviteeEmail],
            rejectText: ["Decline invitation", "Cancel invitation", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The layout stays centered on mobile and honors reduced motion", {
          voiceover: vo[3],
          action: async () => {
            await applyViewport(ctx, 390, 900, true);
            await setReducedMotion(ctx, true);
            await openSignedOutInvite(ctx, "mobile-reduced-motion");
          },
          assert: async () => {
            const visual = await inviteVisualState(ctx);
            witness(ctx, visual.viewportWidth <= 430, "The mobile viewport was applied", visual);
            witness(ctx, visual.rootOverflowY === "auto" && typeof visual.rootMinHeight === "string" && visual.rootMinHeight.endsWith("px"), "The invitation shell is scroll-safe on small screens", visual);
            witness(ctx, visual.foregroundWithinViewport && visual.detailsWithinViewport && visual.authWithinViewport, "Foreground, details, and auth remain inside the mobile viewport", visual);
            witness(ctx, visual.authSubmitWithinViewport && visual.actionsWithinViewport, "The mobile screenshot includes the primary join button and Not now action", visual);
            witness(ctx, visual.backgroundShaderSpeed === "0" && visual.backgroundMotion === "reduced", "Reduced motion sets the shader speed to zero", visual);
            witness(ctx, visual.rootCanvasCount === 1 && visual.rootFrames === 0, "Mobile keeps one Dithering canvas and no stacked frames", visual);
          },
          screenshot: {
            name: "join-invite-mobile-reduced-motion",
            claim: "On a phone-sized viewport with reduced motion, the same focused invitation remains centered and readable.",
            requireText: [state.organizationName, state.inviteeEmail, state.roleLabel, "Not now"],
            rejectText: ["Inviter", "Something went wrong"],
          },
        });
      },
    },
  ],
};
