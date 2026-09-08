import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { createDesktopVaultKeyProvider } from "./secure-vault-key.mjs";
import { createDesktopFreeSigner, desktopFreeBootstrapEligible } from "./desktop-free-signer.mjs";
import { desktopFreeProofMessage, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH } from "@openwork/types/desktop-free-access";

describe("native desktop free signer", () => {
  it("persists one protected identity and signs exact bytes, headers, and main-owned metadata on every request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwork-free-signer-"));
    const filePath = path.join(root, "identity.bin");
    try {
      const options = { filePath, loadSafeStorage: () => fakeSafeStorage(), appVersion: "0.20.0", platform: process.platform, arch: "arm64", isEligible: () => true };
      const first = createDesktopFreeSigner(options);
      const identity = await first.identity();
      assert.equal("privateKey" in identity, false);
      const protectedBlob = await readFile(filePath);
      assert.equal(protectedBlob.includes("privateKey"), false);
      if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      const restarted = createDesktopFreeSigner(options);
      assert.deepEqual(await restarted.identity(), identity);
      const key = createPublicKey({ key: Buffer.from(identity.publicKey, "base64"), type: "spki", format: "der" });
      const nonces = new Set();
      for (const requestPath of [DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH]) {
        const method = [DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_CHAT_PATH].includes(requestPath) ? "POST" : "GET";
        const body = Buffer.from(method === "POST" ? '{ "model": "openai/gpt-5.6-luna" }' : "");
        const authorization = requestPath === DESKTOP_FREE_SESSION_PATH ? "" : "Bearer server-only-fixture";
        const proof = JSON.parse(Buffer.from(await restarted.sign({ method, path: requestPath, body, authorization }), "base64url").toString());
        assert.equal(proof.appVersion, "0.20.0");
        assert.equal(proof.platform, process.platform);
        assert.equal(proof.arch, "arm64");
        assert.equal(nonces.has(proof.nonce), false);
        nonces.add(proof.nonce);
        const fields = { ...proof, method, path: requestPath, bodyHash: createHash("sha256").update(body).digest("hex"), authorizationHash: createHash("sha256").update(authorization).digest("hex") };
        const signature = Buffer.from(proof.signature, "base64url");
        assert.equal(verify(null, Buffer.from(desktopFreeProofMessage(fields)), key, signature), true);
        assert.equal(verify(null, Buffer.from(desktopFreeProofMessage({ ...fields, appVersion: "99.0.0" })), key, signature), false);
        assert.equal(verify(null, Buffer.from(desktopFreeProofMessage({ ...fields, authorizationHash: createHash("sha256").update("different-header").digest("hex") })), key, signature), false);
      }
      await assert.rejects(first.sign({ method: "POST", path: "/other", body: new Uint8Array(), authorization: "" }), /Unsupported/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed without encryption and never replaces corrupt identity bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwork-free-signer-"));
    const filePath = path.join(root, "identity.bin");
    try {
      const options = { filePath, appVersion: "0.20.0", platform: process.platform, arch: "arm64", isEligible: () => true };
      await assert.rejects(createDesktopFreeSigner({ ...options, loadSafeStorage: () => fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }) }).identity(), /secure storage/);
      assert.deepEqual(await readdir(root), []);
      await assert.rejects(createDesktopFreeSigner({ ...options, platform: "linux", loadSafeStorage: () => fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }) }).identity(), /secure storage/);
      await writeFile(filePath, "broken-encrypted-record");
      await assert.rejects(createDesktopFreeSigner({ ...options, loadSafeStorage: () => fakeSafeStorage() }).identity());
      assert.equal(await readFile(filePath, "utf8"), "broken-encrypted-record");
      assert.deepEqual(await readdir(root), ["identity.bin"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires public hosted desktop without explicit sign-in or activation policies", () => {
    const publicDesktop = { flavor: "public" };
    const hosted = { baseUrl: "https://app.openworklabs.com", requireSignin: false };
    assert.equal(desktopFreeBootstrapEligible(publicDesktop, hosted), true);
    for (const bootstrap of [{ ...hosted, requireSignin: true }, { ...hosted, requireActivation: true }, { ...hosted, baseUrl: "https://selfhosted.test" }, { ...hosted, apiBaseUrl: "https://selfhosted.test" }]) {
      assert.equal(desktopFreeBootstrapEligible(publicDesktop, bootstrap), false);
    }
    assert.equal(desktopFreeBootstrapEligible({ flavor: "enterprise" }, hosted), false);
    // Legacy cohort policy is no longer authority, even for the old required cohort.
    assert.equal(desktopFreeBootstrapEligible(publicDesktop, { ...hosted, installationRequiresSignin: true }), true);
  });
});

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
