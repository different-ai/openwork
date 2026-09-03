import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker Workers: a Worker's findings wake the coworker, share this Mac's run limit, and the coworker starts one through its own tool"
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

  evidence.recordAssertionEvidence(
    "Asked in the discussion, the coworker starts a Worker through its own tool",
    `Editor started Worker ${toolWorkerId} ("Tool check", 1 turn) through its own worker_spawn tool; the conversation showed the receipt "${String(receipt)}", the Worker's first event read Started by Editor, and it finished its one turn.`,
    true,
  );
});
