import { randomInt } from "node:crypto";

import { BridgeStore } from "./db.js";

const SETTING_KEY = "pairing_code";
const SETTING_CREATED_AT_KEY = "pairing_code_created_at";

// Rotate the pairing code if it is older than this many milliseconds.
// The code is persisted in SQLite and checked on process start. Within a single
// process lifetime it remains stable.
const PAIRING_CODE_TTL_MS = 24 * 60 * 60 * 1000;

export function resolvePairingCode(store: BridgeStore, override?: string): string {
  if (override) {
    const now = Date.now();
    store.setSetting(SETTING_KEY, override);
    store.setSetting(SETTING_CREATED_AT_KEY, String(now));
    return override;
  }

  const now = Date.now();
  const existing = store.getSetting(SETTING_KEY);
  const createdAtRaw = store.getSetting(SETTING_CREATED_AT_KEY);
  const createdAt = createdAtRaw ? Number.parseInt(createdAtRaw, 10) : NaN;
  const isFresh =
    !!existing && Number.isFinite(createdAt) && now - (createdAt as number) < PAIRING_CODE_TTL_MS;

  if (isFresh) return existing as string;

  const code = String(randomInt(100000, 999999));
  store.setSetting(SETTING_KEY, code);
  store.setSetting(SETTING_CREATED_AT_KEY, String(now));
  return code;
}
