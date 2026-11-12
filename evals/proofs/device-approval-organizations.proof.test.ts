import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deviceApprovalOrganizations } from "../worlds/device-approval-organizations.ts";

const test = spec.world(deviceApprovalOrganizations, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

test("a member explicitly chooses a remote computer's organization without changing existing terminal consent", async ({ world, user, probe, step, evidence }) => {
  const browser = user.on(world.web);
  const browserProbe = probe.on(world.web);
  const singleBrowser = user.on(world.singleWeb);

  await step("before: a member with two organizations cannot approve the active organization by accident", async () => {
    await browser.navigate(world.desktop.url);
    await browser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 90_000 });
    await browser.see({ text: "Choose an organization" });
    expect((await browserProbe.dom('[data-testid="device-approve"][disabled]')).elements).toHaveLength(1);
    expect(await world.browserOrganizationId()).toBe(world.orgA.id);
    const pending = await world.desktop.redeem();
    expect(pending.error).toBe("authorization_pending");
    expect(pending.sessionIssued).toBe(false);
    evidence.recordAssertionEvidence("Multiple organizations require an explicit choice", "browser active organization=A; placeholder=Choose an organization; Approve disabled; device has no session", pending.error === "authorization_pending" && !pending.sessionIssued);
    await browser.screenshot();
  });

  await step("the member chooses organization B and only then can approve that computer", async () => {
    await browser.click({ role: "button", label: "Organization" });
    await browser.click({ role: "option", label: world.orgB.name });
    await browser.see({ testId: "device-desktop-consent-line" }, { text: new RegExp(world.orgB.name) });
    const enabled = (await browserProbe.dom('[data-testid="device-approve"]:not([disabled])')).elements.length;
    const browserOrganizationId = await world.browserOrganizationId();
    expect(enabled).toBe(1);
    expect(browserOrganizationId).toBe(world.orgA.id);
    evidence.recordAssertionEvidence("Consent follows the explicit organization choice", "Approve enabled; computer consent names organization B; browser active organization remains A", enabled === 1 && browserOrganizationId === world.orgA.id);
    await browser.screenshot();
    await browser.click({ role: "button", label: "Approve" });
    await browser.see({ text: "Return to the OpenWork app on that computer." }, { timeoutMs: 30_000 });
  });

  await step("after: the device receives organization B while the approving browser stays in A", async () => {
    const session = await probe.eventually(() => world.desktop.redeem(), {
      within: 30_000, intervalMs: 5_000, label: "the device receives its approved organization", until: value => value.status === 200,
    });
    expect(session.sessionIssued).toBe(true);
    expect(session.organizationId).toBe(world.orgB.id);
    expect(await world.browserOrganizationId()).toBe(world.orgA.id);
    await browser.see({ text: "Return to the OpenWork app on that computer." });
    evidence.recordAssertionEvidence("Approval changes only the remote computer's organization", `device HTTP ${session.status}; device organization=B; approving browser organization=A`, session.sessionIssued && session.organizationId === world.orgB.id);
    await browser.screenshot();
  });

  await step("a member with one organization sees it selected with no organization picker", async () => {
    await singleBrowser.navigate(world.single.url);
    await singleBrowser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 90_000, text: new RegExp(world.orgA.name) });
    await singleBrowser.notSee({ role: "button", label: "Organization" });
    await singleBrowser.notSee({ text: "Choose an organization" });
    const enabled = (await probe.on(world.singleWeb).dom('[data-testid="device-approve"]:not([disabled])')).elements.length;
    expect(enabled).toBe(1);
    evidence.recordAssertionEvidence("One organization needs no extra choice", "organization A shown in consent; no organization picker; Approve enabled", enabled === 1);
    await singleBrowser.screenshot();
    await singleBrowser.click({ role: "button", label: "Approve" });
    await singleBrowser.see({ text: "Return to the OpenWork app on that computer." }, { timeoutMs: 30_000 });
    const session = await probe.eventually(() => world.single.redeem(), {
      within: 30_000, intervalMs: 5_000, label: "the only organization is approved", until: value => value.status === 200,
    });
    expect(session.organizationId).toBe(world.orgA.id);
  });

  for (const client of [
    { request: world.cli, name: "OpenWork CLI" },
    { request: world.plugin, name: "OpenWork - OpenCode Plugin" },
  ]) {
    await step(`the existing ${client.name} still preselects the browser's active organization`, async () => {
      await browser.navigate(client.request.url);
      await browser.see({ role: "button", label: `Sign in ${client.name}` }, { timeoutMs: 90_000 });
      await browser.see({ testId: "device-consent-line" }, { text: new RegExp(world.orgA.name) });
      await browser.notSee({ text: "Choose an organization" });
      expect((await browserProbe.dom('[data-testid="device-approve"]:not([disabled])')).elements).toHaveLength(1);
      expect(await world.browserOrganizationId()).toBe(world.orgA.id);
      await browser.screenshot();
      await browser.click({ role: "button", label: `Sign in ${client.name}` });
      await browser.see({ text: `${client.name} is signed in` }, { timeoutMs: 30_000 });
      const session = await probe.eventually(() => client.request.redeem(), {
        within: 30_000, intervalMs: 5_000, label: "the terminal client keeps its original organization", until: value => value.status === 200,
      });
      expect(session.sessionIssued).toBe(true);
      expect(session.organizationId).toBe(world.orgA.id);
      evidence.recordAssertionEvidence("Existing terminal consent keeps its active organization", `${client.name}: no extra choice; device HTTP ${session.status}; organization=A`, session.sessionIssued && session.organizationId === world.orgA.id);
    });
  }
});
