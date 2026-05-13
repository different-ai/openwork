// OpenEral credential storage. Three secrets live here:
//   - databaseUrl       PostgreSQL connection string for the `_openeral` schema
//   - anthropicApiKey   Required for OpenClaw; Claude Code can use providers
//   - stringcostApiKey  Optional cost-tracking API key
//
// All values are encrypted at rest via Electron's safeStorage API (Keychain
// on macOS, DPAPI on Windows, libsecret/kwallet on Linux). The renderer
// never sees the plaintext — only "set"/"unset" status flags. The
// openeral.mjs module in Phase O3 reads decrypted values directly from
// the main process when staging the credential bundle for a sandbox.

import { safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CREDENTIALS_FILE = path.join(os.homedir(), ".openwork", "openeral-credentials.json");

/** @typedef {"databaseUrl" | "anthropicApiKey" | "stringcostApiKey"} CredentialKey */

const CREDENTIAL_KEYS = /** @type {const} */ ([
  "databaseUrl",
  "anthropicApiKey",
  "stringcostApiKey",
]);

function isKnownKey(key) {
  return CREDENTIAL_KEYS.includes(key);
}

async function loadBlob() {
  try {
    const text = await readFile(CREDENTIALS_FILE, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveBlob(blob) {
  await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  // Mode 0o600 caps the impact of safeStorage's fallback "basic" backend on
  // Linux systems without a keyring — even if the encryption is weak, only
  // this user can read the file.
  await writeFile(CREDENTIALS_FILE, JSON.stringify(blob, null, 2), { mode: 0o600 });
}

/**
 * Encrypt and persist a credential. Throws if safeStorage's backend isn't
 * available (some headless Linux environments). UI surfaces the error so
 * the user knows secrets won't be stored.
 */
export async function setCredential(key, value) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown OpenEral credential key: ${key}`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Encryption is not available on this system (no keyring detected). " +
        "Cannot store OpenEral credentials securely. " +
        "Install gnome-keyring or kwallet on Linux, or run from a logged-in desktop session.",
    );
  }
  const plaintext = String(value ?? "");
  if (!plaintext.trim()) {
    throw new Error("Credential value is empty.");
  }
  const encrypted = safeStorage.encryptString(plaintext);
  const blob = await loadBlob();
  blob[key] = encrypted.toString("base64");
  await saveBlob(blob);
}

export async function clearCredential(key) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown OpenEral credential key: ${key}`);
  }
  const blob = await loadBlob();
  if (key in blob) {
    delete blob[key];
    await saveBlob(blob);
  }
}

/**
 * Internal helper for the openeral.mjs module (Phase O3). NEVER exposed
 * via IPC — the renderer reaches credentials only by name, never by
 * value. Returns null on missing or decrypt failure.
 */
export async function getCredential(key) {
  if (!isKnownKey(key)) {
    throw new Error(`Unknown OpenEral credential key: ${key}`);
  }
  const blob = await loadBlob();
  if (!blob[key]) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob[key], "base64"));
  } catch {
    // safeStorage backend keys change when the user switches keyrings or
    // when /run/keyring is rotated. A decrypt failure is recoverable —
    // the user re-enters the credential.
    return null;
  }
}

/**
 * Renderer-safe view of the credential state. Returns the literal string
 * "set" or "unset" per key — never the value. The renderer renders
 * status pills + Configure/Clear buttons from this shape alone.
 */
export async function getCredentialStatus() {
  const blob = await loadBlob();
  const status = {};
  for (const key of CREDENTIAL_KEYS) {
    status[key] = blob[key] ? "set" : "unset";
  }
  status.encryptionAvailable = safeStorage.isEncryptionAvailable();
  return status;
}
