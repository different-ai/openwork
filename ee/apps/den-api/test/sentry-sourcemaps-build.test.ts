import { describe, expect, test } from "bun:test"

import {
  missingSentrySourcemapUploadEnv,
  requireSentrySourcemapUploadEnv,
  sentrySourcemapUploadFlag,
  shouldUploadSentrySourcemaps,
} from "../scripts/build.mjs"

describe("den-api Sentry source-map build gating", () => {
  test("normal builds skip source-map upload", () => {
    expect(shouldUploadSentrySourcemaps({})).toBe(false)
    expect(shouldUploadSentrySourcemaps({ [sentrySourcemapUploadFlag]: "0" })).toBe(false)
  })

  test("complete build credentials allow upload without runtime Sentry backend or DSN", () => {
    const env = {
      [sentrySourcemapUploadFlag]: "1",
      SENTRY_AUTH_TOKEN: "token",
      SENTRY_ORG: "openwork",
      SENTRY_PROJECT: "den-api",
      SENTRY_RELEASE: "den-api@1.0.0",
    }

    expect(shouldUploadSentrySourcemaps(env)).toBe(true)
    expect(missingSentrySourcemapUploadEnv(env)).toEqual([])
    expect(() => requireSentrySourcemapUploadEnv(env)).not.toThrow()
  })

  test("upload mode reports incomplete build credentials", () => {
    const env = {
      [sentrySourcemapUploadFlag]: "1",
      SENTRY_AUTH_TOKEN: "token",
      SENTRY_ORG: "openwork",
      SENTRY_PROJECT: "den-api",
    }

    expect(missingSentrySourcemapUploadEnv(env)).toEqual(["SENTRY_RELEASE"])
    expect(() => requireSentrySourcemapUploadEnv(env)).toThrow("SENTRY_RELEASE")
  })
})
