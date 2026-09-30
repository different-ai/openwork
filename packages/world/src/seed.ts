/**
 * Named, composable data a world prepares after it boots (for example a team,
 * a restricted policy, or twenty sessions). The world package only carries the
 * syntax; each world applies seeds with the building blocks it declares.
 */
export interface WorldSeed {
  name: string;
  arg?: string;
}

export const SEEDS_ENV = "OPENWORK_WORLD_SEEDS";

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const ARG = /^[A-Za-z0-9._-]{1,64}$/;

/** Parse one `--seed a,b:arg` value into seeds, preserving order. */
export function parseSeedFlag(value: string): WorldSeed[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("Use --seed followed by comma-separated seed names.");
  return entries.map((entry) => {
    const separator = entry.indexOf(":");
    const name = separator === -1 ? entry : entry.slice(0, separator);
    const arg = separator === -1 ? undefined : entry.slice(separator + 1);
    if (!NAME.test(name)) throw new Error(`Invalid seed name ${JSON.stringify(name)}.`);
    if (arg !== undefined && !ARG.test(arg)) throw new Error(`Invalid argument for seed ${JSON.stringify(name)}.`);
    return arg === undefined ? { name } : { name, arg };
  });
}

export function formatSeed(seed: WorldSeed): string {
  return seed.arg === undefined ? seed.name : `${seed.name}:${seed.arg}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function seedsFromEnv(env: NodeJS.ProcessEnv = process.env): WorldSeed[] {
  const text = env[SEEDS_ENV]?.trim();
  if (!text) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid ${SEEDS_ENV}.`); }
  if (!Array.isArray(value)) throw new Error(`Invalid ${SEEDS_ENV}.`);
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !NAME.test(entry.name)
      || (entry.arg !== undefined && (typeof entry.arg !== "string" || !ARG.test(entry.arg)))) {
      throw new Error(`Invalid ${SEEDS_ENV}.`);
    }
    return typeof entry.arg === "string" ? { name: entry.name, arg: entry.arg } : { name: entry.name };
  });
}
