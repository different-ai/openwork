import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemberAgentSource } from "@openwork/types/den/workbot-proactive";
import { connectorBatches, connectorPolicyChanges } from "./my-agent-enable-connectors";

const ready: MemberAgentSource = {
  id: "one", kind: "other", name: "One", policy: "members", on: false, instruction: "", lastReadAt: null,
  connections: [{ id: "one", name: "One", url: "https://one.example", state: "connected" }], options: [], chosenBy: null,
};

test("enable all selects connected, optional connectors with potentially readable tools", () => {
  const skipped: MemberAgentSource[] = [
    { ...ready, kind: "calendar" }, { ...ready, on: true }, { ...ready, policy: "off" },
    { ...ready, policy: "everyone" }, { ...ready, readTools: 0 }, { ...ready, connections: [] },
    ...(["needs_connection", "reconnect"] as const).map((state) => ({ ...ready, connections: [{ ...ready.connections[0], state }] })),
  ];
  assert.deepEqual(connectorBatches(skipped, true), []);
  assert.deepEqual(connectorBatches([...skipped, { ...ready, readTools: null }], true), [{ sources: [{ source: "one", on: true }] }]);
});

test("a large selection respects the API limit and includes every connector once", () => {
  const rows = Array.from({ length: 43 }, (_, i) => ({ ...ready, id: String(i) }));
  const batches = connectorBatches(rows, true);
  assert.deepEqual(batches.map((batch) => batch.sources.length), [20, 20, 3]);
  assert.deepEqual(batches.flatMap((batch) => batch.sources.map((source) => source.source)), rows.map((row) => row.id));
});

test("turn all off includes optional active sources even after an account disconnects", () => {
  const rows: MemberAgentSource[] = [
    { ...ready, id: "calendar", kind: "calendar", on: true },
    { ...ready, id: "disconnected", on: true, connections: [], readTools: 0 },
    { ...ready, policy: "everyone", on: true }, { ...ready, policy: "off", on: true }, ready,
  ];
  assert.deepEqual(connectorBatches(rows, false), [{ sources: [
    { source: "calendar", on: false }, { source: "disconnected", on: false },
  ] }]);
});

test("admin bulk changes preserve existing bans and omit unchanged policies", () => {
  const choices = [{ id: "one", policy: "everyone" }, { id: "two", policy: "members" }, { id: "three", policy: "off" }] as const;
  assert.deepEqual(connectorPolicyChanges(choices, "everyone"), { two: "everyone" });
  assert.deepEqual(connectorPolicyChanges(choices, "off"), { one: "off", two: "off" });
});
