import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Which code a world runs, per component (for example `den` or `desktop`).
 * Sources are resolved to immutable identities before a world launches, so a
 * moving branch can never make an old world look reusable.
 */
export const RELEASE_DISTRIBUTIONS = ["public", "cloud", "enterprise"] as const;
export type ReleaseDistribution = typeof RELEASE_DISTRIBUTIONS[number];

export type WorldSource =
  | { kind: "local" }
  | { kind: "sha"; sha: string; ref?: string }
  | { kind: "release"; version: string; distribution: ReleaseDistribution };

export type SourceKind = WorldSource["kind"];
export const SOURCE_KINDS: readonly SourceKind[] = ["local", "sha", "release"];

/** Component key that applies to every component without its own source. */
export const DEFAULT_COMPONENT = "*";
export const SOURCES_ENV = "OPENWORK_WORLD_SOURCES";

export type WorldSources = Readonly<Record<string, WorldSource>>;

/** A source as written on the command line, before refs are resolved. */
export type SourceSpec = WorldSource | { kind: "ref"; ref: string };

export interface SourceRequest {
  component: string;
  spec: SourceSpec;
}

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,30}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isSourceKind(value: unknown): value is SourceKind {
  return value === "local" || value === "sha" || value === "release";
}

function isDistribution(value: unknown): value is ReleaseDistribution {
  return typeof value === "string" && RELEASE_DISTRIBUTIONS.some((entry) => entry === value);
}

export function parseSourceSpec(spec: string): SourceSpec {
  const value = spec.trim();
  if (value === "local") return { kind: "local" };
  if (SHA.test(value)) return { kind: "sha", sha: value };
  if (value.startsWith("sha:")) {
    const sha = value.slice(4);
    if (!SHA.test(sha)) throw new Error("A sha source needs a full 40-character lowercase commit SHA.");
    return { kind: "sha", sha };
  }
  if (value.startsWith("ref:")) {
    const ref = value.slice(4);
    if (!REF.test(ref) || ref.includes("..")) throw new Error(`Invalid git ref ${JSON.stringify(ref)}.`);
    return { kind: "ref", ref };
  }
  if (value.startsWith("release:")) {
    const [version, distribution = "public", ...rest] = value.slice(8).split("/");
    if (!version || !VERSION.test(version) || rest.length > 0) {
      throw new Error("A release source is release:<x.y.z>[/public|cloud|enterprise]; latest and prereleases are not accepted.");
    }
    if (!isDistribution(distribution)) {
      throw new Error(`Unknown release distribution ${JSON.stringify(distribution)}. Use ${RELEASE_DISTRIBUTIONS.join(", ")}.`);
    }
    return { kind: "release", version, distribution };
  }
  throw new Error(`Unknown source ${JSON.stringify(value)}. Use local, sha:<sha>, ref:<branch>, or release:<x.y.z>/<distribution>.`);
}

/** Parse one `--source [component=]spec` value. */
export function parseSourceFlag(value: string): SourceRequest {
  const separator = value.indexOf("=");
  const component = separator === -1 ? DEFAULT_COMPONENT : value.slice(0, separator).trim();
  if (component !== DEFAULT_COMPONENT && !COMPONENT.test(component)) {
    throw new Error(`Invalid source component ${JSON.stringify(component)}.`);
  }
  return { component, spec: parseSourceSpec(separator === -1 ? value : value.slice(separator + 1)) };
}

export type RefResolver = (ref: string) => Promise<string>;

/** Resolve a branch or tag on origin to its current commit SHA. */
export function gitRefResolver(cwd: string): RefResolver {
  return async (ref) => {
    // Never put the requested ref in git argv. Git accepts command overrides
    // such as --upload-pack; selecting an exact ref from its output keeps the
    // only variable input out of the command line altogether.
    const requested = parseSourceSpec(`ref:${ref}`);
    if (requested.kind !== "ref") throw new Error("A branch ref is required.");
    const { stdout } = await promisify(execFile)("git", ["ls-remote", "--heads", "origin"], {
      cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    const matches = stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2 && parts[1] === `refs/heads/${requested.ref}`);
    const sha = matches.length === 1 ? matches[0]?.[0] : undefined;
    if (!sha || !SHA.test(sha)) throw new Error(`origin did not return a commit SHA for ${JSON.stringify(ref)}.`);
    return sha;
  };
}

/** Turn requests into immutable sources. Duplicate components are rejected. */
export async function resolveSources(requests: readonly SourceRequest[], resolveRef: RefResolver): Promise<WorldSources> {
  const sources: Record<string, WorldSource> = {};
  for (const request of requests) {
    if (request.component in sources) throw new Error(`Source for ${JSON.stringify(request.component)} was given twice.`);
    sources[request.component] = request.spec.kind === "ref"
      ? { kind: "sha", sha: await resolveRef(request.spec.ref), ref: request.spec.ref }
      : request.spec;
  }
  return sources;
}

/** The source for one component, falling back to the default component. */
export function sourceFor(sources: WorldSources, component: string): WorldSource | undefined {
  return sources[component] ?? sources[DEFAULT_COMPONENT];
}

export function formatSource(source: WorldSource): string {
  if (source.kind === "local") return "local working tree";
  if (source.kind === "sha") return source.ref ? `${source.sha} (${source.ref})` : source.sha;
  return `release ${source.version} (${source.distribution})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSource(value: unknown): WorldSource {
  if (!isRecord(value)) throw new Error("Invalid world source.");
  if (value.kind === "local") return { kind: "local" };
  if (value.kind === "sha" && typeof value.sha === "string" && SHA.test(value.sha)) {
    return { kind: "sha", sha: value.sha, ...(typeof value.ref === "string" ? { ref: value.ref } : {}) };
  }
  if (value.kind === "release" && typeof value.version === "string" && VERSION.test(value.version) && isDistribution(value.distribution)) {
    return { kind: "release", version: value.version, distribution: value.distribution };
  }
  throw new Error("Invalid world source.");
}

export function sourcesFromEnv(env: NodeJS.ProcessEnv = process.env): WorldSources {
  const text = env[SOURCES_ENV]?.trim();
  if (!text) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid ${SOURCES_ENV}.`); }
  if (!isRecord(value)) throw new Error(`Invalid ${SOURCES_ENV}.`);
  const sources: Record<string, WorldSource> = {};
  for (const [component, entry] of Object.entries(value)) sources[component] = parseSource(entry);
  return sources;
}
