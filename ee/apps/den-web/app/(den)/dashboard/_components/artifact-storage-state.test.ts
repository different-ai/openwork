import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactStorageRowState } from "./artifact-storage-state";

const empty = { rowCount: 0, sizeBytes: 0, updatedAt: null, collections: [] };
const saved = { rowCount: 42, sizeBytes: 18000, updatedAt: "2026-01-01T00:00:00.000Z", collections: [{ name: "items" }] };

test("storage keeps the existing artifact row unadorned while loading or before the first save", () => {
  for (const summary of [undefined, null, empty]) assert.deepEqual(artifactStorageRowState(summary, false), { kind: "hidden" });
});

test("storage distinguishes missing data from an unavailable summary and retains known data on a failed refresh", () => {
  assert.deepEqual(artifactStorageRowState(undefined, true), { kind: "unavailable" });
  for (const failed of [true, false]) {
    assert.deepEqual(artifactStorageRowState(saved, failed), { kind: "saved", rowCount: 42, sizeBytes: 18000, collections: ["items"] });
  }
});
