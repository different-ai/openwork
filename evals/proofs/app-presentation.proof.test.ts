import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appPresentation, APP_FALLBACK, APP_REPLY, APP_REQUEST, APP_RESOURCE } from "../worlds/app-presentation.ts";

const test = spec.world(appPresentation, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "opencode"] },
});

test("a member reads the saved fallback before slow preview discovery finishes", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  world.scenario("slow");
  await step("the member publishes a checklist while the preview resource is slow", async () => {
    await user.type("composer", APP_REQUEST);
    await user.click("Run task");
    await user.see({ role: "button", label: "Open preview" }, { timeoutMs: 60_000 });
    const offered = (await probe.dom('[data-built-app-result] button[aria-label="Open preview"]')).elements.length;
    expect(offered).toBe(1);
    evidence.recordAssertionEvidence("The publication is available without requiring the interactive resource", `Open actions=${offered}; model final reply remains held`, offered === 1);
    await user.screenshot();
  });
  await step("after: Open immediately shows saved text labelled as not live data", async () => {
    const start = Date.now();
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ text: APP_FALLBACK }, { timeoutMs: 1_000 });
    await user.see({ text: "Saved fallback · Not live data" });
    const frames = (await probe.dom("[data-built-app-preview] iframe")).elements.length;
    const resolutions = world.resolutions();
    expect(frames).toBe(0);
    expect(resolutions).toHaveLength(0);
    evidence.recordAssertionEvidence("The fallback is useful before any iframe or resource exists", `text observed=${Date.now() - start}ms; iframes=${frames}; completed discovery=${resolutions.length}; provider freshness explicitly not claimed`, frames === 0 && resolutions.length === 0);
    await user.screenshot();
  });
  await step("the interactive checklist later connects without displacing the fallback", async () => {
    const before = await world.geometry();
    await user.see({ role: "heading", text: "Project checklist", mcpApp: { resourceUri: APP_RESOURCE } }, { timeoutMs: 20_000 });
    await user.see({ text: "Connected" });
    const after = await world.geometry();
    expect(after.fallback).toEqual(before.fallback);
    expect(world.resolutions()[0]?.elapsedMs).toBeGreaterThanOrEqual(1_800);
    evidence.recordAssertionEvidence("Slow discovery is witnessed and the saved text keeps its position", `discovery=${world.resolutions()[0]?.elapsedMs}ms; fallback before=${JSON.stringify(before.fallback)}, after=${JSON.stringify(after.fallback)}`, Boolean(after.fallback));
    await user.screenshot();
    await world.releaseReply();
  });
});

test("a member chooses when to open a published App and retains a useful fallback when its preview fails", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("publication offers Open without taking the conversation into a panel", async () => {
    await user.type("composer", APP_REQUEST);
    await user.click("Run task");
    await user.see({ role: "button", label: "Open preview" }, { timeoutMs: 60_000 });
    const panels = (await probe.dom("[data-built-app-preview]")).elements.length;
    const resolutions = world.resolutions();
    expect(panels).toBe(0);
    expect(resolutions).toHaveLength(0);
    evidence.recordAssertionEvidence("Publication does not open or start the preview", `open actions=1; preview panes=${panels}; resource resolutions=${resolutions.length}; model reply still held`, panels === 0 && resolutions.length === 0);
    await user.screenshot();
  });

  expect((await world.geometry()).loading).not.toBeNull();
  world.armFlicker();
  const measurements: { scenario: string; fallbackMs: number; usefulViewMs: number | null }[] = [];
  for (const scenario of ["cold", "warm", "slow", "error", "reopen"] satisfies Array<Parameters<typeof world.scenario>[0]>) {
    world.scenario(scenario);
    await step(`${scenario === "error" ? "a failed preview keeps" : `${scenario} opening shows`} the saved fallback independently of the interactive view`, async () => {
      const startedAt = Date.now();
      const previous = world.resolutions().length;
      await user.click({ role: "button", label: "Open preview" });
      await user.see({ text: APP_FALLBACK });
      await user.see({ text: "Saved fallback · Not live data" });
      const fallbackMs = Date.now() - startedAt;
      const before = await world.geometry();
      if (scenario === "slow") {
        expect(world.resolutions()).toHaveLength(previous);
        await user.see({ text: "Opening" });
      }
      let usefulViewMs: number | null = null;
      if (scenario === "error") {
        await user.see({ text: "Unavailable" }, { timeoutMs: 20_000 });
        await user.see({ role: "button", label: /^Retry$/ });
        await user.see({ text: APP_FALLBACK });
        const after = await world.geometry();
        expect(after.fallback).toEqual(before.fallback);
        await user.notSee({ text: "Ready" });
      } else {
        await user.see({ role: "heading", text: "Project checklist", mcpApp: { resourceUri: APP_RESOURCE } }, { timeoutMs: 20_000 });
        usefulViewMs = Date.now() - startedAt;
        await user.see({ text: "Connected" });
        await user.click({ role: "button", text: "Mark reviewed", mcpApp: { resourceUri: APP_RESOURCE } });
        const after = await world.geometry();
        expect(after.fallback).toEqual(before.fallback);
      }
      const resolution = world.resolutions().at(-1);
      expect(resolution?.scenario).toBe(scenario);
      measurements.push({ scenario, fallbackMs, usefulViewMs });
      evidence.recordAssertionEvidence("Saved text paints without claiming fresh data or successful rendering", `1440x900; ${scenario}; fallback observed=${fallbackMs}ms; useful interactive heading observed=${usefulViewMs === null ? "not rendered" : `${usefulViewMs}ms`}; discovery observed=${resolution?.elapsedMs}ms; fallback geometry held; warm means browser-warm, not a claim of provider cache freshness`, Boolean(before.fallback) && (scenario === "error" || usefulViewMs !== null));
      await user.screenshot();
    });
    if (scenario === "error") {
      await step("Retry recovers the view without hiding or replacing the saved fallback", async () => {
        const before = await world.geometry();
        world.scenario("warm");
        await user.click({ role: "button", label: /^Retry$/ });
        await user.see({ role: "heading", text: "Project checklist", mcpApp: { resourceUri: APP_RESOURCE } }, { timeoutMs: 20_000 });
        await user.see({ text: "Connected" });
        await user.see({ text: APP_FALLBACK });
        const after = await world.geometry();
        expect(after.fallback).toEqual(before.fallback);
        evidence.recordAssertionEvidence("Retry replaces only the failed renderer", `fallback bounds before=${JSON.stringify(before.fallback)}, after=${JSON.stringify(after.fallback)}; preview connected; interactive checklist visible`, Boolean(after.fallback));
        await user.screenshot();
      });
    }
    await user.click("Close panel");
    await user.notSee({ text: "Saved fallback · Not live data" });
  }

  await step("closing the panel stays respected when the assistant finishes", async () => {
    await world.releaseReply();
    await user.see({ text: APP_REPLY }, { timeoutMs: 30_000 });
    const panels = (await probe.dom("[data-built-app-preview]")).elements.length;
    const geometry = await world.geometry();
    const flicker = world.flicker();
    expect(panels).toBe(0);
    expect(flicker.upwardJumps).toBe(0);
    expect(flicker.samples).toContain(",");
    expect(geometry.timings.some(entry => entry.name === "openwork.mcp-app.result-delivered")).toBe(true);
    expect(geometry.timings.some(entry => entry.name === "openwork.mcp-app.first-paint")).toBe(false);
    evidence.recordAssertionEvidence("The final answer does not reopen a pane or confuse a deadline with startup latency", `panes=${panels}; actual timings=${JSON.stringify(measurements)}; measure-chat-flicker=${JSON.stringify(flicker)}; delivery timings are not labelled paint`, panels === 0);
    await user.screenshot();
  });
});
