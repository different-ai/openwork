import { setTimeout as delay } from "node:timers/promises";
import { loopbackRelay, type LocalEndpoint } from "./relay.ts";
import { summarize, type RouteSummary, type SandboxRoute } from "./routes.ts";
import { SshForwardError, sshForward, type SshOptions } from "./ssh.ts";

/** What a readiness check concluded: keep waiting, connected, or this route will never work. */
export type Readiness = "ready" | "retry" | "fail";

export interface ConnectOptions {
  /** Checks a candidate local URL; called repeatedly until ready, fail or timeout. */
  check: (url: string, route: RouteSummary, signal: AbortSignal) => Promise<Readiness>;
  timeoutMs?: number;
  pauseMs?: number;
  signal?: AbortSignal;
  ssh?: Omit<SshOptions, "signal" | "readyTimeoutMs">;
}

export interface RouteOutcome { route: RouteSummary; result: "connected" | "failed" | "timeout" | "cancelled"; reason?: string; checks: number }

export interface SandboxConnection {
  /** Loopback URL; works for HTTP and WebSocket clients alike. */
  url: string;
  route: RouteSummary;
  /** How every route fared, safe to log. */
  outcomes: RouteOutcome[];
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export class SandboxConnectError extends Error {
  readonly outcomes: RouteOutcome[];
  constructor(outcomes: RouteOutcome[]) {
    super(`No route to the sandbox answered (${outcomes.map((item) => `${item.route.label}: ${item.result}${item.reason ? ` ${item.reason}` : ""}`).join("; ") || "no routes"})`);
    this.outcomes = outcomes;
  }
}

async function open(route: SandboxRoute, options: ConnectOptions, signal: AbortSignal, timeoutMs: number): Promise<LocalEndpoint> {
  if (route.kind === "https") return loopbackRelay(new URL(route.url), route.access);
  const forward = await sshForward(route, { ...options.ssh, signal, readyTimeoutMs: timeoutMs });
  if (!route.access || Object.keys(route.access).length === 0) return forward;
  // The guest gateway still wants its cookie; add it on this side of the tunnel.
  try {
    const relay = await loopbackRelay(new URL(forward.url), route.access);
    return { url: relay.url, async [Symbol.asyncDispose]() { await relay[Symbol.asyncDispose](); await forward[Symbol.asyncDispose](); } };
  } catch (error) { await forward[Symbol.asyncDispose](); throw error; }
}

/**
 * Races every route to a sandbox port and returns the first that passes
 * `check`, closing the rest. One provider edge failing (a preview proxy
 * answering 502) no longer fails the caller while another route works.
 */
export async function connectSandboxPort(routes: readonly SandboxRoute[], options: ConnectOptions): Promise<SandboxConnection> {
  const timeoutMs = options.timeoutMs ?? 70_000;
  const deadline = Date.now() + timeoutMs;
  const done = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, done.signal]) : done.signal;
  const outcomes: RouteOutcome[] = routes.map((route) => ({ route: summarize(route), result: "timeout", checks: 0 }));
  const released = new Set<SandboxRoute>();
  const release = async (route: SandboxRoute) => {
    if (released.has(route)) return;
    released.add(route);
    await route.release?.().catch(() => undefined);
  };

  const attempt = async (route: SandboxRoute, outcome: RouteOutcome): Promise<{ endpoint: LocalEndpoint; route: SandboxRoute }> => {
    let endpoint: LocalEndpoint;
    try { endpoint = await open(route, options, signal, Math.max(1, deadline - Date.now())); }
    catch (error) {
      outcome.result = signal.aborted ? "cancelled" : "failed";
      outcome.reason = error instanceof SshForwardError ? error.reason : "open-failed";
      throw error;
    }
    try {
      while (!signal.aborted && Date.now() < deadline) {
        outcome.checks++;
        const verdict = await options.check(endpoint.url, outcome.route, signal).catch((): Readiness => "retry");
        if (verdict === "ready") { outcome.result = "connected"; return { endpoint, route }; }
        if (verdict === "fail") { outcome.result = "failed"; outcome.reason = "rejected"; break; }
        await delay(Math.min(options.pauseMs ?? 1_000, Math.max(0, deadline - Date.now())), undefined, { signal }).catch(() => undefined);
      }
      if (signal.aborted && outcome.result === "timeout") outcome.result = "cancelled";
    } catch (error) { await endpoint[Symbol.asyncDispose]().catch(() => undefined); throw error; }
    await endpoint[Symbol.asyncDispose]().catch(() => undefined);
    throw new Error(outcome.result);
  };

  const attempts = routes.map((route, index) => attempt(route, outcomes[index]));
  let winner: { endpoint: LocalEndpoint; route: SandboxRoute };
  try { winner = await Promise.any(attempts); }
  catch {
    await Promise.all(routes.map(release));
    throw new SandboxConnectError(outcomes);
  }
  done.abort();
  // Losers dispose their own endpoints when they see the abort; wait so nothing outlives this call.
  await Promise.allSettled(attempts.map(async (pending) => {
    const settled = await pending.catch(() => undefined);
    if (settled && settled !== winner) await settled.endpoint[Symbol.asyncDispose]().catch(() => undefined);
  }));
  await Promise.all(routes.filter((route) => route !== winner.route).map(release));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await winner.endpoint[Symbol.asyncDispose](); } finally { await release(winner.route); }
  };
  return { url: winner.endpoint.url, route: summarize(winner.route), outcomes, close, [Symbol.asyncDispose]: close };
}
