import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "email-invites-remove-download-link";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_TOKEN = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? "";
const RUN_TAG = Date.now().toString(36);
const INVITEE_EMAIL = `maya.invite+${RUN_TAG}@acme.test`;

const REMOVED_EMAIL_TEXT = [
  "Download the desktop app",
  "Download OpenWork",
  "Edit spreadsheets",
  "Control your browser",
  "Organize files",
  "Automate tasks",
  "desktop app",
  "Open OpenWork",
  "Install OpenWork",
  "Install the desktop app",
];

const state = {
  invitationCreated: false,
  inviteLink: null,
  inviteToken: null,
  renderedEmailHtml: null,
  latestEmailEntry: null,
  inviterEmail: null,
  inviterName: null,
  organizationName: null,
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function denApiOrigin() {
  return new URL(DEN_API_URL).origin;
}

function authHeaders() {
  return { authorization: `Bearer ${DEN_TOKEN}` };
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

async function denApiFetch(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("origin", denApiOrigin());
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${DEN_API_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function loadOrganization(ctx) {
  const org = await denApiFetch("/v1/org", { headers: authHeaders() });
  witness(ctx, org.response.ok, "Alex can load the organization", {
    status: org.response.status,
    organization: { id: org.body?.organization?.id, name: org.body?.organization?.name },
  });
  state.organizationName = org.body?.organization?.name ?? null;
  witness(ctx, Boolean(state.organizationName), "The invitation identifies its workspace", state.organizationName);
  rememberInviter(ctx, org.body);
  return org;
}

function rememberInviter(ctx, orgBody) {
  const members = Array.isArray(orgBody?.members) ? orgBody.members : [];
  const currentMemberId = orgBody?.currentMember?.id;
  const currentUserId = orgBody?.currentMember?.userId;
  const currentMember = members.find((member) => member?.id === currentMemberId || member?.user?.id === currentUserId) ?? null;
  const owner = orgBody?.organization?.owner ?? null;
  const inviterEmail = currentMember?.user?.email ?? owner?.email ?? "";
  const inviterName = currentMember?.user?.name ?? owner?.name ?? inviterEmail;
  state.inviterEmail = inviterEmail;
  state.inviterName = inviterName;
  witness(ctx, inviterEmail.includes("@"), "The Den token resolves to an inviter email for the invite email", {
    inviterEmail,
    inviterName,
  });
}

async function createInvitation(ctx) {
  if (state.invitationCreated) return;
  await loadOrganization(ctx);
  const created = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: INVITEE_EMAIL, role: "member" }),
  });
  witness(ctx, created.response.ok, "Maya's invitation is created through POST /v1/invitations", {
    status: created.response.status,
    email: created.body?.email,
    role: created.body?.role,
    inviteTokenLength: typeof created.body?.inviteToken === "string" ? created.body.inviteToken.length : 0,
    error: created.body?.error,
  });
  witness(ctx, created.body?.email === INVITEE_EMAIL, "The invitation API returns Maya's email", created.body?.email);
  witness(ctx, created.body?.role === "member", "The invitation API assigns Maya the member role", created.body?.role);
  if (typeof created.body?.inviteToken === "string") state.inviteToken = created.body.inviteToken;
  state.invitationCreated = true;
  await assertPendingInvitation(ctx);
}

async function ensureInvitationEmail(ctx) {
  if (state.renderedEmailHtml && state.latestEmailEntry) {
    return { entry: state.latestEmailEntry, html: state.renderedEmailHtml, inviteLink: state.inviteLink, inviteToken: state.inviteToken };
  }
  await createInvitation(ctx);
  const email = await latestInvitationEmail(ctx);
  state.inviteLink = email.inviteLink;
  state.inviteToken = email.inviteToken;
  state.renderedEmailHtml = email.html;
  state.latestEmailEntry = email.entry;
  ctx.output("organization-invite-email", JSON.stringify({
    to: email.entry?.to,
    subject: email.entry?.subject,
    acceptLink: redactInviteUrl(email.inviteLink),
  }, null, 2));
  return email;
}

async function navigateTo(ctx, url) {
  await ctx.eval(`location.assign(${JSON.stringify(url)}); true`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${url}` });
}

async function withGenericBrowser(ctx, fn) {
  const cdpBaseUrl = cleanBaseUrl(ctx.cdpBaseUrl ?? process.env.OPENWORK_EVAL_CDP_URL);
  witness(ctx, cdpBaseUrl.length > 0, "A generic CDP browser endpoint is available for rendered-email screenshots", cdpBaseUrl || "missing --cdp-url/OPENWORK_EVAL_CDP_URL");
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
  if (page) return page;

  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) response = await fetch(`${base}/json/new?about:blank`);
  if (!response.ok) throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);

  const created = await response.json();
  if (created?.type === "page" && created.webSocketDebuggerUrl) return created;
  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) throw new Error(`No page target available at ${cdpBaseUrl}.`);
  return nextPage;
}

async function assertPendingInvitation(ctx) {
  const org = await loadOrganization(ctx);
  const invitations = Array.isArray(org.body?.invitations) ? org.body.invitations : [];
  const pending = invitations.find((entry) => entry?.email === INVITEE_EMAIL && entry?.status === "pending") ?? null;
  witness(ctx, Boolean(pending), "Maya's invitation is pending in /v1/org", {
    pending: pending ? { id: pending.id, email: pending.email, role: pending.role, status: pending.status } : null,
  });
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
  for (const match of html.matchAll(/\bhref=(["'])(.*?)\1/g)) {
    hrefs.push(decodeHtmlAttribute(match[2] ?? ""));
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

function extractInviteFromHtml(html, ctx) {
  const hrefLink = htmlHrefs(html).find((href) => {
    try {
      const parsed = new URL(href, denApiOrigin());
      return parsed.pathname === "/join-org" && parsed.searchParams.has("invite");
    } catch {
      return false;
    }
  }) ?? "";
  const absoluteMatch = html.match(/https?:\/\/[^"'<>\s]+\/join-org\?invite=[^"'<>\s]+/);
  const relativeMatch = html.match(/\/join-org\?invite=[^"'<>\s]+/);
  const rawLink = hrefLink || absoluteMatch?.[0] || relativeMatch?.[0] || "";
  const link = decodeHtmlAttribute(rawLink);
  witness(ctx, link.length > 0, "The invitation email contains an Accept invite join link", redactInviteUrl(link));
  const parsed = new URL(link, denApiOrigin());
  const token = parsed.searchParams.get("invite")?.trim() ?? "";
  const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, denApiOrigin());
  witness(ctx, normalized.origin === denApiOrigin(), "The invite link is parsed against the Den API origin", { origin: normalized.origin, pathname: normalized.pathname });
  witness(ctx, parsed.pathname === "/join-org", "The invite email CTA targets the join page", parsed.pathname);
  witness(ctx, token.length >= 8, "The invite link carries an opaque invite credential", token.length);
  return { link: normalized.toString(), token };
}

function redactInviteUrl(value) {
  try {
    const url = new URL(value, denApiOrigin());
    if (url.searchParams.has("invite")) url.searchParams.set("invite", "[redacted]");
    return new URL(`${url.pathname}${url.search}${url.hash}`, denApiOrigin()).toString();
  } catch {
    return "invalid invite URL";
  }
}

async function latestInvitationEmail(ctx) {
  const list = await denApiFetch("/v1/dev/emails?template=organizationInvite");
  const emails = Array.isArray(list.body?.emails) ? list.body.emails : [];
  const emailSummaries = emails.map((entry) => ({ template: entry?.template, to: entry?.to, subject: entry?.subject, at: entry?.at }));
  witness(ctx, list.response.ok && emails.some((entry) => entry?.to === INVITEE_EMAIL), "The dev outbox contains Maya's resulting organizationInvite email", emailSummaries);
  witness(ctx, emails[0]?.to === INVITEE_EMAIL, "Maya's invitation is the newest rendered organization email", emailSummaries[0]);

  const response = await fetch(`${DEN_API_URL}/v1/dev/emails/last?template=organizationInvite`);
  const html = await response.text();
  witness(ctx, response.ok, "The rendered invitation email is available", response.status);
  const invite = extractInviteFromHtml(html, ctx);
  return { entry: emails[0], html, inviteLink: invite.link, inviteToken: invite.token };
}

function assertInviteEmailPresence(ctx, html) {
  const text = htmlText(html);
  const organizationName = state.organizationName ?? "";
  witness(ctx, organizationName.length > 0 && text.includes(`Join ${organizationName}`), "The invitation email names its workspace", `Join ${organizationName}`);
  witness(ctx, text.includes("Accept invite"), "The invitation email keeps the accept action", "Accept invite");
  const inviterEmail = state.inviterEmail ?? "";
  witness(ctx, inviterEmail.length > 0 && text.includes(inviterEmail), "The invitation email includes inviter email details", inviterEmail);
  const inviterName = state.inviterName ?? "";
  if (inviterName && inviterName !== inviterEmail) {
    witness(ctx, text.includes(inviterName), "The invitation email includes inviter name details", inviterName);
  }
  witness(ctx, text.includes(`invited you to join ${organizationName}`), "The invitation email explains who is inviting Maya to the workspace", organizationName);
}

function assertRemovedDesktopCopy(ctx, html) {
  const lowerHtml = html.toLowerCase();
  for (const removedText of REMOVED_EMAIL_TEXT) {
    witness(ctx, !lowerHtml.includes(removedText.toLowerCase()), `The invitation email omits desktop/download copy: ${removedText}`, "absent");
  }
  witness(ctx, !lowerHtml.includes("/install?token="), "The invitation email has no organization install token link", "absent");
  witness(ctx, !lowerHtml.includes("openworklabs.com/download"), "The invitation email has no generic desktop download link", "absent");

  const blockedLinks = htmlHrefs(html).filter((href) => {
    const lowerHref = href.toLowerCase();
    return lowerHref.includes("/install") || lowerHref.includes("openworklabs.com/download") || lowerHref.includes("download") || lowerHref.includes("openwork://");
  });
  witness(ctx, blockedLinks.length === 0, "The invitation email contains no download or install hrefs", blockedLinks);
}

async function showRenderedInvitationEmail(ctx, placement) {
  await navigateTo(ctx, `${DEN_API_URL}/v1/dev/emails/last?template=organizationInvite`);
  await ctx.waitForText("Accept invite", { timeoutMs: 20_000 });
  await redactInviteCredentialInPage(ctx);
  await frameRenderedEmail(ctx, placement);
}

async function frameRenderedEmail(ctx, placement) {
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 360,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (placement === "top") {
    await ctx.eval("window.scrollTo(0, 0); true");
    await ctx.waitFor("window.scrollY === 0", { timeoutMs: 5_000, label: "email top framed" });
    return;
  }

  const framed = await ctx.eval(`(() => {
    const candidates = [...document.querySelectorAll('p, a')];
    const lower = candidates.find((element) => (element.textContent ?? '').includes('If the button does not work')) ?? candidates.at(-1);
    lower?.scrollIntoView({ block: 'center' });
    return {
      found: Boolean(lower),
      text: (lower?.textContent ?? '').trim().slice(0, 120),
      scrollY: window.scrollY,
      maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    };
  })()`);
  witness(ctx, framed.found && framed.maxScroll > 0 && framed.scrollY > 0, "The lower invite email content is framed for the absence proof", framed);
}

async function redactInviteCredentialInPage(ctx) {
  const redacted = await ctx.eval(`(() => {
    const token = ${JSON.stringify(state.inviteToken ?? "")};
    const redactedInvite = ${JSON.stringify(new URL("/join-org?invite=%5Bredacted%5D", denApiOrigin()).toString())};
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
  witness(ctx, redacted.redactedLinks > 0 && !redacted.bodyContainsToken && !redacted.hrefContainsToken, "Published email evidence redacts the invitation credential", redacted);
}

export default {
  id: FLOW_ID,
  title: "Invitation emails stay focused on joining the workspace",
  kind: "user-facing",
  requiresApp: false,
  preserveTheme: true,
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await withGenericBrowser(ctx, async () => {
          await loadOrganization(ctx);
            await ctx.prove("Alex sends Maya a workspace invitation and the real email names that workspace", {
            voiceover: vo[0],
            action: async () => {
              await ensureInvitationEmail(ctx);
              await showRenderedInvitationEmail(ctx, "top");
            },
            assert: async () => {
              await assertPendingInvitation(ctx);
              assertInviteEmailPresence(ctx, state.renderedEmailHtml ?? "");
              await ctx.expectText(`Join ${state.organizationName}`);
              await ctx.expectText("Accept invite");
              await ctx.expectText(state.inviterEmail ?? "");
            },
            screenshot: { name: "email-invite-join-action", requireText: [`Join ${state.organizationName}`, "Accept invite", state.inviterEmail ?? ""] },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withGenericBrowser(ctx, async () => {
          await ctx.prove("Maya's real invitation email is join-focused and has no desktop download link", {
            voiceover: vo[1],
            action: async () => {
              await ensureInvitationEmail(ctx);
              await showRenderedInvitationEmail(ctx, "lower");
            },
            assert: async () => {
              assertRemovedDesktopCopy(ctx, state.renderedEmailHtml ?? "");
              await ctx.expectText("If the button does not work");
              for (const removedText of REMOVED_EMAIL_TEXT) {
                await ctx.expectNoText(removedText);
              }
              const blockedLinks = await ctx.eval(`(() => [...document.querySelectorAll('a')]
                .map((link) => link.href)
                .filter((href) => {
                  const lowerHref = href.toLowerCase();
                  return lowerHref.includes('/install') || lowerHref.includes('openworklabs.com/download') || lowerHref.includes('download') || lowerHref.includes('openwork://');
                }))()`);
              witness(ctx, blockedLinks.length === 0, "The rendered email page has no download or install links", blockedLinks);
            },
            screenshot: {
              name: "email-invite-no-desktop-downloads",
              requireText: ["If the button does not work", "[redacted]"],
              rejectText: REMOVED_EMAIL_TEXT,
            },
          });
        });
      },
    },
  ],
};
