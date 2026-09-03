import assert from "node:assert/strict";
import { test } from "node:test";
import { GLIMPSE_CHARS, GLIMPSE_MS, describeGlimpse, describeProgress, describeWorkStep, summarizeWork, technicalSections, workStepState } from "./work-receipt.ts";

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

test("the progress phrase follows the phase, not a timer", () => {
  assert.equal(describeProgress("Nova", "sending"), "Sending…");
  assert.equal(describeProgress("Nova", "thinking"), "Nova is thinking…");
  assert.equal(describeProgress("Nova", "tool", { doing: "editing index.md" }), "Nova is editing index.md…");
  assert.equal(describeProgress("Nova", "tool", null), "Nova is using a tool…");
  assert.equal(describeProgress("Nova", "writing"), "Nova is putting it together…");
  assert.equal(describeProgress("Nova", "retrying"), "Nova is trying again…");
  assert.equal(describeProgress("Nova", "finishing"), "Nova is finishing up…");
});

test("technical details show a shell command on its own, other input as tidy JSON, then result and error, all clipped", () => {
  assert.deepEqual(technicalSections({ input: { command: "ls -la /tmp\n", description: "list" }, output: "a\nb\n" }), [
    { label: "Command", text: "ls -la /tmp" },
    { label: "Input", text: '{\n  "description": "list"\n}' },
    { label: "Result", text: "a\nb" },
  ]);
  assert.deepEqual(technicalSections({ input: {}, output: { ok: true }, error: "boom" }), [
    { label: "Result", text: '{\n  "ok": true\n}' },
    { label: "Error", text: "boom" },
  ]);
  const long = technicalSections({ input: { command: "x".repeat(2000) } });
  assert.equal(long[0]?.text.length, 1200);
  assert.ok(long[0]?.text.endsWith("…"));
  assert.deepEqual(technicalSections({ input: { path: "" }, output: null }), []);
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
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: { section: "Communication", change: { kind: "add", text: "Shorter replies" } }, output: "Updated Communication: added \"Shorter replies\"" }).label, "Updated how I work · Shorter replies");
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: { section: "Principles", change: { kind: "remove", target: "Ask before emailing" } }, output: "Updated Principles" }).label, "Updated how I work · dropped “Ask before emailing”");
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "error", input: { section: "Communication", change: { kind: "add", text: "password: hunter2" } } }).label, "Couldn't update how I work");
  assert.equal(describeWorkStep({ tool: "coworker_self_read", status: "completed", input: { what: "memory" }, output: "# Working memory…" }).label, "Checked what I remember");
  assert.equal(describeWorkStep({ tool: "coworker_self_read", status: "running", input: { what: "soul" } }).doing, "checking what I remember");
  assert.equal(summarizeWork([remembered, describeWorkStep({ tool: "coworker_soul_update", status: "completed", input: { section: "Communication", change: { kind: "add", text: "Shorter replies" } } })]), "Worked with your memory · 2 steps");
});

test("a glance at the live row shows the end of one line of what is streaming, or the step under way, or nothing yet", () => {
  assert.equal(describeGlimpse({ text: "", reasoning: "", step: null }), "");
  assert.equal(describeGlimpse({ text: "", reasoning: "", step: { doing: "editing index.md" } }), "Editing index.md…");
  assert.equal(describeGlimpse({ text: "", reasoning: "First the sources,\n\nthen the summary.", step: null }), "First the sources, then the summary.");
  // Words being written win over the thinking behind them and over the step.
  assert.equal(describeGlimpse({ text: "Here is the plan.", reasoning: "hmm", step: { doing: "reading notes.md" } }), "Here is the plan.");
  const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
  const glance = describeGlimpse({ text: long, reasoning: "", step: null });
  assert.ok(glance.startsWith("…"), glance);
  assert.ok(glance.length <= GLIMPSE_CHARS + 1, String(glance.length));
  assert.ok(glance.endsWith("word39"), glance);
  assert.equal(GLIMPSE_MS, 12_000);
});
