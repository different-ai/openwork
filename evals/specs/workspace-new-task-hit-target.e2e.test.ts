import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workspaceNewTask } from "../worlds/session-shell.ts";

const test = spec.world(workspaceNewTask);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("workspace New task opens an editable composer immediately and creates one task on submit", async ({ world, user, agent, probe, step, evidence }) => {
  const workspaceName = world.workspacePath.split("/").at(-1) ?? world.workspacePath;
  await user.hover({ role: "button", label: workspaceName });

  await step("the plus remains the topmost hit target", async () => {
    // TODO(primitive): probe.hitTarget should identify the painted element at a visible control's center.
    const hit = await probe.eval(`(() => {
      const plus = document.querySelector('[data-sidebar-workspace-id="${world.workspace.workspaceId}"] [data-workspace-new-task]');
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
    evidence.recordAssertionEvidence(
      "The workspace New task plus remains clickable over a long workspace name",
      "The painted element at the plus center belongs to the plus, not the truncated title.", true,
    );
  });

  const before = (await agent.list()).map((session) => session.sessionId).sort();
  const requests = () => probe.eval(`window.__newTaskRequests`);
  // TODO(primitive): probe.attribute should read the accessible control's aria-expanded value.
  const expandedBefore = await probe.eval(`document.querySelector('[data-sidebar-workspace-id="${world.workspace.workspaceId}"] [data-workspace-new-task]')
    ?.closest("[data-workspace-actions]")?.parentElement?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")`);
  // TODO(primitive): probe.paintTiming should measure input-to-visible-content in the renderer.
  await probe.eval(`(() => {
    const button = document.querySelector('[data-sidebar-workspace-id="${world.workspace.workspaceId}"] [data-workspace-new-task]');
    button.addEventListener("click", () => {
      const started = performance.now();
      const observer = new MutationObserver(() => {
        const heading = [...document.querySelectorAll("h2")]
          .find((node) => node.textContent === "What do you need done?" && node.getClientRects().length);
        if (!heading) return;
        window.__newTaskOpenedAfterMs = performance.now() - started;
        observer.disconnect();
      });
      observer.observe(document.body, { subtree: true, childList: true });
    }, { once: true, capture: true });
  })()`);
  await user.click({ role: "button", label: `New session · ${workspaceName}` });
  await user.see({ text: "What do you need done?" });
  const openedAfterMs = await probe.eval(`window.__newTaskOpenedAfterMs`);
  expect(openedAfterMs).toBeLessThan(1000);
  expect(await probe.hash()).not.toContain("/session/ses_");
  expect(await requests()).toEqual([]);
  expect((await agent.list()).map((session) => session.sessionId).sort()).toEqual(before);
  evidence.recordAssertionEvidence(
    "New task opens without waiting for engine session creation",
    `The visible composer appeared ${openedAfterMs} ms after clicking; the limit was 1000 ms. Session POSTs were delayed 5000 ms, but opening issued none and left all existing session IDs unchanged.`, true,
  );

  await step("the empty composer accepts and keeps a draft without creating a session", async () => {
    await user.type({ placeholder: "Describe your task..." }, world.prompt, { verify: true });
    await user.hover({ role: "button", label: workspaceName });
    await user.click({ role: "button", label: `New session · ${workspaceName}` });
    expect(await probe.eval(`document.querySelector('[contenteditable="true"]')?.textContent`)).toBe(world.prompt);
    expect(await requests()).toEqual([]);
    evidence.recordAssertionEvidence(
      "The empty composer accepts a draft and preserves it on another New task click",
      "Typing was verified in the visible editor; clicking New task again retained the exact draft text and still issued no session creation request.", true,
    );
  });
  await user.see({ text: "New task model" });
  await user.click({ placeholder: "Describe your task..." });
  await user.press("Enter");
  await probe.eventually(() => agent.list(), {
    within: 60_000,
    label: "submitting creates exactly one session after the slow engine responds",
    until: (sessions) => sessions.length === before.length + 1,
  });
  await user.see({ text: world.reply });
  expect(await probe.hash()).toContain("/session/ses_");
  const creationRequests = await requests();
  expect(Array.isArray(creationRequests) && creationRequests.length).toBe(1);
  expect(JSON.stringify(creationRequests)).toContain(world.workspace.workspaceId);
  const after = (await agent.list()).map((session) => session.sessionId);
  expect(after.length).toBe(before.length + 1);
  expect(after).toEqual(expect.arrayContaining(before));
  // TODO(primitive): probe.attribute should read the accessible control's aria-expanded value.
  const expandedAfter = await probe.eval(`document.querySelector('[data-sidebar-workspace-id="${world.workspace.workspaceId}"] [data-workspace-new-task]')
    ?.closest("[data-workspace-actions]")?.parentElement?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")`);
  expect(expandedAfter).toBe(expandedBefore);
  evidence.recordAssertionEvidence(
    "Submitting creates exactly one task in the intended workspace and receives the mock reply",
    "The mock model was visible before submission and its reply appeared afterward. Exactly one session POST targeted the selected workspace, one session was added, every existing session remained, and the workspace expansion state was unchanged.", true,
  );
});
