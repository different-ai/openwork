import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ENV_PARITY_SNAPSHOTS, ENV_PARITY_SNAPSHOT_NAMES } from "../test/fixtures/env-parity/snapshots.js"
import { readParsedEnv } from "../test/support/parsed-env.js"

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "env-parity")

for (const name of ENV_PARITY_SNAPSHOT_NAMES) {
  const result = readParsedEnv(ENV_PARITY_SNAPSHOTS[name])
  if (!result.booted) {
    console.error(`${name}: den-api did not start with this environment.\n${result.stderr}`)
    process.exitCode = 1
    continue
  }
  writeFileSync(path.join(fixtureDir, `${name}.parsed.json`), `${JSON.stringify(result.env, null, 2)}\n`)
  process.stdout.write(`${name}: recorded\n`)
}
