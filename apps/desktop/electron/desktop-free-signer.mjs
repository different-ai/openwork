import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDesktopMachineId } from "./desktop-machine-id.mjs";
import {
  DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH,
  DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_CHAT_PATH, DESKTOP_FREE_MACHINE_ID_PATTERN,
  desktopFreeProofMessage, desktopFreeReleaseTagMessage,
} from "@openwork/types/desktop-free-access";

/**
 * Developer-only: a loopback control plane named explicitly in
 * OPENWORK_DEV_FREE_CONTROL_PLANE counts as hosted while OPENWORK_DEV_MODE=1,
 * so a local Den and Gateway can exercise Auto. Packaged builds never set it.
 */
function devFreeControlPlaneOrigin(environment = process.env) {
  if (environment.OPENWORK_DEV_MODE !== "1") return null;
  try {
    const url = new URL(environment.OPENWORK_DEV_FREE_CONTROL_PLANE?.trim() || "");
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:" ? url.origin : null;
  } catch { return null; }
}

export function desktopFreeBootstrapEligible(distribution, bootstrap, environment = process.env) {
  if (distribution.flavor !== "public" || bootstrap.requireSignin === true || bootstrap.requireActivation === true) return false;
  try {
    const devOrigin = devFreeControlPlaneOrigin(environment);
    const clean = (url) => !url.username && !url.password && !url.search && !url.hash;
    const hosted = (value) => {
      const url = new URL(value);
      return clean(url) && ["https://app.openworklabs.com", "https://api.openworklabs.com", "https://api.app.openworklabs.com"].includes(url.origin);
    };
    // Developer mode: the named loopback control plane, whose API may live on another loopback port.
    const loopback = (value) => {
      const url = new URL(value);
      return clean(url) && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    };
    if (devOrigin && new URL(bootstrap.baseUrl).origin === devOrigin && clean(new URL(bootstrap.baseUrl))) {
      return !bootstrap.apiBaseUrl || loopback(bootstrap.apiBaseUrl);
    }
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
    if (!isEligible() || !["darwin", "win32", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) {
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
    async sign({ method, path: requestPath, body, authorization }) {
      const allowed = method === "POST"
        ? [DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_CHAT_PATH]
        : method === "GET" ? [DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_STATUS_PATH] : [];
      if (!allowed.includes(requestPath)) throw new Error("Unsupported desktop free proof request.");
      const [{ privateKey, publicKey, machineId }, secret] = await Promise.all([identity(), releaseSecret()]);
      const base = { publicKey, machineId, appVersion, ...permitted(), timestamp: Date.now(), nonce: randomUUID() };
      const request = { method, path: requestPath, bodyHash: createHash("sha256").update(body).digest("hex"),
        authorizationHash: createHash("sha256").update(authorization).digest("hex") };
      const releaseTag = secret ? createHmac("sha256", secret).update(desktopFreeReleaseTagMessage({ ...base, ...request })).digest("hex") : null;
      // Literal objects keep `version` narrow for the message helper's discriminated claims type.
      const message = releaseTag !== null
        ? desktopFreeProofMessage({ version: 3, ...base, releaseTag, ...request })
        : desktopFreeProofMessage({ version: 2, ...base, ...request });
      const claims = releaseTag !== null ? { version: 3, ...base, releaseTag } : { version: 2, ...base };
      return Buffer.from(JSON.stringify({ ...claims, signature: sign(null, Buffer.from(message), privateKey).toString("base64url") })).toString("base64url");
    },
  });
}
