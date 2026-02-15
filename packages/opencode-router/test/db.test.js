import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeStore } from "../dist/db.js";

test("BridgeStore allowlist and sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const store = new BridgeStore(dbPath);

  assert.equal(store.isAllowed("telegram", "123"), false);
  store.allowPeer("telegram", "123");
  assert.equal(store.isAllowed("telegram", "123"), true);

  store.upsertSession("telegram", "default", "123", "session-1");
  const row = store.getSession("telegram", "default", "123");
  assert.equal(row?.session_id, "session-1");

  store.upsertBinding("slack", "app-1", "D123", "/tmp/ws");
  const binding = store.getBinding("slack", "app-1", "D123");
  assert.equal(binding?.directory, "/tmp/ws");

  store.close();
});
