import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  missingProductionWorkspaceExports,
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

  test("production builds reject a missing workspace export target", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "den-api-export-contract-"))
    const dependencyDir = path.join(fixture, "node_modules", "@fixture", "runtime")

    try {
      mkdirSync(dependencyDir, { recursive: true })
      writeFileSync(path.join(fixture, "package.json"), JSON.stringify({
        name: "fixture-service",
        dependencies: { "@fixture/runtime": "workspace:*" },
      }))
      writeFileSync(path.join(dependencyDir, "package.json"), JSON.stringify({
        name: "@fixture/runtime",
        exports: { ".": { default: "./dist/index.js" } },
      }))

      expect(missingProductionWorkspaceExports(fixture)).toEqual([
        "@fixture/runtime: ./dist/index.js",
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
