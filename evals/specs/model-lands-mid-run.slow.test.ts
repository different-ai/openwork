import { expect } from "vitest";
import {
  control,
  denFetch,
  evalIn,
  readAvailableModels,
  readCurrentOrganizationMemberId,
  selectModel,
  sendComposerMessage,
  waitFor,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/fraimz";
import { app, eventually, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

/**
 * VOICEOVER SPEC — "New models arrive without breaking your flow."
 *
 * 1. Maya has OpenWork deep in a real task — subagents fanned out — signed in
 *    to her company's org.
 * 2. While her task runs, her admin grants the team a new model. Nothing
 *    happens on Maya's screen: no flash, no "The message was interrupted",
 *    no retry countdown.
 * 3. Under the hood OpenWork notices the new model but refuses to restart the
 *    engine while her sessions are live — it parks the update
 *    (lastRun.detail.reloadDeferred).
 * 4. Her task finishes intact. She touches nothing — within moments the
 *    parked update lands on its own (idle-retry, no user gesture, no reload
 *    call).
 * 5. She opens the model picker and the new org model is already there.
 * 6. She switches to it and sends a message; the new model answers — same
 *    session window, zero interruptions, from grant to first reply.
 *
 * This is also the regression net for PR #3634: it exercises the busy-defer
 * guard, the idle-retry freshness path, and the materialized credential
 * end-to-end against the real OpenAI API from a real Daytona sandbox.
 */

const requirements: NeedsSpec = {
  env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  optIn: ["OPENWORK_EVAL_APP_SPECS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `model lands mid-run skipped — needs: ${missingRequirements.join(", ")}`
  : "a model granted mid-run never interrupts the task and is usable right after it finishes";

const COMPLETE_MARKER = "MID-RUN-TASK-COMPLETE";
const NEW_MODEL_MARKER = "NEW-MODEL-LIVE";
const INTERRUPTED_TEXT = "The message was interrupted";
const GRANT_PROVIDER_NAME = "Fresh Grant Models";

const longRunPrompt = [
  "Launch exactly three subagents in parallel using the task tool.",
  "Subagent 1 must run the bash command `sleep 120 && echo subagent-1-done` and report the output.",
  "Subagent 2 must run the bash command `sleep 120 && echo subagent-2-done` and report the output.",
  "Subagent 3 must run the bash command `sleep 120 && echo subagent-3-done` and report the output.",
  `After all three subagents report, reply with exactly: ${COMPLETE_MARKER}`,
].join(" ");

interface StormProbe {
  reconnects: number;
  disposes: Array<{ at: number }>;
  retries: Array<{ at: number; message: string }>;
  errors: Array<{ at: number; name: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStormProbe(value: unknown): StormProbe {
  if (!isRecord(value)) throw new Error(`Storm probe was not an object: ${JSON.stringify(value)}`);
  const list = (input: unknown): Record<string, unknown>[] => (Array.isArray(input) ? input.filter(isRecord) : []);
  return {
    reconnects: typeof value.reconnects === "number" ? value.reconnects : 0,
    disposes: list(value.disposes).map((entry) => ({ at: typeof entry.at === "number" ? entry.at : 0 })),
    retries: list(value.retries).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      message: typeof entry.message === "string" ? entry.message : "",
    })),
    errors: list(value.errors).map((entry) => ({
      at: typeof entry.at === "number" ? entry.at : 0,
      name: typeof entry.name === "string" ? entry.name : "",
      message: typeof entry.message === "string" ? entry.message : "",
    })),
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

async function discoverOpenAiModelCandidates(apiKey: string): Promise<string[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OpenAI model discovery failed: HTTP ${response.status}`);
  const body: unknown = await response.json();
  const ids = isRecord(body) && Array.isArray(body.data)
    ? body.data.filter(isRecord).map((entry) => (typeof entry.id === "string" ? entry.id : "")).filter(Boolean)
    : [];
  const chatLike = ids.filter((id) => /^gpt/i.test(id) && !/audio|realtime|image|tts|transcribe|embed|moderation/i.test(id));
  const preferred = chatLike.filter((id) => /mini|nano/i.test(id));
  const rest = chatLike.filter((id) => !/mini|nano/i.test(id));
  const ordered = [...preferred, ...rest];
  if (ordered.length === 0) throw new Error(`OpenAI model discovery returned no chat-capable gpt ids. Saw: ${ids.slice(0, 20).join(", ")}`);
  return ordered.slice(0, 6);
}

async function grantOrgModel(
  admin: DenSession,
  orgId: string,
  memberId: string,
  apiKey: string,
  candidates: string[],
): Promise<{ providerId: string; modelId: string; attempts: string[] }> {
  const attempts: string[] = [];
  for (const modelId of candidates) {
    const result = await denFetch(admin, "/v1/llm-providers", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": orgId },
      body: JSON.stringify({
        name: GRANT_PROVIDER_NAME,
        source: "models_dev",
        providerId: "openai",
        modelIds: [modelId],
        apiKey,
        memberIds: [memberId],
        teamIds: [],
      }),
    });
    const provider = isRecord(result.body) && isRecord(result.body.llmProvider) ? result.body.llmProvider : null;
    const providerId = provider && typeof provider.id === "string" ? provider.id : "";
    if (result.response.ok && providerId) {
      return { providerId, modelId, attempts };
    }
    attempts.push(`${modelId} -> HTTP ${result.response.status} ${result.text.slice(0, 120)}`);
  }
  throw new Error(`No OpenAI model candidate was accepted by the Den catalog. Attempts: ${attempts.join(" | ")}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(missingRequirements.length > 0)(title, { timeout: 2_700_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({ place });
  await using desktopApp = await app({ den, as: "admin", place });
  const workspaceId = desktopApp.workspaceId;

  // ── Arrange: real Anthropic model for the long task (same path a user's
  // Settings save takes; single pre-run reload, before any session exists) ──
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
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

  const models = await readAvailableModels(desktopApp);
  const selectable = models.filter((model) => model.selectable);
  const claudes = selectable.filter((model) => /anthropic/i.test(model.providerName) || /^claude-/i.test(model.id));
  const runModel = claudes.find((model) => /^claude-sonnet-\d+-\d+$/.test(model.id))
    ?? claudes.find((model) => /sonnet/i.test(model.id))
    ?? claudes[0];
  if (!runModel) throw new Error(`No Anthropic model selectable. Saw: ${models.map((model) => model.id).join(", ") || "none"}`);
  await selectModel(desktopApp, runModel.id);

  // ── Engine event tail: disposes, retries and session errors are the
  // witnesses for "nothing interrupted her" ────────────────────────────────
  const tailStarted = await evalIn(desktopApp, `(() => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    window.__owStorm = { active: true, reconnects: -1, disposes: [], retries: [], errors: [] };
    const record = (event) => {
      const storm = window.__owStorm;
      const type = String(event?.type ?? "unknown");
      const properties = event?.properties ?? {};
      if (type.includes("disposed")) storm.disposes.push({ at: Date.now() });
      if (type === "session.status" && properties?.status?.type === "retry") {
        storm.retries.push({ at: Date.now(), message: String(properties.status.message ?? "") });
      }
      if (type === "session.error") {
        const error = properties?.error ?? {};
        storm.errors.push({ at: Date.now(), name: String(error?.name ?? ""), message: String(error?.data?.message ?? "") });
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

  // ── Arm the server-side provider sync with the signed-in Den session ────
  const readSyncStatusExpression = `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/status", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) return null;
    return await response.json();
  })()`;
  const armProbe = String(await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const hostToken = localStorage.getItem("openwork.server.hostToken");
    const denToken = (localStorage.getItem("openwork.den.authToken") ?? "").trim();
    const orgId = (localStorage.getItem("openwork.den.activeOrgId") ?? "").trim();
    if (!port || !hostToken || !denToken || !orgId) return "missing:" + [port, hostToken, denToken, orgId].map(Boolean).join(",");
    const response = await fetch("http://127.0.0.1:" + port + "/den-session", {
      method: "PUT",
      headers: { "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: ${JSON.stringify(den.ref.apiUrl)}, token: denToken, orgId }),
    });
    return "PUT /den-session -> " + response.status + "; orgId=" + orgId;
  })()`, { awaitPromise: true, timeoutMs: 30_000 }));
  expect(armProbe).toContain("204");
  const activeOrgId = armProbe.split("orgId=")[1] ?? "";
  expect(activeOrgId.startsWith("org_"), `active org id unreadable: ${armProbe}`).toBe(true);
  await eventually(async () => {
    const status = await evalIn(desktopApp, readSyncStatusExpression, { awaitPromise: true, timeoutMs: 30_000 });
    return isRecord(status) && status.hasSession === true;
  }, { within: 60_000, label: "cloud provider sync armed", until: (armed) => armed === true });

  // ── Frame 1: Maya's long subagent task is genuinely running ─────────────
  const ownerMemberId = await readCurrentOrganizationMemberId(den.admin);
  const candidates = await discoverOpenAiModelCandidates(openaiKey);
  await control(desktopApp, "session.create_task");
  const sandboxRunStartedAt = Number(await evalIn(desktopApp, "Date.now()"));
  await sendComposerMessage(desktopApp, longRunPrompt);
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "run became active" });
  const sawSubagents = await waitFor(desktopApp, `Boolean(document.querySelector('[data-subagent-run]'))`, {
    timeoutMs: 300_000,
    label: "subagent run line visible",
  }).then(() => true, () => false);
  expect(sawSubagents, "the task never fanned out to subagents").toBe(true);
  evidence.fact(
    "Frame 1 — a real subagent task is running in a signed-in org desktop",
    `Model ${runModel.id}; [data-subagent-run] visible; composer stop enabled.`,
    true,
  );

  // ── Frame 2: the admin grants a new model WHILE the task runs ───────────
  const grant = await grantOrgModel(den.admin, activeOrgId, ownerMemberId, openaiKey, candidates);
  evidence.fact(
    "Frame 2 — the org grants a new model mid-run through the real Den API",
    `POST /v1/llm-providers accepted ${grant.modelId} as ${grant.providerId} (rejected candidates: ${grant.attempts.length ? grant.attempts.join(" | ") : "none"}).`,
    true,
  );

  // ── Frame 3: the sync sees it and PARKS the engine reload (busy) ────────
  const syncRun = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const hostToken = localStorage.getItem("openwork.server.hostToken");
    const response = await fetch("http://127.0.0.1:" + port + "/cloud-provider-sync/run", {
      method: "POST",
      headers: { "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "mid_run_grant" }),
    });
    return response.status + ":" + (await response.text()).slice(0, 120);
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(String(syncRun)).toContain("200");
  const deferredStatus = await evalIn(desktopApp, readSyncStatusExpression, { awaitPromise: true, timeoutMs: 30_000 });
  const lastRun = isRecord(deferredStatus) && isRecord(deferredStatus.lastRun) ? deferredStatus.lastRun : {};
  const detail = isRecord(lastRun.detail) ? lastRun.detail : {};
  const stillBusy = (await evalIn(desktopApp, stopEnabledExpression)) === true;
  evidence.fact(
    "Frame 3 — the update is parked, not applied over a live engine",
    `Sync pass after the grant: ${String(syncRun)}; lastRun=${JSON.stringify(lastRun)}; run still busy: ${stillBusy}.`,
    detail.reloadDeferred === true && stillBusy,
  );
  expect(detail.reloadDeferred, `the sync pass did not defer its reload: ${JSON.stringify(lastRun)}`).toBe(true);
  expect(stillBusy, "the run was no longer busy right after the grant sync pass").toBe(true);
  const domInterruptedMidRun = (await evalIn(desktopApp, `document.body.innerText.includes(${JSON.stringify(INTERRUPTED_TEXT)})`)) === true;
  expect(domInterruptedMidRun, "the grant interrupted the visible conversation").toBe(false);

  const midRunShot = await screenshot(desktopApp);
  const midRunSeen = await validate(midRunShot, [
    "A task with subagent activity is still running (a subagent/task row and a Stop control are visible)",
    "No error banner, no 'The message was interrupted' text and no retry countdown is visible",
  ]);
  expect(midRunSeen.ok, midRunSeen.why).toBe(true);

  // ── Frame 4: the task finishes intact; the parked update lands ALONE ────
  await waitFor(desktopApp, assistantHasText(COMPLETE_MARKER), { timeoutMs: 420_000, label: `assistant reply containing ${COMPLETE_MARKER}` });
  await waitFor(desktopApp, stopDisabledExpression, { timeoutMs: 120_000, label: "run settled" });
  const sandboxRunEndedAt = Number(await evalIn(desktopApp, "Date.now()"));

  // No picker, no focus events, no reload calls: only the server's own
  // idle-retry may land the parked reload now.
  const freshnessStartedAt = Date.now();
  const engineHasProvider = `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    for (const path of ["/opencode/config/providers", "/opencode/config"]) {
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + path, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.includes(${JSON.stringify(grant.providerId)})) return true;
    }
    return false;
  })()`;
  const landed = await eventually(
    async () => (await evalIn(desktopApp, engineHasProvider, { awaitPromise: true, timeoutMs: 30_000 })) === true,
    { within: 120_000, label: "engine exposes the granted provider without user action", until: (seen) => seen === true },
  ).then(() => true, () => false);
  const freshnessMs = Date.now() - freshnessStartedAt;
  evidence.fact(
    "Frame 4 — the parked update lands by itself moments after the task finishes",
    landed
      ? `The engine exposed ${grant.providerId} ${Math.round(freshnessMs / 1000)}s after idle, with no user action and no reload call.`
      : `The engine never exposed ${grant.providerId} within 120s of going idle.`,
    landed,
  );
  expect(landed, "the deferred reload did not land on its own after idle").toBe(true);

  // ── Witnesses: nothing was interrupted, ever ─────────────────────────────
  const probe = parseStormProbe(await evalIn(desktopApp, `(() => {
    const storm = window.__owStorm ?? null;
    if (storm) storm.active = false;
    return storm ? JSON.parse(JSON.stringify(storm)) : null;
  })()`));
  const disposesDuringRun = probe.disposes.filter((dispose) => dispose.at >= sandboxRunStartedAt && dispose.at <= sandboxRunEndedAt);
  const disposesAfterIdle = probe.disposes.filter((dispose) => dispose.at > sandboxRunEndedAt);
  const abortErrors = probe.errors.filter((error) => error.name === "MessageAbortedError");
  const headerTimeoutRetries = probe.retries.filter((retry) => /headers? timed out/i.test(retry.message));
  const domInterrupted = (await evalIn(desktopApp, `document.body.innerText.includes(${JSON.stringify(INTERRUPTED_TEXT)})`)) === true;
  evidence.fact(
    "Frames 2-4 negative half — zero interruptions from grant to landing",
    `Disposes during run: ${disposesDuringRun.length}; after idle: ${disposesAfterIdle.length}; session errors: ${JSON.stringify(probe.errors)}; header-timeout retries: ${headerTimeoutRetries.length}; '${INTERRUPTED_TEXT}' visible: ${domInterrupted}.`,
    disposesDuringRun.length === 0 && disposesAfterIdle.length >= 1 && abortErrors.length === 0 && !domInterrupted,
  );
  expect(disposesDuringRun.length, `engine disposes during the live run: ${JSON.stringify(disposesDuringRun)}`).toBe(0);
  expect(disposesAfterIdle.length, "no dispose after idle — the landed reload should have produced one").toBeGreaterThanOrEqual(1);
  expect(abortErrors, "sessions were aborted").toEqual([]);
  expect(domInterrupted, `'${INTERRUPTED_TEXT}' is visible`).toBe(false);
  expect(headerTimeoutRetries, "provider header-timeout retries observed").toEqual([]);

  // ── Frame 5: the new model is simply there in the picker ────────────────
  // The engine's catalog can land after the picker's first paint (the same
  // race models-available.slow.test.ts documents: "0 models at first read, 7
  // shortly after"), so poll the open dialog instead of trusting one scrape.
  let afterModels = await readAvailableModels(desktopApp);
  let grantedRow = afterModels.find((model) => model.id === grant.modelId && model.selectable);
  const pickerDeadline = Date.now() + 180_000;
  while (!grantedRow && Date.now() < pickerDeadline) {
    await sleep(3_000);
    afterModels = await readAvailableModels(desktopApp);
    grantedRow = afterModels.find((model) => model.id === grant.modelId && model.selectable);
  }
  if (!grantedRow) {
    // Name the layer that lost the model: engine catalog vs. app picker.
    const engineView = await evalIn(desktopApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const out = {};
      for (const path of ["/opencode/config/providers", "/opencode/config"]) {
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + path, {
          headers: { Authorization: "Bearer " + token },
        });
        if (!response.ok) { out[path] = "HTTP " + response.status; continue; }
        const text = await response.text();
        out[path] = {
          hasProvider: text.includes(${JSON.stringify(grant.providerId)}),
          hasModel: text.includes(${JSON.stringify(grant.modelId)}),
        };
      }
      return out;
    })()`, { awaitPromise: true, timeoutMs: 30_000 });
    evidence.fact(
      "Frame 5 diagnostic — which layer dropped the granted model",
      `Engine config view: ${JSON.stringify(engineView)}; picker rows: ${afterModels.map((model) => model.id).join(", ") || "none"}.`,
      false,
    );
  }
  evidence.fact(
    "Frame 5 — the granted model appears in the picker with no restart",
    grantedRow
      ? `${grant.modelId} is listed under provider '${grantedRow.providerName}' after polling the open picker.`
      : `${grant.modelId} missing from picker after 180s; saw ${afterModels.map((model) => model.id).join(", ")}.`,
    Boolean(grantedRow),
  );
  expect(grantedRow, `the granted model ${grant.modelId} is not selectable in the picker`).toBeTruthy();
  await selectModel(desktopApp, grant.modelId);
  const pickerShot = await screenshot(desktopApp);
  const pickerSeen = await validate(pickerShot, [
    "The conversation shows the earlier task completed successfully (its final reply is present)",
    "No error banner and no 'The message was interrupted' text is visible",
  ]);
  expect(pickerSeen.ok, pickerSeen.why).toBe(true);

  // ── Frame 6: the new model actually answers, same session window ────────
  await sendComposerMessage(desktopApp, `Reply with exactly: ${NEW_MODEL_MARKER}`);
  const answered = await waitFor(desktopApp, assistantHasText(NEW_MODEL_MARKER), {
    timeoutMs: 300_000,
    label: `assistant reply containing ${NEW_MODEL_MARKER}`,
  }).then(() => true, () => false);
  evidence.fact(
    "Frame 6 — the newly granted model answers in the same session window",
    answered
      ? `A prompt on ${grant.modelId} (via ${grant.providerId}) completed with ${NEW_MODEL_MARKER}.`
      : `The prompt on ${grant.modelId} never produced ${NEW_MODEL_MARKER}.`,
    answered,
  );
  expect(answered, "the granted model did not complete a prompt").toBe(true);

  const finalShot = await screenshot(desktopApp);
  const finalSeen = await validate(finalShot, [
    `The assistant's reply containing '${NEW_MODEL_MARKER}' is visible`,
    `No '${INTERRUPTED_TEXT}' text and no 'Retrying in' countdown is visible anywhere`,
  ]);
  expect(finalSeen.ok, finalSeen.why).toBe(true);

  // Keep the reused Den clean for later runs (best-effort).
  await denFetch(den.admin, `/v1/llm-providers/${encodeURIComponent(grant.providerId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": activeOrgId },
  }).catch(() => undefined);
  await sleep(250);
});
