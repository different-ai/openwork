import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { UIMessage } from "ai";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { expect } from "vitest";
import { briefTest, claim, needs, testBrief } from "@openwork/testkit";

import {
  findFreePort,
  makeClient,
  normalizeEvent,
  spawnOpencodeServe,
  waitForHealthy,
} from "../../apps/app/scripts/_util.mjs";
import { getReactQueryClient } from "../../apps/app/src/react-app/infra/query-client";
import { useSessionActivityStore } from "../../apps/app/src/react-app/domains/session/status/session-activity-store";
import {
  __disposeWorkspaceSessionSyncForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __setWorkspaceSessionSyncSubscriptionFactoryForTest,
  ensureWorkspaceSessionSync,
  snapshotKey,
  statusKey,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../../apps/app/src/react-app/domains/session/sync/session-sync";

type TimelineEntry = {
  boundary: string;
  atMs: number;
  detail?: Record<string, string | number | boolean | null>;
};

const modelId = "session-completion-reconciliation";
const providerId = "session-completion-provider";
const finalAnswer = "The fixture capability completed successfully.";
const finalToTerminalDelayMs = 800;
const terminalToProviderEndDelayMs = 600;

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

function eventSessionId(event: ReturnType<typeof normalizeEvent>): string {
  if (!event) return "";
  const properties = (event.properties ?? {}) as {
    sessionID?: unknown;
    part?: { sessionID?: unknown };
    info?: { sessionID?: unknown };
  };
  const value = properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID;
  return typeof value === "string" ? value : "";
}

function messageParts(messages: UIMessage[]) {
  return messages.flatMap((message) => message.parts);
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
  behavior: "A completed OpenCode turn converges promptly to idle even when a live event transport loses its terminal edge, without treating final text or elapsed time as completion.",
  claims: {
    providerAndEngine: claim("a deterministic OpenAI-compatible provider drives a real tool call and final response through OpenCode, whose ordinary completion path emits terminal session state promptly", {
      never: "attribute provider inference or tool execution time to renderer completion convergence",
    }),
    genuineWorkStaysActive: claim("final text delivered before the provider terminal marker does not stop a genuinely active run", {
      never: "treat visible assistant text or a timer as proof that work finished",
    }),
    missedTerminalConverges: claim("when terminal events are removed from an otherwise-open transport, the authoritative session status level moves the tracked task to idle within one bounded reconciliation cycle", {
      never: "wait for stream closure, reconnect, or an arbitrary completion timeout",
    }),
    finalStatePreserved: claim("the completed tool result and final assistant answer remain visible after level-triggered idle reconciliation", {
      never: "clear or hide the final response while stopping the activity state",
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

  const workspace = await mkdtemp(join(tmpdir(), "openwork-session-completion-reconciliation-"));
  await mkdir(join(workspace, ".opencode"), { recursive: true });
  const workspaceId = "workspace-session-completion-reconciliation";
  const syncInput = {
    workspaceId,
    baseUrl: "http://session-completion-reconciliation.invalid/opencode",
    openworkToken: "fixture-token",
  };

  let provider: Server | null = null;
  let engine: Awaited<ReturnType<typeof spawnOpencodeServe>> | null = null;
  let releaseWorkspaceSync: (() => void) | null = null;
  let releaseTrackedSession: (() => void) | null = null;
  let sessionId = "";
  let providerRequests = 0;
  let providerFinalContentWritten = false;
  let providerTerminalSent = false;
  let providerEndCalled = false;
  let resolveFinalContent: () => void = () => {};
  const finalContentWritten = new Promise<void>((resolve) => {
    resolveFinalContent = resolve;
  });
  let sawBusyEvent = false;
  let sawBusyStatusAfterFinalContent = false;
  let sawAuthoritativeIdle = false;
  let filteredTerminalEvents = 0;
  let eventStreamEnded = false;

  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
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
        providerRequests += 1;
        const turn = providerRequests;
        stamp("provider.request", { turn });
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        const responseId = `chatcmpl-session-completion-${turn}`;
        writeFrame(response, streamChunk(responseId, { role: "assistant" }));

        if (turn === 1) {
          writeFrame(response, streamChunk(responseId, {
            tool_calls: [{
              index: 0,
              id: "call_fixture_capability",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "printf 'fixture capability result\\n'" }),
              },
            }],
          }));
          stamp("provider.tool-call", { turn });
          writeFrame(response, streamChunk(responseId, {}, "tool_calls"));
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }

        writeFrame(response, streamChunk(responseId, { content: finalAnswer }));
        providerFinalContentWritten = true;
        stamp("provider.final-content", { bytes: Buffer.byteLength(finalAnswer) });
        resolveFinalContent();

        void (async () => {
          await sleep(finalToTerminalDelayMs);
          writeFrame(response, streamChunk(responseId, {}, "stop"));
          response.write("data: [DONE]\n\n");
          providerTerminalSent = true;
          stamp("provider.terminal-marker", { reason: "stop" });
          await sleep(terminalToProviderEndDelayMs);
          providerEndCalled = true;
          stamp("provider.response-end-called");
          response.end();
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider?.once("error", reject);
      provider?.listen(providerPort, "127.0.0.1", resolve);
    });
    stamp("provider.listening");

    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      permission: { bash: "allow" },
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Session completion fixture",
          options: {
            apiKey: "fixture-key",
            baseURL: `http://127.0.0.1:${providerPort}/v1`,
          },
          models: { [modelId]: { name: "Session completion fixture" } },
        },
      },
    }, null, 2));

    const enginePort = await findFreePort();
    engine = await spawnOpencodeServe({ directory: workspace, port: enginePort });
    const client = makeClient({ baseUrl: engine.baseUrl, directory: workspace });
    await waitForHealthy(client);
    stamp("opencode.healthy");

    __setWorkspaceSessionSyncSubscriptionFactoryForTest(async (_baseUrl, _token, signal) => {
      const subscription = await client.event.subscribe({ directory: workspace }, { signal });
      stamp("sync.event-stream-connected");
      return (async function* filteredStream() {
        try {
          for await (const raw of subscription.stream) {
            const event = normalizeEvent(raw);
            if (!event) continue;
            const matchesSession = Boolean(sessionId) && eventSessionId(event) === sessionId;
            if (matchesSession && event.type === "session.status") {
              const properties = (event.properties ?? {}) as { status?: SessionStatus };
              if (properties.status?.type === "busy") {
                sawBusyEvent = true;
                stamp("opencode.event-busy");
              }
              if (properties.status?.type === "idle") {
                filteredTerminalEvents += 1;
                stamp("opencode.event-terminal-filtered", { event: "session.status" });
                continue;
              }
            }
            if (matchesSession && event.type === "session.idle") {
              filteredTerminalEvents += 1;
              stamp("opencode.event-terminal-filtered", { event: "session.idle" });
              continue;
            }
            if (matchesSession && event.type === "message.part.updated") {
              const properties = (event.properties ?? {}) as {
                part?: { type?: string; text?: string; state?: { status?: string } };
              };
              if (properties.part?.type === "tool" && properties.part.state?.status === "completed") {
                stamp("opencode.tool-completed");
              }
              if (properties.part?.type === "text" && properties.part.text) {
                stamp("opencode.final-message-part", {
                  bytes: Buffer.byteLength(properties.part.text),
                });
              }
            }
            yield raw;
          }
        } finally {
          eventStreamEnded = true;
          stamp("sync.event-stream-ended");
        }
      })();
    });

    let lastStatus = "";
    __setWorkspaceSessionSyncStatusFetcherForTest(async (_baseUrl, _token, signal) => {
      const statuses = await client.session.status(undefined, { signal }) as Record<string, SessionStatus>;
      if (sessionId) {
        const status = statuses[sessionId]?.type ?? "idle";
        if (status !== lastStatus) {
          lastStatus = status;
          stamp("opencode.status-level", { status });
        }
        if (providerFinalContentWritten && !providerTerminalSent && status !== "idle") {
          sawBusyStatusAfterFinalContent = true;
        }
        if (sawBusyEvent && status === "idle" && !sawAuthoritativeIdle) {
          sawAuthoritativeIdle = true;
          stamp("opencode.status-authoritative-idle");
        }
      }
      return statuses;
    });

    releaseWorkspaceSync = ensureWorkspaceSessionSync(syncInput);
    const session = await client.session.create({ title: "Session completion reconciliation" });
    sessionId = session.id;
    releaseTrackedSession = trackWorkspaceSessionSync(syncInput, sessionId);
    getReactQueryClient().setQueryData(snapshotKey(workspaceId, sessionId), { fixture: true });
    stamp("opencode.session-created");

    await client.session.promptAsync({
      sessionID: sessionId,
      model: { providerID: providerId, modelID: modelId },
      parts: [{ type: "text", text: "Run the fixture capability and report its result." }],
    });
    stamp("opencode.prompt-accepted");

    await finalContentWritten;
    const respondingBeforeTerminal = await waitUntil(
      () => useSessionActivityStore.getState().getStatus(workspaceId, sessionId) === "responding",
      500,
    );
    const statusRemainedBusyAfterFinalContent = await waitUntil(
      () => sawBusyStatusAfterFinalContent,
      600,
    );
    expect(providerTerminalSent).toBe(false);
    expect(respondingBeforeTerminal).toBe(true);
    expect(statusRemainedBusyAfterFinalContent).toBe(true);
    stamp("sync.still-active-after-final-content");

    const converged = await waitUntil(
      () => useSessionActivityStore.getState().getStatus(workspaceId, sessionId) === "idle",
      5_000,
    );
    expect(converged).toBe(true);
    stamp("sync.authoritative-idle-applied", { providerEndCalled });

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
    const parts = messageParts(transcript);
    const completedTool = parts.find((part) =>
      part.type === "dynamic-tool"
      && "state" in part
      && part.state === "output-available"
    );
    const visibleFinalAnswer = parts.some((part) =>
      part.type === "text"
      && "text" in part
      && part.text.includes(finalAnswer)
    );

    const providerTerminalAt = timeOf("provider.terminal-marker");
    const engineTerminalAt = timeOf("opencode.event-terminal-filtered");
    const authoritativeIdleAt = timeOf("opencode.status-authoritative-idle");
    const syncIdleAt = timeOf("sync.authoritative-idle-applied");
    expect(providerTerminalAt).toBeTypeOf("number");
    expect(engineTerminalAt).toBeTypeOf("number");
    expect(authoritativeIdleAt).toBeTypeOf("number");
    expect(syncIdleAt).toBeTypeOf("number");
    const providerToEngineTerminalMs = (engineTerminalAt ?? Infinity) - (providerTerminalAt ?? 0);
    const providerToAuthoritativeIdleMs = (authoritativeIdleAt ?? Infinity) - (providerTerminalAt ?? 0);
    const providerToSyncIdleMs = (syncIdleAt ?? Infinity) - (providerTerminalAt ?? 0);
    const authoritativeIdleToSyncIdleMs = (syncIdleAt ?? Infinity) - (authoritativeIdleAt ?? 0);

    prove.providerAndEngine(
      providerRequests === 2
      && sawBusyEvent
      && filteredTerminalEvents >= 1
      && providerToEngineTerminalMs >= 0
      && providerToEngineTerminalMs < 1_000,
      `The real OpenCode engine made ${providerRequests} provider turns (tool then final), emitted busy, and produced its terminal event ${providerToEngineTerminalMs.toFixed(2)}ms after the provider terminal marker.`,
    );
    prove.genuineWorkStaysActive(
      respondingBeforeTerminal && sawBusyStatusAfterFinalContent,
      `During the ${finalToTerminalDelayMs}ms final-text-to-terminal gap, authoritative status remained busy and the activity store remained responding.`,
    );
    prove.missedTerminalConverges(
      filteredTerminalEvents >= 1
      && sawAuthoritativeIdle
      && providerToAuthoritativeIdleMs >= 0
      && providerToSyncIdleMs >= 0
      && authoritativeIdleToSyncIdleMs >= 0
      && authoritativeIdleToSyncIdleMs < 500
      && !eventStreamEnded,
      `${filteredTerminalEvents} terminal event(s) were withheld while the event stream stayed open; authoritative status became idle ${providerToAuthoritativeIdleMs.toFixed(2)}ms after the provider marker and workspace sync applied idle ${authoritativeIdleToSyncIdleMs.toFixed(2)}ms after that authoritative observation.`,
    );
    prove.finalStatePreserved(
      Boolean(completedTool)
      && visibleFinalAnswer
      && getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))?.type === "idle"
      && getReactQueryClient().getQueryState(snapshotKey(workspaceId, sessionId))?.isInvalidated === true,
      `After idle convergence, the transcript retained ${transcript.length} assistant message(s), including the completed tool and ${Buffer.byteLength(finalAnswer)}-byte final answer; status cache was idle and the durable snapshot was invalidated.`,
    );

    evidence.recordJsonArtifact("session completion phase timeline", {
      schemaVersion: 1,
      timings: timeline,
      counters: {
        providerRequests,
        filteredTerminalEvents,
      },
    });

    expect(await waitUntil(() => providerEndCalled, 2_000)).toBe(true);
  } finally {
    releaseTrackedSession?.();
    releaseWorkspaceSync?.();
    __disposeWorkspaceSessionSyncForTest(syncInput);
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(null);
    __setWorkspaceSessionSyncStatusFetcherForTest(null);
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
    getReactQueryClient().clear();
    await engine?.close();
    if (provider) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider?.close(() => resolve()));
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
