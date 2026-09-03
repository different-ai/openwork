import { EVAL_COWORKER_MODEL, clickButton, coworker, evalIn, fill, needs, test, waitFor, waitForText } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker Workers view: a person starts, steers, pauses, resumes, and stops a Worker, answers its decision, and finds it all after a reload"
  : "Open Coworker Workers view journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

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
  await using app = await coworker({ name: "workers-view" });

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
  await invokeCoworker(app, "coworkers.update", { slug: "editor", patch: { model: EVAL_COWORKER_MODEL, modelVariant: "" } });
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

  // A scheduled assignment exists (never run here), so the Assignments section below the Workers has a row.
  const responsibility = resultRecord(await invokeCoworker(app, "localResponsibilities.create", {
    slug: "editor",
    name: "Limit check",
    instructions: "Reply with exactly RESPONSIBILITY DONE.",
    schedule: { kind: "once", timezone: "UTC", at: Date.now() + 365 * 86_400_000 },
  }));
  expect(responsibility.name).toBe("Limit check");


  // The Workers view: the panel starts folded to its strip; its Workers icon opens the view, which
  // says no Worker is running yet and starts an open-ended one from its own form.
  expect(await evalIn(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed")`)).toBe("true");
  await evalIn(app, `document.querySelector('[data-testid="context-rail-workers"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-workers"]'))`, { timeoutMs: 30_000, label: "Workers view" });
  expect(await evalIn(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-view")`)).toBe("workers");
  const emptyState = await waitFor(app, `document.querySelector('[data-testid="workers-empty"]')?.textContent?.trim() || false`, { timeoutMs: 30_000, label: "empty Workers state" });
  expect(String(emptyState)).toContain("No Workers running. Ask Editor to start one, or start one here.");
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
  expect(resultRecords(await invokeCoworker(app, "workers.list", { slug: "editor" })).map((worker) => [worker.id, worker.status])).toEqual([[watcherId, "cancelled"]]);

  // The view keeps to flat rows (no card inside a card) and Escape folds the panel away.
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-workers"] .rounded-2xl .rounded-2xl').length`)).toBe(0);
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "true"`, { timeoutMs: 10_000, label: "panel folded by Escape" });

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
  // Once the coworker's own review reply has settled, the header says the person is needed — for the Worker's
  // decision, or for a question the coworker chose to ask about it.
  const headerWhileDeciding = await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "";
    return status === "Needs you" || status === "Waiting for an answer" ? status : false;
  })()`, { timeoutMs: 300_000, label: "header saying the person is needed for the Worker's decision" });
  expect(String(headerWhileDeciding)).toMatch(/^(Needs you|Waiting for an answer)$/);
  const greenOption = decisionCard.options.findIndex((option) => /green/i.test(String(option)));
  expect(greenOption).toBeGreaterThanOrEqual(0);
  await evalIn(app, `document.querySelectorAll('[data-testid="worker-decision-card"] [data-testid="interaction-option"]')[${greenOption}].click(); true`);
  await waitFor(app, `!document.querySelector('[data-testid="worker-decision-card"]')`, { timeoutMs: 30_000, label: "the decision card gone once answered" });
  // If the coworker also asked the person about it, answer that too so the discussion is free again.
  await evalIn(app, `(() => {
    const option = [...document.querySelectorAll('[data-testid="question-card"] [data-testid="interaction-option"]')].find((candidate) => /green/i.test(candidate.textContent ?? ""))
      ?? document.querySelector('[data-testid="question-card"] [data-testid="interaction-option"]');
    if (option instanceof HTMLElement) option.click();
    return true;
  })()`);
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
    if (rows.length < 2) return false;
    return rows.map((row) => [row.querySelector('[data-testid="worker-name"]')?.textContent?.trim(), row.getAttribute("data-status")]);
  })()`, { timeoutMs: 60_000, label: "Workers listed again after the reload" });
  expect(afterReload).toEqual([["Decider", "finished"], ["Long watch", "cancelled"]]);
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);

  evidence.recordAssertionEvidence(
    "From the Workers view a person starts, steers, pauses, resumes, and stops a Worker; a Worker's decision is asked in the discussion",
    `The folded panel's Workers icon opened the view (data-view workers), which said no Worker was running yet. New Worker started open-ended Worker ${watcherId} ("Long watch") from the form; its row read "${watcherLine}" and the rail said "${String(railLine)}". A steer typed in the row appeared in its timeline and then as the Worker's next turn in its read-only work view (Worker badge, no composer, no Stop in the header, no person bubbles). Pause held it (row Paused, nothing queued), Resume let it go on, Stop ended it: record Stopped with an end time, events Paused/Resumed/Stopped attributed to the person, no finding after the stop within 15 seconds, no active or queued runs, a second stop harmless, steering refused, both Workers listed newest first. The view had no card inside a card and Escape folded the panel. Below the Workers, Assignments listed the scheduled Limit check once (its run thread not repeated as a one-off). Worker ${deciderId} ("Decider") asked for a decision: the discussion showed the card "Decider asks" with its lettered choices while the header read Needs you; choosing Green steered it (one steer, by the person) and it finished with Done naming Green. After a window reload the Workers view listed both Workers with their final states.`,
    true,
  );
});
