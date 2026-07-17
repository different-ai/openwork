import { execSync } from "node:child_process";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/invite-to-desktop.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("invite-to-desktop");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const MOBILE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_MOBILE);
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_PASSWORD = "OpenWorkDemo123!";
const DOWNLOAD_URL = "https://openworklabs.com/download";
const REMOVED_INVITE_EMAIL_TEXT = [
  "Download the desktop app",
  "Download OpenWork",
  "Edit spreadsheets",
  "Control your browser",
  "Organize files",
  "Automate tasks",
  "desktop app",
  "Open OpenWork",
];
const RUN_TAG = Date.now().toString(36);
const MAYA_EMAIL = `maya+${RUN_TAG}@acme.test`;
const RILEY_EMAIL = `riley+${RUN_TAG}@acme.test`;

const state = {
  desktopClient: null,
  adminToken: null,
  mayaInviteLink: null,
  mayaInviteToken: null,
  rileyInviteLink: null,
  rileyInviteToken: null,
  copiedDesktopUrl: null,
};

export default {
  id: "invite-to-desktop",
  title: "Invited teammates join Acme, get a desktop handoff, and receive mobile-safe download guidance",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_WEB_CDP_MOBILE",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        rememberDesktopClient(ctx);
        await withClient(ctx, ADMIN_CDP_URL, async () => {
        await ctx.prove("Maya's Acme invite is sent and visible as pending on Members", {
          voiceover: vo[0],
          action: async () => {
            await ensureAdminToken(ctx);
            await withClient(ctx, ADMIN_CDP_URL, async () => {
              await signInToDenWeb(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard/members");
              // Alex sends the invite through the real Members UI.
              await clickExactText(ctx, "Add member", "button");
              await ctx.fill('input[placeholder="teammate@example.com"]', MAYA_EMAIL);
              await clickExactText(ctx, "Send invite", "button");
              await ctx.waitForText(MAYA_EMAIL, { timeoutMs: 30_000 });
              await ctx.waitForText("Pending", { timeoutMs: 20_000 });
            });
          },
          assert: async () => {
            await withClient(ctx, ADMIN_CDP_URL, async () => {
              const invitation = await assertPendingInvitation(ctx, MAYA_EMAIL);
              state.mayaInviteToken = invitation.inviteToken ?? state.mayaInviteToken;
              await ctx.expectText(MAYA_EMAIL);
              await ctx.expectText("Pending");
            });
          },
          screenshot: { name: "maya-pending-invite", requireText: [MAYA_EMAIL, "Pending"] },
        });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
        await ctx.prove("Maya's real invite email is focused on joining Acme, not downloading the app", {
          voiceover: vo[1],
          action: async () => {
            await withClient(ctx, ADMIN_CDP_URL, async () => {
              await navigateToAbsolute(ctx, `${DEN_API_URL}/v1/dev/emails/last?template=organizationInvite`);
              await ctx.waitForText("Accept invite", { timeoutMs: 20_000 });
            });
          },
          assert: async () => {
            const { entry, html } = await getLatestDevEmail(ctx, "organizationInvite", MAYA_EMAIL);
            const text = htmlText(html);
            ctx.assert(text.includes("Join Acme Robotics"), "Invite email is missing the Acme join heading.");
            ctx.assert(text.includes("Accept invite"), "Invite email is missing Accept invite.");
            ctx.assert(text.includes(ADMIN_EMAIL), "Invite email is missing the inviter email.");
            ctx.assert(text.includes("invited you to join Acme Robotics"), "Invite email is missing the inviter context.");
            const lowerHtml = html.toLowerCase();
            for (const removedText of REMOVED_INVITE_EMAIL_TEXT) {
              ctx.assert(!lowerHtml.includes(removedText.toLowerCase()), `Invite email still contains removed desktop/download copy: ${removedText}.`);
            }
            ctx.assert(!lowerHtml.includes("/install?token="), "Invite email still contains an organization install token link.");
            ctx.assert(!html.includes(DOWNLOAD_URL), `Organization invite email still points at ${DOWNLOAD_URL}.`);
            const blockedLinks = blockedDownloadOrInstallHrefs(html);
            ctx.assert(blockedLinks.length === 0, `Invite email still contains download/install hrefs: ${JSON.stringify(blockedLinks)}.`);
            const invite = extractInviteFromHtml(html, ctx);
            state.mayaInviteToken = invite.token;
            state.mayaInviteLink = rewriteInviteLink(invite.link);
            ctx.output("maya-invite-email", JSON.stringify({ to: entry.to, subject: entry.subject, acceptLink: redactInviteLink(state.mayaInviteLink) }, null, 2));
            await withClient(ctx, ADMIN_CDP_URL, async () => {
              await ctx.expectText("Join Acme Robotics");
              await ctx.expectText("Accept invite");
              await ctx.expectText(ADMIN_EMAIL);
              for (const removedText of REMOVED_INVITE_EMAIL_TEXT) {
                await ctx.expectNoText(removedText);
              }
              await redactInviteCredentialInPage(ctx, state.mayaInviteToken);
            });
          },
          screenshot: {
            name: "maya-invite-email",
            requireText: ["Join Acme Robotics", "Accept invite", ADMIN_EMAIL],
            rejectText: REMOVED_INVITE_EMAIL_TEXT,
          },
        });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
        await ctx.prove("Maya's laptop invite page shows Acme is ready and her role is set", {
          voiceover: vo[2],
          action: async () => {
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.mayaInviteLink, "Maya invite link"));
              await ctx.waitForText("Acme Robotics", { timeoutMs: 30_000 });
              await ctx.waitForText("Your team is already set up and waiting.", { timeoutMs: 20_000 });
            });
          },
          assert: async () => {
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await ctx.expectText("Acme Robotics");
              await ctx.expectText("Role");
              await ctx.expectText("Your team is already set up and waiting.");
            });
          },
          screenshot: {
            name: "maya-laptop-join-page",
            requireText: ["Acme Robotics", "Role", "Your team is already set up and waiting."],
          },
        });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
        await ctx.prove("Maya joins and lands on the desktop-app success step instead of the dashboard", {
          voiceover: vo[3],
          action: async () => {
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await completeInviteSignup(ctx, MAYA_EMAIL, MEMBER_PASSWORD);
            });
          },
          assert: async () => {
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", { timeoutMs: 45_000, label: "join-org success" });
              await ctx.expectText("You're in");
              await ctx.expectText("Open OpenWork");
              await ctx.expectText("Download the desktop app");
              const pathname = await ctx.eval("location.pathname");
              ctx.assert(typeof pathname === "string" && !pathname.startsWith("/dashboard"), `Join success redirected unexpectedly to ${pathname}.`);
            });
          },
          screenshot: {
            name: "maya-success-desktop-cta",
            requireText: ["Open OpenWork", "Download the desktop app", "Edit spreadsheets"],
            rejectText: ["Something went wrong"],
          },
        });
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The desktop welcome screen offers a Joining a team sign-in affordance", {
          voiceover: vo[4],
          action: async () => {
            useDesktopClient(ctx);
            await ensureDesktopReady(ctx);
            await showDesktopWelcome(ctx);
          },
          assert: async () => {
            useDesktopClient(ctx);
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"welcome-team-signin\"]'))", { timeoutMs: 30_000, label: "team sign-in affordance" });
            const label = await ctx.eval("document.querySelector('[data-testid=\"welcome-team-signin\"]')?.textContent?.trim() ?? ''");
            ctx.assert(label === "Joining a team? Sign in", `Unexpected welcome team sign-in label: ${label}`);
            const disabled = await ctx.eval("document.querySelector('[data-testid=\"welcome-team-signin\"]')?.disabled === true");
            ctx.assert(disabled === false, "Welcome team sign-in affordance is disabled.");
            ctx.output(
              "desktop-welcome-handler",
              "WelcomeRoute.handleTeamSignIn calls platform.openLink(buildDenAuthUrl(settings.baseUrl || DEFAULT_DEN_BASE_URL, 'sign-in')); buildDenAuthUrl adds desktopAuth=1 and desktopScheme=openwork in desktop builds.",
            );
          },
          screenshot: {
            name: "desktop-welcome-team-signin",
            requireText: ["Joining a team? Sign in"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Maya clicks Open OpenWork and the Electron app signs into Acme", {
          voiceover: vo[5],
          action: async () => {
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await stubClipboardCapture(ctx);
              await ctx.clickText("Copy sign-in link", { selector: "button", timeoutMs: 20_000 });
              state.copiedDesktopUrl = await ctx.waitFor(
                "typeof window.__capturedSignin === 'string' && window.__capturedSignin.startsWith('openwork://den-auth') && window.__capturedSignin",
                { timeoutMs: 30_000, label: "captured OpenWork sign-in link" },
              );
              const clicked = await ctx.eval(`(() => {
                const button = document.querySelector('[data-testid="join-org-open-openwork"]');
                button?.scrollIntoView({ block: "center" });
                button?.click();
                return Boolean(button);
              })()`);
              ctx.assert(clicked, "Open OpenWork button was not available on Maya's success page.");
            });

            useDesktopClient(ctx);
            await ensureDesktopReady(ctx);
            await resetDesktopDenSession(ctx);
            // Dev Electron does not register the OS openwork:// protocol handler;
            // this delivers the exact copied URL through the same renderer bridge
            // event shape used by the native deep-link bridge.
            await deliverDeepLinkToDesktop(ctx, requireStateValue(state.copiedDesktopUrl, "copied desktop sign-in URL"));
            ctx.output(
              "desktop-deep-link-delivery",
              "Dev Electron lacks OS protocol registration in evals, so the flow dispatches openwork:deep-link with { detail: { urls: [openworkUrl] } } — the same renderer bridge DenAuthProvider consumes.",
            );
          },
          assert: async () => {
            useDesktopClient(ctx);
            await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "persisted Den auth token" });
            await ctx.waitFor("(localStorage.getItem('openwork.den.activeOrgName') ?? '').includes('Acme Robotics')", { timeoutMs: 60_000, label: "Acme active org" });
            // The handoff sign-in routes the app into org onboarding; walk the
            // real journey (choose org -> resources -> workspace) before
            // asserting the signed-in account surface.
            await ctx.waitForText("Choose your organization", { timeoutMs: 45_000 });
            await ctx.expectText("Acme Robotics");
            await clickExactText(ctx, "Continue with organization", "button");
            await ctx.waitForText("You have access to the following resources.", { timeoutMs: 45_000 });
            await clickExactText(ctx, "Continue to workspace", "button");
            await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 45_000, label: "workspace route" });
            await ctx.navigateHash("/settings/cloud-account");
            await ctx.waitForText("Sign out", { timeoutMs: 45_000 });
            await ctx.expectText("Acme Robotics", { timeoutMs: 45_000 });
            await ctx.expectText(MAYA_EMAIL, { timeoutMs: 45_000 });
          },
          screenshot: {
            name: "desktop-signed-into-acme",
            requireText: ["Acme Robotics", MAYA_EMAIL, "Sign out"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await withClient(ctx, MOBILE_CDP_URL, async () => {
        await ctx.prove("Riley accepts the same Acme invite from a mobile browser", {
          voiceover: vo[6],
          action: async () => {
            await createInvitation(ctx, RILEY_EMAIL);
            const { html } = await getLatestDevEmail(ctx, "organizationInvite", RILEY_EMAIL);
            const invite = extractInviteFromHtml(html, ctx);
            state.rileyInviteToken = invite.token;
            state.rileyInviteLink = rewriteInviteLink(invite.link);
            await withClient(ctx, MOBILE_CDP_URL, async () => {
              await applyMobileEmulation(ctx);
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.rileyInviteLink, "Riley invite link"));
              await completeInviteSignup(ctx, RILEY_EMAIL, MEMBER_PASSWORD);
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", { timeoutMs: 45_000, label: "mobile join success" });
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-mobile-note\"]'))", { timeoutMs: 20_000, label: "mobile note" });
            });
          },
          assert: async () => {
            await withClient(ctx, MOBILE_CDP_URL, async () => {
              await ctx.expectText("You're in");
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-mobile-note\"]'))", { timeoutMs: 20_000, label: "mobile note" });
            });
          },
          screenshot: {
            name: "riley-mobile-success",
            requireText: ["You're in"],
            rejectText: ["Something went wrong"],
          },
        });
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await withClient(ctx, MOBILE_CDP_URL, async () => {
        await ctx.prove("Mobile success is honest: email the link, no dead-end app open or download buttons", {
          voiceover: vo[7],
          action: async () => {
            await withClient(ctx, MOBILE_CDP_URL, async () => {
              await applyMobileEmulation(ctx);
              await ctx.eval("document.querySelector('[data-testid=\"join-org-mobile-note\"]')?.scrollIntoView({ block: 'center' })");
              // Step through the page as a keyboard user would; the real Tab
              // keypress draws a :focus-visible ring on the primary action,
              // which also keeps this frame visually distinct from frame 7.
              await ctx.eval("document.body.focus()");
              for (let presses = 0; presses < 6; presses += 1) {
                await ctx.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
                await ctx.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
                const focused = await ctx.eval("document.activeElement?.getAttribute('data-testid') ?? ''");
                if (focused === "join-org-email-download") break;
              }
            });
          },
          assert: async () => {
            await withClient(ctx, MOBILE_CDP_URL, async () => {
              await applyMobileEmulation(ctx);
              await ctx.expectText("OpenWork runs on your computer.");
              await ctx.expectText("Email me the download link");
              await ctx.expectNoText("Open OpenWork");
              const hiddenDesktopButtons = await ctx.eval(`(() => {
                return document.querySelector('[data-testid="join-org-open-openwork"]') === null
                  && document.querySelector('[data-testid="join-org-download"]') === null;
              })()`);
              ctx.assert(hiddenDesktopButtons, "Mobile success rendered a desktop-only open or download button.");
            });
          },
          screenshot: {
            name: "riley-mobile-honest-next-step",
            requireText: ["OpenWork runs on your computer", "Email me the download link"],
            rejectText: ["Open OpenWork", "Download the desktop app", "Something went wrong"],
          },
        });
        });
      },
    },
    {
      name: "Frame 9",
      run: async (ctx) => {
        await withClient(ctx, MOBILE_CDP_URL, async () => {
        await ctx.prove("Riley's download-link email is sent and shows the desktop value", {
          voiceover: vo[8],
          action: async () => {
            await withClient(ctx, MOBILE_CDP_URL, async () => {
              await applyMobileEmulation(ctx);
              await clickSelector(ctx, '[data-testid="join-org-email-download"]', "email download button");
              await ctx.waitForText("Sent — check your inbox", { timeoutMs: 20_000 });
            });
          },
          assert: async () => {
            const { entry, html } = await getLatestDevEmail(ctx, "downloadLink", RILEY_EMAIL);
            ctx.assert(html.includes(DOWNLOAD_URL), `Download email is missing ${DOWNLOAD_URL}.`);
            ctx.assert(html.includes("Download OpenWork"), "Download email is missing its primary heading/CTA.");
            ctx.output("riley-download-email", JSON.stringify({ to: entry.to, subject: entry.subject }, null, 2));
            await withClient(ctx, MOBILE_CDP_URL, async () => {
              await applyMobileEmulation(ctx);
              await navigateToAbsolute(ctx, `${DEN_API_URL}/v1/dev/emails/last?template=downloadLink`);
              await ctx.waitForText("Download OpenWork", { timeoutMs: 20_000 });
              await ctx.expectText("Edit spreadsheets");
            });
          },
          screenshot: {
            name: "riley-download-email",
            requireText: ["Download OpenWork", "Edit spreadsheets"],
            rejectText: ["Something went wrong"],
          },
        });
        });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function rememberDesktopClient(ctx) {
  if (!state.desktopClient) {
    state.desktopClient = ctx.client;
  }
}

function useDesktopClient(ctx) {
  rememberDesktopClient(ctx);
  ctx.client = state.desktopClient;
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
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
    // Close the extra websocket so the runner process can exit cleanly.
    try {
      client.close();
    } catch {
      // Socket already gone.
    }
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

async function denApiFetch(path, options = {}) {
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
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function ensureAdminToken(ctx) {
  if (state.adminToken) {
    return state.adminToken;
  }
  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (signedIn.response.ok && typeof signedIn.body?.token === "string") {
    state.adminToken = signedIn.body.token;
    return state.adminToken;
  }
  const token = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? "";
  ctx.assert(token.length > 0, `Admin sign-in failed and OPENWORK_EVAL_DEN_TOKEN is missing: ${signedIn.response.status}`);
  state.adminToken = token;
  return token;
}

async function createInvitation(ctx, email) {
  const token = await ensureAdminToken(ctx);
  const invitation = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, role: "member" }),
  });
  ctx.assert(
    invitation.response.ok,
    `Invitation failed for ${email}: ${invitation.response.status} ${JSON.stringify(invitation.body).slice(0, 300)}`,
  );
  if (email === MAYA_EMAIL && typeof invitation.body?.inviteToken === "string") {
    state.mayaInviteToken = invitation.body.inviteToken;
    state.mayaInviteLink = rewriteInviteLink(`/join-org?invite=${encodeURIComponent(invitation.body.inviteToken)}`);
  }
  if (email === RILEY_EMAIL && typeof invitation.body?.inviteToken === "string") {
    state.rileyInviteToken = invitation.body.inviteToken;
    state.rileyInviteLink = rewriteInviteLink(`/join-org?invite=${encodeURIComponent(invitation.body.inviteToken)}`);
  }
  return invitation.body;
}

async function assertPendingInvitation(ctx, email) {
  const token = await ensureAdminToken(ctx);
  const org = await denApiFetch("/v1/org", {
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(org.response.ok, `Organization lookup failed: ${org.response.status}`);
  const invitations = Array.isArray(org.body?.invitations) ? org.body.invitations : [];
  const members = Array.isArray(org.body?.members) ? org.body.members : [];
  const invitation = invitations.find((entry) => entry?.email === email && entry?.status === "pending") ?? null;
  const pendingMember = members.find((member) => member?.user?.email === email && !member?.joinedAt) ?? null;
  ctx.assert(Boolean(invitation || pendingMember), `No pending invitation for ${email} in /v1/org.`);
  return invitation ?? pendingMember ?? {};
}

async function goToDenWeb(ctx, path) {
  await navigateToAbsolute(ctx, `${DEN_WEB_URL}${path}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${path}` });
}

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

async function signInToDenWeb(ctx, email, password) {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`,
    { awaitPromise: true },
  );
  await goToDenWeb(ctx, "/");
  await ctx.waitFor("document.body.innerText.includes('Sign in')", { timeoutMs: 30_000, label: "sign-in screen" });
  await clickExactText(ctx, "Sign in", "button, a");
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))", { timeoutMs: 15_000, label: "email input" });
  await ctx.fill('input[type="email"], input[name="email"]', email);
  await ctx.fill('input[type="password"]', password);
  await clickLastExactText(ctx, "Sign in", "button");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
  await ctx.eval(
    `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
}

async function clickExactText(ctx, text, selector) {
  const clicked = await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
  return clicked;
}

async function clickLastExactText(ctx, text, selector) {
  const clicked = await ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
  return clicked;
}

async function clickSelector(ctx, selector, label) {
  await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label });
}

async function completeInviteSignup(ctx, email, password) {
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "invite password field" });
  await ctx.fill('input[type="password"]', password);
  await ctx.clickText("Join Acme Robotics", { selector: "button", timeoutMs: 20_000 });
  await ctx.waitFor(
    `document.body.innerText.includes("You're one click away from the team workspace.") || Boolean(document.querySelector('[data-testid="join-org-success"]'))`,
    { timeoutMs: 45_000, label: "signed in invite accept step" },
  );
  const alreadySuccess = await ctx.eval("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))");
  if (!alreadySuccess) {
    await ctx.expectText(email, { timeoutMs: 20_000 });
    markEmailVerified(ctx, email);
    await ctx.clickText("Join Acme Robotics", { selector: "button", timeoutMs: 20_000 });
  }
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", { timeoutMs: 45_000, label: "join org success" });
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Invitation acceptance requires a verified email; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function getLatestDevEmail(ctx, template, expectedTo) {
  const listResponse = await fetch(`${DEN_API_URL}/v1/dev/emails?template=${encodeURIComponent(template)}`);
  const listText = await listResponse.text();
  ctx.assert(listResponse.ok, `Could not list ${template} emails: ${listResponse.status} ${listText.slice(0, 200)}`);
  const list = JSON.parse(listText);
  const emails = Array.isArray(list.emails) ? list.emails : [];
  const entry = emails.find((candidate) => candidate?.to === expectedTo) ?? null;
  ctx.assert(Boolean(entry), `No ${template} email found for ${expectedTo}.`);
  ctx.assert(emails[0]?.to === expectedTo, `Latest ${template} email is ${emails[0]?.to ?? "none"}, expected ${expectedTo}.`);

  const htmlResponse = await fetch(`${DEN_API_URL}/v1/dev/emails/last?template=${encodeURIComponent(template)}`);
  const html = await htmlResponse.text();
  ctx.assert(htmlResponse.ok, `Could not fetch latest ${template} email HTML: ${htmlResponse.status} ${html.slice(0, 200)}`);
  return { entry, html };
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function htmlHrefs(html) {
  const hrefs = [];
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    hrefs.push(decodeHtmlAttribute(match[1] ?? ""));
  }
  return hrefs;
}

function htmlText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockedDownloadOrInstallHrefs(html) {
  return htmlHrefs(html).filter((href) => {
    const lowerHref = href.toLowerCase();
    return lowerHref.includes("/install") || lowerHref.includes("openworklabs.com/download") || lowerHref.includes("download");
  });
}

function extractInviteFromHtml(html, ctx) {
  const absoluteMatch = html.match(/https?:\/\/[^"'<>\s]+\/join-org\?invite=[^"'<>\s]+/);
  const relativeMatch = html.match(/\/join-org\?invite=[^"'<>\s]+/);
  const rawLink = absoluteMatch?.[0] ?? relativeMatch?.[0] ?? "";
  const link = decodeHtmlAttribute(rawLink);
  ctx.assert(link.length > 0, "Invite email did not contain a /join-org?invite= link.");
  const parsed = new URL(link, DEN_WEB_URL);
  const token = parsed.searchParams.get("invite")?.trim() ?? "";
  ctx.assert(token.length > 0, `Invite link did not include an invite token: ${link}`);
  return { link: parsed.toString(), token };
}

function redactInviteLink(inviteLink) {
  try {
    const parsed = new URL(inviteLink, DEN_WEB_URL);
    if (parsed.searchParams.has("invite")) parsed.searchParams.set("invite", "[redacted]");
    return parsed.toString();
  } catch {
    return "invalid invite URL";
  }
}

async function redactInviteCredentialInPage(ctx, inviteToken) {
  const redacted = await ctx.eval(`(() => {
    const token = ${JSON.stringify(inviteToken ?? "")};
    const redactedInvite = ${JSON.stringify(`${DEN_WEB_URL}/join-org?invite=%5Bredacted%5D`)};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let redactedTextNodes = 0;
    let node = walker.nextNode();
    while (node) {
      const before = node.nodeValue ?? '';
      let after = before;
      if (token) after = after.split(token).join('[redacted]');
      after = after.replace(/([?&]invite=)[^&\\s<>"')]+/g, '$1[redacted]');
      if (after !== before) {
        node.nodeValue = after;
        redactedTextNodes += 1;
      }
      node = walker.nextNode();
    }
    let redactedLinks = 0;
    for (const link of document.querySelectorAll('a[href*="/join-org?invite="]')) {
      link.href = redactedInvite;
      link.setAttribute('href', redactedInvite);
      redactedLinks += 1;
    }
    const bodyContainsToken = token ? document.body.innerText.includes(token) : false;
    const hrefContainsToken = token ? [...document.querySelectorAll('a')].some((link) => link.href.includes(token) || (link.getAttribute('href') ?? '').includes(token)) : false;
    return { redactedTextNodes, redactedLinks, bodyContainsToken, hrefContainsToken };
  })()`);
  ctx.assert(redacted.redactedLinks > 0 && !redacted.bodyContainsToken && !redacted.hrefContainsToken, `Invite email evidence still exposes the invite credential: ${JSON.stringify(redacted)}.`);
}

function rewriteInviteLink(inviteLink) {
  // The local stack's trusted-origin used to render email links can differ from
  // the den-web origin the eval browser drives, so keep the path/search and
  // explicitly trust OPENWORK_EVAL_DEN_WEB_URL for the browser navigation.
  const parsed = new URL(inviteLink, DEN_WEB_URL);
  return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, DEN_WEB_URL).toString();
}

async function ensureDesktopReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API" });
}

async function showDesktopWelcome(ctx) {
  await ctx.eval(`(() => {
    const raw = localStorage.getItem('openwork.preferences');
    let prefs = {};
    try { prefs = raw ? JSON.parse(raw) : {}; } catch { prefs = {}; }
    localStorage.setItem('openwork.preferences', JSON.stringify({ ...prefs, hasCompletedOnboarding: false }));
    location.hash = '#/welcome';
    location.reload();
    return true;
  })()`);
  await ensureDesktopReady(ctx);
  await ctx.waitFor("location.hash.includes('/welcome')", { timeoutMs: 30_000, label: "welcome hash" });
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"welcome-team-signin\"]'))", { timeoutMs: 30_000, label: "welcome team sign-in" });
}

async function stubClipboardCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedSignin = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__capturedSignin = String(value);
          return Promise.resolve();
        },
      },
    });
    return true;
  })()`);
}

async function deliverDeepLinkToDesktop(ctx, openworkUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    const pending = window.__OPENWORK__.deepLinks || [];
    window.__OPENWORK__.deepLinks = [...pending, url];
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function resetDesktopDenSession(ctx) {
  await ctx.eval(`(() => {
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
    ]) {
      localStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { status: 'signed_out' } }));
    return true;
  })()`);
}

async function applyMobileEmulation(ctx) {
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await ctx.client.send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
}
