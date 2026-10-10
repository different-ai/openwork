import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_RESPONSES_PATH, DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_OPEN_API_KEY, DESKTOP_FREE_PROVIDER_ID,
  DESKTOP_FREE_STATUS_PATH, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_RESPONSES_PATH, MEMBER_FREE_CREDENTIAL_PATH, MEMBER_FREE_MODELS_PATH,
  MEMBER_FREE_STATUS_PATH, type DesktopFreeAccessStatus,
} from "@openwork/free-auto";
import type { CloudProviderDenSession } from "../cloud-provider-sync.js";
import type { DesktopFreeHost, ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { externalFetch } from "../server-fetch.js";
import { managedDesktopPolicy } from "../managed-desktop-policy.js";
import { writeOpenworkRuntimeConfigFile } from "../openwork-runtime-config.js";
import {
  mergeRuntimeProviderUpdate, readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList, writeGlobalRuntimeOpencodeConfig,
} from "../runtime-opencode-config-store.js";
import { TaskActivation, taskRoute } from "./activation.js";
import { RemoteFailure, isRecord, jsonError, readBoundedBody, readJson, responseHeaders } from "./http.js";
import { isOwnedProvider, ownedProvider } from "./provider-config.js";
import { memberCredentialFailure, parseMemberCredential, parseStatus, statusFromRejection } from "./responses.js";
import {
  ANONYMOUS_INFERENCE_PROVIDER_ID, ERROR_BODY_LIMIT, FAILURE_CACHE_LIMIT, FAILURE_CACHE_MS, HEADER_TIMEOUT_MS, MEMBER_CREDENTIAL_CACHE_MS,
  REQUEST_BODY_LIMIT, REQUEST_BODY_TIMEOUT_MS, REQUEST_LIFETIME_MS, SESSION_TIMEOUT_MS, STATUS_CACHE_MS, readRelaySettings, type RelaySettings,
} from "./settings.js";

export type AutoPreferences = { enabled: boolean; available: boolean; canEnable: boolean };
type Logger = { log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void };
const IDENTITY_CHANGED = "Auto's account changed. Retry after reloading the engine.";
const freshLocalToken = () => `owf_local_${randomBytes(32).toString("base64url")}`;
const memberPath = (path: string) => path === DESKTOP_FREE_STATUS_PATH ? MEMBER_FREE_STATUS_PATH
  : path === DESKTOP_FREE_MODELS_PATH ? MEMBER_FREE_MODELS_PATH : path === DESKTOP_FREE_CHAT_PATH ? MEMBER_FREE_CHAT_PATH : path === DESKTOP_FREE_RESPONSES_PATH ? MEMBER_FREE_RESPONSES_PATH : path;
const statusHttpCode = (state: DesktopFreeAccessStatus["state"]) => state === "update_required" ? 426 : state === "exhausted" ? 429 : 503;

/**
 * The local end of free Auto. The engine talks to it on loopback with a
 * per-identity `owf_local_` token; it forwards to the Gateway as a signed-in
 * member (Den-issued `ow_inf_` key) or, signed out, as an open client with
 * OpenCode Zen's "public" key, which the Gateway limits by IP. It forwards
 * only while a task the user started from the app is live.
 */
export class AnonymousInferenceService {
  private readonly settings: RelaySettings;
  private readonly enabled: boolean;
  private readonly host: DesktopFreeHost | null;
  private localAccessToken = freshLocalToken();
  // The member credential the engine's relay token is bound to. Held only in memory, like the credential itself,
  // and compared directly: it is an identity, not something to derive a digest from.
  private relayPrincipal: string | null = null;
  private relayPrincipalPending = false;
  private boundPort: number | null = null;
  private relayConfigUpdate: Promise<void> = Promise.resolve();
  private relayConfigFailed = false;
  private available = false;
  private stopped = false;
  private memberSession: CloudProviderDenSession | null = null;
  private memberCredential: { session: CloudProviderDenSession; authorization: string; expiresAt: number } | null = null;
  private memberCredentialPromise: { session: CloudProviderDenSession; promise: Promise<string> } | null = null;
  private identityController = new AbortController();
  private activeControllers = new Set<AbortController>();
  private failures = new Map<string, { expiresAt: number; failure: RemoteFailure }>();
  private cachedStatus: { key: string; expiresAt: number; value: DesktopFreeAccessStatus } | null = null;
  private readonly activation: TaskActivation;
  private readonly selectedAutoSessions = new Set<string>();
  private preferenceQueue: Promise<void> = Promise.resolve();
  /** Set by the server: reload the engine's providers after the relay credential it holds was replaced. */
  onEngineConfigChanged: (() => void) | null = null;

  constructor(private readonly config: ServerConfig, private readonly logger: Logger,
    environment: NodeJS.ProcessEnv = process.env, private readonly now: () => number = Date.now) {
    this.settings = readRelaySettings(environment);
    this.activation = new TaskActivation(now);
    // The desktop host says whether this installation may offer Auto; OpenWork web and headless servers always may.
    this.host = config.anonymousInference?.desktop ?? null;
    this.enabled = !config.readOnly && !this.settings.disabledByEnvironment;
  }

  // ── Identity ───────────────────────────────────────────────────────────

  setMemberSession(session: CloudProviderDenSession | null): Promise<void> {
    const next = session ? { ...session, baseUrl: session.baseUrl.replace(/\/+$/, "") } : null;
    const previous = this.memberSession;
    if (previous?.baseUrl === next?.baseUrl && previous?.orgId === next?.orgId && previous?.token === next?.token) return this.relayConfigUpdate;
    const sameScope = previous && next && previous.baseUrl === next.baseUrl && previous.orgId === next.orgId;
    this.memberSession = next;
    this.memberCredential = null;
    this.memberCredentialPromise = null;
    this.resetIdentityController("Desktop free access identity changed.");
    this.cachedStatus = null;
    this.failures.clear();
    this.relayPrincipalPending = Boolean(sameScope && this.relayPrincipal);
    if (!this.relayPrincipalPending) {
      this.relayPrincipal = null;
      this.rotateRelayCredential();
    }
    return this.relayConfigUpdate;
  }

  private resetIdentityController(reason: string): void {
    this.identityController.abort(new Error(reason));
    this.identityController = new AbortController();
  }

  private rotateRelayCredential(): void {
    // A new engine credential means a new identity: tasks the previous identity started are over.
    this.activation.close();
    this.selectedAutoSessions.clear();
    this.localAccessToken = freshLocalToken();
    this.cachedStatus = null;
    this.failures.clear();
    this.relayConfigUpdate = this.relayConfigUpdate.then(async () => {
      // The running engine still holds the old credential until it reloads its providers.
      if (this.boundPort !== null && !this.stopped && await this.initialize(this.boundPort)) this.onEngineConfigChanged?.();
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
    const pending = { session, promise: this.exchangeMemberCredential(session) };
    this.memberCredentialPromise = pending;
    try { return await pending.promise; }
    finally { if (this.memberCredentialPromise === pending) this.memberCredentialPromise = null; }
  }

  /** Trades the Den session for the member's Auto key, then makes it the relay's principal. */
  private async exchangeMemberCredential(session: CloudProviderDenSession): Promise<string> {
    const signal = AbortSignal.any([this.identityController.signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]);
    try {
      const den = new URL(session.baseUrl);
      const local = this.settings.allowLocalDen && ["localhost", "127.0.0.1", "[::1]"].includes(den.hostname);
      if (den.username || den.password || den.search || den.hash
        || (den.protocol !== "https:" && !(local && den.protocol === "http:"))) throw new Error("Invalid Den endpoint.");
      signal.throwIfAborted();
      const response = await externalFetch(`${den.href.replace(/\/+$/, "")}${MEMBER_FREE_CREDENTIAL_PATH}`, {
        method: "POST", headers: {
          Accept: "application/json", Authorization: `Bearer ${session.token}`,
          "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId,
        }, signal, redirect: "error", credentials: "omit", cache: "no-store",
      });
      const bytes = await readBoundedBody(response.body, ERROR_BODY_LIMIT, signal);
      if (!response.ok) {
        const failure = memberCredentialFailure(response.status, bytes);
        throw new ApiError(failure.status, failure.code, "Signed-in Auto access could not be authorized.");
      }
      const apiKey = parseMemberCredential(JSON.parse(new TextDecoder().decode(bytes)), this.settings.origin);
      await this.assertDispatchAllowed();
      signal.throwIfAborted();
      if (this.memberSession !== session) throw new Error("Desktop free access identity changed.");
      const authorization = `Bearer ${apiKey}`;
      if (this.relayPrincipal && this.relayPrincipal !== authorization) this.rotateRelayCredential();
      this.relayPrincipal = authorization;
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
  }

  // ── Engine configuration and dispatch guard ────────────────────────────

  async initialize(boundPort: number): Promise<boolean> {
    this.boundPort = boundPort;
    this.cachedStatus = null;
    if (this.stopped || this.config.readOnly) return false;
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    let permitted = this.enabled && runtime.managedPolicy?.allowCustomProviders !== false;
    let reason = !this.enabled ? "disabled by environment" : !permitted ? "custom providers blocked by policy" : null;
    if (permitted && this.host && !this.host.eligible()) { permitted = false; reason = "not offered for this installation"; }
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
      const provider = ownedProvider(this.localAccessToken, boundPort);
      changed = JSON.stringify(current) !== JSON.stringify(provider);
      return changed ? { ...snapshot, provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: provider }) } : snapshot;
    });
    if (reason) this.logger.log("warn", `Auto is not registered: ${reason}`);
    if (changed || this.relayConfigFailed) await writeOpenworkRuntimeConfigFile(this.config);
    this.relayConfigFailed = false;
    return changed;
  }

  // ── The person's Auto on/off preference ────────────────────────────────

  /** Whether Auto is turned on here, whether it could be, and whether it is registered right now. */
  async preferences(): Promise<AutoPreferences> {
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    const enabled = !runtimeDisabledProviderList(runtime).includes(ANONYMOUS_INFERENCE_PROVIDER_ID);
    const canEnable = this.enabled && !this.stopped && runtime.managedPolicy?.allowCustomProviders !== false;
    return { enabled, available: enabled && canEnable && this.available && !this.relayConfigFailed, canEnable };
  }

  /** Turns Auto on or off for this device; turning it off also retires the engine's relay credential. Calls run one at a time. */
  setEnabled(enabled: boolean): Promise<AutoPreferences> {
    const run = this.preferenceQueue.then(async () => {
      if (this.config.readOnly) throw new ApiError(403, "read_only", "This device is read-only.");
      if (enabled) {
        await managedDesktopPolicy(this.config).assert("model", { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID });
        if (!(await this.preferences()).canEnable) throw new ApiError(403, "auto_blocked", "Auto is unavailable on this device or blocked by your administrator.");
      } else {
        this.disable();
        this.localAccessToken = freshLocalToken();
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
      state: "unavailable", code, currentVersion: this.host?.currentVersion ?? "",
      minimumVersion: null, providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID, allowance: null,
    };
  }

  /** Throws unless the engine config, local policy and identity all still allow a call to leave the machine. */
  private async assertDispatchAllowed(): Promise<void> {
    const signal = this.identityController.signal;
    const token = this.localAccessToken;
    await this.relayConfigUpdate;
    signal.throwIfAborted();
    if (token !== this.localAccessToken) throw new ApiError(409, "auto_identity_changed", IDENTITY_CHANGED);
    if (this.relayConfigFailed) throw new ApiError(503, "auto_identity_changed", "Auto's engine configuration is not current. Reload the engine before continuing.");
    if (!this.enabled || !this.available || this.stopped) throw new Error("Desktop free inference is unavailable.");
    await managedDesktopPolicy(this.config).assert("model", { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID });
    const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
    const provider = runtime.provider?.[ANONYMOUS_INFERENCE_PROVIDER_ID];
    signal.throwIfAborted();
    if (token !== this.localAccessToken) throw new ApiError(409, "auto_identity_changed", IDENTITY_CHANGED);
    if (runtime.managedPolicy?.allowCustomProviders === false || runtimeDisabledProviderList(runtime).includes(ANONYMOUS_INFERENCE_PROVIDER_ID)
      || !isOwnedProvider(provider) || !isRecord(provider) || !isRecord(provider.options) || provider.options.apiKey !== this.localAccessToken) {
      this.disable();
      throw new ApiError(403, "organization_policy_denied", "Desktop free inference is disabled by local policy or configuration.");
    }
    if (this.host && !this.host.eligible()) throw new Error("Desktop free inference is not available for this installation.");
  }

  // ── Status and task activation ─────────────────────────────────────────

  /** A person asked (preflight before a send, or Retry): ask the gateway again. */
  async preflight(): Promise<DesktopFreeAccessStatus> {
    return this.status(true);
  }

  async status(force = false): Promise<DesktopFreeAccessStatus> {
    // A deployment opt-out uses the same quiet UI state as a switched-off gateway.
    if (this.settings.disabledByEnvironment) return this.unavailable("free_disabled");
    const signal = this.identityController.signal;
    try {
      await this.relayConfigUpdate;
      signal.throwIfAborted();
      if (force && this.relayConfigFailed && this.boundPort !== null) await this.initialize(this.boundPort);
      await this.assertDispatchAllowed();
      signal.throwIfAborted();
      const authorization = await this.memberAuthorization();
      const key = authorization ?? "guest";
      signal.throwIfAborted();
      if (!force && this.cachedStatus?.key === key && this.cachedStatus.expiresAt > Date.now()) return this.cachedStatus.value;
      if (force) this.failures.clear();
      const timed = () => AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]);
      const response = await this.remote(DESKTOP_FREE_STATUS_PATH, "GET", new Uint8Array(), timed());
      const value = parseStatus(await readJson(response.body, ERROR_BODY_LIMIT, timed()), this.unavailable());
      signal.throwIfAborted();
      if (authorization && this.memberCredential?.authorization !== authorization) throw new Error("Member Auto credential changed.");
      this.cachedStatus = { key, expiresAt: Date.now() + STATUS_CACHE_MS, value };
      return value;
    } catch (error) {
      if (error instanceof RemoteFailure) return statusFromRejection(error.payload(), this.unavailable());
      return this.unavailable(error instanceof ApiError ? error.code : undefined);
    }
  }

  /**
   * Runs on every task request the app sends through the OpenWork server. A
   * send with Auto selected opens (or extends) the activation window that the
   * engine's relayed model calls need; ending the session closes it.
   */
  async assertTaskAccess(request: Request, path: string): Promise<void> {
    const route = taskRoute(request.method, path);
    if (!route) return;
    if (route.kind === "end") { this.activation.end(route.sessionID); this.selectedAutoSessions.delete(route.sessionID); return; }
    const payload: unknown = await request.clone().json().catch(() => null);
    if (!isRecord(payload)) return;
    const model = payload.model;
    const free = isRecord(model) ? model.providerID === DESKTOP_FREE_PROVIDER_ID
      : typeof model === "string" && model.startsWith(`${DESKTOP_FREE_PROVIDER_ID}/`);
    if (route.kind === "model") {
      // Bound memory even when sessions are abandoned. A fresh picker selection will re-register an evicted session.
      if (this.selectedAutoSessions.size >= 1000) this.selectedAutoSessions.clear();
      if (free) this.selectedAutoSessions.add(route.sessionID); else this.selectedAutoSessions.delete(route.sessionID);
      if (!free) this.activation.end(route.sessionID);
      return;
    }
    if (!free && !(model === undefined && this.selectedAutoSessions.has(route.sessionID))) return;
    const status = await this.status(true);
    if (status.state !== "ready") throw new ApiError(statusHttpCode(status.state),
      status.code ?? "anonymous_unavailable", "Auto is not available. Check desktop free access status.", status);
    this.activation.start(route.sessionID);
  }

  // ── Gateway calls ──────────────────────────────────────────────────────

  private async remote(path: string, method: string, body: Uint8Array<ArrayBuffer>, requestSignal = AbortSignal.timeout(SESSION_TIMEOUT_MS), relayToken?: string): Promise<Response> {
    const signal = AbortSignal.any([requestSignal, this.identityController.signal]);
    await this.assertDispatchAllowed();
    signal.throwIfAborted();
    if (relayToken) this.assertRelayIdentity(relayToken);
    const member = await this.memberAuthorization();
    if (relayToken) this.assertRelayIdentity(relayToken);
    signal.throwIfAborted();
    // Signed out, like OpenCode Zen: no device identity, just the shared "public" key; the gateway limits it by IP.
    const authorization = member ?? `Bearer ${DESKTOP_FREE_OPEN_API_KEY}`;
    const actualPath = member ? memberPath(path) : path;
    const response = await externalFetch(`${this.settings.origin}${actualPath}`, {
      method, body: method === "GET" ? undefined : body,
      headers: { authorization, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      signal, redirect: "error", credentials: "omit", cache: "no-store",
    });
    signal.throwIfAborted();
    if (response.ok) return response;
    const failure = new RemoteFailure(response.status, await readBoundedBody(response.body, ERROR_BODY_LIMIT, signal), responseHeaders(response.headers));
    if (member && [401, 403].includes(failure.status) && this.memberCredential?.authorization === member) {
      this.memberCredential = null;
      this.cachedStatus = null;
    }
    throw failure;
  }

  // ── Engine-facing relay ────────────────────────────────────────────────

  async handle(request: Request, endpoint: "models" | "chat/completions" | "responses"): Promise<Response> {
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
      // Only the engine working on a task the user started from the app may spend the allowance.
      if (endpoint !== "models" && !this.activation.allows(request.headers.get("x-openwork-session-id"))) {
        return jsonError(403, "auto_not_activated", "Auto only runs for tasks started from OpenWork. Send a message with Auto selected to continue.");
      }
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (declaredLength > REQUEST_BODY_LIMIT) return jsonError(413, "anonymous_request_too_large", "The OpenWork Models request is too large.");
      const body = await readBoundedBody(request.body, REQUEST_BODY_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_BODY_TIMEOUT_MS)]));
      if (endpoint !== "models") {
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
      requestKey = `${member ?? "guest"}\n${endpoint}\n${createHash("sha256").update(body).digest("hex")}`;
      const cached = this.failures.get(requestKey);
      if (cached && cached.expiresAt > Date.now()) return cached.failure.response();
      if (endpoint !== "models") {
        const status = await this.status(true);
        signal.throwIfAborted();
        if (status.state !== "ready") return Response.json({ error: { ...status, message: "Auto is not available.", type: "openwork_anonymous_error" } }, {
          status: statusHttpCode(status.state),
        });
      }
      const headerTimeout = setTimeout(() => controller.abort(new Error("Desktop free inference response headers timed out.")), HEADER_TIMEOUT_MS);
      let response: Response;
      try { response = await this.remote(endpoint === "models" ? DESKTOP_FREE_MODELS_PATH : endpoint === "responses" ? DESKTOP_FREE_RESPONSES_PATH : DESKTOP_FREE_CHAT_PATH, request.method, body, signal, relayToken); }
      finally { clearTimeout(headerTimeout); }
      this.cachedStatus = null;
      const completed = () => { if (endpoint !== "models" && response.ok) this.activation.touch(); };
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
          if (this.failures.size >= FAILURE_CACHE_LIMIT) this.failures.clear();
          this.failures.set(requestKey, { expiresAt: Date.now() + FAILURE_CACHE_MS, failure: error });
        }
        return error.response();
      }
      if (error instanceof ApiError) return jsonError(error.status, error.code, error.message);
      this.logger.log("warn", "Desktop free inference failed before a response began.");
      return jsonError(503, "anonymous_unavailable", "Auto is temporarily unavailable. Try again later or use your own provider.");
    } finally { if (!streaming) cleanup(); }
  }

  // ── Shutdown ───────────────────────────────────────────────────────────

  private disable(): void {
    this.available = false;
    this.activation.close();
    this.selectedAutoSessions.clear();
    this.memberCredential = null;
    this.memberCredentialPromise = null;
    this.cachedStatus = null;
    this.resetIdentityController("Desktop free inference disabled.");
    for (const controller of this.activeControllers) controller.abort(new Error("Desktop free inference disabled."));
    this.activeControllers.clear();
  }

  stop(): void { this.stopped = true; this.disable(); this.failures.clear(); }
}

