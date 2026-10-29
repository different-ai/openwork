import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { memoryRecord, rememberLastOrganization } from "../worlds/remember-last-organization.ts";

const test = spec.world(rememberLastOrganization, {
  resources: { surfaces: ["appWeb"], services: ["den"] },
  timeout: 900_000,
});

async function pasteSignIn(user: User, probe: Probe, grant: string) {
  await user.click({ testId: "account-status-menu" });
  // Wait for the menu to mount before reading its disclosure state; it can
  // remain expanded across a same-page sign-out/sign-in.
  await user.see({ role: "button", label: /^(?:Paste|Hide) sign-in code$/ });
  if (await probe.has("Paste sign-in code")) {
    await user.click({ role: "button", label: "Paste sign-in code" });
  }
  await user.see({ role: "textbox", label: "Sign-in link or one-time code" });
  // This is a disposable, single-use fixture grant, not a password. The real
  // paste field is intentionally plain text; capture only after it is consumed.
  await user.type({ role: "textbox", label: "Sign-in link or one-time code" }, grant, { replace: true });
  await user.click({ role: "button", label: "Finish sign-in" });
}

async function chooseOrganization(user: User, name: string) {
  await user.click({ role: "radio", label: new RegExp(name) });
  await user.click({ role: "button", label: "Continue with organization" });
  await user.click({ role: "button", label: /^Continue(?: to workspace)?$/ });
  await user.see("composer", { timeoutMs: 60_000 });
  await user.see({ role: "button", label: "Returning Member — account and status" });
}

async function openAccountSettings(user: User) {
  await user.press("Escape");
  await user.click({ testId: "account-status-menu" });
  await user.click({ role: "menuitem", label: "Settings" });
  await user.click({ role: "button", label: "Account" });
}

async function dismissAccountMenu(user: User, probe: Probe) {
  await user.press("Escape");
  // notSee checks absence immediately and continuously; first let the menu's
  // normal exit animation finish rather than treating that frame as a failure.
  await probe.eventually(() => probe.has("Log out"), {
    within: 5_000, label: "the account menu finishes closing", until: visible => !visible,
  });
  await user.notSee({ role: "menuitem", label: "Log out" });
}

async function signOut(user: User, probe: Probe) {
  // A successful same-page handoff can leave its dropdown open. Normalize it
  // after authentication finishes, rather than racing the asynchronous submit.
  await dismissAccountMenu(user, probe);
  await user.click({ testId: "account-status-menu" });
  await user.click({ role: "menuitem", label: "Log out" });
  await user.see({ role: "button", label: "Account and status" }, { timeoutMs: 30_000 });
}

test("a returning member reaches their last organization without choosing twice, but another account still chooses", async ({ world, user, probe, step, evidence }) => {
  const { organizationA: a, organizationB: b, organizationC: c, first, returningLogin, restored, anotherAccount } = world;

  await step("before: a member with several organizations and no preference chooses where to work", async () => {
    const directory = await probe.api(first.session, "/v1/me/orgs");
    const memberships = memoryRecord(directory.body);
    const orgs = memberships.orgs;
    expect(directory.response.ok).toBe(true);
    expect(Array.isArray(orgs) && orgs.length).toBe(3);
    await pasteSignIn(user, probe, first.grant);
    await user.see({ role: "heading", label: "Choose your organization" }, { timeoutMs: 60_000 });
    await user.see({ text: a.name });
    await user.see({ text: b.name });
    const chooser = await probe.has("Choose your organization");
    evidence.recordAssertionEvidence(
      "multiple memberships still require a first choice",
      `memberships=${Array.isArray(orgs) ? orgs.length : 0}; no feature overrides; chooser shown=${chooser}`,
      Array.isArray(orgs) && orgs.length === 3 && chooser,
    );
    await user.screenshot();
  });

  await step("when the member chooses Organization A, chat opens in A", async () => {
    await chooseOrganization(user, a.name);
    const selected = await probe.api(first.session, "/v1/me/orgs");
    const activeId = memoryRecord(selected.body).activeOrgId;
    evidence.recordAssertionEvidence("the explicit choice is active on the server", `chat visible; active organization is A=${activeId === a.id}`, selected.response.ok && activeId === a.id);
    expect(activeId).toBe(a.id);
    await user.screenshot();
  });

  await step("after: returning to Organization A goes straight to chat without a feature override", async () => {
    await signOut(user, probe);
    await pasteSignIn(user, probe, returningLogin.grant);
    await user.see("composer", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Returning Member — account and status" });
    await dismissAccountMenu(user, probe);
    await user.notSee({ role: "heading", label: "Choose your organization" });
    const directory = await probe.api(returningLogin.session, "/v1/me/orgs");
    const activeId = memoryRecord(directory.body).activeOrgId;
    const chooser = await probe.has("Choose your organization");
    evidence.recordAssertionEvidence("organization memory is generally available", `same account=${returningLogin.userId === first.userId}; new session=${returningLogin.session.token !== first.session.token}; server remains in A=${activeId === a.id}; chooser shown=${chooser}`, returningLogin.userId === first.userId && directory.response.ok && activeId === a.id && !chooser);
    expect(activeId).toBe(a.id);
    await user.screenshot();
  });

  await step("when the member switches to Organization C, chat opens in C", async () => {
    await openAccountSettings(user);
    await user.click({ role: "button", label: "Switch organization" });
    await user.see({ role: "heading", label: "Choose your organization" });
    await chooseOrganization(user, c.name);
    const selected = await probe.api(returningLogin.session, "/v1/me/orgs");
    const activeId = memoryRecord(selected.body).activeOrgId;
    evidence.recordAssertionEvidence("the explicitly selected organization is active", `chat visible; active organization is C=${activeId === c.id}`, selected.response.ok && activeId === c.id);
    expect(activeId).toBe(c.id);
    await user.screenshot();
  });

  await step("the member can still change organizations from Account settings", async () => {
    await openAccountSettings(user);
    await user.see({ text: c.name }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Switch organization" }, { timeoutMs: 30_000 });
    const available = await probe.has("Switch organization");
    evidence.recordAssertionEvidence("remembering an organization does not remove switching", `Account settings show C; Switch organization available=${available}`, available);
    await user.screenshot();
  });

  await step("canceling a switch keeps the current organization and returns to Account settings", async () => {
    await user.click({ role: "button", label: "Switch organization" });
    await user.see({ role: "heading", label: "Choose your organization" });
    await user.click({ role: "radio", label: new RegExp(b.name) });
    await user.see({ role: "button", label: "Cancel" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await user.see({ text: c.name }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Switch organization" });
    const selected = await probe.api(returningLogin.session, "/v1/me/orgs");
    const activeId = memoryRecord(selected.body).activeOrgId;
    const chooser = await probe.has("Choose your organization");
    evidence.recordAssertionEvidence("an unconfirmed choice never replaces C", `draft choice was B; after Cancel, C remains active=${activeId === c.id}; chooser shown=${chooser}`, selected.response.ok && activeId === c.id && !chooser);
    expect(activeId).toBe(c.id);
    await user.screenshot();
  });

  await step("when the member switches from C to B, chat opens in B", async () => {
    await user.click({ role: "button", label: "Switch organization" });
    await user.see({ role: "heading", label: "Choose your organization" });
    const beforeChoice = await probe.api(returningLogin.session, "/v1/me/orgs");
    const preservedId = memoryRecord(beforeChoice.body).activeOrgId;
    expect(preservedId).toBe(c.id);
    await chooseOrganization(user, b.name);
    const selected = await probe.api(returningLogin.session, "/v1/me/orgs");
    const activeId = memoryRecord(selected.body).activeOrgId;
    const fresh = await probe.api(restored.session, "/v1/me/orgs");
    const freshActiveId = memoryRecord(fresh.body).activeOrgId;
    evidence.recordAssertionEvidence("switching keeps C until the choice, then selects B", `C preserved while choosing=${preservedId === c.id}; chosen B=${activeId === b.id}; independent next session is A=${freshActiveId === a.id}`, beforeChoice.response.ok && selected.response.ok && fresh.response.ok && preservedId === c.id && activeId === b.id && freshActiveId === a.id);
    expect(activeId).toBe(b.id);
    expect(freshActiveId).toBe(a.id);
    await user.screenshot();
  });

  await step("after: the same member signs in again and returns straight to chat in B", async () => {
    await signOut(user, probe);
    await pasteSignIn(user, probe, restored.grant);
    await user.see("composer", { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Returning Member — account and status" });
    await dismissAccountMenu(user, probe);
    await user.notSee({ role: "heading", label: "Choose your organization" });
    const selected = await probe.eventually(async () => {
      const result = await probe.api(restored.session, "/v1/me/orgs");
      return { ok: result.response.ok, activeId: memoryRecord(result.body).activeOrgId };
    }, { within: 30_000, label: "the fresh server session follows the remembered organization", until: result => result.ok && result.activeId === b.id });
    const chooser = await probe.has("Choose your organization");
    evidence.recordAssertionEvidence("a fresh login restores B without another organization click", `same account=${restored.userId === first.userId}; new session=${restored.session.token !== returningLogin.session.token}; fresh session moved A → B=${selected.activeId === b.id}; chooser shown=${chooser}`, restored.userId === first.userId && selected.activeId === b.id && !chooser);
    expect(selected.activeId).toBe(b.id);
    await user.screenshot();
  });

  await step("another account using the same app still makes its own organization choice", async () => {
    await signOut(user, probe);
    await pasteSignIn(user, probe, anotherAccount.grant);
    await user.see({ role: "heading", label: "Choose your organization" }, { timeoutMs: 60_000 });
    await user.see({ text: a.name });
    await user.see({ text: b.name });
    const directory = await probe.api(anotherAccount.session, "/v1/me/orgs");
    const activeId = memoryRecord(directory.body).activeOrgId;
    const chooser = await probe.has("Choose your organization");
    evidence.recordAssertionEvidence("one account's remembered B does not select B for another account", `different verified account=${anotherAccount.userId !== first.userId}; server remains in A=${activeId === a.id}; chooser shown=${chooser}`, anotherAccount.userId !== first.userId && directory.response.ok && activeId === a.id && chooser);
    expect(anotherAccount.userId).not.toBe(first.userId);
    expect(activeId).toBe(a.id);
    await user.screenshot();
  });
});
