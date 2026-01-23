import { randomInt } from "node:crypto";

import { BridgeStore } from "./db.js";

const SETTING_KEY = "pairing_code";

export function resolvePairingCode(store: BridgeStore, override?: string): string {
  if (override) {
    store.setSetting(SETTING_KEY, override);
    return override;
  }

  const existing = store.getSetting(SETTING_KEY);
  if (existing) return existing;

  const code = String(randomInt(100000, 999999));
  store.setSetting(SETTING_KEY, code);
  return code;
}
