import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { expect } from "vitest";
import { briefTest, claim, needs, testBrief } from "@openwork/testkit";

import {
  findFreePort,
  makeClient,
  spawnOpencodeServe,
  waitForHealthy,
} from "../../apps/app/scripts/_util.mjs";
import { getReactQueryClient } from "../../apps/app/src/react-app/infra/query-client";
import { useSessionActivityStore } from "../../apps/app/src/react-app/domains/session/status/session-activity-store";
import {
  __disposeWorkspaceSessionSyncForTest,
  __resetWorkspaceSyncReconcileHealthForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __setWorkspaceSessionSyncSubscriptionFactoryForTest,
  ensureWorkspaceSessionSync,
  reconcileFailureDegradedThreshold,
  statusKey,
  trackWorkspaceSessionSync,
  useWorkspaceSyncStreamStore,
  workspaceSyncStreamKey,
} from "../../apps/app/src/react-app/domains/session/sync/session-sync";

type TimelineEntry = {
  boundary: string;
  atMs: number;
  detail?: Record<string, string | number | boolean | null>;
};

const modelId = "working-status-liveness";
const providerId = "working-status-liveness-provider";

function streamChunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeFrame(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sleep(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

briefTest(testBrief({
  behavior: "A live run whose engine becomes unreachable (network drop, sleep, dead process) is continuously revalidated: the failure is recorded within seconds so the transcript can stop presenting a confident ticking Working row, the busy state is never fabricated into idle, and reachability alone settles the run from authoritative status.",
  claims: {
    continuousValidation: claim("while a run is believed live, the sync layer keeps revalidating against /session/status and records consecutive failures once the engine is unreachable, crossing the degraded threshold within seconds", {
      never: "swallow failed revalidations silently while a Working indicator keeps ticking",
    }),
    noFabricatedIdle: claim("an unreachable engine leaves the busy run state and status cache untouched", {
      never: "invent idle or completion from elapsed time or from failed validation",
    }),
    degradedPresentation: claim("the recorded failure count crosses the exported threshold that flips the transcript from the ticking Working row to its reconnecting presentation, and the frozen last-confirmed time predates the outage", {
      never: "present unvalidated elapsed time as confident progress",
    }),
    authoritativeRecovery: claim("once an engine answers on the same endpoint again, one revalidation settles the run from authoritative status and clears the degradation without a reload or timer expiry", {
      never: "require user action or stream reconnect backoff to settle a reachable run",
    }),
  },
}), async ({ prove, evidence }) => {
  needs({
    commands: ["opencode"],
    optIn: ["OPENWORK_EVAL_E2E_TESTS"],
    placement: "local",
  });

  const startedAt = performance.now();
  const timeline: TimelineEntry[] = [];
  const stamp = (
    boundary: string,
    detail?: Record<string, string | number | boolean | null>,
  ) => {
    timeline.push({
      boundary,
      atMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...(detail ? { detail } : {}),
    });
  };
  const timeOf = (boundary: string) => timeline.find((entry) => entry.boundary === boundary)?.atMs;

  const workspace = await mkdtemp(join(tmpdir(), "openwork-working-status-liveness-"));
  await mkdir(join(workspace, ".opencode"), { recursive: true });
  const workspaceId = "workspace-working-status-liveness";
  let engineBaseUrl = "";

  let provider: Server | null = null;
  const heldProviderResponses: ServerResponse[] = [];
  let engine: Awaited<ReturnType<typeof spawnOpencodeServe>> | null = null;
  let restartedEngine: Awaited<ReturnType<typeof spawnOpencodeServe>> | null = null;
  let releaseWorkspaceSync: (() => void) | null = null;
  let releaseTrackedSession: (() => void) | null = null;
  let syncInput: { workspaceId: string; baseUrl: string; openworkToken: string } | null = null;
  let sessionId = "";
  let statusFetchAttempts = 0;
  let statusFetchAttemptsAtKill = 0;

  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  __resetWorkspaceSyncReconcileHealthForTest();
  getReactQueryClient().clear();

  try {
    const providerPort = await findFreePort();
    provider = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        // Emit a role chunk, then hold the stream open without a terminal
        // marker: the engine's run stays genuinely busy for as long as this
        // spec needs it to be.
        writeFrame(response, streamChunk("chatcmpl-working-status-liveness", { role: "assistant" }));
        heldProviderResponses.push(response);
        stamp("provider.holding-run-open");
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider?.once("error", reject);
      provider?.listen(providerPort, "127.0.0.1", resolve);
    });
    stamp("provider.listening");

    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Working status liveness fixture",
          options: {
            apiKey: "fixture-key",
            baseURL: `http://127.0.0.1:${providerPort}/v1`,
          },
          models: { [modelId]: { name: "Working status liveness fixture" } },
        },
      },
    }, null, 2));

    const enginePort = await findFreePort();
    engine = await spawnOpencodeServe({ directory: workspace, port: enginePort });
    engineBaseUrl = engine.baseUrl;
    const client = makeClient({ baseUrl: engineBaseUrl, directory: workspace });
    await waitForHealthy(client);
    stamp("opencode.healthy");

    syncInput = {
      workspaceId,
      baseUrl: engineBaseUrl,
      openworkToken: "fixture-token",
    };
    const healthKey = workspaceSyncStreamKey(syncInput);
    const reconcileHealth = () => useWorkspaceSyncStreamStore.getState().reconcileHealthByKey[healthKey];

    __setWorkspaceSessionSyncSubscriptionFactoryForTest(async (_baseUrl, _token, signal) => {
      const subscription = await client.event.subscribe({ directory: workspace }, { signal });
      stamp("sync.event-stream-connected");
      return subscription.stream;
    });
    __setWorkspaceSessionSyncStatusFetcherForTest(async (_baseUrl, _token, signal) => {
      statusFetchAttempts += 1;
      return await client.session.status(undefined, { signal }) as Record<string, SessionStatus>;
    });

    releaseWorkspaceSync = ensureWorkspaceSessionSync(syncInput);
    const session = await client.session.create({ title: "Working status liveness" });
    sessionId = session.id;
    releaseTrackedSession = trackWorkspaceSessionSync(syncInput, sessionId);
    stamp("opencode.session-created");

    await client.session.promptAsync({
      sessionID: sessionId,
      model: { providerID: providerId, modelID: modelId },
      parts: [{ type: "text", text: "Hold this run open." }],
    });
    stamp("opencode.prompt-accepted");

    const runObservedBusy = await waitUntil(() => (
      useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive === true
      && heldProviderResponses.length > 0
    ), 15_000);
    expect(runObservedBusy).toBe(true);
    const validatedWhileHealthy = await waitUntil(() => statusFetchAttempts >= 2, 5_000);
    expect(validatedWhileHealthy).toBe(true);
    expect(reconcileHealth()?.consecutiveFailures ?? 0).toBe(0);
    stamp("sync.run-busy-and-validated", { statusFetchAttempts });

    // The engine dies abruptly mid-run — the local stand-in for a network
    // drop, a laptop sleep that severed connections, or a crashed engine.
    statusFetchAttemptsAtKill = statusFetchAttempts;
    engine.child.kill("SIGKILL");
    stamp("engine.killed");

    const degraded = await waitUntil(
      () => (reconcileHealth()?.consecutiveFailures ?? 0) >= reconcileFailureDegradedThreshold,
      10_000,
    );
    stamp("sync.degraded-threshold-crossed", {
      consecutiveFailures: reconcileHealth()?.consecutiveFailures ?? 0,
      attemptsSinceKill: statusFetchAttempts - statusFetchAttemptsAtKill,
    });
    const runStillBusyWhileUnreachable =
      useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive === true;
    const statusCacheStillBusy =
      (getReactQueryClient().getQueryData<SessionStatus>(statusKey(workspaceId, sessionId)))?.type === "busy";
    const lastConfirmedAt = reconcileHealth()?.lastSuccessAt ?? null;

    const killAt = timeOf("engine.killed");
    const degradedAt = timeOf("sync.degraded-threshold-crossed");
    const killToDegradedMs = (degradedAt ?? Infinity) - (killAt ?? 0);

    prove.continuousValidation(
      degraded
      && statusFetchAttempts - statusFetchAttemptsAtKill >= reconcileFailureDegradedThreshold
      && killToDegradedMs < 10_000,
      `After the engine was killed mid-run, the live reconcile loop kept attempting /session/status (${statusFetchAttempts - statusFetchAttemptsAtKill} attempts) and recorded ${reconcileHealth()?.consecutiveFailures ?? 0} consecutive failures, crossing the degraded threshold ${killToDegradedMs.toFixed(0)}ms after the kill.`,
    );
    prove.noFabricatedIdle(
      runStillBusyWhileUnreachable && statusCacheStillBusy,
      "While the engine was unreachable, the activity record stayed runActive and the status cache stayed busy: failed validation was recorded as degraded health, never converted into a fabricated idle.",
    );
    prove.degradedPresentation(
      (reconcileHealth()?.consecutiveFailures ?? 0) >= reconcileFailureDegradedThreshold
      && lastConfirmedAt !== null
      && lastConfirmedAt <= Date.now(),
      `The recorded failure count (${reconcileHealth()?.consecutiveFailures}) meets reconcileFailureDegradedThreshold (${reconcileFailureDegradedThreshold}) — the exact store input the session surface maps to the reconnecting row with its timer frozen — and the frozen last-confirmed time (${lastConfirmedAt}) predates the outage.`,
    );

    // The engine returns on the same endpoint. A fresh engine has no busy
    // session, so authoritative status settles the stale busy run to idle and
    // the recorded degradation clears — with no reload and no reliance on
    // stream reconnect backoff.
    restartedEngine = await spawnOpencodeServe({ directory: workspace, port: enginePort });
    stamp("engine.restarted");
    const recovered = await waitUntil(() => (
      useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive === false
      && (reconcileHealth()?.consecutiveFailures ?? 0) === 0
    ), 10_000);
    stamp("sync.recovered", {
      consecutiveFailures: reconcileHealth()?.consecutiveFailures ?? 0,
    });
    const restartAt = timeOf("engine.restarted");
    const recoveredAt = timeOf("sync.recovered");
    const restartToRecoveredMs = (recoveredAt ?? Infinity) - (restartAt ?? 0);
    const statusCacheIdleAfterRecovery =
      (getReactQueryClient().getQueryData<SessionStatus>(statusKey(workspaceId, sessionId)))?.type === "idle";

    prove.authoritativeRecovery(
      recovered && statusCacheIdleAfterRecovery && restartToRecoveredMs < 10_000,
      `After an engine answered on the same endpoint again, the run settled from authoritative status within ${restartToRecoveredMs.toFixed(0)}ms: runActive cleared, the status cache read idle, and consecutive failures reset to ${reconcileHealth()?.consecutiveFailures ?? 0}.`,
    );

    evidence.recordJsonArtifact("working status liveness timeline", {
      schemaVersion: 1,
      timings: timeline,
      counters: {
        statusFetchAttempts,
        attemptsSinceKill: statusFetchAttempts - statusFetchAttemptsAtKill,
        degradedThreshold: reconcileFailureDegradedThreshold,
      },
    });
  } finally {
    releaseTrackedSession?.();
    releaseWorkspaceSync?.();
    if (syncInput) __disposeWorkspaceSessionSyncForTest(syncInput);
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(null);
    __setWorkspaceSessionSyncStatusFetcherForTest(null);
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
    __resetWorkspaceSyncReconcileHealthForTest();
    getReactQueryClient().clear();
    for (const held of heldProviderResponses) {
      try {
        held.end();
      } catch {
        // Already closed with its engine.
      }
    }
    await engine?.close();
    await restartedEngine?.close();
    if (provider) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider?.close(() => resolve()));
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
