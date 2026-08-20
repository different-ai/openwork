import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, onTestFinished } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `unconfigured workspace notification skipped — needs: ${missingRequirements.join(", ")}`
  : "an unconfigured workspace explains that it needs a model without rendering a wire error";
const repoRoot = resolve(import.meta.dirname, "../..");
const serverToken = "owt_unconfigured_notification";
const mappedMessage = "Choose a model for this workspace, then try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function startUnconfiguredServer(
  workspacePath: string,
  workspaceId: string,
): Promise<{ appBaseUrl: string; directBaseUrl: string }> {
  const script = `
    const { startServer } = await import("./src/server.ts");
    const server = await startServer({
      host: "0.0.0.0",
      port: 0,
      token: ${JSON.stringify(serverToken)},
      corsOrigins: ["*"],
      workspaces: [{
        id: ${JSON.stringify(workspaceId)},
        name: "Unconfigured workspace",
        path: ${JSON.stringify(workspacePath)},
        preset: "starter",
        workspaceType: "local",
      }],
      authorizedRoots: [${JSON.stringify(workspacePath)}],
      readOnly: false,
      approval: { mode: "auto", timeoutMs: 30_000 },
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "none",
      logFormat: "pretty",
      logRequests: false,
    });
    console.log("UNCONFIGURED_SERVER_PORT:" + server.port);
    setInterval(() => {}, 60_000);
  `;
  const child = spawn("bun", ["--conditions=development", "-e", script], {
    cwd: join(repoRoot, "apps", "server"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Unconfigured OpenWork server did not report a port within 30s.")),
      30_000,
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/UNCONFIGURED_SERVER_PORT:(\d+)/);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Unconfigured OpenWork server exited early (${code}): ${stderr.slice(0, 500)}`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return {
    appBaseUrl: `http://127.0.0.1.nip.io:${port}`,
    directBaseUrl: `http://127.0.0.1:${port}`,
  };
}

test(title, async ({ evidence }) => {
  needs(requirements);
  const localWorkspacePath = await mkdtemp(join(tmpdir(), "openwork-notification-shell-"));
  onTestFinished(async () => {
    await rm(localWorkspacePath, { recursive: true, force: true });
  });

  await using app = await desktop({ name: "opencode-unconfigured-notification" });
  const workspace = await createAndSelectWorkspace(app, { path: localWorkspacePath });
  const server = await startUnconfiguredServer(localWorkspacePath, workspace.workspaceId);

  const configResponse = await fetch(
    `${server.directBaseUrl}/workspace/${workspace.workspaceId}/config`,
    { headers: { authorization: `Bearer ${serverToken}` } },
  );
  const config: unknown = await configResponse.json();
  const opencodeConfig = isRecord(config) && isRecord(config.opencode) ? config.opencode : {};
  const providerConfig = isRecord(opencodeConfig.provider) ? opencodeConfig.provider : {};
  expect(configResponse.status).toBe(200);
  expect(opencodeConfig.model).toBeUndefined();
  expect(Object.keys(providerConfig)).toEqual([]);

  const engineResponse = await fetch(
    `${server.directBaseUrl}/workspace/${workspace.workspaceId}/opencode/session`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${serverToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  const engineError: unknown = await engineResponse.json();
  expect(engineResponse.status).toBe(400);
  expect(isRecord(engineError) ? engineError.code : null).toBe("opencode_unconfigured");

  expect(await evalIn(app, `(() => {
    const state = { rawSeen: document.body.innerText.includes('{"code":') };
    const observer = new MutationObserver(() => {
      if (document.body.innerText.includes('{"code":')) state.rawSeen = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__issue3980NotificationProbe = { observer, state };
    return true;
  })()`)).toBe(true);

  const switchedServer = await evalIn(app, `(async () => {
    const invoke = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!invoke) return false;
    localStorage.setItem("openwork.server.urlOverride", ${JSON.stringify(server.appBaseUrl)});
    localStorage.setItem("openwork.server.token", ${JSON.stringify(serverToken)});
    localStorage.removeItem("openwork.server.hostToken");
    await invoke("engineStop");
    window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    return true;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(switchedServer).toBe(true);
  await waitFor(app, `window.__openworkControl.listActions()
    .some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 60_000,
    label: "New task action for unconfigured workspace",
  });
  const createResult = await evalIn(
    app,
    `window.__openworkControl.execute("session.create_task", null)`,
    { awaitPromise: true, timeoutMs: 30_000 },
  );
  expect(isRecord(createResult) ? createResult.ok : null).toBe(false);

  const outcome = await waitFor(app, `(() => {
    const probe = window.__issue3980NotificationProbe;
    if (probe?.state.rawSeen) return "raw";
    if (document.body.innerText.includes(${JSON.stringify(mappedMessage)})) return "mapped";
    return false;
  })()`, {
    timeoutMs: 30_000,
    label: "mapped unconfigured-workspace message without a raw wire error",
  });
  expect(outcome).toBe("mapped");

  const visibleProof = await evalIn(app, `(() => {
    const probe = window.__issue3980NotificationProbe;
    probe?.observer.disconnect();
    return {
      mappedVisible: document.body.innerText.includes(${JSON.stringify(mappedMessage)}),
      rawSeen: probe?.state.rawSeen === true,
      rawVisible: /\\{"code":/.test(document.body.innerText),
    };
  })()`);
  expect(visibleProof).toEqual({
    mappedVisible: true,
    rawSeen: false,
    rawVisible: false,
  });
  evidence.recordAssertionEvidence(
    "An unconfigured workspace never exposes its JSON error payload and gives the user a model action",
    `The real New task action visibly rendered ${JSON.stringify(mappedMessage)}; the pre-action MutationObserver and final DOM both found no /\\{"code":/ text.`,
    isRecord(visibleProof)
      && visibleProof.mappedVisible === true
      && visibleProof.rawSeen === false
      && visibleProof.rawVisible === false,
  );
});
