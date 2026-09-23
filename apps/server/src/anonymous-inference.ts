import { Worker } from "node:worker_threads";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import {
  DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROOF_HEADER, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_CHAT_PATH, type DesktopFreeAccessStatus, type DesktopFreeSession, DESKTOP_FREE_SESSION_POW_BITS, DESKTOP_FREE_SESSION_POW_MAX_BITS, desktopFreeSessionPowMessage, leadingZeroBits,
} from "@openwork/types/desktop-free-access";
import type { ManagedModelRecommendation } from "@openwork/types/den/inference";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";
import { externalFetch } from "./server-fetch.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import {
  mergeRuntimeProviderUpdate, readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList, writeGlobalRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";

export const ANONYMOUS_INFERENCE_PROVIDER_ID = DESKTOP_FREE_PROVIDER_ID;
export const ANONYMOUS_INFERENCE_MODEL_ID = DESKTOP_FREE_MODEL_ID;
export const ANONYMOUS_INFERENCE_PROVIDER_NAME = "OpenWork Models (Free)";
const LOCAL_ROUTE_PREFIX = "/anonymous-inference/v1";
const REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
const ERROR_BODY_LIMIT = 64 * 1024;
const SESSION_TIMEOUT_MS = 10_000;
const REQUEST_LIFETIME_MS = 5 * 60_000;
const MEMBER_CREDENTIAL_CACHE_MS = 5 * 60_000;
/** Minting a guest session costs a proof of work bound to the request's nonce; 23 bits is a few seconds. */
export function solveSessionPow(machineId: string, nonce: string, bits: number): string {
  for (let counter = 0; ; counter++) {
    const pow = counter.toString(36);
    if (leadingZeroBits(createHash("sha256").update(desktopFreeSessionPowMessage({ machineId, nonce, pow })).digest()) >= bits) return pow;
  }
}
// The same search on a worker thread, so the app stays responsive while it runs at startup.
const POW_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
const { message, bits } = workerData;
for (let counter = 0; ; counter++) {
  const pow = counter.toString(36);
  const digest = createHash("sha256").update(message + pow).digest();
  let zeros = 0;
  for (const byte of digest) { if (byte === 0) { zeros += 8; continue; } zeros += Math.clz32(byte) - 24; break; }
  if (zeros >= bits) { parentPort.postMessage(pow); break; }
}`;
export type PowJob = { nonce: string; bits: number; promise: Promise<string>; cancel: () => void };
// Bun (the test runner) cannot terminate inline workers reliably; the app itself runs on Node inside Electron.
const POW_IN_WORKER = typeof process.versions.bun !== "string";
export function startSessionPow(machineId: string, nonce: string, bits: number, inWorker = POW_IN_WORKER): PowJob {
  const message = desktopFreeSessionPowMessage({ machineId, nonce, pow: "" });
  let worker: Worker | null = null;
  let cancelled = false;
  const solved = new Promise<string>((resolve, reject) => {
    if (!inWorker) { setImmediate(() => { try { resolve(solveSessionPow(machineId, nonce, bits)); } catch (error) { reject(error); } }); return; }
    try {
      worker = new Worker(POW_WORKER_SOURCE, { eval: true, workerData: { message, bits } });
      worker.once("message", (pow: unknown) => { if (typeof pow === "string") resolve(pow); else reject(new Error("Invalid proof of work.")); });
      worker.once("error", reject);
      worker.once("exit", (code: number) => { if (code !== 0) reject(new Error("Proof of work worker exited.")); });
    } catch (error) { reject(error); }
  });
  // A worker failure falls back to solving in process, unless the job was cancelled: then nobody is waiting.
  const promise = solved.catch((error: unknown) => { if (cancelled) throw error; return solveSessionPow(machineId, nonce, bits); });
  const cancel = () => { cancelled = true; promise.catch(() => undefined); void worker?.terminate(); };
  return { nonce, bits, promise, cancel };
}
// Engine calls are relayed only while a task the user started from the app is live.
const ACTIVATION_IDLE_MS = 15 * 60_000;
const ACTIVATION_MAX_MS = 2 * 60 * 60_000;
const TASK_PATH = /\/session\/([^/]+)\/(prompt|prompt_async|message|command|summarize)$/;
const TASK_END_PATH = /\/session\/([^/]+)(?:\/abort)?$/;
const MEMBER_CREDENTIAL_PATH = "/v1/inference/free/credential";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecommendation(value: unknown): value is ManagedModelRecommendation {
  return isRecord(value) && typeof value.modelID === "string" && typeof value.displayName === "string"
    && typeof value.providerName === "string" && typeof value.summary === "string"
    && typeof value.recommended === "boolean" && typeof value.rank === "number" && Number.isFinite(value.rank)
    && Array.isArray(value.capabilities) && value.capabilities.every((capability) => typeof capability === "string");
}

export function resolveAnonymousInferenceOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(environment.OPENWORK_FREE_INFERENCE_ORIGIN?.trim() || "https://inference.openworklabs.com");
  const local = (environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test")
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("OPENWORK_FREE_INFERENCE_ORIGIN must be an HTTPS origin (loopback HTTP is development-only).");
  }
  return url.origin;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function generatedModel(id = ANONYMOUS_INFERENCE_MODEL_ID) {
  return {
    id, name: "GPT-5.6 Luna", attachment: false, reasoning: false, temperature: false, tool_call: true,
    options: { reasoningEffort: "none" },
    limit: { context: 135_168, input: 131_072, output: 4_096 },
    modalities: { input: ["text"], output: ["text"] },
  };
}

export function isOwnedProvider(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "npm", "options", "models"])
    || value.name !== ANONYMOUS_INFERENCE_PROVIDER_NAME || value.npm !== "@ai-sdk/openai-compatible"
    || !isRecord(value.options) || !hasExactKeys(value.options, ["apiKey", "baseURL"])
    || typeof value.options.apiKey !== "string" || !/^owf_local_[A-Za-z0-9_-]{43}$/.test(value.options.apiKey)
    || typeof value.options.baseURL !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/anonymous-inference\/v1$/.test(value.options.baseURL)
    || !isRecord(value.models) || Object.keys(value.models).length !== 1) return false;
  const model = value.models[ANONYMOUS_INFERENCE_MODEL_ID];
  if (!isRecord(model) || !hasExactKeys(model, Object.keys(generatedModel()))) return false;
  return Object.entries(generatedModel()).every(([key, expected]) => JSON.stringify(model[key]) === JSON.stringify(expected));
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { message, type: "openwork_anonymous_error", code } }, { status });
}

function responseHeaders(headers: Headers): Headers {
  const result = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "retry-after", "x-request-id", "x-openwork-request-id", "x-openwork-error-code", "x-openwork-usage-state", "x-openwork-anonymous-no-upstream-retry"]) {
    const value = headers.get(name);
    if (value) result.set(name, value);
  }
  return result;
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) throw new ApiError(413, "anonymous_request_too_large", "The OpenWork Models request is too large.");
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

class RemoteFailure extends Error {
  constructor(readonly status: number, readonly body: Uint8Array<ArrayBuffer>, readonly headers: Headers) {
    super("Desktop free inference gateway rejected the request.");
  }
  response() { return new Response(this.body.slice(), { status: this.status, headers: this.headers }); }
  payload(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(this.body));
      if (isRecord(parsed)) {
        if (isRecord(parsed.error)) return { ...parsed, ...parsed.error, ...(isRecord(parsed.error.details) ? parsed.error.details : {}) };
        return { ...parsed, ...(isRecord(parsed.details) ? parsed.details : {}) };
      }
    } catch {}
    return {};
  }
}

export class AnonymousInferenceService {
  private readonly origin: string;
  private localAccessToken = `owf_local_${randomBytes(32).toString("base64url")}`;
  private relayPrincipal: string | null = null;
  private relayPrincipalPending = false;
  private boundPort: number | null = null;
  private relayConfigUpdate: Promise<void> = Promise.resolve();
  private relayConfigFailed = false;
  private readonly enabled: boolean;
  private available = false;
  private stopped = false;
  private session: DesktopFreeSession | null = null;
  private sessionPromise: Promise<DesktopFreeSession> | null = null;
  private memberSession: CloudProviderDenSession | null = null;
  private memberCredential: { session: CloudProviderDenSession; authorization: string; expiresAt: number } | null = null;
  private memberCredentialPromise: { session: CloudProviderDenSession; promise: Promise<string> } | null = null;
  private readonly allowLocalDen: boolean;
  private identityController = new AbortController();
  private activeControllers = new Set<AbortController>();
  private failures = new Map<string, { expiresAt: number; failure: RemoteFailure }>();
  private cachedStatus: { key: string; expiresAt: number; value: DesktopFreeAccessStatus } | null = null;
  private preferenceQueue: Promise<void> = Promise.resolve();
  private activation: { openedAt: number; lastActivityAt: number; sessions: Set<string> } | null = null;
  private sessionPowBits: number;
  private powJob: PowJob | null = null;

  constructor(private readonly config: ServerConfig, private readonly logger: {
    log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
  }, environment: NodeJS.ProcessEnv = process.env, private readonly now: () => number = Date.now) {
    this.origin = resolveAnonymousInferenceOrigin(environment);
    const powBits = Number(environment.OPENWORK_FREE_SESSION_POW_BITS ?? DESKTOP_FREE_SESSION_POW_BITS);
    this.sessionPowBits = Number.isSafeInteger(powBits) && powBits >= 0 && powBits <= DESKTOP_FREE_SESSION_POW_MAX_BITS ? powBits : DESKTOP_FREE_SESSION_POW_BITS;
    this.allowLocalDen = environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test";
    this.enabled = Boolean(config.anonymousInference?.desktop) && !config.readOnly
      && ![environment.OPENWORK_DISABLE_FREE_INFERENCE, environment.OPENWORK_DISABLE_HOSTED_MODELS, environment.VITE_DISABLE_OPENWORK_MODELS]
        .some((value) => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? ""));
  }

  setMemberSession(session: CloudProviderDenSession | null): Promise<void> {
    const next = session ? { ...session, baseUrl: session.baseUrl.replace(/\/+$/, "") } : null;
    const previous = this.memberSession;
    if (previous?.baseUrl === next?.baseUrl && previous?.orgId === next?.orgId && previous?.token === next?.token) return this.relayConfigUpdate;
    const sameScope = previous && next && previous.baseUrl === next.baseUrl && previous.orgId === next.orgId;
    this.memberSession = next;
    this.memberCredential = null;
    this.memberCredentialPromise = null;
    this.identityController.abort(new Error("Desktop free access identity changed."));
    this.identityController = new AbortController();
    this.session = null;
    this.sessionPromise = null;
    this.cachedStatus = null;
    this.failures.clear();
    this.relayPrincipalPending = Boolean(sameScope && this.relayPrincipal);
    if (!this.relayPrincipalPending) {
      this.relayPrincipal = null;
      this.rotateRelayCredential();
    }
    return this.relayConfigUpdate;
  }

  private rotateRelayCredential(): void {
    // A new engine credential means a new identity: tasks the previous identity started are over.
    this.activation = null;
    this.localAccessToken = `owf_local_${randomBytes(32).toString("base64url")}`;
    this.cachedStatus = null;
    this.failures.clear();
    this.relayConfigUpdate = this.relayConfigUpdate.then(async () => {
      if (this.boundPort !== null && !this.stopped) await this.initialize(this.boundPort);
    }).catch(() => {
      this.relayConfigFailed = true;
      this.logger.log("warn", "Auto identity changed but its engine configuration could not be refreshed.");
    });
  }

  private assertRelayIdentity(token: string): void {
    if (token !== this.localAccessToken || this.relayPrincipalPending) {
      throw new ApiError(409, "auto_identity_changed", "Auto's account changed. Reload the engine and select Auto again before continuing.");
    }
  }

  private async memberAuthorization(): Promise<string | null> {
    const session = this.memberSession;
    if (!session) return null;
    if (this.memberCredential?.session === session && this.memberCredential.expiresAt > Date.now()) return this.memberCredential.authorization;
    if (this.memberCredentialPromise?.session === session) return this.memberCredentialPromise.promise;
    const signal = AbortSignal.any([this.identityController.signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]);
    const exchange = async (): Promise<string> => {
      try {
        const den = new URL(session.baseUrl);
        const local = this.allowLocalDen && ["localhost", "127.0.0.1", "[::1]"].includes(den.hostname);
        if (den.username || den.password || den.search || den.hash
          || (den.protocol !== "https:" && !(local && den.protocol === "http:"))) throw new Error("Invalid Den endpoint.");
        signal.throwIfAborted();
        const response = await externalFetch(`${den.href.replace(/\/+$/, "")}${MEMBER_CREDENTIAL_PATH}`, {
          method: "POST", headers: {
            Accept: "application/json", Authorization: `Bearer ${session.token}`,
            "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId,
          }, signal, redirect: "error", credentials: "omit", cache: "no-store",
        });
        const bytes = await readBoundedBody(response.body, ERROR_BODY_LIMIT, signal);
        if (!response.ok) {
          const status = [401, 403, 429, 503].includes(response.status) ? response.status : 503;
          let code = status === 401 ? "member_free_auth_required" : status === 403 ? "member_free_policy_denied" : "member_free_credentials_unavailable";
          try {
            const error: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (isRecord(error) && typeof error.error === "string"
              && ["free_disabled", "free_accounting_unavailable", "managed_models_disabled_for_dpa", "managed_models_policy_unavailable"].includes(error.error)) code = error.error;
          } catch {}
          throw new ApiError(status, code, "Signed-in Auto access could not be authorized.");
        }
        const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const credential = isRecord(payload) ? payload.credential : null;
        if (!isRecord(credential) || typeof credential.apiKey !== "string" || !/^ow_inf_[A-Za-z0-9_-]{43}$/.test(credential.apiKey)
          || credential.modelID !== DESKTOP_FREE_MODEL_ID
          || credential.baseURL !== `${this.origin}${MEMBER_FREE_MODELS_PATH.slice(0, -"/models".length)}`
          || credential.statusURL !== `${this.origin}${MEMBER_FREE_STATUS_PATH}`) throw new Error("Invalid member Auto credential.");
        await this.assertDispatchAllowed();
        signal.throwIfAborted();
        if (this.memberSession !== session) throw new Error("Desktop free access identity changed.");
        const authorization = `Bearer ${credential.apiKey}`;
        const principal = createHash("sha256").update(authorization).digest("hex");
        if (this.relayPrincipal && this.relayPrincipal !== principal) this.rotateRelayCredential();
        this.relayPrincipal = principal;
        this.relayPrincipalPending = false;
        await this.relayConfigUpdate;
        signal.throwIfAborted();
        if (this.relayConfigFailed || this.memberSession !== session) throw new Error("Auto engine configuration is not current.");
        this.memberCredential = { session, authorization, expiresAt: Date.now() + MEMBER_CREDENTIAL_CACHE_MS };
        return authorization;
      } catch (error) {
        if (error instanceof ApiError && error.code !== "anonymous_request_too_large") throw error;
        throw new ApiError(503, "member_free_credentials_unavailable", "Signed-in Auto credentials are temporarily unavailable.");
      }
    };
    const pending = { session, promise: exchange() };
    this.memberCredentialPromise = pending;
    try { return await pending.promise; }
    finally { if (this.memberCredentialPromise === pending) this.memberCredentialPromise = null; }
  }

  async initialize(boundPort: number): Promise<boolean> {
    this.boundPort = boundPort;
    this.cachedStatus = null;
    if (this.stopped || this.config.readOnly) return false;
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    let permitted = this.enabled && runtime.managedPolicy?.allowCustomProviders !== false;
    let reason = !this.enabled ? "disabled by environment" : !permitted ? "custom providers blocked by policy" : null;
    if (permitted) {
      try {
        const { machineId } = await this.config.anonymousInference!.desktop.identity();
        // Start paying for the first guest session while the app is still loading.
        this.warmSessionPow(machineId);
      } catch (error) { permitted = false; reason = error instanceof Error ? error.message : "identity unavailable"; }
    }
    let changed = false;
    await writeGlobalRuntimeOpencodeConfig(this.config, (snapshot) => {
      const current = snapshot.provider?.[ANONYMOUS_INFERENCE_PROVIDER_ID];
      if (permitted && runtimeDisabledProviderList(snapshot).includes(ANONYMOUS_INFERENCE_PROVIDER_ID)) { permitted = false; reason = "turned off in this workspace"; }
      if (permitted && current !== undefined && !isOwnedProvider(current)) reason = "a user-defined provider already uses its id";
      if (!permitted || (current !== undefined && !isOwnedProvider(current))) {
        this.disable();
        if (!isOwnedProvider(current)) return snapshot;
        changed = true;
        return { ...snapshot, provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: null }) };
      }
      this.available = true;
      const provider = {
        name: ANONYMOUS_INFERENCE_PROVIDER_NAME, npm: "@ai-sdk/openai-compatible",
        options: { apiKey: this.localAccessToken, baseURL: `http://127.0.0.1:${boundPort}${LOCAL_ROUTE_PREFIX}` },
        models: { [ANONYMOUS_INFERENCE_MODEL_ID]: generatedModel() },
      };
      changed = JSON.stringify(current) !== JSON.stringify(provider);
      return changed ? { ...snapshot, provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: provider }) } : snapshot;
    });
    if (reason) this.logger.log("warn", `Auto is not registered: ${reason}`);
    if (changed || this.relayConfigFailed) await writeOpenworkRuntimeConfigFile(this.config);
    this.relayConfigFailed = false;
    return changed;
  }

  async preferences() {
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    const enabled = !runtimeDisabledProviderList(runtime).includes(ANONYMOUS_INFERENCE_PROVIDER_ID);
    const canEnable = this.enabled && !this.stopped && runtime.managedPolicy?.allowCustomProviders !== false;
    return { enabled, available: enabled && canEnable && this.available && !this.relayConfigFailed, canEnable };
  }

  setEnabled(enabled: boolean): Promise<Awaited<ReturnType<AnonymousInferenceService["preferences"]>>> {
    const run = this.preferenceQueue.then(async () => {
      if (this.config.readOnly) throw new ApiError(403, "read_only", "This device is read-only.");
      if (enabled) {
        await managedDesktopPolicy(this.config).assert("model", { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID });
        if (!(await this.preferences()).canEnable) throw new ApiError(403, "auto_blocked", "Auto is unavailable on this device or blocked by your administrator.");
      } else {
        this.disable();
        this.localAccessToken = `owf_local_${randomBytes(32).toString("base64url")}`;
        this.failures.clear();
      }
      await writeGlobalRuntimeOpencodeConfig(this.config, (runtime) => ({
        ...runtime,
        disabled_providers: [...new Set([...runtimeDisabledProviderList(runtime).filter((id) => id !== ANONYMOUS_INFERENCE_PROVIDER_ID), ...(enabled ? [] : [ANONYMOUS_INFERENCE_PROVIDER_ID])])],
      }));
      await this.initialize(this.boundPort ?? this.config.port);
      await writeOpenworkRuntimeConfigFile(this.config);
      return this.preferences();
    });
    this.preferenceQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private unavailable(code = "anonymous_unavailable"): DesktopFreeAccessStatus {
    return {
      state: "unavailable", code, currentVersion: this.config.anonymousInference?.desktop.currentVersion ?? "",
      minimumVersion: null, providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID, allowance: null,
    };
  }

  private async assertDispatchAllowed(): Promise<void> {
    const signal = this.identityController.signal;
    const token = this.localAccessToken;
    await this.relayConfigUpdate;
    signal.throwIfAborted();
    if (token !== this.localAccessToken) throw new ApiError(409, "auto_identity_changed", "Auto's account changed. Retry after reloading the engine.");
    if (this.relayConfigFailed) throw new ApiError(503, "auto_identity_changed", "Auto's engine configuration is not current. Reload the engine before continuing.");
    if (!this.enabled || !this.available || this.stopped) throw new Error("Desktop free inference is unavailable.");
    await managedDesktopPolicy(this.config).assert("model", { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID });
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    const provider = runtime.provider?.[ANONYMOUS_INFERENCE_PROVIDER_ID];
    signal.throwIfAborted();
    if (token !== this.localAccessToken) throw new ApiError(409, "auto_identity_changed", "Auto's account changed. Retry after reloading the engine.");
    if (runtime.managedPolicy?.allowCustomProviders === false || runtimeDisabledProviderList(runtime).includes(ANONYMOUS_INFERENCE_PROVIDER_ID)
      || !isOwnedProvider(provider) || !isRecord(provider) || !isRecord(provider.options) || provider.options.apiKey !== this.localAccessToken) {
      this.disable();
      throw new ApiError(403, "organization_policy_denied", "Desktop free inference is disabled by local policy or configuration.");
    }
    await this.config.anonymousInference!.desktop.identity();
  }

  async status(force = false): Promise<DesktopFreeAccessStatus> {
    const signal = this.identityController.signal;
    try {
      await this.relayConfigUpdate;
      signal.throwIfAborted();
      if (force && this.relayConfigFailed && this.boundPort !== null) await this.initialize(this.boundPort);
      await this.assertDispatchAllowed();
      signal.throwIfAborted();
      const authorization = await this.memberAuthorization();
      const key = createHash("sha256").update(authorization ?? "guest").digest("hex");
      signal.throwIfAborted();
      if (!force && this.cachedStatus?.key === key && this.cachedStatus.expiresAt > Date.now()) return this.cachedStatus.value;
      if (force) this.failures.clear();
      const response = await this.remote(DESKTOP_FREE_STATUS_PATH, "GET", new Uint8Array(), true, AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]));
      const payload: unknown = JSON.parse(new TextDecoder().decode(await readBoundedBody(response.body, ERROR_BODY_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]))));
      if (!isRecord(payload)) throw new Error("Invalid desktop free status.");
      const allowance = payload.allowance;
      let validatedAllowance: DesktopFreeAccessStatus["allowance"] = null;
      if (isRecord(allowance) && typeof allowance.limitUsd === "number" && typeof allowance.usedUsd === "number"
        && typeof allowance.reservedUsd === "number" && typeof allowance.remainingUsd === "number" && typeof allowance.resetsAt === "string"
        && Number.isFinite(Date.parse(allowance.resetsAt))
        && [allowance.limitUsd, allowance.usedUsd, allowance.reservedUsd, allowance.remainingUsd].every((value) => Number.isFinite(value) && value >= 0)) {
        validatedAllowance = { limitUsd: allowance.limitUsd, usedUsd: allowance.usedUsd, reservedUsd: allowance.reservedUsd, remainingUsd: allowance.remainingUsd, resetsAt: allowance.resetsAt };
      }
      const state = payload.state;
      if (state !== "ready" && state !== "update_required" && state !== "unavailable" && state !== "exhausted") throw new Error("Invalid desktop free status state.");
      // Guests are version-gated by the Gateway; members use their Models key on /api/v1, which is not.
      if (state === "ready" && (!validatedAllowance || (!authorization && typeof payload.minimumVersion !== "string"))) throw new Error("Incomplete desktop free status.");
      const value: DesktopFreeAccessStatus = {
        ...this.unavailable(), state, code: typeof payload.code === "string" ? payload.code : null,
        minimumVersion: typeof payload.minimumVersion === "string" ? payload.minimumVersion : null,
        allowance: validatedAllowance,
        ...(Array.isArray(payload.catalog) ? { catalog: payload.catalog.filter(isRecommendation) } : {}),
        // Den's organization Auto pin policy travels with status so an admin unpin reaches native pickers.
        ...(typeof payload.defaultPinned === "boolean" ? { defaultPinned: payload.defaultPinned } : {}),
      };
      signal.throwIfAborted();
      if (authorization && this.memberCredential?.authorization !== authorization) throw new Error("Member Auto credential changed.");
      this.cachedStatus = { key, expiresAt: Date.now() + 10_000, value };
      return value;
    } catch (error) {
      if (error instanceof RemoteFailure) {
        const payload = error.payload();
        const code = typeof payload.code === "string" ? payload.code : "anonymous_unavailable";
        return { ...this.unavailable(code),
          state: code === "desktop_update_required" ? "update_required"
            : ["anonymous_limit_exceeded", "anonymous_reservation_does_not_fit", "free_allowance_exhausted"].includes(code) ? "exhausted" : "unavailable",
          minimumVersion: typeof payload.minimumVersion === "string" ? payload.minimumVersion : null,
        };
      }
      return this.unavailable(error instanceof ApiError ? error.code : undefined);
    }
  }

  /**
   * Runs on every task request the app sends through the OpenWork server. A
   * send with Auto selected opens (or extends) the activation window that the
   * engine's relayed model calls need; ending the session closes it.
   */
  async assertTaskAccess(request: Request, path: string): Promise<void> {
    const ended = (request.method === "POST" || request.method === "DELETE") ? TASK_END_PATH.exec(path) : null;
    if (ended && (request.method === "DELETE" || path.endsWith("/abort"))) { this.endSession(decodeURIComponent(ended[1])); return; }
    const task = request.method === "POST" ? TASK_PATH.exec(path) : null;
    if (!task) return;
    const payload: unknown = await request.clone().json().catch(() => null);
    if (!isRecord(payload)) return;
    const model = payload.model;
    const free = isRecord(model) ? model.providerID === DESKTOP_FREE_PROVIDER_ID
      : typeof model === "string" && model.startsWith(`${DESKTOP_FREE_PROVIDER_ID}/`);
    if (!free) return;
    const status = await this.status(true);
    if (status.state !== "ready") throw new ApiError(status.state === "update_required" ? 426 : status.state === "exhausted" ? 429 : 503,
      status.code ?? "anonymous_unavailable", "Auto is not available. Check desktop free access status.", status);
    this.activate(decodeURIComponent(task[1]));
  }

  private async remote(path: string, method: string, body: Uint8Array<ArrayBuffer>, authenticated: boolean, requestSignal = AbortSignal.timeout(SESSION_TIMEOUT_MS), retry = true, relayToken?: string, nonce?: string): Promise<Response> {
    const signal = AbortSignal.any([requestSignal, this.identityController.signal]);
    await this.assertDispatchAllowed();
    signal.throwIfAborted();
    if (relayToken) this.assertRelayIdentity(relayToken);
    const member = authenticated ? await this.memberAuthorization() : null;
    if (relayToken) this.assertRelayIdentity(relayToken);
    const session = authenticated && !member ? await this.guestSession() : null;
    await this.assertDispatchAllowed();
    signal.throwIfAborted();
    const authorization = member ?? (session ? `Bearer ${session.token}` : "");
    const actualPath = member ? path === DESKTOP_FREE_STATUS_PATH ? MEMBER_FREE_STATUS_PATH
      : path === DESKTOP_FREE_MODELS_PATH ? MEMBER_FREE_MODELS_PATH : path === DESKTOP_FREE_CHAT_PATH ? MEMBER_FREE_CHAT_PATH : path : path;
    const proof = await this.config.anonymousInference!.desktop.sign({ method, path: actualPath, body, authorization, ...(nonce ? { nonce } : {}) });
    signal.throwIfAborted();
    if (relayToken) this.assertRelayIdentity(relayToken);
    const response = await externalFetch(`${this.origin}${actualPath}`, {
      method, body: method === "GET" ? undefined : body,
      headers: { [DESKTOP_FREE_PROOF_HEADER]: proof, ...(authorization ? { authorization } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      signal, redirect: "error", credentials: "omit", cache: "no-store",
    });
    signal.throwIfAborted();
    if (response.ok) return response;
    const failure = new RemoteFailure(response.status, await readBoundedBody(response.body, ERROR_BODY_LIMIT, signal), responseHeaders(response.headers));
    if (member && [401, 403].includes(failure.status) && this.memberCredential?.authorization === member) {
      this.memberCredential = null;
      this.cachedStatus = null;
    }
    if (authenticated && !member && retry && failure.status === 401 && failure.payload().code === "invalid_anonymous_token") {
      if (this.session?.token === session?.token) this.session = null;
      return this.remote(path, method, body, authenticated, signal, false, relayToken, nonce);
    }
    throw failure;
  }

  /** Has (or starts) a solved proof of work ready for the next guest session; returns the nonce it is bound to. */
  warmSessionPow(machineId: string, bits = this.sessionPowBits): { nonce: string; ready: Promise<void> } {
    if (!this.powJob || this.powJob.bits < bits) {
      this.powJob?.cancel();
      this.powJob = startSessionPow(machineId, randomUUID(), bits);
    }
    const job = this.powJob;
    return { nonce: job.nonce, ready: job.promise.then(() => undefined) };
  }
  private takeSessionPow(machineId: string, bits: number): PowJob {
    const job = this.powJob && this.powJob.bits >= bits ? this.powJob : startSessionPow(machineId, randomUUID(), bits);
    if (this.powJob === job) this.powJob = null;
    return job;
  }

  private async guestSession(): Promise<DesktopFreeSession> {
    if (this.session && this.session.expiresAt - 30_000 > Date.now()) return this.session;
    if (this.sessionPromise) return this.sessionPromise;
    const signal = this.identityController.signal;
    const mint = async (bits = this.sessionPowBits, retry = true): Promise<DesktopFreeSession> => {
      // The signed proof carries the machine identity; the body carries the proof of work for the proof's own nonce.
      const { machineId } = await this.config.anonymousInference!.desktop.identity();
      const job = this.takeSessionPow(machineId, bits);
      const nonce = job.nonce;
      const pow = await job.promise;
      // The next session's work starts now, so it is ready long before this session expires.
      this.warmSessionPow(machineId, bits);
      const body = new TextEncoder().encode(JSON.stringify({ pow }));
      let response: Response;
      try {
        response = await this.remote(DESKTOP_FREE_SESSION_PATH, "POST", body, false, AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]), true, undefined, nonce);
      } catch (error) {
        // The gateway may ask for more work than this build assumed; do it once.
        const asked = error instanceof RemoteFailure && error.status === 400 ? error.payload() : null;
        const required = asked?.code === "session_pow_required" && typeof asked.bits === "number" ? asked.bits : null;
        if (retry && required !== null && Number.isSafeInteger(required) && required > bits && required <= DESKTOP_FREE_SESSION_POW_MAX_BITS) {
          this.sessionPowBits = required;
          return mint(required, false);
        }
        throw error;
      }
      const payload: unknown = JSON.parse(new TextDecoder().decode(await readBoundedBody(response.body, ERROR_BODY_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]))));
      if (!isRecord(payload) || typeof payload.token !== "string" || !payload.token.trim()
        || typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()
        || payload.model !== DESKTOP_FREE_MODEL_ID) throw new Error("Invalid desktop free session response.");
      return { token: payload.token, expiresAt: payload.expiresAt, model: payload.model };
    };
    const pending = mint();
    this.sessionPromise = pending;
    try { const session = await pending; signal.throwIfAborted(); this.session = session; return session; }
    finally { if (this.sessionPromise === pending) this.sessionPromise = null; }
  }

  async handle(request: Request, endpoint: "models" | "chat/completions"): Promise<Response> {
    const supplied = Buffer.from(request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "");
    const relayToken = this.localAccessToken;
    const expected = Buffer.from(relayToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return jsonError(401, "invalid_local_anonymous_token", "This Auto credential is no longer valid. Reload the engine and select Auto again.");
    if (request.method !== (endpoint === "models" ? "GET" : "POST")) return jsonError(405, "method_not_allowed", "Unsupported OpenWork Models method.");
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const signal = AbortSignal.any([request.signal, controller.signal, this.identityController.signal]);
    const timer = setTimeout(() => controller.abort(new Error("Desktop free inference request timed out.")), REQUEST_LIFETIME_MS);
    let streaming = false;
    const cleanup = () => { clearTimeout(timer); this.activeControllers.delete(controller); };
    let requestKey = "";
    try {
      this.assertRelayIdentity(relayToken);
      await this.assertDispatchAllowed();
      this.assertRelayIdentity(relayToken);
      if (endpoint === "chat/completions") {
        // Only the engine working on a task the user started from the app may spend the allowance.
        const sessionID = request.headers.get("x-openwork-session-id");
        if (!this.activationOpen() || (sessionID && !this.activation?.sessions.has(sessionID))) {
          return jsonError(403, "auto_not_activated", "Auto only runs for tasks started from OpenWork. Send a message with Auto selected to continue.");
        }
      }
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (declaredLength > REQUEST_BODY_LIMIT) return jsonError(413, "anonymous_request_too_large", "The OpenWork Models request is too large.");
      const body = await readBoundedBody(request.body, REQUEST_BODY_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      if (endpoint === "chat/completions") {
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder().decode(body)); }
        catch { return jsonError(400, "invalid_request", "Expected a JSON request body."); }
        if (!isRecord(payload) || payload.model !== DESKTOP_FREE_MODEL_ID || "models" in payload || "route" in payload) {
          return jsonError(400, "anonymous_model_not_allowed", "Auto only supports the configured free model.");
        }
      }
      this.assertRelayIdentity(relayToken);
      const member = await this.memberAuthorization();
      signal.throwIfAborted();
      this.assertRelayIdentity(relayToken);
      requestKey = createHash("sha256").update(member ?? "guest").update(endpoint).update(body).digest("hex");
      const cached = this.failures.get(requestKey);
      if (cached && cached.expiresAt > Date.now()) return cached.failure.response();
      if (endpoint !== "models") {
        const status = await this.status(true);
        signal.throwIfAborted();
        if (status.state !== "ready") return Response.json({ error: { ...status, message: "Auto is not available.", type: "openwork_anonymous_error" } }, {
          status: status.state === "update_required" ? 426 : status.state === "exhausted" ? 429 : 503,
        });
      }
      const headerTimeout = setTimeout(() => controller.abort(new Error("Desktop free inference response headers timed out.")), 30_000);
      let response: Response;
      try { response = await this.remote(endpoint === "models" ? DESKTOP_FREE_MODELS_PATH : DESKTOP_FREE_CHAT_PATH, request.method, body, true, signal, true, relayToken); }
      finally { clearTimeout(headerTimeout); }
      this.cachedStatus = null;
      const completed = () => { if (endpoint === "chat/completions" && response.ok && this.activation) this.activation.lastActivityAt = this.now(); };
      if (!response.body) { completed(); return new Response(null, { status: response.status, headers: responseHeaders(response.headers) }); }
      const reader = response.body.getReader();
      const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); cleanup(); };
      signal.addEventListener("abort", abort, { once: true });
      const finish = () => { signal.removeEventListener("abort", abort); cleanup(); };
      streaming = true;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) { completed(); finish(); output.close(); } else output.enqueue(chunk.value);
          } catch (error) { finish(); output.error(error); }
        },
        async cancel(reason) { controller.abort(reason); finish(); await reader.cancel(reason).catch(() => undefined); },
      }), { status: response.status, headers: responseHeaders(response.headers) });
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof RemoteFailure) {
        if ([401, 403, 429, 503].includes(error.status)) {
          error.headers.set("x-openwork-anonymous-no-upstream-retry", "1");
          if (this.failures.size >= 64) this.failures.clear();
          this.failures.set(requestKey, { expiresAt: Date.now() + 30_000, failure: error });
        }
        return error.response();
      }
      if (error instanceof ApiError) return jsonError(error.status, error.code, error.message);
      this.logger.log("warn", "Desktop free inference failed before a response began.");
      return jsonError(503, "anonymous_unavailable", "Auto is temporarily unavailable. Try again later or use your own provider.");
    } finally { if (!streaming) cleanup(); }
  }

  /** Whether a task started from the app is still live; closes the window lazily when it is not. */
  private activationOpen(): boolean {
    if (!this.activation) return false;
    const now = this.now();
    if (now - this.activation.lastActivityAt >= ACTIVATION_IDLE_MS || now - this.activation.openedAt >= ACTIVATION_MAX_MS) {
      this.activation = null;
      return false;
    }
    return true;
  }
  private activate(sessionID: string): void {
    const now = this.now();
    if (!this.activationOpen()) this.activation = { openedAt: now, lastActivityAt: now, sessions: new Set() };
    this.activation!.sessions.add(sessionID);
    this.activation!.lastActivityAt = now;
  }
  private endSession(sessionID: string): void {
    if (!this.activation) return;
    this.activation.sessions.delete(sessionID);
    if (this.activation.sessions.size === 0) this.activation = null;
  }

  private disable(): void {
    this.available = false;
    this.activation = null;
    this.memberCredential = null;
    this.memberCredentialPromise = null;
    this.sessionPromise = null;
    this.session = null;
    this.cachedStatus = null;
    this.identityController.abort(new Error("Desktop free inference disabled."));
    this.identityController = new AbortController();
    for (const controller of this.activeControllers) controller.abort(new Error("Desktop free inference disabled."));
    this.activeControllers.clear();
  }

  stop(): void { this.stopped = true; this.disable(); this.failures.clear(); this.powJob?.cancel(); this.powJob = null; }
}
