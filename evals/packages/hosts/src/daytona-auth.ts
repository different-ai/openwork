import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
type Auth = { mode: "api-key"; apiKey: string; apiUrl: string } | { mode: "cli" };

/** Same identity as the CLI: scoped key+URL, otherwise the active saved profile. Never changes login. */
export async function worldDaytonaAuth(env: NodeJS.ProcessEnv = process.env, read: (path: string, encoding: "utf8") => Promise<string> = readFile): Promise<Auth> {
  if (env.DAYTONA_API_KEY && env.DAYTONA_API_URL) return { mode: "api-key", apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL };
  const dir = env.DAYTONA_CONFIG_DIR ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "daytona") : join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "daytona"));
  let parsed: unknown;
  try { parsed = JSON.parse(await read(join(dir, "config.json"), "utf8")); } catch { throw new Error("Missing or invalid Daytona CLI profile; run daytona login"); }
  if (!record(parsed) || !Array.isArray(parsed.profiles)) throw new Error("Invalid Daytona CLI profile; run daytona login");
  const profile = parsed.profiles.find((p: unknown) => record(p) && (p.id === parsed.activeProfile || p.name === parsed.activeProfile));
  if (!record(profile) || !record(profile.api) || !text(profile.api.url)) throw new Error("No active Daytona CLI profile; run daytona login");
  const apiUrl = text(profile.api.url);
  if (!apiUrl) throw new Error("Daytona profile is missing its API URL");
  const apiKey = text(profile.api.key);
  if (apiKey) return { mode: "api-key", apiKey, apiUrl };
  // Browser profiles need the CLI's refresh/session machinery. Keep that
  // transport rather than copying tokens into a second, non-refreshing client.
  return { mode: "cli" };
}
