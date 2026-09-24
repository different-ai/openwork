import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_PROOF_HEADER, DESKTOP_FREE_PROVIDER_ID,
  DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_CREDENTIAL_PATH, MEMBER_FREE_MODELS_PATH,
  MEMBER_FREE_STATUS_PATH, type DesktopFreeAccessStatus, type DesktopFreeSession, type SessionPowParams,
} from "@openwork/free-auto";
import type { CloudProviderDenSession } from "../cloud-provider-sync.js";
import type { ServerConfig } from "../types.js";
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
import { memberCredentialFailure, parseGuestSession, parseMemberCredential, parseStatus, requestedSessionPow, statusFromRejection } from "./responses.js";
import { SessionPowPool } from "./session-pow.js";
import {
  ANONYMOUS_INFERENCE_PROVIDER_ID, ERROR_BODY_LIMIT, FAILURE_CACHE_LIMIT, FAILURE_CACHE_MS, HEADER_TIMEOUT_MS, MEMBER_CREDENTIAL_CACHE_MS,
  REQUEST_BODY_LIMIT, REQUEST_BODY_TIMEOUT_MS, REQUEST_LIFETIME_MS, SESSION_TIMEOUT_MS, STATUS_CACHE_MS, readRelaySettings, type RelaySettings,
} from "./settings.js";

type Logger = { log: (level: "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void };
const IDENTITY_CHANGED = "Auto's account changed. Retry after reloading the engine.";
const freshLocalToken = () => `owf_local_${randomBytes(32).toString("base64url")}`;
const memberPath = (path: string) => path === DESKTOP_FREE_STATUS_PATH ? MEMBER_FREE_STATUS_PATH
  : path === DESKTOP_FREE_MODELS_PATH ? MEMBER_FREE_MODELS_PATH : path === DESKTOP_FREE_CHAT_PATH ? MEMBER_FREE_CHAT_PATH : path;
const statusHttpCode = (state: DesktopFreeAccessStatus["state"]) => state === "update_required" ? 426 : state === "exhausted" ? 429 : 503;

/**
 * The local end of free Auto. The engine talks to it on loopback with a
 * per-identity `owf_local_` token; it forwards to the Gateway as a signed-in
 * member (Den-issued `ow_inf_` key) or as a guest (a session minted with the
 * desktop's signed proof and a proof of work), and only while a task the user
 * started from the app is live.
 */
export class AnonymousInferenceService {
  private readonly settings: RelaySettings;
  private readonly enabled: boolean;
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
  private session: DesktopFreeSession | null = null;
  private sessionPromise: Promise<DesktopFreeSession> | null = null;
  private memberSession: CloudProviderDenSession | null = null;
  private memberCredential: { session: CloudProviderDenSession; authorization: string; expiresAt: number } | null = null;
  private memberCredentialPromise: { session: CloudProviderDenSession; promise: Promise<string> } | null = null;
  private identityController = new AbortController();
  private activeControllers = new Set<AbortController>();
  private failures = new Map<string, { expiresAt: number; failure: RemoteFailure }>();
  private cachedStatus: { key: string; expiresAt: number; value: DesktopFreeAccessStatus } | null = null;
  private readonly activation: TaskActivation;
  private sessionPow: SessionPowParams;
  private readonly powPool = new SessionPowPool();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: ServerConfig, private readonly logger: Logger,
    environment: NodeJS.ProcessEnv = process.env, now: () => number = Date.now) {
    this.settings = readRelaySettings(environment);
    this.sessionPow = this.settings.pow;
    this.activation = new TaskActivation(now);
    this.enabled = Boolean(config.anonymousInference?.desktop) && !config.readOnly && !this.settings.disabledByEnvironment;
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

  private resetIdentityController(reason: string): void {
    this.identityController.abort(new Error(reason));
    this.identityController = new AbortController();
  }

  private rotateRelayCredential(): void {
    // A new engine credential means a new identity: tasks the previous identity started are over.
    this.activation.close();
    this.localAccessToken = freshLocalToken();
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
    if (permitted) {
      try {
        const { machineId } = await this.config.anonymousInference!.desktop.identity();
        // Start paying for the first guest session while the app is still loading.
        this.warmSessionPow(machineId);
      } catch { permitted = false; }
    }
    let changed = false;
    await writeGlobalRuntimeOpencodeConfig(this.config, (snapshot) => {
      const current = snapshot.provider?.[ANONYMOUS_INFERENCE_PROVIDER_ID];
      permitted = permitted && !runtimeDisabledProviderList(snapshot).includes(ANONYMOUS_INFERENCE_PROVIDER_ID);
      if (!permitted || (current !== undefined && !isOwnedProvider(current))) {
        this.disable();
        if (!isOwnedProvider(current)) return snapshot;
        changed = true;
        return { ...snapshot, provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: null }) };
      }
      this.available = true;
      this.startHeartbeat();
      const provider = ownedProvider(this.localAccessToken, boundPort);
      changed = JSON.stringify(current) !== JSON.stringify(provider);
      return changed ? { ...snapshot, provider: mergeRuntimeProviderUpdate(snapshot.provider, { [ANONYMOUS_INFERENCE_PROVIDER_ID]: provider }) } : snapshot;
    });
    if (changed || this.relayConfigFailed) await writeOpenworkRuntimeConfigFile(this.config);
    this.relayConfigFailed = false;
    return changed;
  }

  private unavailable(code = "anonymous_unavailable"): DesktopFreeAccessStatus {
    return {
      state: "unavailable", code, currentVersion: this.config.anonymousInference?.desktop.currentVersion ?? "",
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
    await this.config.anonymousInference!.desktop.identity();
  }

  // ── Status and task activation ─────────────────────────────────────────

  async status(force = false): Promise<DesktopFreeAccessStatus> {
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
      const response = await this.remote(DESKTOP_FREE_STATUS_PATH, "GET", new Uint8Array(), true, timed());
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
    if (route.kind === "end") { this.activation.end(route.sessionID); return; }
    const payload: unknown = await request.clone().json().catch(() => null);
    if (!isRecord(payload)) return;
    const model = payload.model;
    const free = isRecord(model) ? model.providerID === DESKTOP_FREE_PROVIDER_ID
      : typeof model === "string" && model.startsWith(`${DESKTOP_FREE_PROVIDER_ID}/`);
    if (!free) return;
    const status = await this.status(true);
    if (status.state !== "ready") throw new ApiError(statusHttpCode(status.state),
      status.code ?? "anonymous_unavailable", "Auto is not available. Check desktop free access status.", status);
    this.activation.start(route.sessionID);
  }

  // ── Gateway calls ──────────────────────────────────────────────────────

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
    const actualPath = member ? memberPath(path) : path;
    const proof = await this.config.anonymousInference!.desktop.sign({ method, path: actualPath, body, authorization, ...(nonce ? { nonce } : {}) });
    signal.throwIfAborted();
    if (relayToken) this.assertRelayIdentity(relayToken);
    const response = await externalFetch(`${this.settings.origin}${actualPath}`, {
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
  warmSessionPow(machineId: string, bits = this.sessionPow.bits, rounds = this.sessionPow.rounds): { nonce: string; ready: Promise<void> } {
    return this.powPool.warm(machineId, { bits, rounds });
  }

  private startHeartbeat(): void {
    // While the app is open and signed out, a signed status check tells the gateway the app is in use.
    if (this.heartbeat || this.settings.heartbeatMs === 0) return;
    this.heartbeat = setInterval(() => {
      if (this.stopped || !this.available || this.memberSession) return;
      void this.status(true).catch(() => undefined);
    }, this.settings.heartbeatMs);
    this.heartbeat.unref?.();
  }
  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async guestSession(): Promise<DesktopFreeSession> {
    if (this.session && this.session.expiresAt - 30_000 > Date.now()) return this.session;
    if (this.sessionPromise) return this.sessionPromise;
    const signal = this.identityController.signal;
    const pending = this.mintGuestSession(signal, this.sessionPow, true);
    this.sessionPromise = pending;
    try { const session = await pending; signal.throwIfAborted(); this.session = session; return session; }
    finally { if (this.sessionPromise === pending) this.sessionPromise = null; }
  }

  private async mintGuestSession(signal: AbortSignal, params: SessionPowParams, retry: boolean): Promise<DesktopFreeSession> {
    // The signed proof carries the machine identity; the body carries the proof of work for the proof's own nonce.
    const { machineId } = await this.config.anonymousInference!.desktop.identity();
    const job = this.powPool.take(machineId, params);
    const pow = await job.promise;
    // The next session's work starts now, so it is ready long before this session expires.
    this.powPool.warm(machineId, params);
    const body = new TextEncoder().encode(JSON.stringify({ pow }));
    const timed = () => AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await this.remote(DESKTOP_FREE_SESSION_PATH, "POST", body, false, timed(), true, undefined, job.nonce);
    } catch (error) {
      // The gateway may ask for more work than this build assumed; do it once.
      const asked = retry && error instanceof RemoteFailure && error.status === 400 ? requestedSessionPow(error.payload(), params) : null;
      if (!asked) throw error;
      this.sessionPow = asked;
      return this.mintGuestSession(signal, asked, false);
    }
    return parseGuestSession(await readJson(response.body, ERROR_BODY_LIMIT, timed()));
  }

  // ── Engine-facing relay ────────────────────────────────────────────────

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
      // Only the engine working on a task the user started from the app may spend the allowance.
      if (endpoint === "chat/completions" && !this.activation.allows(request.headers.get("x-openwork-session-id"))) {
        return jsonError(403, "auto_not_activated", "Auto only runs for tasks started from OpenWork. Send a message with Auto selected to continue.");
      }
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (declaredLength > REQUEST_BODY_LIMIT) return jsonError(413, "anonymous_request_too_large", "The OpenWork Models request is too large.");
      const body = await readBoundedBody(request.body, REQUEST_BODY_LIMIT, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_BODY_TIMEOUT_MS)]));
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
      try { response = await this.remote(endpoint === "models" ? DESKTOP_FREE_MODELS_PATH : DESKTOP_FREE_CHAT_PATH, request.method, body, true, signal, true, relayToken); }
      finally { clearTimeout(headerTimeout); }
      this.cachedStatus = null;
      const completed = () => { if (endpoint === "chat/completions" && response.ok) this.activation.touch(); };
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
    this.stopHeartbeat();
    this.memberCredential = null;
    this.memberCredentialPromise = null;
    this.sessionPromise = null;
    this.session = null;
    this.cachedStatus = null;
    this.resetIdentityController("Desktop free inference disabled.");
    for (const controller of this.activeControllers) controller.abort(new Error("Desktop free inference disabled."));
    this.activeControllers.clear();
  }

  stop(): void { this.stopped = true; this.disable(); this.failures.clear(); this.powPool.cancel(); }
}
