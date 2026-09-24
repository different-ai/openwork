import { expect } from "vitest";
import { spec, type Target } from "@openwork/testkit";
import { reviewSandboxWorld } from "../worlds/review-sandbox.ts";

const test = spec.world(reviewSandboxWorld, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { placement: "local", commands: ["git"] },
});
const picker = { role: "combobox", label: "Preview world" } satisfies Target;

test("sandbox controls preserve a launched environment and recover from failures and expiry", async ({ world, user, probe, step, evidence }) => {
  const url = `https://ow-${"a".repeat(32)}.preview.openwork.software/__openwork_launch?token=synthetic`;
  function ready(expiresAt: string) {
    return { url, world: "app-web", expiresAt, outputs: {
      webUrl: { value: url, group: "Services", secret: true },
      alexEmail: { value: "reviewer@example.test" },
      alexPassword: { value: "synthetic-password", secret: true },
    } };
  }
  await step("launch failure stays actionable", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.click({ role: "button", text: "Launch in Freestyle" });
    await user.see({ text: "The sandbox could not launch. Try again." });
    await user.screenshot();
  });
  await step("ready sandbox stays tied to the launched environment", async () => {
    world.respond(201, ready(new Date(Date.now() + 120_000).toISOString()));
    await user.click({ role: "button", text: "Launch in Freestyle" });
    await user.see({ role: "link", text: "Open sandbox" });
    await user.see({ role: "button", text: "Launch another" });
    expect((await probe.dom(".connection-field code")).elements.map((item) => item.text)).toContain("••••••••");
    await user.click({ role: "button", text: "Show credentials" });
    await user.see({ text: "synthetic-password" });
    await user.click({ role: "button", text: "Hide credentials" });
    await user.click({ role: "button", text: "Hide sandbox" });
    await user.click({ role: "button", text: "Show sandbox" });
    await user.press("Tab");
    await user.press("Space");
    await user.press("ArrowDown");
    await user.press("Enter");
    await user.see(picker, { value: "desktop", timeoutMs: 2000 });
    await user.see({ role: "link", text: "Open sandbox" });
    await user.notSee({ role: "link", text: "Open desktop" });
    expect(world.requests.map((request) => JSON.parse(request))).toEqual([{ world: "app-web" }, { world: "app-web" }]);
    await user.click({ role: "button", text: "Hide sandbox" });
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see({ role: "link", text: "Open sandbox" });
    await user.screenshot();
    evidence.recordAssertionEvidence("Ready session identity and credentials survive selector changes and disclosure", "A synthetic successful response renders Open sandbox and Launch another with masked credentials. Choosing desktop sends no request and leaves the original web link intact; hiding and showing the panel preserves it. No provider VM was launched.", true);
  });
  await step("expired sessions lose their links and offer a fresh launch", async () => {
    await user.click({ role: "button", text: "Hide sandbox" });
    await user.click({ role: "button", text: "Show sandbox" });
    await user.press("Tab");
    await user.press("Space");
    await user.press("ArrowUp");
    await user.press("Enter");
    world.respond(201, ready(new Date(Date.now() + 2500).toISOString()));
    await user.click({ role: "button", text: "Launch another" });
    await user.see({ role: "button", text: "Launch again" });
    await user.see({ text: "Expired. Launch again to create a fresh sandbox." });
    await user.notSee({ role: "link", text: "Open sandbox" });
    expect((await probe.dom("section[aria-label='Your connection details']")).elements).toHaveLength(0);
    await user.screenshot();
    world.respond(201, ready(new Date(Date.now() + 120_000).toISOString()));
    await user.click({ role: "button", text: "Launch again" });
    await user.see({ role: "link", text: "Open sandbox" });
    evidence.recordAssertionEvidence("Expired sandbox recovery removes dead access and creates a fresh session", "The production UI expires a short-lived synthetic session, removes all service and credential controls, offers Launch again, and renders the next successful response. The launch endpoint is a local response fixture, not a live provider check.", true);
  });
});
