import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotSetupApps } from "../worlds/workbot-setup-apps.ts";

const test = spec.world(workbotSetupApps, { timeout: 300_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

const chip = { testId: "workbot-setup-chip" };
const panel = { testId: "workbot-setup-panel" };

test("a Workbot member sets up apps from the Get set up chip: connect in place, everything else on the exact Den page", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const link = async (step: string, path: string) => (await probe.dom(`a[data-activation-action="${step}"][href="${world.denPage(path)}"][target="_blank"]`)).elements.length === 1;

  await step("given Den is open in another team while Workbot belongs to Acme", async () => {
    await user.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    expect(await world.activeOrganizationId()).toBe(world.otherOrganizationId);
    expect((await probe.dom('[data-testid="workspace-switcher-trigger"]')).elements.map(element => element.text).join()).toContain("Other team");
    evidence.recordAssertionEvidence("Another workspace is active before Invite", `Den active workspace: ${await world.activeOrganizationId()}; Workbot workspace: ${world.organizationId}`, (await world.activeOrganizationId()) === world.otherOrganizationId);
    await user.screenshot();
  });

  await step("by default the chip shows progress after the member's first answer", async () => {
    await user.navigate(world.url);
    await user.see({ text: "The launch moved to Thursday." });
    await user.see({ role: "button", label: "Get set up, 1 of 6" }, { timeoutMs: 30_000 });
    const den = await world.activation();
    expect(den.done).toEqual(["first_response"]);
    evidence.recordAssertionEvidence("Workbot reports its first answer and Den counts it", `Den done steps: ${den.done.join(", ")}; chip "Get set up, 1 of 6"`, den.done.join() === "first_response");
    await user.screenshot();
  });

  await step("the chip lists the six steps and links keys, AI Gateway, skills and invites to the exact Den pages", async () => {
    await user.click(chip);
    await user.see(panel);
    const rows = await probe.dom('[data-testid^="workbot-setup-step-"] > div > p:first-child');
    const titles = rows.elements.map((element) => element.text.trim());
    expect(titles).toEqual(["Get your first answer", "Invite a teammate", "Use a skill", "Set up a model provider", "Share a provider on AI Gateway", "Connect an app"]);
    const links = {
      own_provider: await link("own_provider", "library?show=models"),
      gateway_provider: await link("gateway_provider", "ai-gateway?tab=ai-providers"),
      use_skill: await link("use_skill", "library?show=skills"),
      invite_teammate: await link("invite_teammate", "members"),
    };
    expect(links).toEqual({ own_provider: true, gateway_provider: true, use_skill: true, invite_teammate: true });
    await user.see({ role: "button", label: /^Connect / });
    evidence.recordAssertionEvidence("Each Den action opens its exact page in a new tab for this workspace", `Add key -> ${world.denPage("library?show=models")}; Share -> ${world.denPage("ai-gateway?tab=ai-providers")}; Try a skill -> ${world.denPage("library?show=skills")}; Invite -> ${world.denPage("members")}`, Object.values(links).every(Boolean));
    await user.screenshot();
  });

  await step("after: clicking Invite opens Acme's Members page even with another team active", async () => {
    await user.click({ role: "link", label: /^Invite/ });
    const members = await probe.eventually(() => world.membersPage(), { within: 30_000, label: "Invite opens a Den tab", until: value => Boolean(value) });
    const invitee = user.on(members);
    const loaded = await probe.eventually(() => probe.on(members).text(), { within: 90_000, label: "the linked workspace loads or reports an access error", until: value => value.includes("Add member") || value.includes("This Workbot workspace is unavailable") });
    expect(loaded).not.toContain("This Workbot workspace is unavailable");
    await invitee.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    await invitee.see({ text: "Avery Owner" });
    expect((await probe.on(members).dom('[data-testid="workspace-switcher-trigger"]')).elements.map(element => element.text).join()).toContain("Acme");
    await invitee.see({ role: "button", label: "Add member" });
    await invitee.notSee({ text: /This Workbot workspace is unavailable/ });
    const active = await world.activeOrganizationId();
    expect(active).toBe(world.organizationId);
    const destination = await probe.on(members).url();
    expect(new URL(destination).pathname).toBe("/dashboard/members");
    expect(new URL(destination).searchParams.has("workbotOrganizationId")).toBe(false);
    evidence.recordAssertionEvidence("Invite reaches the Workbot team's Members page", `Acme Members shows Avery Owner and Add member; active workspace: ${active}; workspace hint consumed`, active === world.organizationId);
    await invitee.screenshot();
  });

  await step("Connect an app opens consent in place and checks off only once Den says the connection is ready", async () => {
    expect(await world.ready()).toBe(false);
    await user.click({ role: "button", label: /^Connect / });
    const consent = await probe.eventually(() => world.consent(), { within: 15_000, label: "provider consent opens from the chip", until: (value) => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Approve access" });
    const den = await probe.eventually(() => world.activation(), { within: 30_000, label: "Den counts the ready connection", until: (value) => value.done.includes("connector") });
    await user.see({ role: "button", label: "Get set up, 2 of 6" }, { timeoutMs: 30_000 });
    expect(await probe.url()).toBe(world.url);
    const ready = await world.ready();
    expect(ready).toBe(true);
    evidence.recordAssertionEvidence("Connected comes from Den's readiness, not the popup", `connect starts=${world.starts()}; Den ready=${ready}; done steps ${den.done.join(", ")}; still on ${await probe.url()}`, ready && den.done.includes("connector") && world.starts() === 1);
    // The list stays open across consent; reopen it only if the member's click elsewhere closed it.
    if ((await probe.dom('[data-testid="workbot-setup-panel"]')).elements.length === 0) await user.click(chip);
    await user.see(panel);
    await user.see({ text: /connected$/ });
    await probe.eventually(() => probe.dom('[data-testid="workbot-setup-step-connector"][data-state="done"]'), { within: 10_000, label: "the connector row is checked", until: (dom) => dom.elements.length === 1 });
    await user.screenshot();
  });

});
