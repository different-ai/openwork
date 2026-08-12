import type { Surface } from "./surface.ts";

export interface NetworkConditions {
  /** Extra round-trip latency added to every request, in milliseconds. */
  latencyMs: number;
  /** Download ceiling in bytes per second. Use 0 to leave it unthrottled. */
  downloadBps: number;
  /** Upload ceiling in bytes per second. Use 0 to leave it unthrottled. */
  uploadBps: number;
  /** Take the surface off the network entirely. */
  offline?: boolean;
}

/**
 * The conditions worth reproducing, named so a spec reads as a claim about the
 * user's situation rather than a pile of byte counts. The throughput figures
 * match the presets Chrome DevTools ships, so a red run can be reproduced by
 * hand from the same menu.
 */
export const NETWORK_PROFILES = {
  "slow-3g": { latencyMs: 2000, downloadBps: 50_000, uploadBps: 50_000 },
  "fast-3g": { latencyMs: 563, downloadBps: 180_000, uploadBps: 84_375 },
  "high-latency": { latencyMs: 1500, downloadBps: 0, uploadBps: 0 },
  offline: { latencyMs: 0, downloadBps: 0, uploadBps: 0, offline: true },
} as const satisfies Record<string, NetworkConditions>;

export type NetworkProfileName = keyof typeof NETWORK_PROFILES;

/** CDP reads a negative throughput as "do not throttle this direction". */
const UNTHROTTLED = -1;

function throughput(bytesPerSecond: number): number {
  return bytesPerSecond > 0 ? bytesPerSecond : UNTHROTTLED;
}

export interface ThrottledNetwork extends AsyncDisposable {
  conditions: NetworkConditions;
  /** Put the surface back on an unthrottled network. */
  restore(): Promise<void>;
}

function resolve(conditions: NetworkConditions | NetworkProfileName): NetworkConditions {
  return typeof conditions === "string" ? NETWORK_PROFILES[conditions] : conditions;
}

async function emulate(surface: Surface, conditions: NetworkConditions, timeoutMs: number): Promise<void> {
  await surface.client.send("Network.enable", {}, { timeoutMs });
  await surface.client.send("Network.emulateNetworkConditions", {
    offline: conditions.offline ?? false,
    latency: conditions.latencyMs,
    downloadThroughput: throughput(conditions.downloadBps),
    uploadThroughput: throughput(conditions.uploadBps),
  }, { timeoutMs });
}

/**
 * Hold a surface on a degraded network for the duration of a scope.
 *
 * Onboarding is the flow most likely to be run once, on hotel wifi, by someone
 * who will not try again — so the interesting assertions are the ones made
 * while the network is bad. Pair with `await using` so a failing assertion
 * still leaves the surface usable for teardown and screenshots.
 */
export async function throttleNetwork(
  surface: Surface,
  conditions: NetworkConditions | NetworkProfileName,
  opts: { timeoutMs?: number } = {},
): Promise<ThrottledNetwork> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const resolved = resolve(conditions);
  await emulate(surface, resolved, timeoutMs);

  const restore = async () => {
    await emulate(surface, { latencyMs: 0, downloadBps: 0, uploadBps: 0, offline: false }, timeoutMs);
  };

  return {
    conditions: resolved,
    restore,
    [Symbol.asyncDispose]: restore,
  };
}

/**
 * Run one step under a degraded network and restore afterwards, even if the
 * step throws. Use when only a single action needs to be slow.
 */
export async function underNetworkConditions<T>(
  surface: Surface,
  conditions: NetworkConditions | NetworkProfileName,
  run: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  await using _throttled = await throttleNetwork(surface, conditions, opts);
  return await run();
}
