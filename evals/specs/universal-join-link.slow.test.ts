import { expect } from "vitest";
import {
  captureOpenedUrls,
  clickButton,
  clickText,
  completeDesktopHandoff,
  denFetch,
  evalIn,
  fill,
  visibleText,
  waitFor,
  waitForText,
  waitUntilInteractive,
} from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/fraimz";
import { chrome, desktop } from "@openwork/hosts";
import { localMysqlIsRunning, server, test } from "@openwork/testkit";

/**
 * UNIVERSAL JOIN LINK — the invite link is the only artifact a teammate needs.
 *
 * Voice-over (the demo this spec encodes):
 *  1. An admin invites a new teammate to Acme Robotics. The invite link is the
 *     only thing the teammate receives — no install link, no server URL, no
 *     token.
 *  2. The teammate opens a fresh OpenWork, opens the account menu in the
 *     sidebar, and picks "Join your organization". Garbage input is refused
 *     in place; the invite link is recognized.
 *  3. The app looks the invite up, names the organization, and hands the
 *     teammate to the browser — already on the org's join page, with the
 *     desktop return flags set.
 *  4. In the browser the teammate creates their account and joins with one
 *     click. The org welcomes them.
 *  5. One click — "Return to OpenWork" — hands a one-time grant back to the
 *     app, which signs in with the new org active. The browser confirms the
 *     app took the handoff.
 *
 * Faithfulness notes:
 *  - The browser hop is real: the URL asserted is the one the app handed to
 *    the OS (captured by the product's cross-platform eval seam
 *    OPENWORK_OPEN_EXTERNAL_CAPTURE_FILE plus the Linux xdg-open PATH shim).
 *  - Only the OS protocol dispatch of `openwork://den-auth?grant=…` is
 *    bridged (spawned eval apps register no protocol handler). The grant is
 *    the real one Den minted for the browser session, read from the web app's
 *    own persisted copy, and handed to the product's documented entry point
 *    for exactly this case (`auth.exchange-grant`).
 */

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1";
const reuseDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const mysqlOpen = reuseDen || await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "universal join link skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in"
  : !localPlacement
    ? "universal join link skipped: this spec drives a local desktop and browser; unset OPENWORK_EVAL_DAYTONA"
    : !mysqlOpen
      ? "universal join link skipped: run pnpm dev:den:mysql (or set OPENWORK_EVAL_DEN_API_URL)"
      : "an invite link pasted into a fresh app signs the teammate into the org through one browser hop";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

async function readOrganizationContext(admin: DenSession): Promise<{ result: DenFetchResult; invitations: Record<string, unknown>[]; members: Record<string, unknown>[] }> {
  const result = await denFetch(admin, "/v1/org", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  const invitations = isRecord(result.body) && Array.isArray(result.body.invitations)
    ? result.body.invitations.filter(isRecord)
    : [];
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  return { result, invitations, members };
}

/**
 * Emails of members who actually joined. Pending invitations surface as
 * placeholder member rows (no user, no joinedAt) so admins can see and manage
 * them — those must not count as memberships here.
 */
function activeMemberEmails(members: Record<string, unknown>[]): string[] {
  return members
    .filter((member) => Boolean(member.joinedAt) && Boolean(member.userId))
    .map((member) => stringAt(member, "user", "email") ?? "")
    .filter((email) => email.length > 0);
}

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ place }) => {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = "Acme Robotics";
  const inviteeEmail = `riley.invited+${stamp}@openwork.test`;
  const inviteePassword = "OpenWorkEval123!";

  await using den = await server({
    place,
    org: {
      name: orgName,
      admin: { email: `acme.admin+${stamp}@openwork.test`, name: "Acme Admin" },
      members: {},
    },
  });

  // ── 1. The admin invites the teammate; the link is the only artifact. ──────
  const invited = await denFetch(den.admin, "/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ email: inviteeEmail, role: "member" }),
  });
  const inviteToken = stringAt(invited.body, "inviteToken");
  expect(invited.response.status, `invitation create failed: ${invited.text.slice(0, 500)}`).toBe(201);
  expect(inviteToken, "the invitation response must carry the invite token").toBeTruthy();
  if (!inviteToken) throw new Error("unreachable");
  const inviteLink = `${den.ref.webUrl}/join-org?invite=${inviteToken}`;

  // The link previews publicly (what the app will rely on), and the teammate
  // is not a member yet — the negative half of every claim that follows.
  const preview = await fetch(`${den.ref.webUrl}/api/den/v1/orgs/invitations/preview?id=${inviteToken}`);
  const previewBody: unknown = await preview.json();
  expect(preview.status).toBe(200);
  expect(stringAt(previewBody, "invitation", "status")).toBe("pending");
  expect(stringAt(previewBody, "organization", "name")).toBe(orgName);
  {
    const before = await readOrganizationContext(den.admin);
    expect(before.result.response.ok, before.result.text.slice(0, 300)).toBe(true);
    expect(activeMemberEmails(before.members)).not.toContain(inviteeEmail);
  }

  // ── 2. A fresh app; the teammate pastes the invite link. ───────────────────
  const capture = await captureOpenedUrls();
  await using app = await desktop({
    name: "universal-join-link",
    bootstrap: { baseUrl: den.ref.webUrl, apiBaseUrl: den.ref.webUrl, requireSignin: false },
    env: capture.env,
  });

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A fresh OpenWork app is visible with a Sign in entry in the sidebar",
      "No error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // The account menu in the sidebar offers the join entry for signed-out use.
  await waitFor(app, `Boolean(document.querySelector('[data-testid="account-status-menu"]'))`, {
    timeoutMs: 60_000,
    label: "sidebar account menu trigger",
  });
  await evalIn(app, `document.querySelector('[data-testid="account-status-menu"]').click()`);
  await clickText(app, "Join your organization", { timeoutMs: 30_000, selector: "[role=menuitem], button, [role=button]" });
  await waitFor(app, `Boolean(document.querySelector('#join-organization-input'))`, {
    timeoutMs: 30_000,
    label: "join organization dialog input",
  });

  // The dialog renders in a portal whose text does not surface through
  // document.body.innerText, so its content is asserted via textContent.
  const dialogText = `(document.querySelector('[role="dialog"]')?.textContent ?? "")`;

  // Garbage is refused in place, before any browser opens.
  await fill(app, "#join-organization-input", "nope");
  await clickButton(app, "Connect", { timeoutMs: 30_000 });
  await waitFor(app, `${dialogText}.includes("That does not look like")`, {
    timeoutMs: 30_000,
    label: "the dialog refuses garbage input",
  });
  expect(await capture.opened()).toEqual([]);

  // ── 3. The real link: the app names the org and hands off to the browser. ──
  await fill(app, "#join-organization-input", inviteLink);
  await clickButton(app, "Connect", { timeoutMs: 30_000 });
  await waitFor(app, `${dialogText}.includes(${JSON.stringify(`Finish joining ${orgName} in your browser`)})`, {
    timeoutMs: 60_000,
    label: "the dialog names the org and waits for the browser",
  });
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      `The join dialog says to finish joining ${orgName} in the browser`,
      "The dialog shows a waiting state rather than an error",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const openedUrl = await capture.waitForUrl(
    (url) => url.includes("/join-org") && url.includes("desktopAuth=1"),
    { timeoutMs: 60_000 },
  );
  const opened = new URL(openedUrl);
  expect(opened.origin, `the app opened a foreign origin: ${openedUrl}`).toBe(new URL(den.ref.webUrl).origin);
  expect(opened.searchParams.get("invite")).toBe(inviteToken);
  expect(opened.searchParams.get("desktopScheme")).toBe("openwork");

  // ── 4. The teammate signs up and joins in a real browser. ──────────────────
  await using browser = await chrome({ name: "universal-join-link", startUrl: "about:blank" });
  await evalIn(browser, `window.location.href = ${JSON.stringify(openedUrl)}`);
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(orgName)})
    && document.body.innerText.includes(${JSON.stringify(inviteeEmail)})`, {
    timeoutMs: 90_000,
    label: "join page previews the org and the invited email",
  });
  // The panel resolves the sign-in method for the invited email first; the
  // account form is the settled state worth claiming.
  await waitFor(browser, `Boolean(document.querySelector('input[autocomplete="name"]'))
    && Boolean(document.querySelector('input[type="password"]'))`, {
    timeoutMs: 90_000,
    label: "account creation form for the invited email",
  });
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      `A join page shows an invitation to ${orgName} for ${inviteeEmail}`,
      "An account creation form or sign-in step is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // The invited email is locked in — only name and password are asked for.
  await fill(browser, 'input[autocomplete="name"]', "Riley Invited", { timeoutMs: 60_000 });
  await fill(browser, 'input[type="password"]', inviteePassword);
  const submitted = await evalIn(browser, `(() => {
    const form = document.querySelector('input[type="password"]')?.closest("form");
    const submit = form?.querySelector('button[type="submit"]');
    if (!(submit instanceof HTMLButtonElement) || submit.disabled) return false;
    submit.click();
    return true;
  })()`);
  expect(submitted, "the sign-up form must be submittable").toBe(true);

  const joinLabel = `Join ${orgName}`;
  await waitFor(browser, `Boolean([...document.querySelectorAll("button")]
    .find((element) => (element.textContent ?? "").trim() === ${JSON.stringify(joinLabel)} && !element.disabled))`, {
    timeoutMs: 90_000,
    label: "the one-click join button after account creation",
  });
  await clickButton(browser, joinLabel, { timeoutMs: 30_000 });
  await waitForText(browser, "You're in", { timeoutMs: 90_000 });
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      `A success screen welcomes the person to ${orgName}`,
      "A 'Return to OpenWork' action is offered",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // Server truth: the invitation is accepted and the membership exists now.
  {
    const after = await readOrganizationContext(den.admin);
    expect(activeMemberEmails(after.members)).toContain(inviteeEmail);
    const invitation = after.invitations.find((entry) => stringAt(entry, "email") === inviteeEmail);
    expect(invitation, "the invitation must still be listed for the admin").toBeDefined();
    expect(stringAt(invitation, "status")).toBe("accepted");
  }

  // The app is still signed out: joining happened in the browser only.
  expect(await evalIn(app, `window.localStorage.getItem("openwork.den.authToken")`)).toBeNull();

  // ── 5. "Return to OpenWork": the one-time grant signs the app in. ──────────
  await clickButton(browser, "Return to OpenWork", { timeoutMs: 30_000 });
  const storedGrant = await waitFor(browser, `(() => {
    const raw = window.localStorage.getItem("openwork.den.lastHandoffGrant");
    if (!raw) return false;
    try { return JSON.parse(raw).grant || false; } catch { return false; }
  })()`, { timeoutMs: 60_000, label: "the grant Den minted for this browser session" });
  if (typeof storedGrant !== "string" || !storedGrant) throw new Error("No handoff grant was persisted by the web app.");

  // Bridge only the OS protocol dispatch of the deep link the web app opened.
  const exchanged = await completeDesktopHandoff(
    app,
    `openwork://den-auth?grant=${encodeURIComponent(storedGrant)}&denBaseUrl=${encodeURIComponent(den.ref.webUrl)}`,
    den.ref.webUrl,
  );
  expect(exchanged).toBe(storedGrant);

  await waitFor(app, `Boolean(window.localStorage.getItem("openwork.den.authToken"))`, {
    timeoutMs: 90_000,
    label: "the app holds a Den session after the handoff",
  });
  await waitFor(app, `window.localStorage.getItem("openwork.den.activeOrgName") === ${JSON.stringify(orgName)}`, {
    timeoutMs: 90_000,
    label: "the joined organization is the app's active organization",
  });
  await waitUntilInteractive(app, { timeoutMs: 120_000 });
  const signedInText = await visibleText(app);
  expect(
    signedInText.includes(orgName) || /onboarding|organization|workspace/i.test(signedInText),
    `the app does not look signed in to the org. Visible: ${signedInText.slice(0, 400)}`,
  ).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The app is signed in and shows an organization or onboarding surface",
      "No sign-in failure or error message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // The browser confirms the app actually took the handoff — the grant is
  // consumed, so the same link cannot sign anything else in.
  await waitForText(browser, `Connected — ${orgName} is ready in OpenWork`, { timeoutMs: 60_000 });
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      `The browser reports that ${orgName} is ready in OpenWork`,
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
