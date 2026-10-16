import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineConnectorsParity } from "../worlds/engine-connectors-parity.ts";

// Web app + a real Den org connection ("Amber Reports") reached through OpenWork Cloud.
const test = spec.world(engineConnectorsParity, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const PROMPT = "What does the latest amber report say?";

test(`AGENT-VIS-04: a person asks for a report from a connected service and can see what went where and what came back`, async ({ world, user, probe, step, evidence }) => {
  await step("the person asks what the latest amber report says", async () => {
    await world.prepareReport(PROMPT);
    await user.type("composer", PROMPT);
    await user.click("Run task");
    await user.see({ text: PROMPT });
    await user.screenshot();
  });

  await step("while the service answers, a Working line stays on screen", async () => {
    const glances: Array<{ at: number; working: boolean; done: boolean }> = [];
    const started = Date.now();
    await probe.eventually(async () => {
      const text = await probe.text();
      const done = text.includes(world.proof);
      glances.push({ at: Date.now() - started, working: /Working\s*\d/.test(text), done });
      return done;
    }, { within: 60_000, intervalMs: 150, label: "the connected service's answer" }).catch(() => false);
    const first = glances.findIndex((glance) => glance.working);
    const gaps = (first >= 0 ? glances.slice(first) : glances).filter((glance) => !glance.working && !glance.done);
    evidence.recordAssertionEvidence("Working stays on screen while the connection runs",
      `${glances.length} glances; Working missing at ${gaps.map((gap) => `${gap.at}ms`).join(", ") || "none"}`, first >= 0 && gaps.length === 0);
    expect.soft(gaps.map((gap) => gap.at), "glances without a Working line while the service answered").toEqual([]);
  });

  await step("the step reads in plain words, never as raw tool names", async () => {
    await user.see({ text: world.proof }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    // A finished one-call run shows its step rows directly; there is no folded group to open.
    await user.see({ text: /current amber report/i });
    await user.notSee({ text: /openwork-cloud_execute_capability|execute_capability|search_capabilities/ });
    const rows = (await probe.dom("[data-capability-call]")).elements.map((element) => element.text);
    const readable = rows.some((row) => /current amber report/i.test(row));
    evidence.recordAssertionEvidence("The connection step is readable", `${rows.length} step(s): ${rows.join(" | ").slice(0, 160)}; no raw tool names on screen`, readable);
    expect(rows.join(" | ")).toMatch(/current amber report/i);
    await user.screenshot();
  });

  await step("a refused action says the provider's reason instead of claiming success", async () => {
    const prompt = "What does the violet status say?";
    await world.prepareReport(prompt, true);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: /Report service unavailable/ }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /openwork-cloud_execute_capability/ });
    expect((await world.den.mocks.report.toolCalls()).map((call) => call.name)).toContain("unavailable_violet_status");
    await user.screenshot();
  });
});
