import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH,
  DESKTOP_FREE_CHAT_PATH, desktopFreeProofMessage,
} from "@openwork/types/desktop-free-access";

export function desktopFreeBootstrapEligible(distribution, bootstrap) {
  if (distribution.flavor !== "public" || bootstrap.requireSignin === true || bootstrap.requireActivation === true) return false;
  try {
    const hosted = (value) => {
      const url = new URL(value);
      return !url.username && !url.password && ["https://app.openworklabs.com", "https://api.openworklabs.com"].includes(url.origin);
    };
    return hosted(bootstrap.baseUrl) && (!bootstrap.apiBaseUrl || hosted(bootstrap.apiBaseUrl));
  } catch { return false; }
}

/**
 * Proof of installation-key possession, NOT binary attestation. A modified
 * open-source binary can lie about metadata or mint a new installation. The
 * gateway owns version enforcement, replay prevention, and quota accounting.
 * No IPC exposes this signer; metadata is captured once from Electron main.
 * @param {{ filePath: string; loadSafeStorage: () => import("electron").SafeStorage;
 * appVersion: string; platform: NodeJS.Platform; arch: string; isEligible: () => boolean }} options
 * @returns {import("../../server/src/types.js").DesktopFreeSigner}
 */
export function createDesktopFreeSigner({ filePath, loadSafeStorage, appVersion, platform, arch, isEligible }) {
  let pending = null;
  const permitted = () => {
    if (!isEligible() || !["darwin", "win32", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) {
      throw new Error("Desktop free inference is not available for this installation.");
    }
    return {
      platform: /** @type {"darwin" | "win32" | "linux"} */ (platform),
      arch: /** @type {"arm64" | "x64"} */ (arch),
    };
  };
  async function loadIdentity() {
    const storage = loadSafeStorage();
    if (!storage || !(await storage.isAsyncEncryptionAvailable()) || (platform === "linux" && storage.getSelectedStorageBackend() === "basic_text")) {
      throw new Error("Desktop free inference requires operating-system secure storage.");
    }
    let encrypted;
    try { encrypted = await readFile(filePath); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!encrypted) {
      const { privateKey } = generateKeyPairSync("ed25519");
      encrypted = await storage.encryptStringAsync(JSON.stringify({
        version: 1, installationId: randomUUID(),
        privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      }));
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        // Publish complete bytes exclusively; concurrent starts must use the
        // winner's identity, never replace it or silently reset its allowance.
        try { await link(temporary, filePath); }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
      } finally { await rm(temporary, { force: true }); }
      encrypted = await readFile(filePath);
    }
    await chmod(filePath, 0o600);
    const { result } = await storage.decryptStringAsync(encrypted);
    const record = JSON.parse(result);
    if (record.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.installationId) || typeof record.privateKey !== "string") {
      throw new Error("Invalid protected desktop free identity.");
    }
    const privateKey = createPrivateKey({ key: Buffer.from(record.privateKey, "base64"), type: "pkcs8", format: "der" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid desktop free signing key.");
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
    return { privateKey, publicKey, installationId: record.installationId };
  }
  async function identity() {
    permitted();
    pending ??= loadIdentity();
    // Corrupt/unreadable records fail closed and stay intact. No auto reenrollment.
    return await pending;
  }
  return Object.freeze({
    currentVersion: appVersion,
    async identity() {
      const { publicKey, installationId } = await identity();
      return { publicKey, installationId, appVersion, ...permitted() };
    },
    async sign({ method, path: requestPath, body, authorization }) {
      const allowed = method === "POST"
        ? [DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_CHAT_PATH]
        : method === "GET" ? [DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH] : [];
      if (!allowed.includes(requestPath)) throw new Error("Unsupported desktop free proof request.");
      const { privateKey, publicKey } = await identity();
      /** @type {import("@openwork/types/desktop-free-access").DesktopFreeProofClaims} */
      const claims = { version: 1, publicKey, appVersion, ...permitted(), timestamp: Date.now(), nonce: randomUUID() };
      const message = desktopFreeProofMessage({
        ...claims, method, path: requestPath,
        bodyHash: createHash("sha256").update(body).digest("hex"),
        authorizationHash: createHash("sha256").update(authorization).digest("hex"),
      });
      return Buffer.from(JSON.stringify({ ...claims, signature: sign(null, Buffer.from(message), privateKey).toString("base64url") })).toString("base64url");
    },
  });
}
