import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWorkLine, describeWorkProgress, describeWorkStep, executionDuration, executionMetadata, summarizeWork, workStepState } from "./work-receipt.ts";
import { PROGRESS_LIMITS, PROGRESS_SYSTEM } from "./progress-config.ts";
import { createProgressBudget, createProgressService, isLongProgress, progressFingerprint, progressNoteText, type ProgressNote, type ProgressObservation, type ProgressSummarizer } from "./progress-service.ts";

test("tool calls become steps a person can read, with the tool name kept for details", () => {
  const edit = describeWorkStep({ tool: "edit", status: "completed", input: { filePath: "/Users/me/coworkers/yo/memory/index.md" } });
  assert.deepEqual(edit, { label: "Edited index.md", doing: "editing index.md", service: "your files", state: "done", tool: "edit" });
  assert.equal(describeWorkStep({ tool: "write", status: "running", input: { path: "notes/working.md" } }).label, "Wrote working.md");
  assert.equal(describeWorkStep({ tool: "read", status: "success", input: { filePath: "a/b/soul.md" } }).label, "Read soul.md");
  assert.equal(describeWorkStep({ tool: "bash", status: "completed", input: { command: "ls", description: "List files" } }).label, "Ran a command: List files");
  assert.equal(describeWorkStep({ tool: "grep", status: "completed", input: {} }).label, "Looked through your files");
  assert.equal(describeWorkStep({ tool: "openwork-cloud_search_capabilities", status: "completed", input: { query: "calendar" } }).label, "Searched connected tools for “calendar”");
  assert.equal(describeWorkStep({ tool: "openwork-cloud_execute_capability", status: "completed", input: { name: "google_calendar_list_events" } }).label, "Used google_calendar_list_events");
  const mcp = describeWorkStep({ tool: "skill-studio_create_skill", status: "error", input: {}, error: "boom" });
  assert.deepEqual([mcp.label, mcp.service, mcp.state], ["Used Create Skill in Skill Studio", "Skill Studio", "failed"]);
  assert.equal(describeWorkStep({ tool: "Bash", status: "pending", input: {} }).state, "running");
  assert.equal(workStepState("completed"), "done");
  assert.equal(workStepState("failed"), "failed");
});

test("the collapsed line sums the work up and never hides a failure or a running step", () => {
  const edited = describeWorkStep({ tool: "edit", status: "completed", input: { filePath: "index.md" } });
  const wrote = describeWorkStep({ tool: "edit", status: "completed", input: { filePath: "working.md" } });
  const searched = describeWorkStep({ tool: "openwork-cloud_search_capabilities", status: "completed", input: { query: "calendar" } });
  const failed = describeWorkStep({ tool: "skill-studio_create_skill", status: "failed", input: {} });
  const running = describeWorkStep({ tool: "bash", status: "running", input: {} });
  assert.equal(summarizeWork([]), "");
  assert.equal(summarizeWork([edited]), "Edited index.md");
  assert.equal(summarizeWork([edited, wrote]), "Worked with your files · 2 steps");
  assert.equal(summarizeWork([edited, searched]), "Worked with your files and OpenWork Connect · 2 steps");
  assert.equal(summarizeWork([edited, searched, failed]), "Worked with your files and OpenWork Connect and 1 more · 3 steps · 1 step didn't finish");
  assert.equal(summarizeWork([edited, running]), "Worked with your files and the terminal · 2 steps · still working");
});

test("the transcript line says what is happening now while a step runs, and sums the work up once it has settled", () => {
  const edited = describeWorkStep({ tool: "edit", status: "completed", input: { filePath: "index.md" } });
  const running = describeWorkStep({ tool: "bash", status: "running", input: {} });
  const failed = describeWorkStep({ tool: "skill-studio_create_skill", status: "failed", input: {} });
  assert.equal(describeWorkLine([]), "");
  assert.equal(describeWorkLine([running]), "Running a command");
  assert.equal(describeWorkLine([edited, running]), "Running a command · 2 of 2");
  assert.equal(describeWorkLine([edited, running, describeWorkStep({ tool: "read", status: "pending", input: { filePath: "notes.md" } })]), "Reading notes.md · 3 of 3");
  assert.equal(describeWorkLine([edited]), "Edited index.md");
  assert.equal(describeWorkLine([edited, failed]), "Worked with your files and Skill Studio · 2 steps · 1 step didn't finish");
  assert.equal(describeWorkProgress([edited, running]), "1 of 2 done");
  assert.equal(describeWorkProgress([edited]), "1 step");
  assert.equal(describeWorkProgress([edited, edited]), "2 steps");
  assert.equal(describeWorkProgress([edited, failed]), "2 steps · 1 didn't finish");
});

test("inspection projects only execution metadata without reading reasoning, input, output, or errors", () => {
  const call = {
    tool: "bash", status: "running", startedAt: 1_000,
    get input(): never { throw new Error("private command"); },
    get output(): never { throw new Error("private result"); },
    get reasoning(): never { throw new Error("private reasoning"); },
    get error(): never { throw new Error("private error"); },
  };
  const metadata = executionMetadata(call);
  assert.deepEqual(metadata, { kind: "command", status: "running", startedAt: 1_000, completedAt: null });
  assert.equal(executionDuration(metadata, 5_000), "4 s elapsed");
  assert.deepEqual(executionMetadata({ tool: "private-unrecognized-tool", status: "invented", startedAt: NaN }), { kind: "other", status: "unknown", startedAt: null, completedAt: null });
  const done = executionMetadata({ tool: "read", status: "completed", startedAt: 1_000, completedAt: 3_000 });
  assert.equal(executionDuration(done, 9_000), "2 s recorded");
  assert.equal(executionDuration({ ...done, completedAt: null }, 9_000), "Duration unavailable");
  assert.equal(executionDuration({ ...done, completedAt: 0 }, 9_000), "Duration unavailable");
  assert.equal(executionMetadata({ tool: "read", status: "cancelled" }).status, "cancelled");
  assert.equal(executionMetadata({ tool: "read", status: "pending" }).status, "pending");
});

const progressObservation: ProgressObservation = {
  executionId: "execution-one", status: "waiting", startedAt: 1_000,
  completedSteps: 2, pendingCoworkers: 1, pendingWorkers: 2,
};

test("long progress uses observed counts and dependencies, not ETA, reasoning, or clock-driven changes", () => {
  assert.equal(progressNoteText(progressObservation), "Waiting for a result. Pending: 1 coworker result and 2 Worker results. 2 tool steps completed.");
  assert.equal(isLongProgress(progressObservation, 15_999), false);
  assert.equal(isLongProgress(progressObservation, 16_000), true);
  assert.equal(isLongProgress({ ...progressObservation, startedAt: null }, 90_000), false);
  assert.equal(progressFingerprint(progressObservation), progressFingerprint({ ...progressObservation, startedAt: 0 }));
  assert.equal(progressNoteText({ ...progressObservation, status: "failed", completedSteps: NaN, pendingWorkers: -1, pendingCoworkers: 0, failedSteps: 1 }), "Failed. 1 tool step failed.");
  assert.equal(progressNoteText({ ...progressObservation, completedSteps: Infinity, pendingWorkers: 100_000 }).includes("999+ Worker results"), true);
  const stale: ProgressNote = { fingerprint: "other-execution", factIds: ["status"], source: "selected" };
  assert.equal(progressNoteText(progressObservation, stale), progressNoteText(progressObservation));
  const missingDependency: ProgressNote = { ...stale, fingerprint: progressFingerprint(progressObservation) };
  assert.equal(progressNoteText(progressObservation, missingDependency), progressNoteText(progressObservation));
});

test("optional summaries default to no inference, including opt-in without an explicit cheap model", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  let calls = 0;
  const summarize: ProgressSummarizer = async () => { calls++; return '{"facts":["status"]}'; };
  for (const config of [{}, { enabled: true }, { cheapModelId: "chosen/cheap" }]) {
    const service = createProgressService({ ...config, executionId: progressObservation.executionId, summarize, onNote: () => assert.fail("no summary") });
    assert.equal(service.update(progressObservation).source, "observed");
    context.mock.timers.tick(60_000);
    service.dispose();
  }
  assert.equal(calls, 0);
});

test("summaries debounce, cap input/output/calls, suppress unchanged facts, and never display invented prose", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const requests: Parameters<ProgressSummarizer>[0][] = [];
  const notes: ProgressNote[] = [];
  const service = createProgressService({
    executionId: progressObservation.executionId, enabled: true, cheapModelId: "chosen/cheap",
    summarize: async (request) => {
      requests.push(request);
      return requests.length === 2 ? "Almost finished, 99% confident, only a minute left" : '{"facts":["status","dependencies"]}';
    },
    onNote: (note) => notes.push(note),
  });
  service.update(progressObservation);
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs - 1);
  assert.equal(requests.length, 0);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.modelId, "chosen/cheap");
  assert.equal(requests[0]?.maxOutputTokens, PROGRESS_LIMITS.maxOutputTokens);
  assert.ok(requests[0] && Buffer.byteLength(requests[0].prompt + PROGRESS_SYSTEM) + PROGRESS_LIMITS.inputFramingBytes <= PROGRESS_LIMITS.maxInputBytes);
  assert.doesNotMatch(requests[0]?.prompt ?? "", /[^\x20-\x7e]/);
  assert.doesNotMatch(requests[0]?.prompt ?? "", /execution-one/);
  assert.equal(notes.length, 1);
  assert.equal(progressNoteText(progressObservation, notes[0]), "Waiting for a result. Pending: 1 coworker result and 2 Worker results.");
  service.update({ ...progressObservation, startedAt: 0 });
  context.mock.timers.tick(60_000);
  assert.equal(requests.length, 1);
  for (let completedSteps = 3; completedSteps < 7; completedSteps++) {
    service.update({ ...progressObservation, completedSteps });
    context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
    await Promise.resolve();
  }
  assert.equal(requests.length, PROGRESS_LIMITS.maxCallsPerExecution);
  assert.equal(notes.length, 2);
  service.dispose();
});

test("new facts, timeout, and disposal abort summaries and reject late generations", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const pending: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
  const notes: ProgressNote[] = [];
  const service = createProgressService({
    executionId: progressObservation.executionId, enabled: true, cheapModelId: "chosen/cheap",
    summarize: ({ signal }) => new Promise<string>((resolve) => pending.push({ signal, resolve })),
    onNote: (note) => notes.push(note),
  });
  service.update(progressObservation);
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs);
  service.update({ ...progressObservation, completedSteps: 3 });
  assert.equal(pending[0]?.signal.aborted, true);
  pending[0]?.resolve('{"facts":["status","dependencies"]}');
  await Promise.resolve();
  assert.equal(notes.length, 0);
  service.update({ ...progressObservation, completedSteps: 3 });
  context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
  assert.equal(pending.length, 2);
  context.mock.timers.tick(PROGRESS_LIMITS.timeoutMs);
  assert.equal(pending[1]?.signal.aborted, true);
  pending[1]?.resolve('{"facts":["status","dependencies"]}');
  await Promise.resolve();
  service.update({ ...progressObservation, completedSteps: 4 });
  context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
  service.dispose();
  assert.equal(pending[2]?.signal.aborted, true);
  pending[2]?.resolve('{"facts":["status","dependencies"]}');
  await Promise.resolve();
  assert.equal(notes.length, 0);
  service.update({ ...progressObservation, completedSteps: 5 });
  context.mock.timers.tick(60_000);
  assert.equal(pending.length, 3);
});

test("a main-owned budget survives service replacement and counts errors without retrying facts", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const budget = createProgressBudget();
  const calls: number[] = [];
  const create = () => createProgressService({
    executionId: progressObservation.executionId, enabled: true, cheapModelId: "fixture/progress", budget,
    summarize: async () => { calls.push(Date.now()); throw new Error("fixture failure"); },
    onNote: () => assert.fail("errors cannot select facts"),
  });
  let service = create();
  service.update(progressObservation);
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs);
  await Promise.resolve();
  service.dispose();
  service = create();
  service.update(progressObservation);
  context.mock.timers.tick(60_000);
  assert.equal(calls.length, 1);
  for (let completedSteps = 3; completedSteps < 8; completedSteps++) {
    service.dispose();
    service = create();
    service.update({ ...progressObservation, completedSteps });
    context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
    await Promise.resolve();
  }
  assert.equal(calls.length, 3);
  assert.equal(budget.calls, 3);
  assert.ok(calls.slice(1).every((at, index) => at - (calls[index] ?? 0) >= PROGRESS_LIMITS.minCallIntervalMs));
  service.dispose();
});

test("the coworker's document tools read as plain steps: wrote, updated by section, put aside, archived", () => {
  const kept = (document: Record<string, unknown>) => ({ openworkMcpApp: { content: [{ type: "text", text: "ok" }], structuredContent: { document } } });
  const wrote = describeWorkStep({ tool: "coworker_document_create", status: "completed", input: { title: "Launch plan", summary: "S", body: "B" } });
  assert.deepEqual([wrote.label, wrote.doing, wrote.service], ["Wrote a document · Launch plan", "writing a document", "documents"]);
  const updated = describeWorkStep({
    tool: "coworker_document_update",
    status: "completed",
    input: { id: "launch-plan", patch: { heading: "Timeline", content: "x" } },
    output: { content: [{ type: "text", text: "Updated" }] },
    metadata: kept({ id: "launch-plan", title: "Launch plan", section: "Timeline" }),
  });
  assert.equal(updated.label, "Updated Launch plan · Timeline section");
  assert.equal(updated.doing, "updating Launch plan");
  // Without a kept result the id still names the document.
  assert.equal(describeWorkStep({ tool: "coworker_document_update", status: "running", input: { id: "old-vendor-notes", body: "x" } }).label, "Updated Old vendor notes");
  assert.equal(describeWorkStep({ tool: "coworker_document_read", status: "completed", input: { id: "launch-plan" } }).label, "Read a document · Launch plan");
  assert.equal(describeWorkStep({ tool: "coworker_documents_list", status: "completed", input: {} }).label, "Looked over its documents");
  const aside = describeWorkStep({
    tool: "coworker_context_set",
    status: "completed",
    input: { active: ["launch-plan"], aside: ["old-vendor-notes"] },
    output: { content: [{ type: "text", text: "Put aside: Old vendor notes." }] },
    metadata: { openworkMcpApp: { content: [{ type: "text", text: "ok" }], structuredContent: { changed: [{ id: "old-vendor-notes", title: "Old vendor notes", status: "aside" }] } } },
  });
  assert.equal(aside.label, "Put aside · Old vendor notes");
  assert.equal(describeWorkStep({ tool: "coworker_context_set", status: "completed", input: { aside: ["a-b", "c-d", "e-f"] } }).label, "Put aside · A b, C d and 1 more");
  assert.equal(describeWorkStep({ tool: "coworker_context_set", status: "completed", input: { active: ["a"] } }).label, "Sorted its documents");
  assert.equal(describeWorkStep({ tool: "coworker_document_archive", status: "completed", input: { id: "old-vendor-notes" } }).label, "Archived · Old vendor notes");
  // They group into the existing line like any other work, without raw tool names.
  const line = summarizeWork([wrote, updated, describeWorkStep({ tool: "edit", status: "completed", input: { filePath: "working.md" } })]);
  assert.equal(line, "Worked with documents and your files · 3 steps");
  assert.doesNotMatch(wrote.label + updated.label + aside.label, /[a-z]+_[a-z]+/);
});

test("the coworker's own assignment tools read as what changed, never as tool ids or JSON", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const created = describeWorkStep({
    tool: "coworker_assignment_create",
    status: "completed",
    input: { name: "Move the car", instructions: "Remind me to move the car.", schedule: { kind: "weekly", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0, timezone: zone } },
    output: 'Created assignment "Move the car" · Every weekday at 9:00 AM\nNext run: tomorrow at 9:00 AM',
  });
  assert.deepEqual([created.label, created.service, created.state], ["Created assignment · Move the car · Every weekday at 9:00 AM", "your assignments", "done"]);
  assert.equal(describeWorkStep({ tool: "coworker_assignment_create", status: "running", input: { name: "Move the car" } }).label, "Setting up an assignment · Move the car");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_create", status: "error", input: { name: "Move the car" }, error: "Runs on this Mac need at least 1 hour between them." }).label, "Couldn't create assignment · Move the car");
  const changed = describeWorkStep({
    tool: "coworker_assignment_update",
    status: "completed",
    input: { id: "abc", patch: { schedule: { kind: "interval", everyMinutes: 120, from: "09:00", until: "18:00", maxPerDay: 4, timezone: zone } } },
    output: 'Changed assignment "Move the car" · Every 2 hours between 9:00 AM and 6:00 PM, up to 4 times a day',
  });
  assert.equal(changed.label, "Changed Move the car to every 2 hours between 9:00 AM and 6:00 PM, up to 4 times a day");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_update", status: "completed", input: { id: "abc", patch: { active: false } }, output: 'Paused assignment "Move the car"' }).label, "Paused Move the car");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_update", status: "completed", input: { id: "abc", patch: { active: true } }, output: 'Resumed assignment "Move the car"' }).label, "Resumed Move the car");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_update", status: "completed", input: { id: "abc", patch: { name: "Car day" } }, output: 'Renamed assignment "Move the car" to "Car day"' }).label, "Renamed Move the car to Car day");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_update", status: "completed", input: { id: "abc", patch: { instructions: "Also check the sign." } }, output: 'Changed assignment "Move the car"' }).label, "Changed what Move the car does");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_update", status: "running", input: { id: "abc", patch: { active: false } } }).label, "Changing the assignment");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_run_now", status: "completed", input: { id: "abc" }, output: 'Started assignment "Move the car" now' }).label, "Started Move the car now");
  assert.equal(describeWorkStep({ tool: "coworker_assignment_remove", status: "completed", input: { id: "abc" }, output: 'Removed assignment "Move the car"' }).label, "Removed Move the car");
  assert.equal(describeWorkStep({ tool: "coworker_assignments_list", status: "completed", input: {}, output: "2 assignments" }).label, "Checked the assignments");
  const steps = [created, changed];
  assert.equal(summarizeWork(steps), "Worked with your assignments · 2 steps");
  for (const step of [created, changed]) assert.doesNotMatch(step.label, /coworker_|\{|"kind"/);
});

test("the coworker's memory and soul tools read as what it remembered or changed, and never echo a refused secret", () => {
  const remembered = describeWorkStep({ tool: "coworker_memory_remember", status: "completed", input: { text: "You work in Product", kind: "long-term", topic: "About you" }, output: "Remembered in long-term memory (About you): You work in Product" });
  assert.deepEqual([remembered.label, remembered.service], ["Remembered · You work in Product", "your memory"]);
  assert.equal(describeWorkStep({ tool: "coworker_memory_remember", status: "completed", input: { text: "We use Slack and Linear", kind: "long-term" }, output: "Moved to long-term memory (Tools): We use Slack and Linear" }).label, "Moved to long-term memory · We use Slack and Linear");
  assert.equal(describeWorkStep({ tool: "coworker_memory_remember", status: "running", input: { text: "You work in Product", kind: "working" } }).label, "Remembering · You work in Product");
  assert.equal(describeWorkStep({ tool: "coworker_memory_remember", status: "error", input: { text: "API key sk-live-1234567890abcdef1234", kind: "working" }, error: "That looks like a secret." }).label, "Couldn't remember that");
  assert.equal(describeWorkStep({ tool: "coworker_memory_forget", status: "completed", input: { target: "The launch is on Friday" }, output: "Forgot from working memory: The launch is on Friday" }).label, "Forgot · The launch is on Friday");
  // A progress note reads as where the work stands; clearing it reads as that; a refused note echoes nothing.
  const noted = describeWorkStep({ tool: "coworker_memory_note", status: "completed", input: { work: "Vendor comparison", text: "Two contracts read; next: call Beta." }, output: "Noted for Vendor comparison: Two contracts read; next: call Beta." });
  assert.deepEqual([noted.label, noted.service, noted.doing], ["Noted · Vendor comparison — Two contracts read; next: call Beta.", "your memory", "noting where the work stands"]);
  assert.equal(describeWorkStep({ tool: "coworker_memory_note", status: "running", input: { work: "Vendor comparison", text: "Starting." } }).label, "Noting · Vendor comparison");
  assert.equal(describeWorkStep({ tool: "coworker_memory_note", status: "completed", input: { work: "Vendor comparison", text: "" }, output: "Cleared the note for Vendor comparison" }).label, "Cleared the note · Vendor comparison");
  assert.equal(describeWorkStep({ tool: "coworker_memory_note", status: "running", input: { work: "Vendor comparison" } }).label, "Clearing the note · Vendor comparison");
  assert.equal(describeWorkStep({ tool: "coworker_memory_note", status: "error", input: { work: "Keys", text: "api key is sk-live-1234567890abcdef1234" }, error: "That looks like a secret." }).label, "Couldn't note that");
  assert.equal(describeWorkStep({ tool: "coworker_memory_note", status: "error", input: { work: "Keys" } }).label, "Couldn't clear the note");
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: { section: "Communication", change: { kind: "add", text: "Shorter replies" } }, output: "Updated Communication: added \"Shorter replies\"" }).label, "Updated how I work · Shorter replies");
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: { section: "Principles", change: { kind: "remove", target: "Ask before emailing" } }, output: "Updated Principles" }).label, "Updated how I work · dropped “Ask before emailing”");
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "error", input: { section: "Communication", change: { kind: "add", text: "password: hunter2" } } }).label, "Couldn't update how I work");
  assert.equal(describeWorkStep({ tool: "coworker_self_read", status: "completed", input: { what: "memory" }, output: "# Working memory…" }).label, "Checked what I remember");
  assert.equal(describeWorkStep({ tool: "coworker_self_read", status: "running", input: { what: "soul" } }).doing, "checking what I remember");
  assert.equal(summarizeWork([remembered, describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: { section: "Communication", change: { kind: "add", text: "Shorter replies" } } })]), "Worked with your memory · 2 steps");
});
