import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker Workers: a Worker's findings wake the coworker, share this Mac's run limit, and stop on request"
  : "Open Coworker Workers journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

type App = Awaited<ReturnType<typeof coworker>>;

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function invokeCoworker(app: App, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function resultRecords(response: unknown): Record<string, unknown>[] {
  if (!isRecord(response) || response.ok !== true || !Array.isArray(response.result) || !response.result.every(isRecord)) {
    throw new Error(`Open Coworker bridge returned an unexpected list: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the Worker's record until `accept` is satisfied; the record is what the bridge returns to the view. */
async function waitForWorker(
  app: App,
  id: string,
  accept: (worker: Record<string, unknown>) => boolean,
  { timeoutMs, label }: { timeoutMs: number; label: string },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = resultRecord(await invokeCoworker(app, "workers.get", { slug: "editor", id }));
    if (accept(last)) return last;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${label}. Last record: ${JSON.stringify(last)}`);
}

/** Row actions disable while one is in flight; click only when the button is ready. */
async function clickRowAction(app: App, testId: string): Promise<void> {
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `${testId} ready to click` });
}

async function workerEvents(app: App, id: string): Promise<Record<string, unknown>[]> {
  return resultRecords(await invokeCoworker(app, "workers.findings", { slug: "editor", id }));
}

async function waitForDiscussionView(app: App, timeoutMs: number): Promise<void> {
  await waitFor(app, `(() => {
    const view = document.querySelector('[data-testid="coworker-discussion-view"]');
    const named = [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Editor");
    return Boolean(view) && named;
  })()`, { timeoutMs, label: "Editor discussion view" });
}

async function reload(app: App): Promise<void> {
  await evalIn(app, "location.reload(); true");
  await waitForDiscussionView(app, 120_000);
  await waitFor(app, `Boolean(document.querySelector('textarea[aria-label="Message Editor"]'))`, { timeoutMs: 60_000, label: "Editor discussion composer" });
}

async function sendDiscussionMessage(app: App, prompt: string, expected: string): Promise<unknown> {
  await fill(app, 'textarea[aria-label="Message Editor"]', prompt);
  await clickButton(app, "Send");
  return waitFor(app, `(() => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(expected)}));
    return message?.textContent ?? false;
  })()`, { timeoutMs: 300_000, label: `assistant response ${json(expected)}` });
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using app = await coworker({ name: "workers" });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: "Editor",
    role: "Writing partner",
    mission: "Help shape clear product writing.",
    avatarColor: "blue",
    avatarGlasses: "round",
  }));
  expect(created.workspaceId).toEqual(expect.any(String));
  await invokeCoworker(app, "coworkers.update", { slug: "editor", patch: { model: "opencode/big-pickle", modelVariant: "" } });
  await reload(app);
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, {
    timeoutMs: 240_000,
    label: "coworker AI ready",
  });

  // The coworker needs an open discussion to be woken in; the first message opens it.
  const firstReply = await sendDiscussionMessage(app, "Reply with exactly COWORKER CHAT READY.", "COWORKER CHAT READY");
  expect(firstReply).toContain("COWORKER CHAT READY");
  const discussionThreadId = String(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId);
  expect(discussionThreadId).toMatch(/^ses_/);
  await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 120_000, label: "discussion settled" });

  // One run at a time on this Mac, so a Worker turn and a responsibility run must take turns.
  expect(resultRecord(await invokeCoworker(app, "settings.update", { maxParallelLocalRuns: 1 })).maxParallelLocalRuns).toBe(1);

  const goal = [
    'On your first turn, end with a section titled "Finding" whose only sentence is: WORKER FINDING ONE.',
    'On your next turn, end with a section titled "Done" whose only sentence is: WORKER DONE.',
  ].join(" ");
  const spawned = resultRecord(await invokeCoworker(app, "workers.spawn", {
    slug: "editor",
    name: "Echo check",
    goal,
    lifespan: { kind: "turns", max: 2 },
  }));
  expect(spawned).toMatchObject({ status: "starting", spawnedBy: "person", lifespan: { kind: "turns", max: 2, used: 0 } });
  const workerId = String(spawned.id);

  const running = await waitForWorker(app, workerId, (worker) => worker.status === "running" && typeof worker.threadId === "string" && worker.threadId.startsWith("ses_"), {
    timeoutMs: 120_000,
    label: "the Worker's first turn",
  });
  const workerThreadId = String(running.threadId);
  expect(workerThreadId).not.toBe(discussionThreadId);

  // While the Worker's turn holds the only slot, a responsibility run waits its turn instead of starting.
  const responsibility = resultRecord(await invokeCoworker(app, "localResponsibilities.create", {
    slug: "editor",
    name: "Limit check",
    instructions: "Reply with exactly RESPONSIBILITY DONE.",
    schedule: { kind: "once", timezone: "UTC", at: Date.now() + 365 * 86_400_000 },
  }));
  const admission = resultRecord(await invokeCoworker(app, "localResponsibilities.runNow", { slug: "editor", id: responsibility.id }));
  expect(admission).toMatchObject({ accepted: true, queued: true });
  const runStatus = resultRecord(await invokeCoworker(app, "localResponsibilities.status", {}));
  expect(runStatus).toMatchObject({ limit: 1, active: 1, queued: 1 });

  // The header counts a working Worker as the coworker working, before any review has begun.
  const topStatusWhileWorking = await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "";
    return status && status !== "Ready" ? status : false;
  })()`, { timeoutMs: 30_000, label: "coworker header showing work in progress" });
  expect(String(topStatusWhileWorking)).not.toBe("Ready");

  // The first finding wakes the coworker: its discussion shows one quiet action line, then the coworker's own reply.
  const reviewLine = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-worker-review"] summary > span:not([aria-hidden])');
    return line?.textContent?.trim() || false;
  })()`, { timeoutMs: 420_000, label: "review action line in the discussion" });
  expect(String(reviewLine)).toMatch(/^Reviewed (an update|\d+ updates) from Echo check$/);
  const reviewReply = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-worker-review"]')?.closest('[data-testid="coworker-action-line"]');
    let node = line?.nextElementSibling ?? null;
    while (node) {
      if (node.matches('[data-message-role="assistant"]') && (node.textContent ?? "").trim()) return node.textContent?.trim();
      node = node.nextElementSibling;
    }
    return false;
  })()`, { timeoutMs: 300_000, label: "the coworker's reply after reviewing" });
  expect(String(reviewReply).length).toBeGreaterThan(0);
  // The scaffolding that woke the coworker is never shown as a message from the person.
  expect(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]')].some((message) => (message.textContent ?? "").includes("Review these updates"))`)).toBe(false);
  const findingsSoFar = (await workerEvents(app, workerId)).filter((event) => event.kind === "finding");
  expect(findingsSoFar.length).toBeGreaterThan(0);
  // The free model sometimes skips straight to Done; either way the finding reads as the Worker wrote it.
  expect(findingsSoFar.some((event) => /WORKER (FINDING ONE|DONE)/.test(String(event.text)))).toBe(true);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(discussionThreadId);

  // The Worker runs out its two turns; the queued responsibility run takes the slot in between and finishes too.
  const finished = await waitForWorker(app, workerId, (worker) => worker.status === "finished", { timeoutMs: 600_000, label: "the Worker to finish within its lifespan" });
  expect(finished.lifespan).toMatchObject({ kind: "turns", max: 2 });
  expect(isRecord(finished.lifespan) ? Number(finished.lifespan.used) : 0).toBeGreaterThanOrEqual(1);
  expect(finished.endedAt).toEqual(expect.any(Number));
  // The review is recorded on the Worker once the coworker's reply has settled.
  const reviewDeadline = Date.now() + 300_000;
  let finalEvents: Record<string, unknown>[] = [];
  while (Date.now() < reviewDeadline) {
    finalEvents = await workerEvents(app, workerId);
    if (finalEvents.some((event) => event.kind === "review" && event.reviewThreadId === discussionThreadId && !event.error)) break;
    await sleep(2_000);
  }
  expect(finalEvents.filter((event) => event.kind === "finding").length).toBeGreaterThanOrEqual(1);
  expect(finalEvents.some((event) => event.kind === "review" && event.reviewThreadId === discussionThreadId && !event.error)).toBe(true);
  const responsibilityRun = await waitFor(app, `window.__COWORKER__.invoke("localResponsibilities.list", { slug: "editor" }).then((response) => {
    const item = (response.result ?? []).find((candidate) => candidate.id === ${json(responsibility.id)});
    const status = item?.latestRun?.status ?? "";
    return status === "succeeded" || status === "failed" ? item.latestRun : false;
  })`, { awaitPromise: true, timeoutMs: 600_000, label: "the queued responsibility run to finish" });
  expect(responsibilityRun).toMatchObject({ status: "succeeded" });

  // A Worker's thread is registered as such and never reads as a discussion or an assignment.
  const registry = JSON.parse(String(resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "workers.json" })).content)) as { threadIds?: string[] };
  expect(registry.threadIds).toContain(workerThreadId);
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-menu"]'))`, { timeoutMs: 10_000, label: "discussion menu" });
  const menuThreadIds = await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-discussion-menu"] [role="menuitemradio"]')].map((item) => item.getAttribute("data-thread-id"))`);
  expect(menuThreadIds).toEqual([discussionThreadId]);
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  // The control reads "Assignments · 1": the responsibility run's thread counts, the Worker's does not.
  const assignmentsControl = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").trim().startsWith("Assignments"));
    if (!button) return false;
    const label = button.textContent?.trim() ?? "";
    button.click();
    return label;
  })()`);
  expect(assignmentsControl).toBe("Assignments · 1");
  await waitFor(app, `!document.querySelector('[data-testid="coworker-discussion-view"]')`, { timeoutMs: 30_000, label: "assignments view" });
  const assignmentsText = String(await evalIn(app, `document.querySelector("main")?.innerText ?? ""`));
  expect(assignmentsText).not.toContain("Worker: Echo check");
  expect(assignmentsText).toContain("Limit check");
  await clickButton(app, "Back");
  await waitForText(app, "COWORKER CHAT READY", { timeoutMs: 30_000 });

  evidence.recordAssertionEvidence(
    "A Worker posts findings that wake the coworker and shares this Mac's run limit",
    `Worker ${workerId} started in native thread ${workerThreadId}; with the limit at one, the responsibility run was admitted as queued (status limit 1 / active 1 / queued 1) and later succeeded once the slot freed. The header left Ready ("${String(topStatusWhileWorking)}") while the Worker worked. Its first finding contained WORKER FINDING ONE and woke the coworker in discussion ${discussionThreadId}: the transcript showed the action line "${String(reviewLine)}" followed by the coworker's own reply, with no person bubble carrying the review scaffolding; a review event named that discussion. The Worker finished within its two turns. workers.json listed its thread, the discussion menu listed only the discussion, and the Assignments view named the responsibility run but not the Worker.`,
    true,
  );

  // The Workers view: the panel starts folded to its strip; its Workers icon opens the view, which
  // lists the finished Worker and starts a new, open-ended one from its own form.
  expect(await evalIn(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed")`)).toBe("true");
  await evalIn(app, `document.querySelector('[data-testid="context-rail-workers"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-workers"]'))`, { timeoutMs: 30_000, label: "Workers view" });
  expect(await evalIn(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-view")`)).toBe("workers");
  const finishedRow = await evalIn(app, `(() => {
    const row = document.querySelector('[data-testid="worker-row"]');
    return row ? { status: row.getAttribute("data-status"), name: row.querySelector('[data-testid="worker-name"]')?.textContent?.trim(), line: row.querySelector('[data-testid="worker-line"]')?.textContent?.trim() } : null;
  })()`);
  expect(finishedRow).toMatchObject({ status: "finished", name: "Echo check", line: expect.stringMatching(/^Done/) });
  await clickButton(app, "New Worker");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="new-worker"]'))`, { timeoutMs: 10_000, label: "New Worker form" });
  await fill(app, '[data-testid="new-worker-name"]', "Long watch");
  await fill(app, '[data-testid="new-worker-goal"]', 'Keep watch on the file workspace/notes.md. Each turn, check whether it exists and how many lines it has, and end with a section titled "Finding" that states just that in one sentence.');
  await evalIn(app, `[...document.querySelectorAll('[data-testid="new-worker"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "Until stopped").click(); true`);
  await clickButton(app, "Start Worker");
  const watcherRow = await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="worker-row"]')].find((candidate) => candidate.querySelector('[data-testid="worker-name"]')?.textContent?.trim() === "Long watch");
    if (!row || row.getAttribute("data-status") !== "running") return false;
    return { expanded: row.getAttribute("data-expanded"), line: row.querySelector('[data-testid="worker-line"]')?.textContent?.trim() ?? "" };
  })()`, { timeoutMs: 120_000, label: "the new Worker's row while it works" });
  expect(watcherRow).toMatchObject({ expanded: "true", line: expect.stringContaining("Working on it · Until you stop it") });
  const watcherLine = isRecord(watcherRow) ? String(watcherRow.line) : "";
  const listed = resultRecords(await invokeCoworker(app, "workers.list", { slug: "editor" }));
  const watcher = listed.find((worker) => worker.name === "Long watch");
  if (!watcher) throw new Error(`The Worker started from the view is missing: ${JSON.stringify(listed)}`);
  const watcherId = String(watcher.id);
  expect(watcher).toMatchObject({ spawnedBy: "person", lifespan: { kind: "open" } });
  // The rail speaks about Workers in words: the Worker's own turn, or the coworker using its Worker tools.
  const railLine = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "";
    return /Worker/.test(line) ? line : false;
  })()`, { timeoutMs: 30_000, label: "rail line naming the Worker" });
  expect(String(railLine)).toMatch(/^(Worker Long watch is working|Working on .+ · \d Workers? running|\d Workers running|Working on (starting|steering|stopping) (a Worker|.+)|Working on (looking over its Workers|reading a Worker's findings))$/);

  // Steering from the view arrives as the Worker's next turn, visible in its own work.
  await fill(app, '[data-testid="worker-steer-input"]', "Count by twos from now on.");
  await evalIn(app, `document.querySelector('[data-testid="worker-steer-send"]').click(); true`);
  await waitFor(app, `[...document.querySelectorAll('[data-testid="worker-event"][data-kind="steer"]')].some((event) => (event.textContent ?? "").includes("Count by twos from now on."))`, { timeoutMs: 30_000, label: "steer in the timeline" });
  await evalIn(app, `document.querySelector('[data-testid="worker-open-work"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-worker-view"]'))`, { timeoutMs: 30_000, label: "the Worker's own work in the main column" });
  const workerViewShape = await evalIn(app, `(() => ({
    badge: [...document.querySelectorAll("header span")].some((node) => node.textContent?.trim() === "Worker"),
    readonly: Boolean(document.querySelector('[data-testid="coworker-worker-readonly"]')),
    composer: Boolean(document.querySelector('textarea[aria-label="Message Editor"]')),
    stopButtons: [...document.querySelectorAll("header button")].filter((button) => button.textContent?.trim() === "Stop").length,
  }))()`);
  expect(workerViewShape).toMatchObject({ badge: true, readonly: true, composer: false, stopButtons: 0 });
  const steerDeadline = Date.now() + 300_000;
  let steerTurn: unknown = false;
  while (Date.now() < steerDeadline) {
    steerTurn = await evalIn(app, `(() => {
      const turn = [...document.querySelectorAll('[data-testid="coworker-worker-turn"]')]
        .find((node) => (node.textContent ?? "").includes("Count by twos from now on."));
      return turn?.textContent?.trim() ?? false;
    })()`);
    if (steerTurn) break;
    const probe = await evalIn(app, `(() => ({
      workerView: Boolean(document.querySelector('[data-testid="coworker-worker-view"]')),
      discussionView: Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')),
      turns: [...document.querySelectorAll('[data-testid="coworker-worker-turn"]')].map((node) => (node.textContent ?? "").slice(0, 60)),
      messages: document.querySelectorAll('[data-message-role]').length,
      status: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "",
      top: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
    }))()`);
    if (isRecord(probe) && probe.workerView !== true) {
      const record = resultRecord(await invokeCoworker(app, "workers.get", { slug: "editor", id: watcherId }));
      const events = await workerEvents(app, watcherId);
      console.log(`[workers-probe ${new Date().toISOString()}] ${JSON.stringify({ ...probe, worker: { status: record.status, waitingFor: record.waitingFor, lifespan: record.lifespan, threadId: record.threadId }, events: events.map((event) => `${event.kind}:${String(event.text).slice(0, 40)}`) })}`);
    }
    await sleep(2_000);
  }
  if (!steerTurn) throw new Error("Timed out waiting for the steer as the Worker's next turn; see the workers-probe lines above.");
  expect(String(steerTurn)).toBe("Steering from the person Editor works for: Count by twos from now on.");
  expect(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]:not([data-worker-turn])')].length`)).toBe(0);
  await clickButton(app, "Back");
  await waitForText(app, "COWORKER CHAT READY", { timeoutMs: 30_000 });

  // Pause holds the Worker after its current step; Resume lets it go on; Stop ends it for good.
  await clickRowAction(app, "worker-pause");
  await waitFor(app, `[...document.querySelectorAll('[data-testid="worker-row"]')].some((row) => row.querySelector('[data-testid="worker-name"]')?.textContent?.trim() === "Long watch" && row.getAttribute("data-status") === "paused")`, { timeoutMs: 30_000, label: "paused row" });
  const pausedLine = String(await evalIn(app, `[...document.querySelectorAll('[data-testid="worker-row"]')].find((row) => row.getAttribute("data-status") === "paused")?.querySelector('[data-testid="worker-line"]')?.textContent?.trim() ?? ""`));
  expect(pausedLine).toMatch(/^Paused/);
  await waitForWorker(app, watcherId, (worker) => worker.status === "paused", { timeoutMs: 10_000, label: "paused record" });
  await sleep(2_000);
  expect(resultRecord(await invokeCoworker(app, "localResponsibilities.status", {}))).toMatchObject({ queued: 0 });
  await clickRowAction(app, "worker-resume");
  await waitForWorker(app, watcherId, (worker) => worker.status === "running" || worker.status === "waiting", { timeoutMs: 60_000, label: "resumed Worker" });
  await clickRowAction(app, "worker-stop");
  await waitFor(app, `[...document.querySelectorAll('[data-testid="worker-row"]')].some((row) => row.querySelector('[data-testid="worker-name"]')?.textContent?.trim() === "Long watch" && row.getAttribute("data-status") === "cancelled")`, { timeoutMs: 30_000, label: "stopped row" });
  const stopped = resultRecord(await invokeCoworker(app, "workers.get", { slug: "editor", id: watcherId }));
  expect(stopped).toMatchObject({ status: "cancelled", waitingFor: "" });
  expect(stopped.endedAt).toEqual(expect.any(Number));
  const stopEvents = await workerEvents(app, watcherId);
  const stopEvent = stopEvents.find((event) => event.kind === "status" && String(event.text).startsWith("Stopped"));
  expect(stopEvent).toMatchObject({ text: "Stopped", by: "person" });
  expect(stopEvents.some((event) => event.kind === "status" && String(event.text).startsWith("Paused"))).toBe(true);
  expect(stopEvents.some((event) => event.kind === "status" && String(event.text) === "Resumed")).toBe(true);
  await sleep(15_000);
  const afterStop = await workerEvents(app, watcherId);
  expect(afterStop.filter((event) => event.kind === "finding" && Number(event.at) > Number(stopEvent?.at)).length).toBe(0);
  expect(resultRecord(await invokeCoworker(app, "localResponsibilities.status", {}))).toMatchObject({ active: 0, queued: 0 });
  // Stopping again is harmless, and a stopped Worker takes no steering.
  expect(resultRecord(await invokeCoworker(app, "workers.cancel", { slug: "editor", id: watcherId })).status).toBe("cancelled");
  const steerRefused = await invokeCoworker(app, "workers.steer", { slug: "editor", id: watcherId, text: "Count by threes." });
  expect(steerRefused).toMatchObject({ ok: false, error: expect.stringContaining("already stopped") });
  expect(resultRecords(await invokeCoworker(app, "workers.list", { slug: "editor" })).map((worker) => [worker.id, worker.status])).toEqual([[watcherId, "cancelled"], [workerId, "finished"]]);

  // The view keeps to flat rows (no card inside a card) and Escape folds the panel away.
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-workers"] .rounded-2xl .rounded-2xl').length`)).toBe(0);
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "true"`, { timeoutMs: 10_000, label: "panel folded by Escape" });

  // The coworker starts a Worker through its own tool when asked; the conversation shows the receipt.
  const toolPrompt = 'Use your worker_spawn tool right now to start a Worker named "Tool check" with the goal: reply with a section titled "Finding" whose only sentence is TOOL WORKER READY, then say Done. Give it 1 turn. Do not ask me anything; after the tool call, tell me in one sentence what you started.';
  await fill(app, 'textarea[aria-label="Message Editor"]', toolPrompt);
  await clickButton(app, "Send");
  const toolStarted = await waitFor(app, `window.__COWORKER__.invoke("workers.list", { slug: "editor" }).then((response) => {
    const worker = (response.result ?? []).find((candidate) => candidate.name === "Tool check");
    return worker ? { id: worker.id, spawnedBy: worker.spawnedBy, lifespan: worker.lifespan } : false;
  })`, { awaitPromise: true, timeoutMs: 300_000, label: "a Worker started by the coworker's tool" });
  expect(toolStarted).toMatchObject({ spawnedBy: "coworker", lifespan: { kind: "turns", max: 1 } });
  const toolWorkerId = isRecord(toolStarted) ? String(toolStarted.id) : "";
  // The receipt names the Worker either as its one line or as one step of a larger receipt.
  const receipt = await waitFor(app, `(() => {
    const summaries = [...document.querySelectorAll('[data-testid="coworker-work-summary"]')];
    for (const summary of summaries) {
      const line = summary.textContent?.trim() ?? "";
      if (/Started a Worker/.test(line)) return line;
      if (/Workers/.test(line) && summary.getAttribute("aria-expanded") !== "true") summary.click();
    }
    const step = [...document.querySelectorAll('[data-testid="coworker-work-step"]')].map((node) => node.textContent?.trim() ?? "").find((line) => /Started a Worker/.test(line));
    return step ?? false;
  })()`, { timeoutMs: 120_000, label: "the receipt for starting a Worker" });
  expect(String(receipt)).toContain("Started a Worker");
  const toolEvents = await workerEvents(app, toolWorkerId);
  expect(toolEvents[0]).toMatchObject({ kind: "status", text: "Started by Editor", by: "coworker" });
  await waitForWorker(app, toolWorkerId, (worker) => worker.status === "finished", { timeoutMs: 300_000, label: "the tool-started Worker to finish its one turn" });

  // The Assignments section sits below the Workers: the scheduled run from earlier is listed once, under its
  // schedule, never again as a one-off from its own thread.
  await evalIn(app, `document.querySelector('[data-testid="context-rail-workers"]').click(); true`);
  const assignmentsSection = await waitFor(app, `(() => {
    const section = document.querySelector('[data-testid="coworker-assignments"]');
    if (!(section instanceof HTMLElement)) return false;
    const scheduled = [...section.querySelectorAll('[data-testid="responsibility-row"]')].map((row) => row.innerText.replace(/\\s+/g, " ").trim());
    if (scheduled.length === 0) return false;
    return { heading: section.querySelector("h3")?.textContent?.trim() ?? "", scheduled, once: document.querySelectorAll('[data-testid="assignment-row"]').length };
  })()`, { timeoutMs: 30_000, label: "Assignments below the Workers" });
  expect(assignmentsSection).toMatchObject({ heading: "Assignments", once: 0 });
  if (!isRecord(assignmentsSection) || !Array.isArray(assignmentsSection.scheduled)) throw new Error("Assignments facts were unavailable.");
  expect(String(assignmentsSection.scheduled[0])).toContain("Limit check");

  // A Worker that needs a decision asks in the discussion as a lettered card; the answer steers it.
  const decider = resultRecord(await invokeCoworker(app, "workers.spawn", {
    slug: "editor",
    name: "Decider",
    goal: 'On your first turn, do no other work: end with a section titled "Needs a decision" that asks "Which color should the banner use?" and lists exactly two options as "A) Blue" and "B) Green". On your next turn, end with a section titled "Done" whose only sentence names the chosen color, for example: The banner uses Green.',
    lifespan: { kind: "turns", max: 2 },
  }));
  const deciderId = String(decider.id);
  await waitForWorker(app, deciderId, (worker) => worker.status === "waiting" && worker.waitingFor === "decision", { timeoutMs: 300_000, label: "the Worker to wait for a decision" });
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  const decisionCard = await waitFor(app, `(() => {
    const card = document.querySelector('[data-testid="worker-decision-card"]');
    if (!(card instanceof HTMLElement)) return false;
    const options = [...card.querySelectorAll('[data-testid="interaction-option"]')].map((option) => option.textContent?.replace(/\\s+/g, " ").trim() ?? "");
    return { title: card.querySelector("h3")?.textContent?.trim() ?? "", text: card.innerText, options };
  })()`, { timeoutMs: 60_000, label: "the Worker's decision card in the discussion" });
  expect(decisionCard).toMatchObject({ title: "Decider asks" });
  if (!isRecord(decisionCard) || !Array.isArray(decisionCard.options)) throw new Error("Decision card facts were unavailable.");
  expect(String(decisionCard.text)).toMatch(/color/i);
  expect(decisionCard.options.length).toBeGreaterThanOrEqual(2);
  // Once the coworker's own review reply has settled, the header says the Worker needs the person.
  const headerWhileDeciding = await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "";
    return status === "Needs you" ? status : false;
  })()`, { timeoutMs: 300_000, label: "header saying Needs you for the Worker's decision" });
  expect(headerWhileDeciding).toBe("Needs you");
  const greenOption = decisionCard.options.findIndex((option) => /green/i.test(String(option)));
  expect(greenOption).toBeGreaterThanOrEqual(0);
  await evalIn(app, `document.querySelectorAll('[data-testid="worker-decision-card"] [data-testid="interaction-option"]')[${greenOption}].click(); true`);
  await waitFor(app, `!document.querySelector('[data-testid="worker-decision-card"]')`, { timeoutMs: 30_000, label: "the decision card gone once answered" });
  const decided = await waitForWorker(app, deciderId, (worker) => worker.status === "finished", { timeoutMs: 300_000, label: "the deciding Worker to finish" });
  expect(decided.steerCount).toBe(1);
  const deciderEvents = await workerEvents(app, deciderId);
  const steerEvent = deciderEvents.find((event) => event.kind === "steer");
  expect(steerEvent).toMatchObject({ by: "person", text: expect.stringMatching(/green/i) });
  const doneEvent = [...deciderEvents].reverse().find((event) => event.kind === "finding" && event.report === "done");
  expect(String(doneEvent?.text ?? "")).toMatch(/green/i);

  // Workers survive a reload of the window: the same rows, the same states.
  await evalIn(app, "location.reload(); true");
  await waitForDiscussionView(app, 120_000);
  await evalIn(app, `document.querySelector('[data-testid="context-rail-workers"]').click(); true`);
  const afterReload = await waitFor(app, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="worker-row"]')];
    if (rows.length < 4) return false;
    return rows.map((row) => [row.querySelector('[data-testid="worker-name"]')?.textContent?.trim(), row.getAttribute("data-status")]);
  })()`, { timeoutMs: 60_000, label: "Workers listed again after the reload" });
  expect(afterReload).toEqual([["Decider", "finished"], ["Tool check", "finished"], ["Long watch", "cancelled"], ["Echo check", "finished"]]);
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);

  evidence.recordAssertionEvidence(
    "From the Workers view a person starts, steers, pauses, resumes, and stops a Worker",
    `The folded panel's Workers icon opened the view (data-view workers), which listed Echo check as Done. New Worker started open-ended Worker ${watcherId} ("Long watch") from the form; its row read "${watcherLine}" and the rail said "${String(railLine)}". A steer typed in the row appeared in its timeline and then as the Worker's next turn in its read-only work view (Worker badge, no composer, no Stop in the header, no person bubbles). Pause held it (row Paused, nothing queued), Resume let it go on, Stop ended it: record Stopped with an end time, events Paused/Resumed/Stopped attributed to the person, no finding after the stop within 15 seconds, no active or queued runs, a second stop harmless, steering refused, both Workers listed newest first. The view had no card inside a card and Escape folded the panel. Asked in the discussion, Editor started Worker ${toolWorkerId} ("Tool check", 1 turn) through its own worker_spawn tool; the conversation showed the receipt "${String(receipt)}", the Worker's first event read Started by Editor, and it finished its one turn. Below the Workers, Assignments listed the scheduled Limit check once (its run thread not repeated as a one-off). Worker ${deciderId} ("Decider") asked for a decision: the discussion showed the card "Decider asks" with its lettered choices while the header read Needs you; choosing Green steered it (one steer, by the person) and it finished with Done naming Green. After a window reload the Workers view listed all four Workers with their final states.`,
    true,
  );
});
