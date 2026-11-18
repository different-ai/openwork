import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { backgroundSubagentComposer } from "../worlds/background-subagent-composer.ts";

const test = spec.world(backgroundSubagentComposer, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["mock", "den"] },
  needs: { commands: ["bun"] },
});

const SEND = '[data-composer-actions] button[aria-label="Run task"]';
const STOP = '[data-composer-actions] button[aria-label="Stop"]';
const AGENTS = "[data-subagent-tracker]:not([hidden])";
const ROW = `${AGENTS} [data-subagent-activity]`;
const ROW_STOP = `${ROW} button[aria-label^="Stop"]`;

test("a helper running in the background keeps its row and the composer keeps Send", async ({ world, user, probe, step, evidence }) => {
  const view = async () => {
    const [send, stop, agents, rows, rowStops] = await Promise.all([SEND, STOP, AGENTS, ROW, ROW_STOP].map((selector) => probe.dom(selector)));
    return {
      sendLabel: send?.elements.length ? "Run task" : stop?.elements.length ? "Stop" : null,
      agentsListed: agents?.elements.length ? rows?.elements.length ?? 0 : 0,
      rowStops: rowStops?.elements.length ?? 0,
    };
  };

  await step("the member asks for a background helper and the parent turn ends while the helper keeps working", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.started }, { timeoutMs: 120_000 });
    await probe.eventually(() => world.childState(), {
      within: 60_000, label: "the helper is waiting on its held reply", until: (state) => state.waiting > 0,
    });
    await probe.eventually(view, {
      within: 30_000, label: "the Agents list shows the running helper", until: (value) => value.agentsListed === 1,
    });
    // Stop may show for a moment while the parent reply settles; it must return to Send on its own, with no typing.
    const shown = await probe.eventually(view, {
      within: 5_000, label: "the composer returns to Send while only the helper works", until: (value) => value.sendLabel === "Run task",
    }).catch(() => view());
    evidence.recordAssertionEvidence("Composer while only the helper runs", JSON.stringify(shown), shown.sendLabel === "Run task");
    await user.screenshot();
    expect(shown.rowStops, "the helper's row has its own Stop").toBe(1);
    expect(shown.sendLabel, "the composer keeps its Send control").toBe("Run task");
  });

  await step("a follow-up keeps the running helper listed above the composer", async () => {
    await user.type("composer", world.followUp);
    await user.click("Run task");
    await user.see({ text: world.followUpReply }, { timeoutMs: 120_000 });
    const after = await probe.eventually(view, {
      within: 15_000, label: "the composer settles after the follow-up", until: (value) => value.sendLabel === "Run task",
    }).catch(() => view());
    const child = await world.childState();
    expect(child.complete || child.aborted, "the helper is still working").toBe(false);
    evidence.recordAssertionEvidence("Composer after a follow-up while the helper runs", JSON.stringify(after), after.agentsListed === 1);
    await user.screenshot();
    expect(after.agentsListed, "the running helper is still listed").toBe(1);
    expect(after.sendLabel).toBe("Run task");
  });

  await step("once the helper finishes, its row settles", async () => {
    await world.releaseChild();
    await user.see({ text: world.childReply }, { timeoutMs: 120_000 }).catch(() => undefined);
    await user.screenshot();
  });
});
