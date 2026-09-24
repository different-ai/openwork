import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDesktopMachineId } from "./desktop-machine-id.mjs";
import {
  DESKTOP_FREE_ARCHES, DESKTOP_FREE_MACHINE_ID_PATTERN, DESKTOP_FREE_NONCE_PATTERN, DESKTOP_FREE_PLATFORMS,
  desktopFreeProofMessage, isDesktopFreeSignableRoute,
} from "@openwork/free-auto";
import { releaseTag as desktopFreeReleaseTag, sha256Hex } from "@openwork/free-auto/node";

export function desktopFreeBootstrapEligible(distribution, bootstrap) {
  if (distribution.flavor !== "public" || bootstrap.requireSignin === true || bootstrap.requireActivation === true) return false;
  try {
    const hosted = (value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash
        && ["https://app.openworklabs.com", "https://api.openworklabs.com", "https://api.app.openworklabs.com"].includes(url.origin);
    };
    return hosted(bootstrap.baseUrl) && (!bootstrap.apiBaseUrl || hosted(bootstrap.apiBaseUrl));
  } catch { return false; }
}

/**
 * `releaseSecret` returns this build's free Auto release secret, or null for a
 * build without one (developer or untagged). With a secret, proofs are v3 and
 * carry a release tag the gateway checks against the claimed version.
 */
export function createDesktopFreeSigner({ filePath, loadSafeStorage, appVersion, platform, arch, isEligible, readMachineId = () => readDesktopMachineId(platform), releaseSecret = async () => null }) {
  let pending = null;
  let machine = null;
  const permitted = () => {
    if (!isEligible() || !DESKTOP_FREE_PLATFORMS.includes(platform) || !DESKTOP_FREE_ARCHES.includes(arch)) {
      throw new Error("Desktop free inference is not available for this installation.");
    }
    return { platform, arch };
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
        version: 1, privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      }));
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        try { await link(temporary, filePath); }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
      } finally { await rm(temporary, { force: true }); }
      encrypted = await readFile(filePath);
    }
    await chmod(filePath, 0o600);
    const { result } = await storage.decryptStringAsync(encrypted);
    const record = JSON.parse(result);
    // Records from earlier builds also carry an unused installationId.
    if (record.version !== 1 || typeof record.privateKey !== "string") {
      throw new Error("Invalid protected desktop free identity.");
    }
    const privateKey = createPrivateKey({ key: Buffer.from(record.privateKey, "base64"), type: "pkcs8", format: "der" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid desktop free signing key.");
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
    return { privateKey, publicKey };
  }
  async function identity() {
    permitted();
    pending ??= loadIdentity();
    if (!machine) {
      machine = Promise.resolve().then(readMachineId).then((value) => {
        if (!DESKTOP_FREE_MACHINE_ID_PATTERN.test(value)) throw new Error("Invalid desktop machine identifier.");
        return value;
      });
      // A failed read is retried next time rather than cached.
      machine.catch(() => { machine = null; });
    }
    const [value, machineId] = await Promise.all([pending, machine]);
    permitted();
    return { ...value, machineId };
  }
  return Object.freeze({
    currentVersion: appVersion,
    async identity() {
      const { publicKey, machineId } = await identity();
      return { publicKey, machineId, appVersion, ...permitted() };
    },
    async sign({ method, path: requestPath, body, authorization, nonce = undefined }) {
      if (!isDesktopFreeSignableRoute(method, requestPath)) throw new Error("Unsupported desktop free proof request.");
      const [{ privateKey, publicKey, machineId }, secret] = await Promise.all([identity(), releaseSecret()]);
      if (nonce !== undefined && !DESKTOP_FREE_NONCE_PATTERN.test(nonce)) throw new Error("Invalid desktop free proof nonce.");
      const base = { publicKey, machineId, appVersion, ...permitted(), timestamp: Date.now(), nonce: nonce ?? randomUUID() };
      const request = { method, path: requestPath, bodyHash: sha256Hex(body), authorizationHash: sha256Hex(authorization) };
      const releaseTag = secret ? desktopFreeReleaseTag(secret, { ...base, ...request }) : null;
      // Literal objects keep `version` narrow for the message helper's discriminated claims type.
      const message = releaseTag !== null
        ? desktopFreeProofMessage({ version: 3, ...base, releaseTag, ...request })
        : desktopFreeProofMessage({ version: 2, ...base, ...request });
      const claims = releaseTag !== null ? { version: 3, ...base, releaseTag } : { version: 2, ...base };
      return Buffer.from(JSON.stringify({ ...claims, signature: sign(null, Buffer.from(message), privateKey).toString("base64url") })).toString("base64url");
    },
  });
}
