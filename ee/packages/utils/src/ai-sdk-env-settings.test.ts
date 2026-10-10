import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { accessSync, constants, readFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { aiSdkEnvSettings } from "./ai-sdk-env-settings.ts"

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..")

/** The pinned OpenCode engine: OPENWORK_OPENCODE_BIN, else `opencode` on PATH. */
function pinnedEngine(): string {
  const pinned = String(JSON.parse(readFileSync(join(repoRoot, "constants.json"), "utf8")).opencodeVersion).replace(/^v/, "")
  const candidates = process.env.OPENWORK_OPENCODE_BIN
    ? [process.env.OPENWORK_OPENCODE_BIN]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "opencode"))
  const binary = candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  assert.ok(binary, `OpenCode ${pinned} not found: install the version pinned in constants.json or set OPENWORK_OPENCODE_BIN.`)
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
  assert.equal(version, pinned, `${binary} is OpenCode ${version}; constants.json pins ${pinned}.`)
  return binary
}

// Minified forms of `loadSetting({ settingValue: options.region, settingName: "region",
// environmentVariableName: "AWS_REGION" })` and `loadApiKey({ apiKey: options.apiKey,
// environmentVariableName: "AZURE_API_KEY" })` as the SDKs ship inside the engine.
const SETTING_PATTERN = /(?:settingValue|apiKey):[A-Za-z_$][\w$]*\.([A-Za-z]+),(?:settingName:"[A-Za-z]+",)?environmentVariableName:"([A-Z][A-Z0-9_]*)"/g

test("aiSdkEnvSettings is exactly what the SDKs bundled in the pinned engine read", () => {
  const source = readFileSync(pinnedEngine()).toString("latin1")
  const optionsByEnv = new Map<string, Set<string>>()
  for (const [, option, envName] of source.matchAll(SETTING_PATTERN)) {
    if (!option || !envName) continue
    optionsByEnv.set(envName, (optionsByEnv.get(envName) ?? new Set<string>()).add(option))
  }
  assert.ok(optionsByEnv.size > 0, "No SDK settings found: the engine bundle format changed, update SETTING_PATTERN.")
  // Bindings are keyed by env name alone, so no env name may feed two options.
  for (const [envName, options] of optionsByEnv) assert.equal(options.size, 1, `${envName} feeds ${[...options].join(", ")}`)
  const extracted = Object.fromEntries([...optionsByEnv].map(([envName, options]) => [envName, [...options][0]]))
  assert.deepEqual({ ...aiSdkEnvSettings }, extracted)
})
