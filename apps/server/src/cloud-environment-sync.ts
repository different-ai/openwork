import {
  environmentVariableKeyProblem,
  resolvedEnvironmentVariablesResponseSchema,
  type ResolvedEnvironmentVariable,
} from "@openwork/types/den/environment-variables";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import { cloudEnvironmentOverlay, hashEnvironment, setCloudEnvironmentOverlay } from "./cloud-environment-overlay.js";
import type { RolloverOutcome } from "./engine-pool.js";
import { rolloverOutcomeApplied } from "./engine-pool.js";

/**
 * Organization environment variables, delivered from OpenWork Cloud to the
 * OpenCode process environment.
 *
 * Den resolves each variable for the signed-in member (an assignment's value,
 * or the member's own). This keeps the latest answer in memory and puts it in
 * the engine overlay. When it changes, a v1 engine gets a standby that starts
 * with it (new conversations get it while running ones finish), and a v2
 * engine picks it up live, like providers: its plugin fetches the overlay and
 * applies it to new shells and tools.
 *
 * Values only reach the engine process. status() never returns a value an
 * admin provisioned; only the member's own values, which they may read.
 */

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type CloudEnvironmentVariableStatus = Omit<ResolvedEnvironmentVariable, "value"> & {
  hasValue: boolean;
  /** Only for variables the member sets themselves. */
  value?: string | null;
};

export type CloudEnvironmentStatus = {
  signedIn: boolean;
  /** False until Den answered once for this session; also false when the organization doesn't have the feature. */
  available: boolean;
  variables: CloudEnvironmentVariableStatus[];
  lastRun: { at: number; ok: boolean; error?: string } | null;
  /** The running engine already has these values. */
  applied: boolean;
};

export type CloudEnvironmentSyncLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

export type CloudEnvironmentSyncOptions = {
  /**
   * Gets the current overlay (fingerprint `digest`) to the engine: a v1
   * standby that starts with it, or confirmation the live v2 engine fetched it.
   * Null when no managed engine runs yet; the first one starts with it.
   */
  reloadEngine: (digest: string) => Promise<RolloverOutcome | null>;
  fetchImpl?: typeof globalThis.fetch;
  intervalMs?: number;
  logger?: CloudEnvironmentSyncLogger;
};

/** Den answers 404 when the organization doesn't have environment variables: nothing is deployed. */
type FetchResult = { kind: "ok"; variables: ResolvedEnvironmentVariable[] } | { kind: "unavailable" };

export async function fetchResolvedEnvironmentVariables(
  fetchImpl: typeof globalThis.fetch,
  session: CloudProviderDenSession,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const response = await fetchImpl(`${session.baseUrl}/v1/environment-variables/resolved`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${session.token}`,
      "x-openwork-legacy-org-id": session.orgId,
      "x-openwork-org-id": session.orgId,
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (response.status === 404) return { kind: "unavailable" };
  if (!response.ok) throw new Error(`den_request_failed_${response.status}`);
  const parsed = resolvedEnvironmentVariablesResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("den_request_invalid_payload");
  return { kind: "ok", variables: parsed.data.environmentVariables };
}

/**
 * The environment for the engine: variables with a value, keyed by name. Keys
 * Den would refuse (reserved, or ones that make programs run other commands)
 * are dropped here too, so an older or compromised Den can't set them.
 */
export function environmentFromVariables(variables: readonly ResolvedEnvironmentVariable[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const variable of variables) {
    if (variable.value !== null && environmentVariableKeyProblem(variable.key) === null) environment[variable.key] = variable.value;
  }
  return environment;
}

export class CloudEnvironmentSync {
  private readonly reloadEngine: CloudEnvironmentSyncOptions["reloadEngine"];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly intervalMs: number;
  private readonly logger?: CloudEnvironmentSyncLogger;
  private session: CloudProviderDenSession | null = null;
  private variables: ResolvedEnvironmentVariable[] = [];
  private available = false;
  private lastRun: CloudEnvironmentStatus["lastRun"] = null;
  /** Hash of the overlay the running engine started with. */
  private appliedHash = hashEnvironment({});
  private interval: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(options: CloudEnvironmentSyncOptions) {
    this.reloadEngine = options.reloadEngine;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger;
  }

  /** Called whenever the delivered variables change (names, sources or values). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSession(session: CloudProviderDenSession): Promise<void> {
    const same = this.session
      && this.session.baseUrl === session.baseUrl
      && this.session.orgId === session.orgId
      && this.session.token === session.token;
    if (same) return Promise.resolve();
    const changedIdentity = this.session !== null;
    this.generation += 1;
    this.session = session;
    this.startInterval();
    if (changedIdentity) {
      // Another person's or organization's values must never be shown or stay
      // in a running engine. Retire it first, so a failed fetch for the new
      // session can't leave the previous values in place.
      this.variables = [];
      this.available = false;
      this.lastRun = null;
      this.publish();
      return this.enqueue(() => this.applyToEngine("den_session_changed"))
        .then(() => this.run("den_session_updated"))
        .then(() => undefined);
    }
    return this.run("den_session_updated").then(() => undefined);
  }

  /** Sign-out: forget every value and start an engine without them. */
  clearSession(): Promise<void> {
    this.generation += 1;
    this.session = null;
    this.stopInterval();
    this.variables = [];
    this.available = false;
    this.lastRun = null;
    this.publish();
    return this.enqueue(() => this.applyToEngine("den_session_cleared"));
  }

  stop(): void {
    this.stopInterval();
  }

  /** Keys the organization delivers with a value; local variables with these keys are replaced. */
  deliveredKeys(): string[] {
    return Object.keys(cloudEnvironmentOverlay()).sort();
  }

  status(): CloudEnvironmentStatus {
    return {
      signedIn: this.session !== null,
      available: this.available,
      variables: this.variables.map(({ value, ...variable }) => ({
        ...variable,
        hasValue: value !== null,
        ...(variable.editable ? { value } : {}),
      })),
      lastRun: this.lastRun,
      applied: this.appliedHash === hashEnvironment(cloudEnvironmentOverlay()),
    };
  }

  run(reason = "manual"): Promise<CloudEnvironmentStatus> {
    return this.enqueue(async () => {
      const session = this.session;
      const generation = this.generation;
      if (!session) return this.status();
      try {
        const result = await fetchResolvedEnvironmentVariables(this.fetchImpl, session);
        if (generation !== this.generation) return this.status();
        this.available = result.kind === "ok";
        this.variables = result.kind === "ok" ? result.variables : [];
        this.lastRun = { at: Date.now(), ok: true };
      } catch (error) {
        // Keep the last known values: a network failure must not strip a
        // working environment from the next engine.
        if (generation !== this.generation) return this.status();
        this.lastRun = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : "cloud_environment_sync_failed" };
        this.logger?.warn("cloud environment sync failed", { reason, message: this.lastRun.error });
        return this.status();
      }
      this.publish();
      await this.applyToEngine(reason);
      return this.status();
    });
  }

  private publish(): void {
    const before = hashEnvironment(cloudEnvironmentOverlay());
    setCloudEnvironmentOverlay(environmentFromVariables(this.variables));
    if (before !== hashEnvironment(cloudEnvironmentOverlay())) {
      for (const listener of this.listeners) listener();
    }
  }

  private async applyToEngine(reason: string): Promise<void> {
    const target = hashEnvironment(cloudEnvironmentOverlay());
    if (target === this.appliedHash) return;
    try {
      const outcome = await this.reloadEngine(target);
      // No managed engine yet: the first one starts with the overlay.
      if (outcome === null || rolloverOutcomeApplied(outcome)) {
        this.appliedHash = target;
        this.logger?.info("cloud environment applied", { reason, keys: Object.keys(cloudEnvironmentOverlay()).length });
      }
      // Otherwise the change stays owed and the next pass retries.
    } catch (error) {
      this.logger?.warn("cloud environment engine reload failed", {
        reason,
        message: error instanceof Error ? error.message : "engine_reload_failed",
      });
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private startInterval(): void {
    if (this.interval) return;
    this.interval = setInterval(() => { void this.run("interval"); }, this.intervalMs);
    this.interval.unref?.();
  }

  private stopInterval(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}
