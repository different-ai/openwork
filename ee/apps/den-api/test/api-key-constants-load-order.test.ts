import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// api-keys.ts and auth.ts import each other (through audit/request-capture.ts
// and session.ts), and auth.ts reads the API key constants while it loads. When
// Node reaches api-keys.ts first, auth.ts runs before api-keys.ts has defined
// anything. #7340 made server.ts reach it first and every deploy crashed with
// "Cannot access 'DEN_API_KEY_DEFAULT_PREFIX' before initialization".
// Load api-keys.ts first, in a fresh process, and require auth.ts to survive.
test("auth.ts loads when api-keys.ts is imported before it", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "await import('./src/api-keys.ts'); await import('./src/auth.ts'); console.log('loaded')",
    ],
    {
      cwd: serviceDir,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL ?? "mysql://den:den@127.0.0.1:1/den",
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "load-order-test-secret-0123456789abcdef",
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8788",
        DEN_DB_ENCRYPTION_KEY: process.env.DEN_DB_ENCRYPTION_KEY ?? "load-order-test-encryption-key-0123456789",
      },
    },
  )
  const output = `${result.stdout}\n${result.stderr}`
  assert.doesNotMatch(output, /before initialization/)
  assert.match(result.stdout, /loaded/, output)
})
