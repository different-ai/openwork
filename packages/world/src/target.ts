/**
 * Where a world runs: a provider (who owns the machine) and the operating
 * system on it. Every other placement fact derives from this pair.
 */
export const WORLD_PROVIDERS = ["local", "daytona", "freestyle"] as const;
export type WorldProvider = typeof WORLD_PROVIDERS[number];

export const WORLD_OSES = ["linux", "macos", "windows"] as const;
export type WorldOs = typeof WORLD_OSES[number];

export interface WorldTarget {
  provider: WorldProvider;
  os: WorldOs;
}

export const PLACE_ENV = "OPENWORK_WORLD_PLACE";
export const OS_ENV = "OPENWORK_WORLD_OS";

/**
 * Which operating systems each provider can actually give a world. `host`
 * means "this computer": local worlds cannot pretend to be another OS.
 */
export const PROVIDER_OSES: Record<WorldProvider, "host" | readonly WorldOs[]> = {
  local: "host",
  daytona: ["linux", "windows"],
  freestyle: ["linux"],
};

export function isWorldProvider(value: unknown): value is WorldProvider {
  return typeof value === "string" && WORLD_PROVIDERS.some((provider) => provider === value);
}

export function isWorldOs(value: unknown): value is WorldOs {
  return typeof value === "string" && WORLD_OSES.some((os) => os === value);
}

export function hostOs(platform: NodeJS.Platform = process.platform): WorldOs {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  throw new Error(`Unsupported local OS ${JSON.stringify(platform)}.`);
}

/** Operating systems a provider can host from this machine. */
export function providerOses(provider: WorldProvider, platform: NodeJS.Platform = process.platform): readonly WorldOs[] {
  const oses = PROVIDER_OSES[provider];
  return oses === "host" ? [hostOs(platform)] : oses;
}

export function formatTarget(target: WorldTarget): string {
  return `${target.provider}/${target.os}`;
}

/**
 * Resolve a requested provider and OS into a target, failing closed on unknown
 * values or combinations the provider cannot host. Remote providers default to
 * Linux; local always means this computer's OS.
 */
export function resolveTarget(
  requested: { provider?: string; os?: string },
  platform: NodeJS.Platform = process.platform,
): WorldTarget {
  const provider = requested.provider?.trim() || "local";
  if (!isWorldProvider(provider)) {
    throw new Error(`Unknown world placement ${JSON.stringify(provider)}. Use ${WORLD_PROVIDERS.join(", ")}.`);
  }
  const allowed = providerOses(provider, platform);
  const requestedOs = requested.os?.trim() || undefined;
  if (requestedOs !== undefined && !isWorldOs(requestedOs)) {
    throw new Error(`Unknown world OS ${JSON.stringify(requestedOs)}. Use ${WORLD_OSES.join(", ")}.`);
  }
  const os = requestedOs ?? allowed[0];
  if (os === undefined || !allowed.includes(os)) {
    const why = PROVIDER_OSES[provider] === "host"
      ? `local worlds run on this computer (${allowed.join(", ")})`
      : `${provider} provides ${allowed.join(", ")}`;
    throw new Error(`Placement ${provider} cannot run ${os ?? "that OS"}: ${why}.`);
  }
  return { provider, os };
}

/** The target a world script was launched with. Unknown values fail instead of falling back to local. */
export function targetFromEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): WorldTarget {
  const provider = env[PLACE_ENV]?.trim() || undefined;
  const os = env[OS_ENV]?.trim() || undefined;
  return resolveTarget({
    ...(provider === undefined ? {} : { provider }),
    ...(os === undefined ? {} : { os }),
  }, platform);
}
