import assert from "node:assert/strict";
import { test } from "node:test";
import { rebaseAgentPermissionDraft } from "./agent-permission-draft";
import { rebaseTeamPermissionDraft, teamPermissionDraft } from "./team-permission-state";

test("an Agents draft keeps new Browser settings instead of replaying an old full snapshot", () => {
  const merged = rebaseAgentPermissionDraft({ commands: { decision: "ask" } }, { commands: { decision: "deny" } }, { commands: { decision: "ask" }, websites: { decision: "deny" } });
  assert.deepEqual(merged, { commands: { decision: "deny" }, websites: { decision: "deny" } });
});

test("an explicit removal of a team override survives rebase without deleting unrelated settings", () => {
  const merged = rebaseAgentPermissionDraft({ commands: { decision: "deny" } }, {}, { commands: { decision: "deny" }, websites: { allow: ["example.test"] } });
  assert.deepEqual(merged, { websites: { allow: ["example.test"] } });
});

test("legacy permission drafts rebase edited capabilities and execution fields only", () => {
  const before = teamPermissionDraft();
  const draft = { ...before, access: { ...before.access, capabilities: { ...before.access.capabilities, allowManageExtensions: !before.access.capabilities.allowManageExtensions } } };
  const latest = { ...before, execution: { ...before.execution, blockBrowserUploads: !before.execution.blockBrowserUploads, browserOrigins: ["https://example.test"] } };
  const merged = rebaseTeamPermissionDraft(before, draft, latest);
  assert.equal(merged.access.capabilities.allowManageExtensions, draft.access.capabilities.allowManageExtensions);
  assert.equal(merged.execution.blockBrowserUploads, latest.execution.blockBrowserUploads);
  assert.deepEqual(merged.execution.browserOrigins, latest.execution.browserOrigins);
});
