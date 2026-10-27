import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { runToolTurn } from "@openwork/behaviors";
import { browserFastPath } from "../worlds/browser-fast-path.ts";

const test = spec.world(browserFastPath, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "The agent's page is drawn in Electron's native page view, scaled inside the side panel.",
  },
});

const fields = [
  { name: "Company name", text: "Example studio" },
  { name: "Email", text: "person@example.test" },
  { name: "Seats", text: "42" },
  { name: "Start date", text: "2026-10-20" },
  { name: "Notes", text: "Filled by the agent" },
];
const page = { tabId: "__TAB__" };
const observe = (): MockAgentToolStep => ({ tool: "browser_observe", argumentsFrom: "browser-page", arguments: { ...page, mode: "full" } });
const parse = (output: string): Record<string, unknown> => { try { return JSON.parse(output); } catch { return {}; } };

test("the page the agent works on keeps one size while the panel changes, then fits the panel again", async ({ world, user, probe, step, evidence }) => {
  const form = `${world.origin}/forms?run=agent-viewport`;
  const viewports = async () => (await world.browserCalls())
    .filter((call) => call.tool === "browser_observe")
    .map((call) => parse(call.output).viewport as { width: number; height: number } | undefined);
  // While locked, the browser bar shows the size and its scale, e.g. "Desktop · 24%".
  const scaleLabel = /^Desktop · \d+%$/;
  // Released at the end of the turn: the view fills the panel, taller than a 1280 × 800 page scaled to its width.
  const released = () => probe.eventually(async () => (await probe.browserState()).nativeViews.find((item) => item.attached),
    { within: 10_000, label: "the page fits the panel after the turn", until: (view) => !!view && view.bounds.height > view.bounds.width * 800 / 1280 + 20 });

  await step("before: in a narrow panel the agent's page lays out at 1280 × 800, and fits the panel again when the turn ends", async () => {
    await user.resizeViewport({ width: 1100, height: 760, deviceScaleFactor: 1 });
    await user.click({ text: world.session.title });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await runToolTurn({ user }, world, "Open the application form and look at it.", [
      { tool: "browser_open", arguments: { url: form } },
      observe(),
    ]);
    const seen = (await viewports()).at(-1);
    const view = await released();
    await user.notSee({ text: scaleLabel }, { timeoutMs: 10_000 });
    expect(seen).toEqual({ width: 1280, height: 800 });
    expect(view?.bounds.width).toBeLessThan(1280);
    evidence.recordAssertionEvidence("The agent's page size in a narrow panel", `observed ${seen?.width} × ${seen?.height} in a panel ${view?.bounds.width} px wide; after the turn the page view is ${view?.bounds.width} × ${view?.bounds.height}`,
      seen?.width === 1280 && seen?.height === 800 && (view?.bounds.width ?? 1280) < 1280);
    await user.screenshot();
  });

  await step("after: at a wider panel the agent's page is still 1280 × 800, its batched clicks land, and it fits the panel when the turn ends", async () => {
    await user.resizeViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
    await runToolTurn({ user }, world, "Fill in the application form and submit it.", [
      { tool: "browser_open", arguments: { url: form } },
      observe(),
      { tool: "browser_act", argumentsFrom: "browser-page", arguments: { ...page, observationId: "__OBSERVATION__", actions: [
        ...fields.map((field) => ({ type: "fill", name: field.name, text: field.text })),
        { type: "click", name: "Submit application" },
      ] } },
    ]);
    const saved = await probe.eventually(() => probe.browserFixtureState(world.origin), { within: 15_000, label: "the form records the submission", until: (state) => state.formSubmissions.length === 1 });
    const seen = (await viewports()).at(-1);
    const receipt = parse((await world.browserCalls()).at(-1)?.output ?? "");
    const view = await released();
    await user.notSee({ text: scaleLabel }, { timeoutMs: 10_000 });
    expect(seen).toEqual({ width: 1280, height: 800 });
    expect(receipt).toMatchObject({ ok: true, completed: 6, failed: 0 });
    expect(saved.formSubmissions[0]?.company).toBe("Example studio");
    evidence.recordAssertionEvidence("The agent's page size after resizing the panel", `observed ${seen?.width} × ${seen?.height}; act completed ${String(receipt.completed)} steps and the form saved one submission; after the turn the page view is ${view?.bounds.width} × ${view?.bounds.height}`,
      seen?.width === 1280 && receipt.completed === 6 && saved.formSubmissions.length === 1);
    await user.screenshot();
  });
});
