import { expect } from "vitest";
import {
  clickButton,
  control,
  createOrgConnection,
  evalIn,
  readAvailableModels,
  readComposerState,
  selectModel,
  sendComposerMessage,
  waitFor,
  writeComposerText,
} from "@openwork/behaviors";
import { daytonaSandbox, deleteSandboxes, provisionDesktopSandbox } from "@openwork/hosts";
import type { DisposableHost, Host } from "@openwork/hosts";
import {
  app,
  denLink,
  eventually,
  mcpMock,
  needs,
  readConnectState,
  readDenClientState,
  server,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { Den, DenLink, Place, TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `chat over a flaky Den link skipped — needs: ${missingRequirements.join(", ")}`
  : "chat and Connect survive emulated VPN degradation, a hard Den outage, and recovery";

const BASELINE_MARKER = `den-link-baseline-${Date.now()}`;
const OFFLINE_MARKER = `den-link-offline-${Date.now()}`;
const RECOVERY_MARKER = `den-link-recovery-${Date.now()}`;
const LONG_RUN_MARKER = "DEN-LINK-LONG-RUN-COMPLETE";
const FOLLOWUP_MARKER = "DEN-LINK-FOLLOWUP-OK";
const INTERRUPTED_TEXT = "The message was interrupted";

interface EventProbe {
  disposes: Array<{ at: number }>;
  retries: Array<{ at: number; sessionID: string | null; message: string }>;
  errors: Array<{ at: number; sessionID: string | null; name: string; message: string }>;
  eventCounts: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseEventProbe(value: unknown): EventProbe {
  if (!isRecord(value)) return { disposes: [], retries: [], errors: [], eventCounts: {} };
  return {
    disposes: records(value.disposes).map((entry) => ({ at: typeof entry.at === "number" ? entry.at : 0 })),
    retries: records(value.retries).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      sessionID: typeof entry.sessionID === "string" ? entry.sessionID : null,
      message: typeof entry.message === "string" ? entry.message : "",
    })),
    errors: records(value.errors).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      sessionID: typeof entry.sessionID === "string" ? entry.sessionID : null,
      name: typeof entry.name === "string" ? entry.name : "",
      message: typeof entry.message === "string" ? entry.message : "",
    })),
    eventCounts: isRecord(value.eventCounts)
      ? Object.fromEntries(Object.entries(value.eventCounts).flatMap(([key, count]) => typeof count === "number" ? [[key, count]] : []))
      : {},
  };
}

function newestSessionId(value: unknown): string {
  if (!Array.isArray(value) || !isRecord(value[0]) || typeof value[0].sessionId !== "string") {
    throw new Error(`session.list_sessions did not return a newest session: ${JSON.stringify(value)}`);
  }
  return value[0].sessionId;
}

function listedSessionIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => isRecord(entry) && typeof entry.sessionId === "string" ? [entry.sessionId] : [])
    : [];
}

interface SurfacePlacement extends AsyncDisposable {
  host?: Host;
  link: DenLink;
}

async function placeSurfaces(den: Den, place: Place): Promise<SurfacePlacement> {
  if (place.kind === "local") {
    const link = await denLink(den.ref);
    return {
      link,
      [Symbol.asyncDispose]: () => link[Symbol.asyncDispose](),
    };
  }

  const provisioned = await provisionDesktopSandbox({
    ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
    name: "chat-survives-flaky-den-link",
    reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
    log: (line) => console.error(`[openwork/testkit] ${line}`),
  });
  let host: DisposableHost | undefined;
  try {
    host = daytonaSandbox(provisioned.sandbox);
    const desktopHost = host;
    const link = await denLink(den.ref, {
      sandboxId: provisioned.sandbox,
      client: "sandbox-loopback",
    });
    return {
      host: desktopHost,
      link,
      async [Symbol.asyncDispose](): Promise<void> {
        try {
          await link[Symbol.asyncDispose]();
        } finally {
          try {
            await desktopHost[Symbol.asyncDispose]();
          } finally {
            if (provisioned.created) await deleteSandboxes([provisioned.sandbox]);
          }
        }
      },
    };
  } catch (error) {
    try {
      await host?.[Symbol.asyncDispose]();
    } finally {
      if (provisioned.created) await deleteSandboxes([provisioned.sandbox]);
    }
    throw error;
  }
}

const assistantHasText = (text: string): string => `(() => [...document.querySelectorAll('[data-message-role="assistant"]')]
  .some((message) => (message.innerText ?? "").includes(${JSON.stringify(text)})))()`;

const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

const sessionRunningExpression = (sessionId: string): string => `(() => {
  const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${sessionId}"]`)});
  return Boolean(row?.querySelector("[data-session-loading-indicator]"));
})()`;

const denProbeExpression = (apiUrl: string): string => `(async () => {
  const token = (localStorage.getItem("openwork.den.authToken") ?? "").trim();
  try {
    const response = await fetch(${JSON.stringify(`${apiUrl}/v1/me/orgs`)}, {
      headers: { Authorization: "Bearer " + token },
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
})()`;

const toolRunningExpression = (workspaceId: string, sessionId: string): string => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  if (!port || !token) return false;
  const response = await fetch(
    "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)})
      + "/sessions/" + encodeURIComponent(${JSON.stringify(sessionId)}) + "/messages?limit=50",
    { headers: { Authorization: "Bearer " + token } },
  );
  const payload = await response.json();
  return (Array.isArray(payload?.items) ? payload.items : []).some((message) =>
    (Array.isArray(message?.parts) ? message.parts : []).some((part) =>
      part && typeof part.tool === "string" && part.tool.includes("bash")
        && (part.state?.status === "running" || part.state?.status === "pending")));
})()`;

test.skipIf(missingRequirements.length > 0)(title, { timeout: 900_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({ place, mocks: { connector: mcpMock({ allowUnauthenticatedMcp: true }) } });
  const connector = den.mocks.connector;
  const connectionName = `Den link echo ${Date.now()}`;
  await createOrgConnection(den.admin, {
    name: connectionName,
    url: connector.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  await using surfacePlacement = await placeSurfaces(den, place);
  const link = surfacePlacement.link;
  const linkedDen = { ...den, ref: link.ref };
  await using desktopApp = surfacePlacement.host
    ? await app({ den: linkedDen, as: "admin", place, host: surfacePlacement.host })
    : await app({ den: linkedDen, as: "admin", place });
  const workspaceId = desktopApp.workspaceId;

  const initialDenState = await eventually(() => readDenClientState(desktopApp), {
    within: 60_000,
    label: "authenticated organization through shaped Den link",
    until: (state) => state.authTokenPresent && Boolean(state.activeOrgId),
  });
  const initialConnectState = await eventually(() => readConnectState(desktopApp), {
    within: 90_000,
    label: "configured Connect state through shaped Den link",
    until: (state) => state.ok && state.connectEnabled === true,
  });
  evidence.recordAssertionEvidence(
    "Authentication, organization selection, and Connect configuration converge through the shaped link",
    `authTokenPresent=${initialDenState.authTokenPresent}, activeOrgId=${initialDenState.activeOrgId}, connectEnabled=${initialConnectState.connectEnabled}; Connect state is configuration, not a reachability witness.`,
    initialDenState.authTokenPresent && Boolean(initialDenState.activeOrgId) && initialConnectState.connectEnabled === true,
  );

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const providerConfigured = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const patch = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ opencode: { provider: { anthropic: { options: { apiKey: ${JSON.stringify(anthropicKey)} } } } } }),
    });
    if (!patch.ok) return "patch:" + patch.status + ":" + (await patch.text()).slice(0, 300);
    const reload = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/engine/reload", {
      method: "POST",
      headers,
    });
    return reload.ok ? "ok" : "reload:" + reload.status + ":" + (await reload.text()).slice(0, 300);
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(providerConfigured).toBe("ok");

  const preferredModel = process.env.OPENWORK_EVAL_MODEL?.trim() ?? "";
  const models = await readAvailableModels(desktopApp);
  const selectable = models.filter((model) => model.selectable);
  const anthropicModels = selectable.filter((model) => /anthropic/i.test(model.providerName) || /^claude-/i.test(model.id));
  const chosen = selectable.find((model) => model.id === preferredModel)
    ?? anthropicModels.find((model) => /^claude-sonnet-\d+-\d+$/.test(model.id))
    ?? anthropicModels.find((model) => /sonnet/i.test(model.id))
    ?? anthropicModels[0];
  if (!chosen) throw new Error(`No Anthropic model selectable in the picker. Saw: ${models.map((model) => model.id).join(", ") || "none"}`);
  await selectModel(desktopApp, chosen.id);
  evidence.recordAssertionEvidence("A real Anthropic model is selected through the product picker", `Selected ${chosen.id} (${chosen.providerName}).`, true);

  await control(desktopApp, "session.create_task");
  const baselineSubmittedAt = new Date().toISOString();
  await sendComposerMessage(
    desktopApp,
    `Use search_capabilities to find mock_echo, call it with text exactly ${BASELINE_MARKER}, then reply with exactly: BASELINE-CONNECT-COMPLETE`,
  );
  const baselineCalls = await connector.toolCalls({ name: "mock_echo", atLeast: 1, sinceIso: baselineSubmittedAt, timeoutMs: 240_000 });
  const baselineMarkerCalls = baselineCalls.filter((call) => String(call.args.text ?? "").includes(BASELINE_MARKER));
  const baselineCompleted = await waitFor(desktopApp, assistantHasText("BASELINE-CONNECT-COMPLETE"), {
    timeoutMs: 180_000,
    label: "baseline Connect completion",
  }).then(() => true, () => false);
  evidence.recordAssertionEvidence(
    "Baseline Connect reaches mock_echo exactly once and reports completion",
    `Calls carrying ${BASELINE_MARKER}: ${JSON.stringify(baselineMarkerCalls)}; completion visible=${baselineCompleted}.`,
    baselineMarkerCalls.length === 1 && baselineCompleted,
  );
  expect(baselineMarkerCalls).toHaveLength(1);
  expect(baselineCompleted).toBe(true);

  const tailStarted = await evalIn(desktopApp, `(() => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    window.__owDenLink = { active: true, disposes: [], retries: [], errors: [], eventCounts: {} };
    const record = (event) => {
      const probe = window.__owDenLink;
      const type = String(event?.type ?? "unknown");
      probe.eventCounts[type] = (probe.eventCounts[type] ?? 0) + 1;
      if (type.includes("disposed")) probe.disposes.push({ at: Date.now() });
      const properties = event?.properties ?? {};
      if (type === "session.status" && properties?.status?.type === "retry") {
        probe.retries.push({
          at: Date.now(),
          sessionID: typeof properties.sessionID === "string" ? properties.sessionID : null,
          message: String(properties.status.message ?? ""),
        });
      }
      if (type === "session.error") {
        const error = properties?.error ?? {};
        probe.errors.push({
          at: Date.now(),
          sessionID: typeof properties.sessionID === "string" ? properties.sessionID : null,
          name: String(error?.name ?? ""),
          message: String(error?.data?.message ?? ""),
        });
      }
    };
    (async () => {
      const url = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/event";
      while (window.__owDenLink.active) {
        try {
          const response = await fetch(url, { headers: { Authorization: "Bearer " + token } });
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (window.__owDenLink.active) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\\n\\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) for (const line of frame.split("\\n")) {
              if (!line.startsWith("data:")) continue;
              try { record(JSON.parse(line.slice(5).trim())); } catch {}
            }
          }
        } catch {}
      }
    })();
    return "ok";
  })()`);
  expect(tailStarted).toBe("ok");

  await control(desktopApp, "session.create_task");
  const longSessionId = newestSessionId(await control(desktopApp, "session.list_sessions"));
  const sandboxRunStartedAt = Number(await evalIn(desktopApp, "Date.now()"));
  await sendComposerMessage(desktopApp, [
    "Run the bash command `sleep 150 && echo den-link-local-tool-done`.",
    "Wait for the command to finish, then reply with exactly:",
    LONG_RUN_MARKER,
  ].join(" "));
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "long local tool workflow became active" });
  const toolMaterialized = await waitFor(desktopApp, toolRunningExpression(workspaceId, longSessionId), {
    timeoutMs: 90_000,
    label: "bash tool call materialized and remained running",
  }).then(() => true, () => false);
  evidence.recordAssertionEvidence(
    "The local-first workflow materialized a live bash tool call before link faults",
    `Session ${longSessionId} exposed a running or pending bash tool part=${toolMaterialized}.`,
    toolMaterialized,
  );
  expect(toolMaterialized).toBe(true);

  await link.admin.phase("vpn-degraded", "vpn-flaky-emulated");
  const vpnProbeResults: unknown[] = [];
  let liveVpnProbes = 0;
  for (let probe = 0; probe < 12; probe += 1) {
    vpnProbeResults.push(await evalIn(desktopApp, denProbeExpression(link.ref.apiUrl), { awaitPromise: true, timeoutMs: 15_000 }));
    if (await evalIn(desktopApp, sessionRunningExpression(longSessionId)) === true) liveVpnProbes += 1;
  }
  const degradedLog = await link.admin.requests();
  const vpnRequests = degradedLog.requests.filter((request) => request.phase === "vpn-degraded" && request.profile === "vpn-flaky-emulated");
  const vpnResets = vpnRequests.filter((request) => request.fault === "reset");
  evidence.recordAssertionEvidence(
    "The live workflow overlaps sustained emulated-VPN traffic and several request resets",
    `${liveVpnProbes}/12 authenticated organization probes ran while session ${longSessionId} was live; ${vpnRequests.length} shaped requests included ${vpnResets.length} resets; results=${JSON.stringify(vpnProbeResults)}.`,
    liveVpnProbes >= 9 && vpnRequests.length >= 9 && vpnResets.length >= 3,
  );

  await link.admin.phase("hard-offline", "vpn-flaky-emulated");
  const offlineStartedAt = Date.now();
  const sandboxOfflineStartedAt = Number(await evalIn(desktopApp, "Date.now()"));
  await link.admin.offline(45_000);
  const offlineHealth = await link.admin.health();
  const runLiveAtOfflineStart = await evalIn(desktopApp, sessionRunningExpression(longSessionId)) === true;
  for (let probe = 0; probe < 3; probe += 1) {
    await evalIn(desktopApp, denProbeExpression(link.ref.apiUrl), { awaitPromise: true, timeoutMs: 10_000 });
  }

  await link.admin.offline(45_000);
  const offlineSessionResult = await control(desktopApp, "session.create_task");
  if (typeof offlineSessionResult !== "string" || !offlineSessionResult.trim()) {
    throw new Error(`session.create_task did not return an offline session ID: ${JSON.stringify(offlineSessionResult)}`);
  }
  const offlineSessionId = offlineSessionResult;
  await waitFor(desktopApp, `(() => {
    const parts = window.__openworkControl.snapshot().route.split("/");
    const sessionIndex = parts.indexOf("session");
    return sessionIndex >= 0
      && decodeURIComponent(parts[sessionIndex + 1] ?? "") === ${JSON.stringify(offlineSessionId)};
  })()`, {
    timeoutMs: 60_000,
    label: `route reached offline session ${offlineSessionId}`,
  });
  const offlineSessionAppeared = offlineSessionId !== longSessionId;
  const beforeOfflineAttempt = await readComposerState(desktopApp);
  await writeComposerText(
    desktopApp,
    `Use search_capabilities to call mock_echo with text exactly ${OFFLINE_MARKER}. Only if the tool succeeds, reply with exactly: OFFLINE-CONNECT-COMPLETED`,
  );
  const offlineAttemptAt = new Date().toISOString();
  await clickButton(desktopApp, "Run task");
  const offlineOutcome = await eventually(
    () => evalIn(desktopApp, `(() => {
      const failureSurfaces = [...document.querySelectorAll(
        '[data-message-role]:not([data-message-role="user"]), [role="alert"]',
      )].filter((surface) => !surface.closest(
        '[data-message-role="user"], form, textarea, [contenteditable="true"]',
      ));
      const namedFailure = [
        /(?:connect|mcp|search_capabilities|mock_echo|network|den|tool)[^\\n]{0,180}(?:failed|failure|error|unavailable|offline|timed out|refused|closed)/i,
        /(?:failed|failure|error|unavailable|offline|timed out|refused|closed)[^\\n]{0,180}(?:connect|mcp|search_capabilities|mock_echo|network|den|tool)/i,
      ].flatMap((pattern) => failureSurfaces.map((surface) => surface.textContent?.match(pattern)?.[0] ?? ""))
        .find(Boolean) ?? "";
      const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
      return { failureText: namedFailure.slice(0, 240), active: Boolean(stop && !stop.disabled) };
    })()`),
    {
      within: 25_000,
      intervalMs: 500,
      label: "offline Connect attempt showed a named failure or remained user-stoppable",
      until: (outcome) => isRecord(outcome)
        && ((typeof outcome.failureText === "string" && outcome.failureText.length > 0) || outcome.active === true),
    },
  );
  const offlineFailureText = isRecord(offlineOutcome) && typeof offlineOutcome.failureText === "string"
    ? offlineOutcome.failureText
    : "";
  const offlineRunStillActive = await evalIn(desktopApp, stopEnabledExpression) === true;
  let offlineCancelled = false;
  if (offlineRunStillActive) {
    await control(desktopApp, "composer.stop");
    offlineCancelled = await waitFor(desktopApp, `(() => {
      const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
      return Boolean(stop?.disabled);
    })()`, {
      timeoutMs: 30_000,
      label: "offline Connect attempt stopped before link recovery",
    }).then(() => true, () => false);
  }
  const offlineOutcomeDetail = offlineFailureText
    ? `visible named failure: ${JSON.stringify(offlineFailureText)}${offlineCancelled ? "; active run also canceled by the user" : ""}`
    : `no named failure appeared; active run canceled by the user=${offlineCancelled}`;
  const offlineUiBounded = offlineFailureText.length > 0 || offlineCancelled;

  const offlineWindow = await eventually(async () => {
    const log = await link.admin.requests();
    return {
      elapsedMs: Date.now() - offlineStartedAt,
      refused: log.refusedConnections["hard-offline"] ?? 0,
      runLive: await evalIn(desktopApp, sessionRunningExpression(longSessionId)) === true,
    };
  }, {
    within: 40_000,
    intervalMs: 1_000,
    label: "30-second hard outage overlapping the original live run",
    until: (probe) => probe.elapsedMs >= 30_000 && probe.refused > 0 && probe.runLive,
  });
  const offlineCalls = await connector.toolCalls({ name: "mock_echo", sinceIso: offlineAttemptAt });
  const offlineMarkerCalls = offlineCalls.filter((call) => String(call.args.text ?? "").includes(OFFLINE_MARKER));
  const falseOfflineSuccess = await evalIn(desktopApp, assistantHasText("OFFLINE-CONNECT-COMPLETED")) === true;
  const offlineUserMessages = (await readComposerState(desktopApp)).userMessageCount;
  const offlineBodyText = String(await evalIn(desktopApp, "document.body.innerText"));
  const offlineCrash = /aw, snap|renderer process gone|application error|uncaught exception/i.test(offlineBodyText);

  evidence.recordAssertionEvidence(
    "A hard Den outage overlaps the already-materialized local workflow for 30-60 seconds",
    `offline=${offlineHealth.offline}, driver interval=${offlineWindow.elapsedMs}ms, sandbox interval began at ${sandboxOfflineStartedAt} after run ${sandboxRunStartedAt}, original run live at start=${runLiveAtOfflineStart} and at end=${offlineWindow.runLive}, refused connections=${offlineWindow.refused}.`,
    offlineHealth.offline && sandboxOfflineStartedAt >= sandboxRunStartedAt && runLiveAtOfflineStart && offlineWindow.runLive
      && offlineWindow.elapsedMs >= 30_000 && offlineWindow.elapsedMs <= 60_000 && offlineWindow.refused > 0,
  );
  evidence.recordAssertionEvidence(
    "The session created during the Den hole exists locally rather than being attributed to Den persistence",
    `Created local OpenCode session ${offlineSessionId} while offline; it differed from live session ${longSessionId} and appeared in session.list_sessions=${offlineSessionAppeared}.`,
    offlineSessionAppeared,
  );
  evidence.recordAssertionEvidence(
    "Offline Connect produces neither a mock call nor a false completed result",
    `Bounded outcome: ${offlineOutcomeDetail}; user messages before=${beforeOfflineAttempt.userMessageCount}, after=${offlineUserMessages}; ${OFFLINE_MARKER} calls=${JSON.stringify(offlineMarkerCalls)}; assistant false-success=${falseOfflineSuccess}.`,
    offlineUiBounded && offlineMarkerCalls.length === 0 && !falseOfflineSuccess,
  );
  evidence.recordAssertionEvidence(
    "The desktop remains responsive without a crash during the hard outage",
    `Crash signature present=${offlineCrash}; current route=${String(await evalIn(desktopApp, "location.hash"))}.`,
    !offlineCrash,
  );
  await link.admin.clear();
  await link.admin.phase("recovered", "baseline");
  const recoveryProbe = await eventually(
    () => evalIn(desktopApp, denProbeExpression(link.ref.apiUrl), { awaitPromise: true, timeoutMs: 15_000 }),
    {
      within: 60_000,
      label: "successful authenticated Den request after link recovery",
      until: (result) => isRecord(result) && result.ok === true,
    },
  );
  const recoveredLog = await link.admin.requests();
  const recoveredRequests = recoveredLog.requests.filter((request) => request.phase === "recovered" && request.status >= 200 && request.status < 400);
  const postRecoveryDenState = await readDenClientState(desktopApp);
  const sessionsAfterRecovery = listedSessionIds(await control(desktopApp, "session.list_sessions"));
  const offlineSessionRemained = sessionsAfterRecovery.includes(offlineSessionId);
  evidence.recordAssertionEvidence(
    "The link recovers with successful requests while auth and organization selection remain intact",
    `Recovery probe=${JSON.stringify(recoveryProbe)}; successful recovered requests=${recoveredRequests.length}; authTokenPresent=${postRecoveryDenState.authTokenPresent}; activeOrgId before=${initialDenState.activeOrgId}, after=${postRecoveryDenState.activeOrgId}.`,
    recoveredRequests.length > 0 && postRecoveryDenState.authTokenPresent
      && postRecoveryDenState.activeOrgId === initialDenState.activeOrgId,
  );
  evidence.recordAssertionEvidence(
    "The locally created outage session remains listed after Den recovery",
    `Session ${offlineSessionId} remained in ${JSON.stringify(sessionsAfterRecovery)}; this asserts local OpenCode continuity, not Den persistence.`,
    offlineSessionRemained,
  );

  await control(desktopApp, "session.open", { sessionId: longSessionId });
  await waitFor(desktopApp, `(() => {
    const parts = window.__openworkControl.snapshot().route.split("/");
    const sessionIndex = parts.indexOf("session");
    return sessionIndex >= 0
      && decodeURIComponent(parts[sessionIndex + 1] ?? "") === ${JSON.stringify(longSessionId)};
  })()`, {
    timeoutMs: 60_000,
    label: `route reached long-running session ${longSessionId}`,
  });
  await waitFor(desktopApp, assistantHasText(LONG_RUN_MARKER), {
    timeoutMs: 240_000,
    label: "already-materialized local workflow completed after Den recovery",
  });
  const longRunCompleted = true;
  await sendComposerMessage(desktopApp, `Reply with exactly: ${FOLLOWUP_MARKER}`);
  const followupCompleted = await waitFor(desktopApp, assistantHasText(FOLLOWUP_MARKER), {
    timeoutMs: 180_000,
    label: "same-session follow-up after Den recovery",
  }).then(() => true, () => false);

  await control(desktopApp, "session.create_task");
  const recoverySessionId = newestSessionId(await control(desktopApp, "session.list_sessions"));
  const recoverySubmittedAt = new Date().toISOString();
  await sendComposerMessage(
    desktopApp,
    `Use search_capabilities to find mock_echo, call it with text exactly ${RECOVERY_MARKER}, then reply with exactly: RECOVERY-CONNECT-COMPLETE`,
  );
  const recoveryCalls = await connector.toolCalls({ name: "mock_echo", atLeast: 1, sinceIso: recoverySubmittedAt, timeoutMs: 240_000 });
  const recoveryMarkerCalls = recoveryCalls.filter((call) => String(call.args.text ?? "").includes(RECOVERY_MARKER));
  const recoveryConnectCompleted = await waitFor(desktopApp, assistantHasText("RECOVERY-CONNECT-COMPLETE"), {
    timeoutMs: 180_000,
    label: "recovered Connect completion",
  }).then(() => true, () => false);

  const eventProbeRaw = await evalIn(desktopApp, `(() => {
    const probe = window.__owDenLink ?? null;
    if (probe) probe.active = false;
    return probe ? JSON.parse(JSON.stringify(probe)) : null;
  })()`);
  const eventProbe = parseEventProbe(eventProbeRaw);
  await control(desktopApp, "session.open", { sessionId: longSessionId });
  const transcript = await control(desktopApp, "session.read_transcript", { count: 50 });
  const transcriptText = isRecord(transcript) && Array.isArray(transcript.messages)
    ? transcript.messages.filter(isRecord).map((message) => String(message.text ?? "")).join("\n")
    : "";
  const domText = String(await evalIn(desktopApp, "document.body.innerText"));
  const disposesDuringRun = eventProbe.disposes.filter((entry) => entry.at >= sandboxRunStartedAt);
  const longRunErrors = eventProbe.errors.filter((entry) => entry.sessionID === longSessionId);
  const longRunRetries = eventProbe.retries.filter((entry) => entry.sessionID === longSessionId);
  const abortErrors = longRunErrors.filter((entry) => entry.name === "MessageAbortedError" || /message was interrupted/i.test(entry.message));
  const retryStorm = longRunRetries.length > 1;
  const finalCalls = await connector.toolCalls({ name: "mock_echo", sinceIso: baselineSubmittedAt });
  const finalBaselineCount = finalCalls.filter((call) => String(call.args.text ?? "").includes(BASELINE_MARKER)).length;
  const finalOfflineCount = finalCalls.filter((call) => String(call.args.text ?? "").includes(OFFLINE_MARKER)).length;
  const finalRecoveryCount = finalCalls.filter((call) => String(call.args.text ?? "").includes(RECOVERY_MARKER)).length;
  await control(desktopApp, "session.open", { sessionId: recoverySessionId });

  evidence.recordAssertionEvidence(
    "Local work is not disposed, aborted, interrupted, or caught in a retry storm by Den loss",
    `completed=${longRunCompleted}; disposes during run=${JSON.stringify(disposesDuringRun)}; long-run errors=${JSON.stringify(longRunErrors)}; long-run retries=${JSON.stringify(longRunRetries)}; all errors (including an intentional offline-session stop)=${JSON.stringify(eventProbe.errors)}; interrupted in transcript=${transcriptText.includes(INTERRUPTED_TEXT)}; interrupted in DOM=${domText.includes(INTERRUPTED_TEXT)}; event counts=${JSON.stringify(eventProbe.eventCounts)}.`,
    longRunCompleted && disposesDuringRun.length === 0 && abortErrors.length === 0 && !retryStorm
      && !transcriptText.includes(INTERRUPTED_TEXT) && !domText.includes(INTERRUPTED_TEXT),
  );
  evidence.recordAssertionEvidence(
    "The same local-first session remains usable after Den recovery",
    `Session ${longSessionId} completed ${LONG_RUN_MARKER} and then answered its follow-up with ${FOLLOWUP_MARKER}=${followupCompleted}.`,
    longRunCompleted && followupCompleted,
  );
  evidence.recordAssertionEvidence(
    "Connect recovery reaches mock_echo exactly once without replaying the offline attempt",
    `Final marker counts: baseline=${finalBaselineCount}, offline=${finalOfflineCount}, recovery=${finalRecoveryCount}; recovery completion visible=${recoveryConnectCompleted}.`,
    finalBaselineCount === 1 && finalOfflineCount === 0 && finalRecoveryCount === 1 && recoveryConnectCompleted,
  );

  expect(vpnRequests.length).toBeGreaterThanOrEqual(9);
  expect(vpnResets.length).toBeGreaterThanOrEqual(3);
  expect(runLiveAtOfflineStart).toBe(true);
  expect(offlineWindow.runLive).toBe(true);
  expect(offlineWindow.refused).toBeGreaterThan(0);
  expect(offlineUiBounded).toBe(true);
  expect(offlineMarkerCalls).toHaveLength(0);
  expect(falseOfflineSuccess).toBe(false);
  expect(offlineCrash).toBe(false);
  expect(offlineSessionRemained).toBe(true);
  expect(recoveredRequests.length).toBeGreaterThan(0);
  expect(postRecoveryDenState.authTokenPresent).toBe(true);
  expect(postRecoveryDenState.activeOrgId).toBe(initialDenState.activeOrgId);
  expect(longRunCompleted).toBe(true);
  expect(followupCompleted).toBe(true);
  expect(disposesDuringRun).toHaveLength(0);
  expect(abortErrors).toHaveLength(0);
  expect(retryStorm).toBe(false);
  expect(transcriptText).not.toContain(INTERRUPTED_TEXT);
  expect(domText).not.toContain(INTERRUPTED_TEXT);
  expect(finalBaselineCount).toBe(1);
  expect(finalOfflineCount).toBe(0);
  expect(finalRecoveryCount).toBe(1);
  expect(recoveryMarkerCalls).toHaveLength(1);
  expect(recoveryConnectCompleted).toBe(true);
});
