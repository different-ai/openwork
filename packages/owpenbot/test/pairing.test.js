import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeStore } from "../dist/db.js";
import { resolvePairingCode } from "../dist/pairing.js";

test("resolvePairingCode persists and reuses codes within TTL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owpenbot-pairing-"));
  const dbPath = path.join(dir, "owpenbot.db");
  const store = new BridgeStore(dbPath);

  const first = resolvePairingCode(store);
  assert.equal(first.length, 6);

  const second = resolvePairingCode(store);
  assert.equal(second, first);

  store.close();
});

test("resolvePairingCode rotates codes when creation timestamp is stale", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owpenbot-pairing-"));
  const dbPath = path.join(dir, "owpenbot.db");
  const store = new BridgeStore(dbPath);

  const initial = resolvePairingCode(store);
  assert.equal(initial.length, 6);

  // Simulate an old creation timestamp to force rotation.
  store.setSetting("pairing_code_created_at", String(Date.now() - 3 * 24 * 60 * 60 * 1000));

  const rotated = resolvePairingCode(store);
  assert.equal(rotated.length, 6);
  assert.notEqual(rotated, initial);

  store.close();
});