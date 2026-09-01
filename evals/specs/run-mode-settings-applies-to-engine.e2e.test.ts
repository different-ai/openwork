import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { eventually, needs, test } from "@openwork/testkit";
import type { Surface } from "@openwork/cdp";

/**
 * The user-visible half of the run mode: choosing it in Settings must change
 * the permission config the running engine serves for this workspace, and
 * choosing the default again must remove it — on the same engine process
 * tree, without the user reloading anything.
 *
 * What this spec does not claim: that a shell tool call prompts in one mode
 * and not the other. On a default install the pinned engine already allows
 * shell, edit, webfetch, and MCP tools in both modes; the engine-evaluated
 * ruleset per mode is covered by run-mode-engine-effective.
 */

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "choosing a run mode in Settings changes the running engine's permission config and back"
  : "run mode Settings journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

interface RunModeFacts {
  storedMode: string;
  catchAll: string | null;
  doomLoop: string | null;
  externalDirectoryDefault: string | null;
  configStatus: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFacts(value: unknown): RunModeFacts {
  if (!isRecord(value) || typeof value.storedMode !== "string" || typeof value.configStatus !== "number") {
    throw new Error(`Invalid run mode facts: ${JSON.stringify(value)}`);
  }
  const text = (entry: unknown) => (typeof entry === "string" ? entry : null);
  return {
    storedMode: value.storedMode,
    catchAll: text(value.catchAll),
    doomLoop: text(value.doomLoop),
    externalDirectoryDefault: text(value.externalDirectoryDefault),
    configStatus: value.configStatus,
  };
}

/** Stored mode from the local server plus the permission config the engine serves for this workspace. */
async function readRunModeFacts(app: Surface, workspaceId: string): Promise<RunModeFacts> {
  const value = await evalIn(app, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { storedMode: "", configStatus: 0 };
    const root = String(info.baseUrl).replace(/\\/+$/, "") + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)});
    const headers = { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") };
    const [modeResponse, configResponse] = await Promise.all([
      fetch(root + "/run-mode", { headers, signal: AbortSignal.timeout(10000) }),
      fetch(root + "/opencode/config", { headers, signal: AbortSignal.timeout(20000) }),
    ]);
    const mode = modeResponse.ok ? await modeResponse.json() : {};
    const config = configResponse.ok ? await configResponse.json() : {};
    const permission = config && typeof config.permission === "object" && config.permission ? config.permission : {};
    const externalDirectory = permission.external_directory && typeof permission.external_directory === "object"
      ? permission.external_directory
      : {};
    return {
      storedMode: typeof mode.mode === "string" ? mode.mode : "",
      catchAll: permission["*"] ?? null,
      doomLoop: permission.doom_loop ?? null,
      externalDirectoryDefault: externalDirectory["*"] ?? null,
      configStatus: configResponse.status,
    };
  })()`, { awaitPromise: true, timeoutMs: 45_000 });
  return parseFacts(value);
}

/** Real pointer input on an element's center: Base UI selects open on pointerdown, not synthetic click(). */
async function pointerClick(app: Surface, selectorExpression: string, label: string): Promise<void> {
  const rect = await waitFor(app, `(() => {
    const element = ${selectorExpression};
    if (!(element instanceof HTMLElement) || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return null;
    element.scrollIntoView({ block: "center" });
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  })()`, { timeoutMs: 60_000, label });
  if (!isRecord(rect) || typeof rect.x !== "number" || typeof rect.y !== "number") {
    throw new Error(`${label}: no clickable box (${JSON.stringify(rect)})`);
  }
  const base = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
  await app.client.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
  await app.client.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await app.client.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
}

async function chooseRunMode(app: Surface, optionLabel: string): Promise<void> {
  await pointerClick(app, `document.querySelector('button[aria-label="Run mode"]')`, "run mode select trigger");
  await pointerClick(
    app,
    `[...document.querySelectorAll('[role="option"]')].find((option) => (option.textContent ?? "").trim() === ${JSON.stringify(optionLabel)}) ?? null`,
    `run mode option ${optionLabel}`,
  );
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 12 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using desktopApp = await desktop({ name: "run-mode-settings", host: place.host() });
  const { workspaceId } = await createAndSelectWorkspace(desktopApp, {
    path: `/tmp/openwork-run-mode-settings-${Date.now()}`,
  });

  await go(desktopApp, `/workspace/${encodeURIComponent(workspaceId)}/settings/permissions`);
  await waitFor(desktopApp, `document.body.innerText.includes("Execution and approvals")
    && document.body.innerText.includes("Authorized folders")`, { timeoutMs: 120_000, label: "Permissions settings visible" });

  const before = await eventually(() => readRunModeFacts(desktopApp, workspaceId), {
    within: 120_000,
    intervalMs: 1_000,
    label: "engine config served for the workspace",
    until: (facts) => facts.configStatus === 200 && facts.storedMode !== "",
  });
  expect(before.storedMode).toBe("approve");
  expect(before.catchAll).toBeNull();
  expect(before.doomLoop).toBeNull();
  expect(before.externalDirectoryDefault).toBeNull();
  await screenshot(desktopApp);

  await chooseRunMode(desktopApp, "Run everything");
  await waitFor(desktopApp, `document.body.innerText.includes("Run mode updated.")
    && document.body.innerText.includes("You accept the risk of unattended tool runs")`, {
    timeoutMs: 120_000,
    label: "run everything saved with its risk warning visible",
  });
  await screenshot(desktopApp);

  // Claim: the running engine now serves the compiled preset for this
  // workspace — catch-all allow with the protections restated — without a
  // manual reload.
  const enabled = await eventually(() => readRunModeFacts(desktopApp, workspaceId), {
    within: 120_000,
    intervalMs: 1_000,
    label: "engine serves the run-everything preset",
    until: (facts) => facts.storedMode === "run-everything" && facts.catchAll === "allow",
  });
  expect(enabled.doomLoop).toBe("ask");
  expect(enabled.externalDirectoryDefault).toBe("ask");
  evidence.recordAssertionEvidence(
    "Choosing Run everything in Settings reaches the running engine",
    `Stored mode ${enabled.storedMode}; engine /config for the workspace now has permission["*"]=${enabled.catchAll}, doom_loop=${enabled.doomLoop}, external_directory["*"]=${enabled.externalDirectoryDefault}.`,
    true,
  );

  // Negative half: the safety direction is just as immediate and leaves no
  // preset behind.
  await chooseRunMode(desktopApp, "Approve each step");
  await waitFor(desktopApp, `document.body.innerText.includes("Run mode updated.")
    && !document.body.innerText.includes("You accept the risk of unattended tool runs")`, {
    timeoutMs: 120_000,
    label: "approve each step saved and the risk warning gone",
  });
  const restored = await eventually(() => readRunModeFacts(desktopApp, workspaceId), {
    within: 120_000,
    intervalMs: 1_000,
    label: "engine serves the default posture again",
    until: (facts) => facts.storedMode === "approve" && facts.catchAll === null,
  });
  expect(restored.doomLoop).toBeNull();
  expect(restored.externalDirectoryDefault).toBeNull();
  evidence.recordAssertionEvidence(
    "Choosing Approve each step again removes the preset from the running engine",
    `Stored mode ${restored.storedMode}; engine /config permission["*"]=${String(restored.catchAll)}, doom_loop=${String(restored.doomLoop)}, external_directory["*"]=${String(restored.externalDirectoryDefault)}.`,
    true,
  );
  await screenshot(desktopApp);
});
