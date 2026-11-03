import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotSetupApps, workbotSetupExternalApps } from "../worlds/workbot-setup-apps.ts";

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
      own_provider: await link("own_provider", "library/model-providers/new"),
      gateway_provider: await link("gateway_provider", "ai-gateway?tab=ai-providers"),
      use_skill: await link("use_skill", "library?show=skills"),
      invite_teammate: await link("invite_teammate", "members"),
    };
    expect(links).toEqual({ own_provider: true, gateway_provider: true, use_skill: true, invite_teammate: true });
    await user.see({ role: "button", label: /^Connect / });
    evidence.recordAssertionEvidence("Each Den action opens its exact page in a new tab for this workspace", `Add key -> ${world.denPage("library/model-providers/new")}; Share -> ${world.denPage("ai-gateway?tab=ai-providers")}; Try a skill -> ${world.denPage("library?show=skills")}; Invite -> ${world.denPage("members")}`, Object.values(links).every(Boolean));
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

const external = spec.world(workbotSetupExternalApps, { timeout: 360_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

external("an owner opens the right team's external connection, adds a private model key and resumes Invite after sign-in", async ({ world, user, probe, step, evidence }) => {
  await step("before: Den has another team active", async () => {
    await user.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    expect(await world.activeOrganizationId()).toBe(world.otherOrganizationId);
    evidence.recordAssertionEvidence("The browser starts in a different team", `active=${await world.activeOrganizationId()}; Workbot=${world.organizationId}`, (await world.activeOrganizationId()) === world.otherOrganizationId);
    await user.screenshot();
  });
  await step("after: the external Connect action opens Acme's Google Workspace connection", async () => {
    await user.navigate(world.url);
    await user.see({ testId: "workbot-setup-chip" }, { timeoutMs: 30_000 });
    await user.click(chip);
    await user.click({ role: "button", label: /^Connect / });
    const connections = await probe.eventually(() => world.denTab("your-connections"), { within: 30_000, label: "external connection tab", until: value => Boolean(value) });
    await user.on(connections).see({ role: "heading", label: "Your Connections" }, { timeoutMs: 90_000 });
    await user.on(connections).see({ text: "Google Workspace" });
    expect((await probe.on(connections).dom('[data-testid="workspace-switcher-trigger"]')).elements.map(item => item.text).join()).toContain("Acme");
    expect(await world.activeOrganizationId()).toBe(world.organizationId);
    evidence.recordAssertionEvidence("External connection uses the Workbot team", "Acme selected; Google Workspace is available", (await world.activeOrganizationId()) === world.organizationId);
    await user.on(connections).screenshot();
    await user.click({ role: "button", label: "Cancel" });
  });
  await step("after: Add key saves a provider for this member and lists it in My Library", async () => {
    if ((await probe.dom('[data-testid="workbot-setup-panel"]')).elements.length === 0) await user.click(chip);
    await user.click({ role: "link", label: /^Add key/ });
    const provider = await probe.eventually(() => world.denTab("library/model-providers/new"), { within: 30_000, label: "provider editor tab", until: value => Boolean(value) });
    const editor = user.on(provider);
    await editor.see({ role: "heading", label: "Add a new LLM provider" }, { timeoutMs: 90_000 });
    await editor.see({ role: "button", label: "People (1)" });
    await editor.click({ role: "tab", label: "Custom provider" });
    await editor.click({ role: "button", label: "Advanced: edit as JSON" });
    await editor.type({ role: "textbox", label: "Custom provider JSON / JSONC" }, world.modelConfig, { replace: true });
    await editor.click({ testId: "llm-provider-name-rename" });
    await editor.type({ testId: "llm-provider-name-input" }, "Fixture provider", { replace: true });
    await editor.press("Enter");
    await editor.type({ placeholder: "Paste the provider credential" }, "fixture-model-key", { sensitive: true });
    await editor.click({ testId: "llm-provider-save" });
    await editor.see({ role: "heading", label: "Fixture provider" }, { timeoutMs: 30_000 });
    expect(await world.savedProviders()).toEqual([{ name: "Fixture provider", hasApiKey: true, allMembers: false, memberCount: 1 }]);
    await editor.click({ role: "link", label: "Back to providers" });
    await editor.see({ testId: "library-personal-models" });
    await editor.see({ text: "Fixture provider" });
    expect((await world.activation()).done).toContain("own_provider");
    evidence.recordAssertionEvidence("A private key was saved and the setup step completed", "1 provider; credential present; everyone=false; 1 member; own_provider done", (await world.savedProviders()).some(provider => provider.hasApiKey === true && provider.allMembers === false && provider.memberCount === 1) && (await world.activation()).done.includes("own_provider"));
    await editor.screenshot();
    await editor.click({ testId: "workspace-switcher-trigger" });
    await editor.click({ role: "button", label: "Sign out" });
    await probe.eventually(() => probe.on(provider).url(), { within: 30_000, label: "Den signed out", until: value => new URL(value).pathname === "/" });
  });
  await step("after: signing in returns to the requested team's Members page", async () => {
    await user.navigate(world.denPage("members"));
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 30_000 });
    const signIn = new URL(await probe.url());
    expect(signIn.searchParams.get("workbotReturnTo")).toContain("/dashboard/members?workbotOrganizationId=");
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    if ((await probe.dom('input[type="password"]')).elements.length === 0) await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Password" }, world.person.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign in" });
    await user.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    expect((await probe.dom('[data-testid="workspace-switcher-trigger"]')).elements.map(item => item.text).join()).toContain("Acme");
    expect(new URL(await probe.url()).pathname).toBe("/dashboard/members");
    expect(new URL(await probe.url()).search).toBe("");
    evidence.recordAssertionEvidence("Sign-in resumes the exact Workbot destination", "Members in Acme; sign-in return and workspace hint consumed", new URL(await probe.url()).pathname === "/dashboard/members" && new URL(await probe.url()).search === "");
    await user.screenshot();
  });
});
