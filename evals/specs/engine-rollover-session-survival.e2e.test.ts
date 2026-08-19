import { expect } from "vitest";
import {
  control,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  waitFor,
} from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { app, eventually, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

/**
 * ACCEPTANCE TAPE — a config reload moves new work to a fresh engine without
 * interrupting a task that is still running on the previous generation.
 *
 * The focused server suite proves the routing table. This tape proves the
 * product boundary: Desktop enables the preview, the real embedded runtime
 * exposes it as a capability, a long model task survives the flip, a new
 * session can be created while both generations are live, and the old process
 * disappears only after its task finishes.
 */

const requirements: TestNeeds = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_ENGINE_ROLLOVER_E2E_TEST"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `engine rollover session survival skipped — needs: ${missingRequirements.join(", ")}`
  : "continuous engine updates preserve the live task and move new sessions to a fresh engine";

const COMPLETE_MARKER = "ROLLOVER-LIVE-TASK-COMPLETE";
const FRESH_MARKER = "ROLLOVER-FRESH-ENGINE-OK";
const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Generation = { role: string; pid: number | null };

function readGenerations(value: unknown): Generation[] {
  if (!isRecord(value) || !isRecord(value.enginePool) || !Array.isArray(value.enginePool.generations)) return [];
  return value.enginePool.generations.flatMap((generation) => {
    if (!isRecord(generation) || typeof generation.role !== "string") return [];
    return [{
      role: generation.role,
      pid: typeof generation.pid === "number" ? generation.pid : null,
    }];
  });
}

const runtimeStatusExpression = `window.__OPENWORK_ELECTRON__.invokeDesktop("runtimeStatus")`;

test.skipIf(missingRequirements.length > 0)(title, { timeout: 900_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({ place });
  await using desktopApp = await app({ den, as: "admin", place });
  const workspaceId = desktopApp.workspaceId;
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
    const workspaceId = ${JSON.stringify(workspaceId)};
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
  if (!chosen) throw new Error("No selectable model was available for the rollover acceptance tape.");
  await selectModel(desktopApp, chosen.id);

  const restarted = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("engineRestart", { engineRollover: true })`,
    { awaitPromise: true, timeoutMs: 120_000 },
  );
  expect(isRecord(restarted) && restarted.running === true).toBe(true);
  await eventually(async () => evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/capabilities", {
      headers: { Authorization: "Bearer " + token },
    });
    const body = await response.json();
    return response.ok && body?.engine?.rollover === true;
  })()`, { awaitPromise: true, timeoutMs: 30_000 }), {
    within: 90_000,
    label: "rollover capability after desktop restart",
    until: (available) => available === true,
  });

  const initialStatus = await evalIn(desktopApp, runtimeStatusExpression, { awaitPromise: true });
  const initialPrimary = readGenerations(initialStatus).find((generation) => generation.role === "primary");
  expect(initialPrimary?.pid).toBeTruthy();

  await control(desktopApp, "session.create_task");
  await sendComposerMessage(desktopApp, [
    "Run the bash command `sleep 45 && echo rollover-task-done`.",
    "Wait for it to finish, then reply with exactly:",
    COMPLETE_MARKER,
  ].join(" "));
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "long task became active" });

  const reloadResult = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const workspaceId = ${JSON.stringify(workspaceId)};
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const patch = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ opencode: { permission: { "rollover_probe_*": "allow" } } }),
    });
    if (!patch.ok) return "patch:" + patch.status + ":" + (await patch.text()).slice(0, 200);
    const reload = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", {
      method: "POST",
      headers,
    });
    return "reload:" + reload.status + ":" + (await reload.text()).slice(0, 200);
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(String(reloadResult)).toMatch(/^reload:20[04]:/);

  const drainingStatus = await eventually(
    async () => evalIn(desktopApp, runtimeStatusExpression, { awaitPromise: true }),
    {
      within: 90_000,
      label: "primary plus draining engine after reload",
      until: (status) => {
        const generations = readGenerations(status);
        return generations.some((generation) => generation.role === "primary" && generation.pid !== initialPrimary?.pid)
          && generations.some((generation) => generation.role === "draining" && generation.pid === initialPrimary?.pid);
      },
    },
  );
  const generationsDuringDrain = readGenerations(drainingStatus);
  const newPrimary = generationsDuringDrain.find((generation) => generation.role === "primary");
  evidence.recordAssertionEvidence(
    "The config reload flips to a fresh primary while the old task keeps its engine",
    `Before: ${JSON.stringify(initialPrimary)}; during drain: ${JSON.stringify(generationsDuringDrain)}.`,
    Boolean(newPrimary?.pid && newPrimary.pid !== initialPrimary?.pid),
  );

  const newSession = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/session", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(isRecord(newSession) && newSession.status === 200 && isRecord(newSession.body)).toBe(true);

  await waitFor(desktopApp, `document.body.innerText.includes(${JSON.stringify(COMPLETE_MARKER)})`, {
    timeoutMs: 300_000,
    label: "live task completed after engine flip",
  });
  expect(await evalIn(desktopApp, `!document.body.innerText.includes("The message was interrupted")`)).toBe(true);

  await eventually(async () => evalIn(desktopApp, runtimeStatusExpression, { awaitPromise: true }), {
    within: 120_000,
    label: "draining engine retired",
    until: (status) => {
      const generations = readGenerations(status);
      return generations.length === 1
        && generations[0]?.role === "primary"
        && generations[0]?.pid === newPrimary?.pid;
    },
  });

  await control(desktopApp, "session.create_task");
  await sendComposerMessage(desktopApp, `Reply with exactly: ${FRESH_MARKER}`);
  await waitFor(desktopApp, `document.body.innerText.includes(${JSON.stringify(FRESH_MARKER)})`, {
    timeoutMs: 180_000,
    label: "fresh primary answers a new task",
  });

  const finalShot = await screenshot(desktopApp);
  const finalFrame = await validate(finalShot, [
    `The assistant reply ${FRESH_MARKER} is visible in a new task`,
    "No interrupted-message error, retry countdown, or generic failure is visible",
  ]);
  expect(finalFrame.ok, finalFrame.why).toBe(true);
  evidence.recordAssertionEvidence(
    "The old generation retires and the fresh primary serves later work",
    `Only primary pid ${newPrimary?.pid ?? "unknown"} remained before the new task answered.`,
    true,
  );
});
