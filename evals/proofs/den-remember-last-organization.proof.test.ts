import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { denMemoryRecord, denRememberLastOrganization } from "../worlds/den-remember-last-organization.ts";

const test = spec.world(denRememberLastOrganization, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

async function signIn(user: User, account: DenSession) {
  await user.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
  await user.type({ role: "textbox", label: /^email$/i }, account.email);
  await user.click({ role: "button", label: "Next" });
  await user.see({ role: "textbox", label: /^password$/i });
  await user.type({ role: "textbox", label: /^password$/i }, account.password, { sensitive: true });
  await user.click({ role: "button", label: "Sign in" });
}

async function dashboard(user: User, name: string) {
  await user.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 60_000 });
  await user.see({ role: "button", label: new RegExp(name) });
  await user.notSee({ role: "heading", label: "Choose an organization" });
}

async function signOut(user: User) {
  await user.click({ testId: "workspace-switcher-trigger" });
  await user.click({ role: "button", label: "Sign out" });
  await user.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
}

async function workspaceName(probe: Probe) {
  const trigger = await probe.dom('[data-testid="workspace-switcher-trigger"]');
  return trigger.elements.map((element) => element.text).join(" ");
}

test("a returning Den web member opens their last organization while another account still chooses", async ({ world, user, probe, step, evidence }) => {
  const { organizationA: a, organizationB: b, first, anotherAccount } = world;

  await step("before: a member with two organizations and no preference still chooses where to work", async () => {
    const directory = await probe.api(first.session, "/v1/me/orgs");
    const orgs = denMemoryRecord(directory.body).orgs;
    expect(directory.response.ok).toBe(true);
    expect(Array.isArray(orgs) ? orgs.length : 0).toBe(2);
    await signIn(user, first.session);
    await user.see({ role: "heading", label: "Choose an organization" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: new RegExp(a.name) });
    await user.see({ role: "button", label: new RegExp(b.name) });
    const chooser = await probe.has("Choose an organization");
    evidence.recordAssertionEvidence("the first login has no guessed organization", `memberships=${Array.isArray(orgs) ? orgs.length : 0}; no feature overrides; chooser shown=${chooser}`, Array.isArray(orgs) && orgs.length === 2 && chooser);
    await user.screenshot();
  });

  await step("when the member chooses A, Den opens that explicit choice", async () => {
    await user.click({ role: "button", label: new RegExp(a.name) });
    await dashboard(user, a.name);
    const displayed = await workspaceName(probe);
    evidence.recordAssertionEvidence("the explicit choice opens A", `sidebar workspace=${displayed}`, displayed.includes(a.name));
    expect(displayed).toContain(a.name);
    await user.screenshot();
  });

  await step("after: returning to A opens the dashboard without a feature override", async () => {
    await signOut(user);
    await signIn(user, first.session);
    await dashboard(user, a.name);
    const chooser = await probe.has("Choose an organization");
    const displayed = await workspaceName(probe);
    evidence.recordAssertionEvidence("organization memory is generally available", `the same member signed in again; workspace=${displayed}; chooser shown=${chooser}`, !chooser && displayed.includes(a.name));
    expect(chooser).toBe(false);
    await user.screenshot();
  });

  await step("when the member switches to B, Den opens the explicit choice", async () => {
    await user.click({ testId: "workspace-switcher-trigger" });
    await user.see({ testId: "workspace-switcher-menu" });
    await user.click({ role: "button", label: new RegExp(b.name) });
    await dashboard(user, b.name);
    const displayed = await workspaceName(probe);
    evidence.recordAssertionEvidence("the new explicit choice opens B", `sidebar workspace=${displayed}`, displayed.includes(b.name));
    expect(displayed).toContain(b.name);
    await user.screenshot();
  });

  await step("the existing sidebar switcher still lets the member choose A and then B", async () => {
    await user.click({ testId: "workspace-switcher-trigger" });
    await user.see({ testId: "workspace-switcher-menu" });
    await user.click({ role: "button", label: new RegExp(a.name) });
    await dashboard(user, a.name);
    const chosenA = await workspaceName(probe);
    await user.click({ testId: "workspace-switcher-trigger" });
    await user.click({ role: "button", label: new RegExp(b.name) });
    await dashboard(user, b.name);
    const chosenB = await workspaceName(probe);
    evidence.recordAssertionEvidence("remembering does not remove explicit switching", `sidebar selected A then B; both choices displayed=${chosenA.includes(a.name) && chosenB.includes(b.name)}`, chosenA.includes(a.name) && chosenB.includes(b.name));
    expect(chosenA).toContain(a.name);
    expect(chosenB).toContain(b.name);
    await user.screenshot();
  });

  await step("after: the same member signs in again and opens B without another organization click", async () => {
    await signOut(user);
    await signIn(user, first.session);
    await dashboard(user, b.name);
    await user.reload();
    await dashboard(user, b.name);
    const chooser = await probe.has("Choose an organization");
    const displayed = await workspaceName(probe);
    const independent = await probe.api(world.freshSessionInA, "/v1/me/orgs");
    const independentActiveId = denMemoryRecord(independent.body).activeOrgId;
    evidence.recordAssertionEvidence("the verified account remembers B rather than inheriting a server-wide default", `sidebar workspace=${displayed} after fresh sign-in and reload; chooser shown=${chooser}; independent fresh server session remains A=${independentActiveId === a.id}`, !chooser && displayed.includes(b.name) && independent.response.ok && independentActiveId === a.id);
    expect(chooser).toBe(false);
    expect(displayed).toContain(b.name);
    expect(independentActiveId).toBe(a.id);
    await user.screenshot();
  });

  await step("another account in the same browser still chooses its own organization", async () => {
    await signOut(user);
    await signIn(user, anotherAccount.session);
    await user.see({ role: "heading", label: "Choose an organization" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: new RegExp(a.name) });
    await user.see({ role: "button", label: new RegExp(b.name) });
    const chooser = await probe.has("Choose an organization");
    const sidebar = await workspaceName(probe);
    evidence.recordAssertionEvidence("the previous account's B is never inherited", `different verified account=${anotherAccount.userId !== first.userId}; chooser shown=${chooser}; active sidebar workspace shown=${sidebar.length > 0}`, anotherAccount.userId !== first.userId && chooser && sidebar.length === 0);
    expect(chooser).toBe(true);
    expect(sidebar).toBe("");
    await user.screenshot();
  });
});
