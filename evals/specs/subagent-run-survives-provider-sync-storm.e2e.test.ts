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
 * REPRODUCTION SPEC for the "aborted messages on almost every message,
 * especially with subagents" reports (Slack #support 2026-08-07, and the
 * "Provider response headers timed out after 10000ms · attempt 6" screenshots).
 *
 * Suspected mechanism (from code reading, to be proven or cleared here):
 *  - apps/server/src/cloud-provider-sync.ts apply()/sweep() call
 *    reloadOpencodeEngine() -> engine POST /instance/dispose with NO
 *    "sessions are running" guard (#3526).
 *  - apps/app/src/react-app/domains/cloud/use-cloud-provider-auto-sync.ts
 *    triggers that sync on window focus, network online, visibilitychange and
 *    a 5-minute interval whenever the desktop is signed in to a Den (#3611).
 *  - Every dispose aborts the parent session AND all subagent child sessions:
 *    the engine emits session.error MessageAbortedError which the app renders
 *    as "The message was interrupted".
 *
 * THE RULE UNDER TEST: the product promises "no engine auto-reload while
 * sessions are running". This spec runs one genuinely long subagent task on a
 * real Anthropic model and, while it runs, fires the exact lifecycle triggers
 * a normal user produces by tabbing in and out of the app. If the rule holds,
 * the run completes with zero disposes, zero aborted messages and zero
 * provider header-timeout retries. Each half is asserted explicitly, so a red
 * run localizes the leak (dispose observed vs. abort rendered vs. retry storm).
 *
 * Long on purpose: the subagents sleep for minutes so the storm overlaps a
 * live run the whole time. Run it with a generous timeout; every individual
 * wait below is still bounded.
 */

const requirements: TestNeeds = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `subagent run vs provider sync storm skipped — needs: ${missingRequirements.join(", ")}`
  : "a long subagent run survives cloud provider sync triggers without aborted messages";

const COMPLETE_MARKER = "STORM-RUN-COMPLETE";
const FOLLOWUP_MARKER = "STORM-FOLLOWUP-OK";
const INTERRUPTED_TEXT = "The message was interrupted";
const STORM_TICK_MS = 15_000;
const STORM_MAX_TICKS = 48; // 12 minutes of trigger pressure at most
const MIN_BUSY_TICKS = 8; // the run must stay busy through >=2 minutes of storm

const longRunPrompt = [
  "Launch exactly three subagents in parallel using the task tool.",
  "Subagent 1 must run the bash command `sleep 150 && echo subagent-1-done` and report the output.",
  "Subagent 2 must run the bash command `sleep 150 && echo subagent-2-done` and report the output.",
  "Subagent 3 must run the bash command `sleep 150 && echo subagent-3-done` and report the output.",
  "After all three report, launch two more subagents in parallel the same way:",
  "subagent 4 runs `sleep 150 && echo subagent-4-done`, subagent 5 runs `sleep 150 && echo subagent-5-done`.",
  "After those two report, run one final bash command yourself: `sleep 45 && echo main-done`.",
  `Then reply with exactly: ${COMPLETE_MARKER}`,
].join(" ");

interface StormProbe {
  reconnects: number;
  disposes: Array<{ at: number }>;
  retries: Array<{ at: number; sessionID: string | null; attempt: number | null; message: string }>;
  errors: Array<{ at: number; sessionID: string | null; name: string; message: string }>;
  eventCounts: Record<string, number>;
}

interface SyncStatusProbe {
  ok: boolean;
  hasSession: boolean;
  lastRunStatus: string;
  lastRunAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newestSessionId(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0]) || typeof value[0].sessionId !== "string") {
    throw new Error(`session.list_sessions did not return a newest session: ${JSON.stringify(value)}`);
  }
  return value[0].sessionId;
}

function parseStormProbe(value: unknown): StormProbe {
  if (!isRecord(value)) throw new Error(`Storm probe was not an object: ${JSON.stringify(value)}`);
  const list = (input: unknown): Record<string, unknown>[] => (Array.isArray(input) ? input.filter(isRecord) : []);
  return {
    reconnects: typeof value.reconnects === "number" ? value.reconnects : 0,
    disposes: list(value.disposes).map((entry) => ({ at: typeof entry.at === "number" ? entry.at : 0 })),
    retries: list(value.retries).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      sessionID: typeof entry.sessionID === "string" ? entry.sessionID : null,
      attempt: typeof entry.attempt === "number" ? entry.attempt : null,
      message: typeof entry.message === "string" ? entry.message : "",
    })),
    errors: list(value.errors).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      sessionID: typeof entry.sessionID === "string" ? entry.sessionID : null,
      name: typeof entry.name === "string" ? entry.name : "",
      message: typeof entry.message === "string" ? entry.message : "",
    })),
    eventCounts: isRecord(value.eventCounts)
      ? Object.fromEntries(Object.entries(value.eventCounts).flatMap(([key, count]) => (typeof count === "number" ? [[key, count]] : [])))
      : {},
  };
}

function parseSyncStatus(value: unknown): SyncStatusProbe {
  if (!isRecord(value)) return { ok: false, hasSession: false, lastRunStatus: "unreadable", lastRunAt: "" };
  const lastRun = isRecord(value.lastRun) ? value.lastRun : {};
  return {
    ok: value.ok === true,
    hasSession: value.hasSession === true,
    lastRunStatus: typeof lastRun.status === "string" ? lastRun.status : "none",
    lastRunAt: typeof lastRun.at === "string" ? lastRun.at : "",
  };
}

const assistantHasText = (text: string): string => `(() => {
  return [...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => (message.innerText ?? "").includes(${JSON.stringify(text)}));
})()`;

const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

const stopDisabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop?.disabled);
})()`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(missingRequirements.length > 0)(title, { timeout: 2_700_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({ place });
  // Signing in matters: a Den session is what arms the server-side cloud
  // provider sync (PUT /den-session -> CloudProviderSync.setSession).
  await using desktopApp = await app({ den, as: "admin", place });
  const workspaceId = desktopApp.workspaceId;

  // ── Configure the real Anthropic provider through the product API ──────
  // Daytona app sandboxes deliberately do not mount the eval secrets volume
  // (untrusted-ref rule in provision.ts), so the key travels from the driver
  // env through the same workspace-config write a user's Settings save does.
  // This single pre-run engine reload happens BEFORE the session exists, so
  // it cannot contaminate the mid-run dispose/abort claims below.
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const providerConfigured = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 300);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: { provider: { anthropic: { options: { apiKey: ${JSON.stringify(anthropicKey)} } } } } }),
    });
    if (patched !== "ok") return patched;
    return request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(providerConfigured).toBe("ok");

  // ── Pick a real Anthropic model through the product picker ─────────────
  // Picker rows carry bare model ids (e.g. "claude-sonnet-4-5"). Sonnet-class
  // keeps the run affordable; set OPENWORK_EVAL_MODEL=claude-opus-4-8 to
  // mirror the support report exactly.
  const preferredModel = process.env.OPENWORK_EVAL_MODEL?.trim() ?? "";
  const models = await readAvailableModels(desktopApp);
  const selectable = models.filter((model) => model.selectable);
  const claudes = selectable.filter((model) => /anthropic/i.test(model.providerName) || /^claude-/i.test(model.id));
  const chosen = selectable.find((model) => model.id === preferredModel)
    ?? claudes.find((model) => /^claude-sonnet-\d+-\d+$/.test(model.id))
    ?? claudes.find((model) => /sonnet/i.test(model.id))
    ?? claudes[0];
  if (!chosen) {
    throw new Error(`No Anthropic model selectable in the picker. Saw: ${models.map((model) => model.id).join(", ") || "none"}`);
  }
  await selectModel(desktopApp, chosen.id);
  evidence.recordAssertionEvidence(
    "A real provider model is selected through the product model picker",
    `Selected ${chosen.id} (${chosen.providerName}); env-key providers were visible to the engine.`,
    true,
  );

  // ── Start the engine event tail (dispose / retry / session.error witness) ──
  const tailStarted = await evalIn(desktopApp, `(() => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    window.__owStorm = { active: true, reconnects: -1, disposes: [], retries: [], errors: [], eventCounts: {} };
    const record = (event) => {
      const storm = window.__owStorm;
      const type = String(event?.type ?? "unknown");
      storm.eventCounts[type] = (storm.eventCounts[type] ?? 0) + 1;
      if (type.includes("disposed")) storm.disposes.push({ at: Date.now(), type });
      const properties = event?.properties ?? {};
      if (type === "session.status" && properties?.status?.type === "retry") {
        storm.retries.push({
          at: Date.now(),
          sessionID: typeof properties.sessionID === "string" ? properties.sessionID : null,
          attempt: typeof properties.status.attempt === "number" ? properties.status.attempt : null,
          message: String(properties.status.message ?? ""),
        });
      }
      if (type === "session.error") {
        const error = properties?.error ?? {};
        storm.errors.push({
          at: Date.now(),
          sessionID: typeof properties.sessionID === "string" ? properties.sessionID : null,
          name: String(error?.name ?? ""),
          message: String(error?.data?.message ?? ""),
        });
      }
    };
    (async () => {
      const url = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/event";
      while (window.__owStorm.active) {
        window.__owStorm.reconnects += 1;
        try {
          const response = await fetch(url, { headers: { Authorization: "Bearer " + token } });
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (window.__owStorm.active) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\\n\\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              for (const line of frame.split("\\n")) {
                if (!line.startsWith("data:")) continue;
                try { record(JSON.parse(line.slice(5).trim())); } catch {}
              }
            }
          }
        } catch {}
        if (window.__owStorm.active) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    return "ok";
  })()`);
  expect(tailStarted).toBe("ok");

  // The sync layer must actually be armed, otherwise this spec stresses nothing.
  const readSyncStatusExpression = `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) return { ok: false };
    const body = await response.json();
    return { ok: true, hasSession: body.hasSession === true, lastRun: body.lastRun ?? null };
  })()`;
  const readSyncStatus = async (): Promise<SyncStatusProbe> =>
    parseSyncStatus(await evalIn(desktopApp, readSyncStatusExpression, { awaitPromise: true, timeoutMs: 30_000 }));
  let armedBy = "sign_in push";
  let syncArmed = await eventually(readSyncStatus, {
    within: 60_000,
    label: "cloud provider sync armed by sign-in",
    until: (status) => status.ok && status.hasSession,
  }).then(() => true, () => false);
  let armingProbe = "";
  if (!syncArmed) {
    // The app's own push swallows every failure (store.ts pushDenSession), so
    // probe each precondition and issue the same PUT /den-session the product
    // sends, with the product's own persisted credentials — the failure, if
    // any, names itself instead of no-oping.
    armingProbe = String(await evalIn(desktopApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const clientToken = localStorage.getItem("openwork.server.token");
      const hostToken = localStorage.getItem("openwork.server.hostToken");
      const denToken = (localStorage.getItem("openwork.den.authToken") ?? "").trim();
      const orgId = (localStorage.getItem("openwork.den.activeOrgId") ?? "").trim();
      const apiBaseUrl = (localStorage.getItem("openwork.den.apiBaseUrl") ?? "").trim()
        || ${JSON.stringify(den.ref.apiUrl)};
      const facts = [
        "hostToken=" + (hostToken ? "present" : "MISSING"),
        "denToken=" + (denToken ? "present" : "MISSING"),
        "orgId=" + (orgId || "MISSING"),
        "apiBaseUrl=" + (apiBaseUrl || "MISSING"),
      ];
      if (!port || !hostToken || !denToken || !orgId || !apiBaseUrl) return facts.join(" ");
      const response = await fetch("http://127.0.0.1:" + port + "/den-session", {
        method: "PUT",
        headers: { "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: apiBaseUrl, token: denToken, orgId }),
      });
      facts.push("PUT /den-session -> " + response.status + " " + (await response.text()).slice(0, 200));
      return facts.join(" ");
    })()`, { awaitPromise: true, timeoutMs: 30_000 }));
    armedBy = `direct PUT /den-session (${armingProbe})`;
    syncArmed = await eventually(readSyncStatus, {
      within: 60_000,
      label: "cloud provider sync armed after direct den-session PUT",
      until: (status) => status.ok && status.hasSession,
    }).then(() => true, () => false);
  }
  const armedStatus = await readSyncStatus();
  evidence.recordAssertionEvidence(
    "The server-side cloud provider sync is armed by the signed-in Den session",
    `GET /cloud-provider-sync/status -> ok=${armedStatus.ok} hasSession=${armedStatus.hasSession} lastRun=${armedStatus.lastRunStatus} (armed by: ${armedBy}).`,
    syncArmed,
  );
  expect(syncArmed, `Den session did not arm CloudProviderSync; the storm would be vacuous. Probe: ${armingProbe || "sign-in push armed"}`).toBe(true);

  // ── Convergence probe: an idle sync must settle to noop ────────────────
  // Three back-to-back passes through the same host-token route the product
  // uses. Initial materialization and its post-refresh runtime-file update may
  // each apply once; failing to reach noop within the bound identifies the
  // dispose/create-loop precondition (#2530's anatomy).
  const convergence: string[] = [];
  for (let pass = 1; pass <= 3; pass += 1) {
    const result = await evalIn(desktopApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const hostToken = localStorage.getItem("openwork.server.hostToken");
      const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/run", {
        method: "POST",
        headers: { "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "spec_convergence_probe" }),
      });
      const body = await response.text();
      return response.status + ":" + body.slice(0, 120);
    })()`, { awaitPromise: true, timeoutMs: 60_000 });
    convergence.push(String(result));
  }
  const convergedToNoop = convergence.at(-1)?.includes("noop") === true;
  evidence.recordAssertionEvidence(
    "An idle cloud provider sync converges to noop within three passes",
    `Three sequential POST /cloud-provider-sync/run results: ${JSON.stringify(convergence)}.`,
    convergedToNoop,
  );

  // ── Launch the long subagent run ────────────────────────────────────────
  await control(desktopApp, "session.create_task");
  const sessionId = newestSessionId(await control(desktopApp, "session.list_sessions"));
  // Sandbox clock, not the driver's: the SSE tail timestamps its events with
  // the renderer's Date.now(), and only disposes AFTER this instant violate
  // the "no reload while sessions run" rule (the idle convergence probe above
  // may legitimately reload).
  const sandboxRunStartedAt = Number(await evalIn(desktopApp, "Date.now()"));
  await sendComposerMessage(desktopApp, longRunPrompt);
  const runStartedAt = Date.now();

  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "run became active (stop enabled)" });
  const sawSubagents = await waitFor(desktopApp, `Boolean(document.querySelector('[data-subagent-run]'))`, {
    timeoutMs: 300_000,
    label: "subagent run line visible",
  }).then(() => true, () => false);
  evidence.recordAssertionEvidence(
    "The model actually fanned work out to subagents",
    sawSubagents
      ? "A [data-subagent-run] collapsible appeared in the transcript."
      : "No [data-subagent-run] element appeared within 5 minutes of sending the prompt.",
    sawSubagents,
  );
  expect(sawSubagents, "The run never showed subagent activity; the reproduction needs child sessions").toBe(true);

  const midRunShot = await screenshot(desktopApp);
  const midRunSeen = await validate(midRunShot, [
    "A chat session is actively running a task that uses subagents (a running/expandable subagent or task row is visible)",
    "No error banner, no 'The message was interrupted' text and no retry countdown is visible",
  ]);
  expect(midRunSeen.ok, midRunSeen.why).toBe(true);

  // ── Storm: fire the real user-lifecycle sync triggers while it runs ─────
  const syncStatuses: SyncStatusProbe[] = [];
  let busyTicks = 0;
  let completed = false;
  for (let tick = 1; tick <= STORM_MAX_TICKS; tick += 1) {
    const ticked = await evalIn(desktopApp, `(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      return true;
    })()`);
    expect(ticked, `storm tick ${tick} could not dispatch lifecycle events`).toBe(true);

    const stillBusy = await evalIn(desktopApp, stopEnabledExpression);
    if (stillBusy === true) busyTicks += 1;

    const status = parseSyncStatus(await evalIn(desktopApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/status", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) return { ok: false };
      const body = await response.json();
      return { ok: true, hasSession: body.hasSession === true, lastRun: body.lastRun ?? null };
    })()`, { awaitPromise: true, timeoutMs: 30_000 }));
    syncStatuses.push(status);

    completed = (await evalIn(desktopApp, assistantHasText(COMPLETE_MARKER))) === true;
    if (completed && stillBusy !== true) break;
    await sleep(STORM_TICK_MS);
  }
  const stormTicks = syncStatuses.length;
  const syncSummary = syncStatuses.reduce<Record<string, number>>((accumulator, status) => {
    const key = status.ok ? status.lastRunStatus : "status_unreachable";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
  const distinctPassTimes = new Set(syncStatuses.map((status) => status.lastRunAt).filter(Boolean)).size;
  evidence.recordAssertionEvidence(
    "Lifecycle sync triggers fired repeatedly while the run was live",
    `${stormTicks} storm ticks (focus+online+visibilitychange every ${STORM_TICK_MS / 1000}s), ${busyTicks} of them while the run was busy; cloud-provider-sync lastRun statuses seen: ${JSON.stringify(syncSummary)} across ${distinctPassTimes} distinct pass timestamps.`,
    busyTicks >= MIN_BUSY_TICKS,
  );
  expect(busyTicks, `the run finished too fast to stress the guard (busy ticks < ${MIN_BUSY_TICKS})`).toBeGreaterThanOrEqual(MIN_BUSY_TICKS);

  // ── Completion: the run must finish despite the storm ───────────────────
  if (!completed) {
    completed = await waitFor(desktopApp, assistantHasText(COMPLETE_MARKER), {
      timeoutMs: 300_000,
      label: `assistant reply containing ${COMPLETE_MARKER}`,
    }).then(() => true, () => false);
  }
  const runSeconds = Math.round((Date.now() - runStartedAt) / 1000);
  evidence.recordAssertionEvidence(
    "The long subagent run completed while sync triggers were firing",
    completed
      ? `The assistant replied with ${COMPLETE_MARKER} after ${runSeconds}s under storm conditions.`
      : `No assistant reply containing ${COMPLETE_MARKER} appeared after ${runSeconds}s; the run did not complete.`,
    completed,
  );

  await waitFor(desktopApp, stopDisabledExpression, { timeoutMs: 120_000, label: "run settled (stop disabled)" });

  // ── Harvest the witnesses BEFORE asserting, so a red run still reports ──
  const probeRaw = await evalIn(desktopApp, `(() => {
    const storm = window.__owStorm ?? null;
    if (storm) storm.active = false;
    return storm ? JSON.parse(JSON.stringify(storm)) : null;
  })()`);
  const probe = parseStormProbe(probeRaw);

  const transcript = await control(desktopApp, "session.read_transcript", { count: 30 });
  const transcriptText = isRecord(transcript) && Array.isArray(transcript.messages)
    ? transcript.messages.filter(isRecord).map((message) => String(message.text ?? "")).join("\n")
    : "";
  const domHasInterrupted = (await evalIn(desktopApp, `document.body.innerText.includes(${JSON.stringify(INTERRUPTED_TEXT)})`)) === true;
  const abortErrors = probe.errors.filter((error) => error.name === "MessageAbortedError");
  const headerTimeoutRetries = probe.retries.filter((retry) => /headers? timed out/i.test(retry.message));

  const finalStatusRaw = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.lastRun ?? null;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  evidence.recordAssertionEvidence(
    "The provider sync names its change terms for diagnosis",
    `Final /cloud-provider-sync/status lastRun: ${JSON.stringify(finalStatusRaw)}.`,
    true,
  );

  const disposesDuringRun = probe.disposes.filter((dispose) => dispose.at >= sandboxRunStartedAt);
  evidence.recordAssertionEvidence(
    "The engine instance was never disposed while sessions were running",
    `Engine event tail over ${probe.reconnects} reconnect(s) recorded ${probe.disposes.length} dispose event(s) total, ${disposesDuringRun.length} after the run started; event counts: ${JSON.stringify(probe.eventCounts)}.`,
    disposesDuringRun.length === 0,
  );
  evidence.recordAssertionEvidence(
    "No session was aborted during the storm",
    `session.error events: ${JSON.stringify(probe.errors)}; '${INTERRUPTED_TEXT}' in DOM: ${domHasInterrupted}; in transcript: ${transcriptText.includes(INTERRUPTED_TEXT)}.`,
    abortErrors.length === 0 && probe.errors.length === 0 && !domHasInterrupted && !transcriptText.includes(INTERRUPTED_TEXT),
  );
  evidence.recordAssertionEvidence(
    "No provider header-timeout retry storm occurred",
    probe.retries.length === 0
      ? "Zero session.status retry events were observed for the whole run."
      : `Retry statuses observed: ${JSON.stringify(probe.retries)}.`,
    headerTimeoutRetries.length === 0,
  );

  const finalShot = await screenshot(desktopApp);
  const finalSeen = await validate(finalShot, [
    `The assistant's final reply containing '${COMPLETE_MARKER}' is visible in the conversation`,
    `No '${INTERRUPTED_TEXT}' error text and no 'Retrying in' countdown is visible anywhere`,
  ]);

  expect(completed, "the long subagent run did not complete under sync-trigger pressure").toBe(true);
  expect(convergedToNoop, `idle cloud provider sync never converged to noop: ${JSON.stringify(convergence)}`).toBe(true);
  expect(disposesDuringRun.length, `engine dispose events observed during a live run: ${JSON.stringify(disposesDuringRun)}`).toBe(0);
  expect(abortErrors, "MessageAbortedError session errors were emitted during the storm").toEqual([]);
  expect(probe.errors, "session.error events were emitted during the storm").toEqual([]);
  expect(domHasInterrupted, `'${INTERRUPTED_TEXT}' is visible in the conversation`).toBe(false);
  expect(transcriptText).not.toContain(INTERRUPTED_TEXT);
  expect(headerTimeoutRetries, "provider header-timeout retries observed (the reported symptom)").toEqual([]);
  expect(finalSeen.ok, finalSeen.why).toBe(true);

  // ── Recovery: the same session must accept and finish a follow-up ───────
  await sendComposerMessage(desktopApp, `Reply with exactly: ${FOLLOWUP_MARKER}`);
  const followedUp = await waitFor(desktopApp, assistantHasText(FOLLOWUP_MARKER), {
    timeoutMs: 240_000,
    label: `assistant reply containing ${FOLLOWUP_MARKER}`,
  }).then(() => true, () => false);
  evidence.recordAssertionEvidence(
    "The session remains usable after the storm",
    followedUp
      ? `A follow-up prompt in session ${sessionId} completed with ${FOLLOWUP_MARKER}.`
      : `The follow-up prompt in session ${sessionId} never produced ${FOLLOWUP_MARKER}.`,
    followedUp,
  );
  expect(followedUp, "the session could not complete a follow-up prompt after the storm").toBe(true);
});
