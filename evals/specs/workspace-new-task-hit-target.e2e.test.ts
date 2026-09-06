import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workspaceNewTask } from "../worlds/session-shell.ts";

const test = spec.world(workspaceNewTask);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the per-workspace New task plus stays clickable over a long truncated workspace name", async ({ world, user, agent, probe, step }) => {
  const workspaceName = world.workspacePath.split("/").at(-1) ?? world.workspacePath;
  await user.hover({ role: "button", label: workspaceName });

  await step("the plus remains the topmost hit target", async () => {
    // TODO(primitive): probe.hitTarget should identify the painted element at a visible control's center.
    const hit = await probe.eval(`(() => {
      const plus = document.querySelector('[data-workspace-new-task]');
      if (!(plus instanceof HTMLElement)) return { hitPlus: false, hitTitle: false, tag: "" };
      const rect = plus.getBoundingClientRect();
      const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const title = plus.closest("[data-workspace-actions]")?.parentElement?.querySelector(".ow-fade-truncate");
      return {
        hitPlus: plus.contains(node),
        hitTitle: Boolean(title && node instanceof Node && title.contains(node)),
        tag: node instanceof Element ? node.tagName.toLowerCase() : "",
      };
    })()`);
    if (!isRecord(hit)) throw new Error(`New task plus returned malformed hit facts: ${JSON.stringify(hit)}`);
    expect(hit.hitPlus).toBe(true);
    expect(hit.hitTitle).toBe(false);
  });

  const before = (await agent.list()).length;
  // TODO(primitive): probe.attribute should read the accessible control's aria-expanded value.
  const expandedBefore = await probe.eval(`document.querySelector('[data-workspace-new-task]')
    ?.closest("[data-workspace-actions]")?.parentElement?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")`);
  await user.click({ role: "button", label: `New session · ${workspaceName}` });
  await probe.eventually(() => agent.list(), {
    within: 60_000,
    label: "session created by workspace New task",
    until: (sessions) => sessions.length > before,
  });
  expect(await probe.hash()).toContain("/session/ses_");
  // TODO(primitive): probe.attribute should read the accessible control's aria-expanded value.
  const expandedAfter = await probe.eval(`document.querySelector('[data-workspace-new-task]')
    ?.closest("[data-workspace-actions]")?.parentElement?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")`);
  expect(expandedAfter).toBe(expandedBefore);
});
