import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeStore } from "../dist/db.js";

test("BridgeStore allowlist and sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owpenbot-"));
  const dbPath = path.join(dir, "owpenbot.db");
  const store = new BridgeStore(dbPath);

  assert.equal(store.isAllowed("telegram", "123"), false);
  store.allowPeer("telegram", "123");
  assert.equal(store.isAllowed("telegram", "123"), true);

  store.upsertSession("telegram", "123", "session-1");
  const row = store.getSession("telegram", "123");
  assert.equal(row?.session_id, "session-1");

  store.close();
});

test("BridgeStore pairing requests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owpenbot-"));
  const dbPath = path.join(dir, "owpenbot.db");
  const store = new BridgeStore(dbPath);

  store.createPairingRequest("whatsapp", "+15551234567", "123456", 1000);
  const list = store.listPairingRequests("whatsapp");
  assert.equal(list.length, 1);
  assert.equal(list[0].code, "123456");

  const approved = store.approvePairingRequest("whatsapp", "123456");
  assert.equal(approved?.peer_id, "+15551234567");

  const empty = store.listPairingRequests("whatsapp");
  assert.equal(empty.length, 0);

  store.close();
});
