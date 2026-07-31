import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  CAPABILITY_PERMISSION,
  CAPABILITY_REQUIRES_GESTURE,
  USER_GESTURE_TTL_MS,
  capabilityRequestSchema,
  checkActivation,
  type AppPermission,
  type CapabilityError,
  type CapabilityName,
  type CapabilityRequest,
  type CapabilityResponse,
  type CapabilityResult,
  type InstalledAppRecord,
} from "@openwork/app-contract";

import type { InstalledAppStore } from "./store.js";

// The capability broker.
//
// Every privileged thing an app can do arrives here, and nothing reaches a host
// service without passing all of these gates, in this order:
//
//   1. the request parses against the versioned schema (unknown fields rejected)
//   2. the app is installed, compatible, set up, enabled, and not quarantined
//   3. the capability's permission is currently granted
//   4. use-time capabilities present a fresh, unspent gesture token
//   5. the app is inside its rate limit for that capability
//   6. the request is bound to the current workspace
//
// Denials are typed and audited without secret values, so a rejected call is
// debuggable without the audit log becoming a place secrets accumulate.

export type GestureReason = "shortcut" | "click" | "key";

/**
 * Capabilities a generic user gesture may authorise.
 *
 * A shortcut press is user intent, not a choice of capability, so the host — not
 * the app — decides what one press can pay for. Scoping the token stops an app
 * banking a press the user made for one visible reason and redirecting it, and
 * makes any future use-time capability opt in here rather than inheriting every
 * outstanding gesture the moment it is added.
 */
export const GESTURE_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  "threads.start",
  "attachments.create",
]);

type IssuedGesture = {
  token: string;
  appId: string;
  expiresAt: number;
  reason: GestureReason;
  /** Capabilities this token may authorise. */
  capabilities: readonly CapabilityName[];
};

/**
 * Short-lived, single-use proof that a real person just did something.
 *
 * Tokens are compared in constant time and deleted on use. Expiry is short
 * enough that a token cannot be banked: an app cannot collect a gesture now and
 * spend it on an unrelated action minutes later.
 */
export class UserGestureRegistry {
  readonly #tokens = new Map<string, IssuedGesture>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? USER_GESTURE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  issue(
    appId: string,
    reason: GestureReason,
    capabilities: readonly CapabilityName[] = GESTURE_CAPABILITIES,
  ): IssuedGesture {
    const token = randomBytes(24).toString("hex");
    const gesture: IssuedGesture = {
      token,
      appId,
      expiresAt: this.#now() + this.#ttlMs,
      reason,
      capabilities: [...capabilities],
    };
    this.#tokens.set(token, gesture);
    return gesture;
  }

  /** Spend a token for one capability. Returns why it failed rather than a bare boolean. */
  spend(
    appId: string,
    token: string,
    capability: CapabilityName,
  ): "ok" | "missing" | "expired" | "wrong_app" | "wrong_capability" | "replayed" {
    const gesture = this.#tokens.get(token);
    if (!gesture) return this.#looksSpent(token) ? "replayed" : "missing";
    this.#tokens.delete(token);
    if (gesture.expiresAt <= this.#now()) return "expired";
    const a = Buffer.from(gesture.appId);
    const b = Buffer.from(appId);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "wrong_app";
    // A token is spendable only on a capability the host said it covers, so a
    // gesture cannot be banked for one action and redirected to another.
    if (!gesture.capabilities.includes(capability)) return "wrong_capability";
    this.#spent.add(token);
    return "ok";
  }

  readonly #spent = new Set<string>();

  #looksSpent(token: string): boolean {
    return this.#spent.has(token);
  }

  /** Drop every outstanding token for an app: disable, revoke, uninstall, crash. */
  revokeAll(appId: string): void {
    for (const [token, gesture] of this.#tokens) {
      if (gesture.appId === appId) this.#tokens.delete(token);
    }
  }

  sweep(): void {
    const now = this.#now();
    for (const [token, gesture] of this.#tokens) {
      if (gesture.expiresAt <= now) this.#tokens.delete(token);
    }
  }
}

/** Per-app, per-capability rate limiting. */
export class CapabilityQuota {
  readonly #calls = new Map<string, number[]>();
  readonly #limits: Readonly<Record<CapabilityName, CapabilityLimit>>;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: {
    limits?: Partial<Record<CapabilityName, CapabilityLimit>>;
    windowMs?: number;
    now?: () => number;
  } = {}) {
    // Overrides layer over the complete default set, so a caller that names one
    // capability cannot accidentally leave the other fourteen unbounded.
    this.#limits = { ...DEFAULT_CAPABILITY_LIMITS, ...options.limits };
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  check(appId: string, capability: CapabilityName): boolean {
    const limit = this.#limits[capability];
    if (limit === "unlimited") return true;
    const key = `${appId}:${capability}`;
    const now = this.#now();
    const window = (this.#calls.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    this.#calls.set(key, window);
    return window.length < limit;
  }

  record(appId: string, capability: CapabilityName): void {
    const key = `${appId}:${capability}`;
    const window = this.#calls.get(key) ?? [];
    window.push(this.#now());
    this.#calls.set(key, window);
  }

  reset(appId: string): void {
    for (const key of [...this.#calls.keys()]) {
      if (key.startsWith(`${appId}:`)) this.#calls.delete(key);
    }
  }
}

/**
 * Calls per rolling window, or an explicit opt-out.
 *
 * `"unlimited"` has to be written down. A capability that simply had no entry
 * used to be unlimited by omission, which is how eight of them — including
 * microphone capture — ended up with no ceiling at all.
 */
export type CapabilityLimit = number | "unlimited";

/**
 * Total by construction: a new capability without a limit is a compile error,
 * the same property that keeps `CAPABILITY_PERMISSION` and
 * `CAPABILITY_REQUIRES_GESTURE` complete.
 */
export const DEFAULT_CAPABILITY_LIMITS: Readonly<Record<CapabilityName, CapabilityLimit>> =
  Object.freeze({
    "env.status": 60,
    "ai.realtime.session": 6,
    "ai.inference.run": 60,
    "connect.capabilities": 30,
    "connect.query": 40,
    "threads.start": 12,
    "attachments.create": 12,
    "surface.present": 60,
    "surface.dismiss": 60,
    "status.set": 120,
    "storage.get": 600,
    "storage.set": 120,
    "storage.remove": 120,
    "audio.capture.start": 30,
    "audio.capture.stop": 60,
  });

/**
 * Host services the broker calls once a request has been authorised.
 *
 * Each is narrow on purpose. There is no generic "call the server" hook,
 * because that is exactly the hole every one of these gates exists to close.
 */
export type CapabilityServices = {
  environmentStatus(appId: string): Promise<Extract<CapabilityResult, { capability: "env.status" }>>;
  mintRealtimeSession(
    appId: string,
    request: Extract<CapabilityRequest, { capability: "ai.realtime.session" }>,
  ): Promise<Extract<CapabilityResult, { capability: "ai.realtime.session" }>>;
  runInference(
    appId: string,
    request: Extract<CapabilityRequest, { capability: "ai.inference.run" }>,
    signal: AbortSignal,
  ): Promise<Extract<CapabilityResult, { capability: "ai.inference.run" }>>;
  connectCapabilities(
    appId: string,
    allowedScopes: readonly string[],
  ): Promise<Extract<CapabilityResult, { capability: "connect.capabilities" }>>;
  connectQuery(
    appId: string,
    request: Extract<CapabilityRequest, { capability: "connect.query" }>,
    signal: AbortSignal,
  ): Promise<Extract<CapabilityResult, { capability: "connect.query" }>>;
  startThread(
    appId: string,
    request: Extract<CapabilityRequest, { capability: "threads.start" }>,
  ): Promise<Extract<CapabilityResult, { capability: "threads.start" }>>;
  createAttachment(
    appId: string,
    request: Extract<CapabilityRequest, { capability: "attachments.create" }>,
  ): Promise<Extract<CapabilityResult, { capability: "attachments.create" }>>;
  presentSurface(appId: string, surface: string, visible: boolean): Promise<void>;
  setStatus(
    appId: string,
    request: Extract<CapabilityRequest, { capability: "status.set" }>,
  ): Promise<void>;
  storageGet(appId: string, key: string): Promise<{ value: unknown; present: boolean }>;
  storageSet(appId: string, key: string, value: unknown, quotaBytes: number): Promise<void>;
  storageRemove(appId: string, key: string): Promise<boolean>;
  startCapture(appId: string, surface: string): Promise<void>;
  stopCapture(appId: string): Promise<void>;
};

export type BrokerOptions = {
  store: InstalledAppStore;
  services: CapabilityServices;
  gestures: UserGestureRegistry;
  quota?: CapabilityQuota;
  /** Identifies the current workspace. A request from another one is refused. */
  currentWorkspaceId: () => string | null;
  now?: () => number;
};

function failure(error: CapabilityError): CapabilityResponse {
  return { ok: false, error };
}

export class CapabilityBroker {
  readonly #store: InstalledAppStore;
  readonly #services: CapabilityServices;
  readonly #gestures: UserGestureRegistry;
  readonly #quota: CapabilityQuota;
  readonly #currentWorkspaceId: () => string | null;
  /** In-flight work per app, so context changes can cancel it. */
  readonly #inFlight = new Map<string, Set<AbortController>>();

  constructor(options: BrokerOptions) {
    this.#store = options.store;
    this.#services = options.services;
    this.#gestures = options.gestures;
    this.#quota = options.quota ?? new CapabilityQuota();
    this.#currentWorkspaceId = options.currentWorkspaceId;
  }

  /**
   * Cancel everything an app has in flight.
   *
   * Called on workspace or account change, disable, revoke, and uninstall. A
   * request issued under the previous context must not deliver a result into the
   * new one.
   */
  cancelAll(appId: string, _reason: "workspace_changed" | "disabled" | "revoked" | "uninstalled"): void {
    const controllers = this.#inFlight.get(appId);
    if (controllers) {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    }
    this.#gestures.revokeAll(appId);
    this.#quota.reset(appId);
  }

  #track(appId: string): AbortController {
    const controller = new AbortController();
    const existing = this.#inFlight.get(appId) ?? new Set<AbortController>();
    existing.add(controller);
    this.#inFlight.set(appId, existing);
    return controller;
  }

  #release(appId: string, controller: AbortController): void {
    this.#inFlight.get(appId)?.delete(controller);
  }

  #granted(record: InstalledAppRecord, permissionId: string): AppPermission | null {
    return record.granted_permissions.find((permission) => permission.id === permissionId) ?? null;
  }

  async #audit(appId: string, version: string, subject: string, reason: string): Promise<void> {
    await this.#store
      .audit({ appId, appVersion: version, event: "capability_denied", subject, reason })
      .catch(() => {});
  }

  /**
   * Handle one capability request from one app.
   *
   * `raw` is whatever came off the bridge; it is parsed here rather than trusted,
   * so a malformed or over-specified request never reaches a service.
   */
  async handle(
    appId: string,
    raw: unknown,
    context: { workspaceId: string | null },
  ): Promise<CapabilityResponse> {
    const parsed = capabilityRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return failure({
        code: "invalid_request",
        message: "The capability request was malformed and was refused.",
      });
    }
    const request = parsed.data;
    const capability = request.capability;

    const record = await this.#store.get(appId);
    if (!record) {
      return failure({ code: "not_ready", message: "That app is not installed." });
    }

    const activation = checkActivation(record);
    if (!activation.active) {
      await this.#audit(appId, record.active.app_version, capability, activation.blocked_by);
      return failure({
        code: activation.blocked_by === "setup" ? "not_ready" : "permission_denied",
        message:
          activation.blocked_by === "enablement"
            ? "That app is disabled."
            : activation.blocked_by === "setup"
              ? "That app still needs configuration."
              : activation.blocked_by === "installation"
                ? "That app is not currently runnable."
                : "That app is not compatible with this version of OpenWork.",
      });
    }

    // A request bound to a workspace the user has since left is refused rather
    // than answered against the new one.
    if (context.workspaceId !== this.#currentWorkspaceId()) {
      return failure({
        code: "workspace_changed",
        message: "The workspace changed while this request was in flight.",
      });
    }

    const requiredPermission = CAPABILITY_PERMISSION[capability];
    let permission: AppPermission | null = null;
    if (requiredPermission !== null) {
      permission = this.#granted(record, requiredPermission);
      if (!permission) {
        await this.#audit(appId, record.active.app_version, capability, "permission_denied");
        return failure({
          code: "permission_denied",
          message: `That app does not have permission to ${capability}.`,
          permission: requiredPermission,
        });
      }
    }

    if (CAPABILITY_REQUIRES_GESTURE[capability]) {
      const token =
        "gesture_token" in request && typeof request.gesture_token === "string"
          ? request.gesture_token
          : "";
      const outcome = this.#gestures.spend(appId, token, capability);
      if (outcome !== "ok") {
        await this.#audit(appId, record.active.app_version, capability, `gesture_${outcome}`);
        return failure({
          code:
            outcome === "expired"
              ? "gesture_expired"
              : outcome === "replayed"
                ? "gesture_replayed"
                : "gesture_required",
          message:
            outcome === "expired"
              ? "That action expired. Do it again to confirm."
              : outcome === "replayed"
                ? "That confirmation was already used."
                : "This action needs a fresh confirmation from you.",
        });
      }
    }

    if (!this.#quota.check(appId, capability)) {
      await this.#audit(appId, record.active.app_version, capability, "quota_exceeded");
      return failure({
        code: "rate_limited",
        message: "That app is making this request too often and was throttled.",
      });
    }
    this.#quota.record(appId, capability);

    const controller = this.#track(appId);
    try {
      const result = await this.#dispatch(appId, record, request, permission, controller.signal);
      return { ok: true, result };
    } catch (error) {
      if (controller.signal.aborted) {
        return failure({
          code: "workspace_changed",
          message: "The request was cancelled because the context changed.",
        });
      }
      // Never surface an upstream error body: it can carry provider payloads.
      const code = error instanceof BrokerFailure ? error.code : "internal_error";
      const message =
        error instanceof BrokerFailure ? error.message : "That request could not be completed.";
      await this.#audit(appId, record.active.app_version, capability, code);
      return failure({ code, message });
    } finally {
      this.#release(appId, controller);
    }
  }

  async #dispatch(
    appId: string,
    record: InstalledAppRecord,
    request: CapabilityRequest,
    permission: AppPermission | null,
    signal: AbortSignal,
  ): Promise<CapabilityResult> {
    switch (request.capability) {
      case "env.status":
        return this.#services.environmentStatus(appId);

      case "ai.realtime.session":
        return this.#services.mintRealtimeSession(appId, request);

      case "ai.inference.run":
        return this.#services.runInference(appId, request, signal);

      case "connect.capabilities": {
        const scopes = permission?.id === "openwork.connect.read" ? permission.scopes : [];
        return this.#services.connectCapabilities(appId, scopes);
      }

      case "connect.query": {
        // The scope must be one the user actually granted, not merely one the
        // vocabulary contains.
        const scopes = permission?.id === "openwork.connect.read" ? permission.scopes : [];
        if (!scopes.includes(request.scope)) {
          throw new BrokerFailure(
            "permission_denied",
            `That app may not read ${request.scope}.`,
          );
        }
        return this.#services.connectQuery(appId, request, signal);
      }

      case "threads.start":
        return this.#services.startThread(appId, request);

      case "attachments.create":
        return this.#services.createAttachment(appId, request);

      case "surface.present":
        await this.#services.presentSurface(appId, request.surface, true);
        return { capability: "surface.present" };

      case "surface.dismiss":
        await this.#services.presentSurface(appId, request.surface, false);
        return { capability: "surface.dismiss" };

      case "status.set":
        await this.#services.setStatus(appId, request);
        return { capability: "status.set" };

      case "storage.get": {
        const stored = await this.#services.storageGet(appId, request.key);
        return { capability: "storage.get", value: stored.value, present: stored.present };
      }

      case "storage.set": {
        const quota = permission?.id === "storage.app" ? permission.quota_bytes : 0;
        await this.#services.storageSet(appId, request.key, request.value, quota);
        return { capability: "storage.set" };
      }

      case "storage.remove":
        return {
          capability: "storage.remove",
          removed: await this.#services.storageRemove(appId, request.key),
        };

      case "audio.capture.start": {
        // Capture is tied to a surface the app actually declared, so there is
        // always something on screen while the microphone is live.
        const manifestSurfaces = record.granted_permissions.some(
          (entry) => entry.id === "desktop.floatingSurface",
        );
        if (!manifestSurfaces) {
          throw new BrokerFailure(
            "permission_denied",
            "Capture needs a visible surface, and that app has none.",
          );
        }
        await this.#services.startCapture(appId, request.surface);
        return { capability: "audio.capture.start" };
      }

      case "audio.capture.stop":
        await this.#services.stopCapture(appId);
        return { capability: "audio.capture.stop" };
    }
  }
}

export class BrokerFailure extends Error {
  constructor(
    readonly code: CapabilityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BrokerFailure";
  }
}
