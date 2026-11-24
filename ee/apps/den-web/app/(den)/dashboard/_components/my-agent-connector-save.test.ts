import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemberAgentSource, MemberAgentView, MemberConnectorSaved } from "@openwork/types/den/workbot-proactive";
import { connectorSwitches, mergeSavedConnectorSwitches } from "./my-agent-connector-save";

const notes: MemberAgentSource = {
  id: "notes", kind: "other", name: "Notes", policy: "members", on: false,
  connections: [], options: [], chosenBy: null, instruction: "Look for action items", lastReadAt: null, readTools: 2,
};
const calendar: MemberAgentSource = { ...notes, id: "calendar", kind: "calendar" };
const view: MemberAgentView = {
  available: true, on: true, snoozedUntil: null, responsibilities: [], destination: null,
  workingHours: { workingDays: "weekdays", startHour: 9, endHour: 17, dailyCap: 3 }, nextCheckAt: null,
  sources: [calendar, notes], todayChecks: [],
};

test("only exact connector switches use the compact save", () => {
  const toggle = { sources: [{ source: "notes", on: true }] };
  assert.deepEqual(connectorSwitches(toggle, view), toggle);
  assert.equal(connectorSwitches(toggle), null);
  assert.equal(connectorSwitches({ sources: [...toggle.sources, { source: "calendar", on: false }] }, view), null);
  assert.equal(connectorSwitches({ sources: [{ ...toggle.sources[0], instruction: "Read notes" }] }, view), null);
  assert.equal(connectorSwitches({ ...toggle, on: true }, view), null);
});

test("confirmed switches preserve source instructions, tool counts, other rows and page data", () => {
  const change: MemberConnectorSaved["changes"][number] = {
    id: "new", at: "2026-01-01T00:00:00.000Z", field: "source", sourceId: notes.id,
    summary: "Use Notes", source: "page", undone: false,
  };
  const saved: MemberConnectorSaved = { sources: [{ id: notes.id, policy: "members", on: true, connections: [] }], changes: [change] };
  const updated = mergeSavedConnectorSwitches({ ...view, changes: [{ ...change, id: "older" }] }, saved);
  assert.deepEqual(updated.sources, [calendar, { ...notes, on: true }]);
  assert.deepEqual(updated.changes?.map((entry) => entry.id), ["new", "older"]);
  assert.equal(updated.todayChecks, view.todayChecks);
  assert.deepEqual(mergeSavedConnectorSwitches(updated, saved), updated);
});
