import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineConnectorsParity } from "../worlds/engine-connectors-parity.ts";

// Web app + a real Den org connection ("Amber Reports") reached through OpenWork Cloud on both engines.
const test = spec.world(engineConnectorsParity, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const PROMPT = "What does the latest amber report say?";

test(`AGENT-VIS-04 ${resolveEvalEngine()}: a person asks for a report from a connected service and can see what went where and what came back`, async ({ world, user, probe, step, evidence }) => {
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
    while (Date.now() - started < 60_000) {
      const text = await probe.text();
      const done = text.includes(world.proof);
      glances.push({ at: Date.now() - started, working: /Working\s*\d/.test(text), done });
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const first = glances.findIndex((glance) => glance.working);
    const gaps = (first >= 0 ? glances.slice(first) : glances).filter((glance) => !glance.working && !glance.done);
    evidence.recordAssertionEvidence("Working stays on screen while the connection runs",
      `${glances.length} glances; Working missing at ${gaps.map((gap) => `${gap.at}ms`).join(", ") || "none"}`, first >= 0 && gaps.length === 0);
    expect.soft(gaps.map((gap) => gap.at), "glances without a Working line while the service answered").toEqual([]);
  });

  await step("the step reads in plain words, never as raw tool names", async () => {
    await user.see({ text: world.proof }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    if (world.engine === "v2") await user.click({ role: "button", label: /Looked up.*Show steps/ });
    await user.notSee({ text: /openwork-cloud_execute_capability|execute_capability|search_capabilities/ });
    const rows = (await probe.dom("[data-capability-call]")).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("The connection step is readable", `${rows.length} step(s): ${rows.join(" | ").slice(0, 160)}; no raw tool names on screen`, rows.length >= 1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await user.screenshot();
  });
});
