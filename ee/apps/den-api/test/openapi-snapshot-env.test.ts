import { describe, expect, test } from "bun:test"

import { publishedApiOrigin, seedSnapshotEnv } from "../scripts/openapi-snapshot-env.js"

describe("OpenAPI snapshot export environment", () => {
  test("a conflicting inherited public API origin is replaced by the hosted origin", () => {
    const env: NodeJS.ProcessEnv = {
      DEN_API_PUBLIC_URL: "http://api.den.local",
      BETTER_AUTH_URL: "http://den.local:3005",
    }

    seedSnapshotEnv(env)

    expect(env.DEN_API_PUBLIC_URL).toBe(publishedApiOrigin)
    expect(env.DEN_API_PUBLIC_URL).toBe("https://api.openworklabs.com")
  })

  test("an empty inherited origin also becomes the hosted origin", () => {
    const env: NodeJS.ProcessEnv = { DEN_API_PUBLIC_URL: "  " }

    seedSnapshotEnv(env)

    expect(env.DEN_API_PUBLIC_URL).toBe(publishedApiOrigin)
  })

  test("inherited values that select the export database survive", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "mysql://root:password@127.0.0.1:3307/openwork_sdk_ci",
      DEN_DB_ENCRYPTION_KEY: "k".repeat(48),
    }

    seedSnapshotEnv(env)

    expect(env.DATABASE_URL).toBe("mysql://root:password@127.0.0.1:3307/openwork_sdk_ci")
    expect(env.DEN_DB_ENCRYPTION_KEY).toBe("k".repeat(48))
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:8790")
    expect(env.BETTER_AUTH_SECRET).toBeString()
  })
})
