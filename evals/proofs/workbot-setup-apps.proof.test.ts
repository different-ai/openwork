import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotSetupApps } from "../worlds/workbot-setup-apps.ts";

const test = spec.world(workbotSetupApps, { timeout: 180_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["den"] } });

const chip = { testId: "workbot-setup-chip" };
const panel = { testId: "workbot-setup-panel" };

test("a Workbot member sets up apps from the Get set up chip: connect in place, everything else on the exact Den page", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const link = async (step: string, path: string) => (await probe.dom(`a[data-activation-action="${step}"][href="${world.denPage(path)}"][target="_blank"]`)).elements.length === 1;

  await step("before: with Get set up off, Workbot's header has no setup chip", async () => {
    await user.navigate(world.url);
    await user.see({ text: "The launch moved to Thursday." });
    await user.notSee(chip);
    const den = await world.activation();
    expect(den.status).toBe(404);
    evidence.recordAssertionEvidence("Off by default in Workbot", `GET /v1/workbot/activation -> ${den.status}; no chip in the header`, den.status === 404);
    await user.screenshot();
  });

  await step("after: once it is on, the chip shows progress after the member's first answer", async () => {
    await world.setChecklist(true);
    await user.reload();
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

  await step("turning Get set up off removes the chip again without touching the conversation", async () => {
    await world.setChecklist(false);
    await user.reload();
    await user.see({ text: "The launch moved to Thursday." });
    await user.notSee(chip);
    const den = await world.activation();
    evidence.recordAssertionEvidence("The kill switch hides it everywhere", `GET /v1/workbot/activation -> ${den.status}; conversation intact; no chip`, den.status === 404);
    await user.screenshot();
  });
});
