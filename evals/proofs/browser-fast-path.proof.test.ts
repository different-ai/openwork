import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { MockAgentToolStep } from "@openwork/labs";
import { runToolTurn } from "@openwork/behaviors";
import { browserFastPath } from "../worlds/browser-fast-path.ts";

const test = spec.world(browserFastPath, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Browser tasks run in Electron's native page view, driven by the engine's browser tools.",
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
const observe = (args: Record<string, unknown> = {}): MockAgentToolStep => ({ tool: "browser_observe", argumentsFrom: "browser-page", arguments: { ...page, ...args } });
const act = (action: Record<string, unknown>): MockAgentToolStep => ({ tool: "browser_act", argumentsFrom: "browser-page", arguments: { ...page, observationId: "__OBSERVATION__", action } });
const submitted = (submission: Record<string, unknown> | undefined) => submission && {
  company: submission.company, email: submission.email, seats: submission.seats, start: submission.start, notes: submission.notes,
};
const parse = (output: string): Record<string, unknown> => { try { return JSON.parse(output); } catch { return {}; } };

test("an agent fills and submits the same form with far fewer model calls by acting in one batch", async ({ world, user, probe, step, evidence }) => {
  const witness = () => probe.browserFixtureState(world.origin);
  let before = 0;
  let beforeBytes = 0;

  await step("before: one action per call, observing the page before every action, takes 15 model calls", async () => {
    await user.click({ text: world.session.title });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    // The previous browser_act contract: one action per call, an observation
    // used once, and no result page, so every action needs its own observation.
    const prompt = await runToolTurn({ user }, world, "Fill in the application form one field at a time and submit it.", [
      { tool: "browser_open", arguments: { url: `${world.origin}/forms?run=one-at-a-time` } },
      ...fields.flatMap((field) => [observe({ mode: "full" }), act({ type: "fill", name: field.name, text: field.text })]),
      observe({ mode: "full" }), act({ type: "click", name: "Submit application" }),
      observe({ mode: "full", includeText: true }),
    ]);
    const saved = await probe.eventually(witness, { within: 15_000, label: "the form records the first submission", until: state => state.formSubmissions.length === 1 });
    before = (await world.modelCalls(prompt)).length;
    const calls = await world.browserCalls();
    beforeBytes = calls.reduce((total, call) => total + call.output.length, 0);
    expect(submitted(saved.formSubmissions[0])).toEqual({ company: "Example studio", email: "person@example.test", seats: "42", start: "2026-10-20", notes: "Filled by the agent" });
    expect(parse(calls.at(-1)?.output ?? "").text).toContain("Application saved");
    expect(before).toBe(15);
    evidence.recordAssertionEvidence("Model calls to fill five fields and submit, one action per call", `${before} model calls; ${calls.length} browser tool calls; ${beforeBytes} characters of tool results; submissions: ${saved.formSubmissions.length}`, before === 15 && saved.formSubmissions.length === 1);
    await user.screenshot();
  });

  await step("after: one interactive observation and one batched act fill and submit the same form in 4 model calls", async () => {
    const prompt = await runToolTurn({ user }, world, "Fill in the application form and submit it.", [
      { tool: "browser_open", arguments: { url: `${world.origin}/forms?run=batch` } },
      observe(),
      { tool: "browser_act", argumentsFrom: "browser-page", arguments: { ...page, observationId: "__OBSERVATION__", actions: [
        ...fields.map((field) => ({ type: "fill", name: field.name, text: field.text })),
        { type: "click", name: "Submit application" },
      ] } },
    ]);
    const saved = await probe.eventually(witness, { within: 15_000, label: "the form records the second submission", until: state => state.formSubmissions.length === 2 });
    const after = (await world.modelCalls(prompt)).length;
    const calls = (await world.browserCalls()).slice(-3);
    const afterBytes = calls.reduce((total, call) => total + call.output.length, 0);
    const receipt = parse(calls.at(-1)?.output ?? "");
    const observation = receipt.observation as { status?: string[] } | undefined;
    expect(submitted(saved.formSubmissions[1])).toEqual(submitted(saved.formSubmissions[0]));
    expect(receipt).toMatchObject({ ok: true, completed: 6, failed: 0, skipped: 0, page: "settled" });
    expect(observation?.status).toContain("Application saved");
    expect(after).toBe(4);
    expect(after).toBeLessThan(before);
    evidence.recordAssertionEvidence("Model calls for the same form with a batched act", `${after} model calls (before: ${before}); ${calls.length} browser tool calls; ${afterBytes} characters of tool results (before: ${beforeBytes}); the act receipt reports ${String(receipt.completed)} completed steps, page ${String(receipt.page)} and status "${observation?.status?.join(" ") ?? ""}"; both submissions match`,
      after === 4 && before === 15 && observation?.status?.includes("Application saved") === true);
    await user.screenshot();
  });
});
