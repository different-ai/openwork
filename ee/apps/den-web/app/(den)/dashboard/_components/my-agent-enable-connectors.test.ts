import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemberAgentSource } from "@openwork/types/den/workbot-proactive";
import { enableConnectorBatches } from "./my-agent-enable-connectors";

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
  assert.deepEqual(enableConnectorBatches(skipped), []);
  assert.deepEqual(enableConnectorBatches([...skipped, { ...ready, readTools: null }]), [{ sources: [{ source: "one", on: true }] }]);
});

test("a large selection respects the API limit and includes every connector once", () => {
  const rows = Array.from({ length: 43 }, (_, i) => ({ ...ready, id: String(i) }));
  const batches = enableConnectorBatches(rows);
  assert.deepEqual(batches.map((batch) => batch.sources.length), [20, 20, 3]);
  assert.deepEqual(batches.flatMap((batch) => batch.sources.map((source) => source.source)), rows.map((row) => row.id));
});
