import os from "node:os"
import { env } from "../../src/env.js"
import { denApiAppVersion } from "../../src/version.js"
import { PARSED_ENV_MARKER } from "./parsed-env-marker.js"

const latestDesktopReleaseTag = `v${denApiAppVersion.latestAppVersion}`
const machineTmpdir = os.tmpdir()

function keepingUndefinedAndNonFiniteVisible(value: unknown): unknown {
  if (value === undefined) return "<undefined>"
  if (typeof value === "number" && !Number.isFinite(value)) return `<${String(value)}>`
  if (typeof value === "string") return withBuildAndMachineValuesNamed(value)
  if (Array.isArray(value)) return value.map(keepingUndefinedAndNonFiniteVisible)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, keepingUndefinedAndNonFiniteVisible(entry)]))
  }
  return value
}

function withBuildAndMachineValuesNamed(value: string): string {
  if (value === latestDesktopReleaseTag) return "<latest desktop release tag>"
  return value.startsWith(machineTmpdir) ? `<tmpdir>${value.slice(machineTmpdir.length)}` : value
}

process.stdout.write(`${PARSED_ENV_MARKER}${JSON.stringify(keepingUndefinedAndNonFiniteVisible(env))}\n`)
