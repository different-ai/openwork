import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDesktopVaultKeyProvider } from "./secure-vault-key.mjs";

/**
 * @param {Partial<import("electron").SafeStorage>} overrides
 * @param {string} marker fake OS keychain secret; payloads sealed with a different marker fail to decrypt
 * @returns {import("electron").SafeStorage}
 */
function fakeSafeStorage(overrides = {}, marker = "sealed") {
  return /** @type {import("electron").SafeStorage} */ ({
    decryptString: () => { throw new Error("sync safe storage is not used"); },
    encryptString: () => { throw new Error("sync safe storage is not used"); },
    isAsyncEncryptionAvailable: async () => true,
    isEncryptionAvailable: () => true,
    setUsePlainTextEncryption: () => {},
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (plaintext) => Buffer.from(`${marker}:${Buffer.from(plaintext).toString("hex")}`),
    decryptStringAsync: async (encrypted) => {
      const payload = encrypted.toString();
      if (!payload.startsWith(`${marker}:`)) {
        throw new Error("safe storage cannot decrypt this payload");
      }
      return {
        result: Buffer.from(payload.slice(`${marker}:`.length), "hex").toString(),
        shouldReEncrypt: false,
      };
    },
    ...overrides,
  });
}

/**
 * @param {string} filePath
 */
async function backupSiblings(filePath) {
  const prefix = `${path.basename(filePath)}.openwork-backup-`;
  return (await readdir(path.dirname(filePath))).filter((name) => name.startsWith(prefix));
}

describe("desktop managed MCP vault key", () => {
  it("persists only an OS-protected blob and restores the same key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwork-vault-key-"));
    const filePath = path.join(root, "vault-key.bin");
    try {
      const safeStorage = fakeSafeStorage();
      const firstProvider = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => safeStorage });
      const first = await firstProvider();
      assert.equal(first.byteLength, 32);
      assert.deepEqual(await firstProvider(), first);

      const protectedBlob = await readFile(filePath);
      assert.equal(protectedBlob.includes(first.toString("base64")), false);
      if (process.platform !== "win32") {
        assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      }

      const restartedProvider = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => safeStorage });
      assert.deepEqual(await restartedProvider(), first);
      assert.deepEqual(await backupSiblings(filePath), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines a blob the OS keychain can no longer decrypt and mints a fresh key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwork-vault-key-"));
    const filePath = path.join(root, "vault-key.bin");
    try {
      const oldKey = await createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => fakeSafeStorage() })();
      const originalBlob = await readFile(filePath);

      const rotatedStorage = fakeSafeStorage({}, "resealed");
      const providerB = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => rotatedStorage });
      const newKey = await providerB();
      assert.equal(newKey.byteLength, 32);
      assert.notDeepEqual(newKey, oldKey);

      const backups = await backupSiblings(filePath);
      assert.equal(backups.length, 1);
      assert.deepEqual(await readFile(path.join(root, backups[0])), originalBlob);

      const providerC = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => rotatedStorage });
      assert.deepEqual(await providerC(), newKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Electron's insecure Linux basic-text backend", async () => {
    const filePath = path.join(os.tmpdir(), "unused-openwork-vault-key.bin");
    const provider = createDesktopVaultKeyProvider({
      filePath,
      loadSafeStorage: () => fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
      platform: "linux",
    });
    await assert.rejects(provider(), /secure Linux password store/);
    assert.deepEqual(await backupSiblings(filePath), []);
  });

  it("fails closed when OS secure storage is unavailable", async () => {
    const filePath = path.join(os.tmpdir(), "unused-openwork-vault-key.bin");
    const provider = createDesktopVaultKeyProvider({
      filePath,
      loadSafeStorage: () => fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }),
    });
    await assert.rejects(provider(), /secure storage is unavailable/);
    assert.deepEqual(await backupSiblings(filePath), []);
  });
});
