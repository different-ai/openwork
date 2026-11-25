import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PARSED_ENV_MARKER } from "./parsed-env-marker.js"

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const printer = path.join("test", "support", "print-parsed-env.ts")

export type EnvInput = Readonly<Record<string, string>>

export type ParsedEnvResult =
  | { booted: true; env: Record<string, unknown>; stderr: string }
  | { booted: false; stderr: string }

export function readParsedEnv(wholeEnvironment: EnvInput): ParsedEnvResult {
  const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", printer], {
    cwd: serviceDir,
    env: { ...wholeEnvironment },
    encoding: "utf8",
    timeout: 120_000,
  })
  const line = child.stdout.split("\n").find((entry) => entry.startsWith(PARSED_ENV_MARKER))
  if (child.status !== 0 || !line) return { booted: false, stderr: child.stderr || String(child.error ?? "") }
  const parsed: unknown = JSON.parse(line.slice(PARSED_ENV_MARKER.length))
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { booted: false, stderr: "env.ts did not export an object" }
  return { booted: true, env: Object.fromEntries(Object.entries(parsed)), stderr: child.stderr }
}
