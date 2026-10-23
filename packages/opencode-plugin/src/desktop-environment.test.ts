import assert from "node:assert/strict"
import { test } from "node:test"
import { EnvironmentApplier, parseEnvironmentSnapshot } from "./desktop-environment.ts"

const digest = (n: number) => String(n).repeat(64).slice(0, 64)

test("new values reach the process and new shells; removed ones are restored or unset", () => {
  const processEnv: Record<string, string | undefined> = { HOME: "/home/me", TOKEN: "my-own" }
  const applier = new EnvironmentApplier(processEnv)

  assert.equal(applier.apply({ digest: digest(1), env: { TOKEN: "org", API_URL: "https://api" } }), true)
  assert.equal(processEnv.TOKEN, "org")
  assert.equal(processEnv.API_URL, "https://api")
  const shell: Record<string, string | undefined> = { HOME: "/home/me", TOKEN: "stale" }
  applier.applyToShell(shell)
  assert.deepEqual(shell, { HOME: "/home/me", TOKEN: "org", API_URL: "https://api" })

  // The same snapshot changes nothing.
  assert.equal(applier.apply({ digest: digest(1), env: { TOKEN: "org", API_URL: "https://api" } }), false)

  // An admin removes both: the person's own TOKEN comes back, API_URL is gone.
  applier.apply({ digest: digest(2), env: {} })
  assert.equal(processEnv.TOKEN, "my-own")
  assert.equal("API_URL" in processEnv, false)
  const later: Record<string, string | undefined> = { HOME: "/home/me", TOKEN: "my-own", API_URL: "https://api" }
  applier.applyToShell(later)
  assert.deepEqual(later, { HOME: "/home/me", TOKEN: "my-own" })
})

test("keys the server set at spawn are owned from the start and can be removed", () => {
  const processEnv: Record<string, string | undefined> = { SPAWNED: "from-spawn" }
  const applier = new EnvironmentApplier(processEnv, ["SPAWNED"])
  assert.deepEqual(applier.keys(), ["SPAWNED"])
  applier.apply({ digest: digest(3), env: {} })
  assert.equal("SPAWNED" in processEnv, false)
})

test("only well-formed snapshots are applied", () => {
  assert.deepEqual(parseEnvironmentSnapshot({ digest: digest(4), env: { A: "1" } }), { digest: digest(4), env: { A: "1" } })
  assert.equal(parseEnvironmentSnapshot({ digest: "short", env: {} }), null)
  assert.equal(parseEnvironmentSnapshot({ digest: digest(4), env: { "BAD KEY": "1" } }), null)
  assert.equal(parseEnvironmentSnapshot({ digest: digest(4), env: { A: 1 } }), null)
  assert.equal(parseEnvironmentSnapshot(null), null)
})
