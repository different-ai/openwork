import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProgress, describeWorkStep, summarizeWork, technicalSections, workStepState } from "./work-receipt.ts";

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
