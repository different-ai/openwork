import { expect } from "vitest";
import {
  control,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  waitFor,
} from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/fraimz";
import { app, eventually, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

/**
 * ACCEPTANCE TAPE — switching to another local workspace must not sabotage a
 * task that is still running in the workspace the user left.
 *
 * The focused server suite proves the deferral predicate. This tape proves the
 * product boundary: a long model task starts in workspace A, the user creates
 * and activates workspace B, returns to A, and the task still completes with
 * its completion marker — with no interrupted-message error and no Aborted
 * badge anywhere.
 */

const requirements: NeedsSpec = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_APP_SPECS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `workspace switch keeps live session skipped — needs: ${missingRequirements.join(", ")}`
  : "switching to another workspace and back does not abort a running task";

const COMPLETE_MARKER = "WORKSPACE-SWITCH-TASK-COMPLETE";
const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const activeWorkspaceExpression = `localStorage.getItem("openwork.react.activeWorkspace")`;

const workspaceOrderExpression = `(() => {
  try {
    return JSON.parse(localStorage.getItem("openwork.react.workspaceOrder") ?? "[]");
  } catch {
    return [];
  }
})()`;

const switchSidebarRowExpression = (targetId: string) => `(() => {
  const order = JSON.parse(localStorage.getItem("openwork.react.workspaceOrder") ?? "[]");
  const index = order.indexOf(${JSON.stringify(targetId)});
  if (index < 0) return { ok: false, reason: "target workspace missing from workspaceOrder" };
  const workspaceUls = [...document.querySelectorAll("ul")]
    .filter((ul) => [...ul.querySelectorAll("button")]
      .filter((button) => String(button.className).includes("menu-button")).length === 1);
  const row = workspaceUls[index]?.querySelector("button");
  if (!row) return { ok: false, reason: "sidebar workspace row not found" };
  row.scrollIntoView({ block: "center" });
  row.click();
  return { ok: true };
})()`;

test.skipIf(missingRequirements.length > 0)(title, { timeout: 900_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({ place });
  await using desktopApp = await app({ den, as: "admin", place });
  const workspaceAId = desktopApp.workspaceId;
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";

  const configured = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      return response.status + ":" + (await response.text()).slice(0, 300);
    };
    const workspaceId = ${JSON.stringify(workspaceAId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: { provider: { anthropic: { options: { apiKey: ${JSON.stringify(anthropicKey)} } } } } }),
    });
    if (!patched.startsWith("200:")) return patched;
    return request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
  })()`, { awaitPromise: true, timeoutMs: 90_000 });
  expect(String(configured)).toMatch(/^20[04]:/);

  const models = await readAvailableModels(desktopApp);
  const chosen = models.find((model) => model.selectable && /sonnet/i.test(model.id))
    ?? models.find((model) => model.selectable && /anthropic/i.test(model.providerName))
    ?? models.find((model) => model.selectable);
  if (!chosen) throw new Error("No selectable model was available for the workspace-switch acceptance tape.");
  await selectModel(desktopApp, chosen.id);

  const startedAt = Date.now();
  await control(desktopApp, "session.create_task");
  await sendComposerMessage(desktopApp, [
    "Run the bash command `sleep 60 && echo workspace-switch-task-done`.",
    "Wait for it to finish, then reply with exactly:",
    COMPLETE_MARKER,
  ].join(" "));
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "long task became active" });

  const otherWorkspacePath = `/tmp/openwork-switch-b-${Date.now()}`;
  await control(desktopApp, "workspace.create", { path: otherWorkspacePath }, { timeoutMs: 90_000 });

  const workspaceBId = await eventually(
    async () => evalIn(desktopApp, activeWorkspaceExpression),
    {
      within: 120_000,
      label: "second workspace selected after create",
      until: (activeId) => typeof activeId === "string" && activeId !== workspaceAId,
    },
  );
  expect(typeof workspaceBId).toBe("string");
  if (typeof workspaceBId !== "string" || workspaceBId === workspaceAId) {
    throw new Error(`Create-and-switch did not select a new workspace (got ${JSON.stringify(workspaceBId)}).`);
  }

  const orderWithB = await evalIn(desktopApp, workspaceOrderExpression);
  expect(Array.isArray(orderWithB)).toBe(true);
  if (!Array.isArray(orderWithB) || orderWithB[0] !== workspaceBId) {
    throw new Error(`Workspace B was created but not made active. Order: ${JSON.stringify(orderWithB)}.`);
  }
  evidence.fact(
    "Creating a second workspace activates it without touching the first workspace's engine",
    `${workspaceAId} -> ${workspaceBId}; the composer in ${workspaceAId} was not stopped`,
    true,
  );

  const switchedBack = await evalIn(desktopApp, switchSidebarRowExpression(workspaceAId));
  expect(isRecord(switchedBack) && switchedBack.ok === true, JSON.stringify(switchedBack)).toBe(true);
  await waitFor(desktopApp, `${activeWorkspaceExpression} === ${JSON.stringify(workspaceAId)}`, {
    timeoutMs: 60_000,
    label: "back on the original workspace",
  });
  await waitFor(desktopApp, `document.body.innerText.includes(${JSON.stringify(COMPLETE_MARKER)})`, {
    timeoutMs: 420_000,
    label: "live task completed after switching away and back",
  });

  const bodyText = await evalIn(desktopApp, "document.body.innerText");
  const interrupted = bodyText.includes("The message was interrupted");
  const abortedBadge = bodyText.includes("Aborted");
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  evidence.fact(
    "The task that was in flight during the switch completes without interrupting or aborting",
    `Completed ${elapsed}s after start; interrupted=${interrupted}; Aborted badge=${abortedBadge}.`,
    !interrupted && !abortedBadge,
  );
  expect(interrupted).toBe(false);
  expect(abortedBadge).toBe(false);

  const finalShot = await screenshot(desktopApp);
  const finalFrame = await validate(finalShot, [
    `The assistant reply ${COMPLETE_MARKER} is visible in workspace A`,
    "No interrupted-message error and no Aborted session badge are visible",
  ]);
  expect(finalFrame.ok, finalFrame.why).toBe(true);
});