import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "the OpenCode v2 engine preview flag controls a hot-mirroring parallel sidecar"
  : "OpenCode v2 engine preview flag skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

interface EngineV2PreviewStatus {
  enabled: boolean;
  running: boolean;
  chatRouting: boolean;
  version?: string;
  pid?: number;
  binSource?: string;
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
}

interface ServerFetchResult {
  status: number;
  json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}



function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Engine v2 status ${field} was not a string array: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseStatus(value: unknown): EngineV2PreviewStatus {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.running !== "boolean" || typeof value.chatRouting !== "boolean") {
    throw new Error(`Unexpected engine v2 preview status: ${JSON.stringify(value)}`);
  }
  if (value.pid !== undefined && typeof value.pid !== "number") throw new Error(`Unexpected engine v2 pid: ${JSON.stringify(value.pid)}`);
  return {
    enabled: value.enabled,
    running: value.running,
    chatRouting: value.chatRouting,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.binSource === "string" ? { binSource: value.binSource } : {}),
    mirroredProviderIds: stringArray(value.mirroredProviderIds, "mirroredProviderIds"),
    skippedProviderIds: stringArray(value.skippedProviderIds, "skippedProviderIds"),
    catalogModelIds: stringArray(value.catalogModelIds, "catalogModelIds"),
    ...(typeof value.lastMirroredAt === "string" ? { lastMirroredAt: value.lastMirroredAt } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

async function serverFetchJson(
  app: Parameters<typeof evalIn>[0],
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<ServerFetchResult> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const requestBody = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (init.body !== undefined && requestBody === undefined) throw new Error(`Could not serialize request body for ${path}`);
  const value = await evalIn(app, `(async () => {
    const port = (localStorage.getItem("openwork.server.port") ?? "").trim();
    const token = (localStorage.getItem("openwork.server.token") ?? "").trim();
    if (!port || !token) return { specProbeError: "missing local server credentials" };
    const response = await fetch("http://127.0.0.1:" + port + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(init.method ?? "GET")},
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ${requestBody === undefined ? "" : `body: ${JSON.stringify(requestBody)},`}
      signal: AbortSignal.timeout(${timeoutMs}),
    });
    const text = await response.text();
    let json = text;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json };
  })()`, { awaitPromise: true, timeoutMs: timeoutMs + 5_000 });
  if (!isRecord(value) || typeof value.status !== "number" || !("json" in value)) {
    throw new Error(`Server request ${path} failed: ${JSON.stringify(value)}`);
  }
  return { status: value.status, json: value.json };
}

async function readStatus(app: Parameters<typeof evalIn>[0]): Promise<EngineV2PreviewStatus> {
  const result = await serverFetchJson(app, "/experimental/engine-v2-preview/status");
  expect(result.status).toBe(200);
  return parseStatus(result.json);
}

async function untilStatus(
  app: Parameters<typeof evalIn>[0],
  predicate: (status: EngineV2PreviewStatus) => boolean,
  timeoutMs: number,
  label: string,
): Promise<EngineV2PreviewStatus> {
  const deadline = Date.now() + timeoutMs;
  let last = await readStatus(app);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    last = await readStatus(app);
  }
  throw new Error(`Timed out waiting for ${label}; last status: ${JSON.stringify(last)}`);
}

async function clickEngineOption(app: Parameters<typeof evalIn>[0], engine: "v1" | "v2"): Promise<void> {
  const point = await evalIn(app, `(() => {
    const control = Array.from(document.querySelectorAll('[aria-label="Chat engine"] [data-engine="${engine}"]'))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    if (!(control instanceof HTMLElement)) return null;
    control.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = control.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (
    !isRecord(point)
    || typeof point.x !== "number"
    || typeof point.y !== "number"
  ) {
    throw new Error(`Could not resolve the ${engine} chat engine option: ${JSON.stringify(point)}`);
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

const engineSelectedExpression = (engine: "v1" | "v2") => `(() => {
  const group = document.querySelector('[aria-label="Chat engine"]');
  const control = group?.querySelector('[data-engine="${engine}"]');
  return control?.getAttribute("aria-pressed") === "true" || control?.getAttribute("data-state") === "on";
})()`;

const engineReadyExpression = `(() => {
  const group = document.querySelector('[aria-label="Chat engine"]');
  if (!group || group.getAttribute("aria-disabled") === "true" || group.hasAttribute("data-disabled")) return false;
  const control = group.querySelector('[data-engine="v1"]');
  return control?.getAttribute("aria-pressed") === "true" || control?.getAttribute("data-state") === "on";
})()`;

test.skipIf(!enabled)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const binPath = place.kind === "local" ? process.env.OPENWORK_EVAL_OPENCODE2_BIN?.trim() || undefined : undefined;
  const profileDir = place.kind === "local"
    ? await mkdtemp(join(tmpdir(), "openwork-engine-v2-preview-eval-"))
    : undefined;
  let app: Awaited<ReturnType<typeof desktop>> | undefined;

  try {
    app = await desktop({
      name: "engine-v2-preview-flag",
      host: place.host(),
      ...(profileDir === undefined ? {} : { profileDir }),
      env: binPath === undefined ? {} : { OPENWORK_OPENCODE2_BIN: binPath },
    });
    let workspacePath: string;
    if (place.kind === "daytona") {
      if (!app.workspaceRoot) throw new Error("Daytona desktop did not expose its workspace root");
      workspacePath = `${app.workspaceRoot}/evals-tmp/engine-v2-preview-${Date.now()}`;
    } else {
      if (profileDir === undefined) throw new Error("Local desktop profile directory was unavailable");
      workspacePath = join(profileDir, "workspace");
    }
    const { workspaceId } = await createAndSelectWorkspace(app, { path: workspacePath });

    const defaultStatus = await readStatus(app);
    expect(defaultStatus).toMatchObject({ enabled: false, running: false });
    expect(Object.hasOwn(defaultStatus, "pid")).toBe(false);
    await go(app, `/workspace/${workspaceId}/settings/advanced`);
    await waitFor(app, engineReadyExpression, {
      timeoutMs: 60_000,
      label: "ready, selected OpenCode v1 chat engine option",
    });
    evidence.recordAssertionEvidence(
      "F1 the preview defaults off without a sidecar",
      "The server reported enabled=false and running=false with no pid, while Advanced Settings selected OpenCode v1.",
      true,
    );

    await clickEngineOption(app, "v2");
    await waitFor(app, engineSelectedExpression("v2"), {
      timeoutMs: 30_000,
      label: "selected OpenCode v2 chat engine option",
    });
    const runningStatus = await untilStatus(
      app,
      (status) => status.enabled && status.running && typeof status.pid === "number",
      180_000,
      "the OpenCode v2 sidecar to start",
    );
    const pid0 = runningStatus.pid;
    if (pid0 === undefined) throw new Error("Running OpenCode v2 status did not contain a pid");
    expect(runningStatus.chatRouting).toBe(true);
    await waitFor(app, `document.body.innerText.includes("Running v")`, {
      timeoutMs: 30_000,
      label: "OpenCode v2 running status line",
    });
    const healthResponse = await serverFetchJson(app, "/health");
    expect(healthResponse.status).toBe(200);
    evidence.recordAssertionEvidence(
      "F2 enabling starts the parallel sidecar without replacing v1",
      `The UI showed a running OpenCode v2 sidecar at pid ${pid0}, while the existing server health endpoint continued returning 200.`,
      true,
    );

    const seededMemberKey = await evalIn(app, `(async () => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/env", {
        method: "PUT", headers: { "x-openwork-host-token": info.hostToken, "Content-Type": "application/json" },
        body: JSON.stringify({ entries: [{ key: "MEMBER_PRIVATE_API_KEY", value: "member-owned-eval-secret" }] })
      });
      return response.status;
    })()`, { awaitPromise: true });
    expect(seededMemberKey).toBe(200);
    const patchResponse = await serverFetchJson(app, `/workspace/${workspaceId}/config`, {
      method: "PATCH",
      body: {
        opencode: {
          provider: {
            "openwork-witness-e2e": {
              npm: "@ai-sdk/openai-compatible",
              name: "Witness E2E",
              options: { baseURL: "http://127.0.0.1:65533/v1", apiKey: "witness-key-e2e" },
              models: { "witness-model-e2e": { name: "Witness Model E2E" } },
            },
            "openwork-skip-e2e": { name: "Skip E2E", options: {} },
            "lpr_unapproved_e2e": {
              npm: "@ai-sdk/openai", options: { baseURL: "http://127.0.0.1:65532/v1" },
              env: ["MEMBER_PRIVATE_API_KEY"], models: { "unapproved-model-e2e": { name: "Unapproved Model" } },
            },
            "openwork-untrusted-api-e2e": {
              npm: "@ai-sdk/openai", api: "http://127.0.0.1:65532/v1",
              options: { apiKey: "rejected-endpoint-key" },
              models: { "rejected-model-e2e": { name: "Rejected Model" } },
            },
          },
        },
      },
    });
    expect(patchResponse.status).toBe(200);
    const patchCompletedAt = Date.now();
    const mirroredStatus = await untilStatus(
      app,
      (status) => status.mirroredProviderIds.includes("openwork-witness-e2e"),
      60_000,
      "the witness provider to be mirrored",
    );
    const mirrorLatencyMs = Date.now() - patchCompletedAt;
    const catalogStatus = await untilStatus(
      app,
      (status) => status.catalogModelIds.includes("witness-model-e2e"),
      120_000,
      "the witness model to appear in the catalog",
    );
    const catalogLatencyMs = Date.now() - patchCompletedAt;
    console.info(`[engine-v2-preview-flag] mirror latency after PATCH 200: ${mirrorLatencyMs}ms; catalog latency: ${catalogLatencyMs}ms`);
    expect(mirroredStatus.skippedProviderIds).toContain("openwork-skip-e2e");
    expect(mirroredStatus.mirroredProviderIds).not.toContain("openwork-skip-e2e");
    expect(mirroredStatus.skippedProviderIds).toContain("openwork-untrusted-api-e2e");
    expect(mirroredStatus.mirroredProviderIds).not.toContain("openwork-untrusted-api-e2e");
    expect(catalogStatus.catalogModelIds).not.toContain("rejected-model-e2e");
    evidence.recordAssertionEvidence("untrusted catalog API endpoints are rejected before credential delivery", "The native provider with an internal catalog API URL and a synthetic credential was reported skipped, never mirrored, and absent from the live model catalog.", true);
    expect(mirroredStatus.skippedProviderIds).toContain("lpr_unapproved_e2e");
    expect(mirroredStatus.mirroredProviderIds).not.toContain("lpr_unapproved_e2e");
    expect(catalogStatus.catalogModelIds).not.toContain("unapproved-model-e2e");
    evidence.recordAssertionEvidence("an organization endpoint cannot claim a member-owned stored credential", "A real member env-store key was present, but the org provider declaring that name without provider-specific cloud credential ownership was skipped and absent from the v2 catalog, including with an explicit custom base URL.", true);
    expect(catalogStatus.pid).toBe(pid0);
    expect(mirroredStatus.running).toBe(true);
    for (const configPath of ["/api/config", "/api/config/", "/api/%63onfig"]) {
      const privateConfig = await serverFetchJson(app, `/workspace/${workspaceId}/opencode2${configPath}`);
      expect(privateConfig.status).toBe(403);
      expect(JSON.stringify(privateConfig.json)).not.toContain("witness-key-e2e");
    }
    evidence.recordAssertionEvidence(
      "F3 private sidecar configuration never exposes mirrored provider credentials",
      "Authenticated reads of the config endpoint, trailing-slash form, and encoded form returned 403 without the synthetic provider key, while the catalog still exposed the witness model.",
      true,
    );
    evidence.recordAssertionEvidence(
      "F3 provider changes hot-mirror without restarting the sidecar",
      `The witness provider mirrored after ${mirrorLatencyMs}ms and its model appeared in the catalog after ${catalogLatencyMs}ms, the invalid provider was skipped and never mirrored, and the sidecar remained running at pid ${pid0}.`,
      true,
    );

    await clickEngineOption(app, "v1");
    const disabledStatus = await untilStatus(
      app,
      (status) => !status.enabled && !status.running,
      60_000,
      "the OpenCode v2 sidecar to stop",
    );
    expect(Object.hasOwn(disabledStatus, "pid")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const settledDisabledStatus = await readStatus(app);
    expect(settledDisabledStatus).toMatchObject({ enabled: false, running: false });
    expect(Object.hasOwn(settledDisabledStatus, "pid")).toBe(false);
    await waitFor(app, engineSelectedExpression("v1"), {
      timeoutMs: 30_000,
      label: "selected OpenCode v1 chat engine option after shutdown",
    });
    evidence.recordAssertionEvidence(
      "F4 disabling stops the sidecar without a zombie restart",
      "The server remained disabled and not running with no pid after a two-second settling period, and the UI returned to OpenCode v1.",
      true,
    );
  } finally {
    if (app !== undefined) await app.stop();
    if (profileDir !== undefined) await rm(profileDir, { recursive: true, force: true });
  }
});
