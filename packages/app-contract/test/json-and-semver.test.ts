import { describe, expect, test } from "bun:test"

import { parseJsonStrict, stringifyJsonCanonical } from "../src/json.js"
import { compareVersionStrings, isSemVer, satisfiesWindow } from "../src/semver.js"
import {
  CRASH_QUARANTINE_THRESHOLD,
  INSTALL_CANDIDATE_TTL_MS,
  canRollBack,
  checkActivation,
  type InstalledAppRecord,
} from "../src/lifecycle.js"
import { canonicalFileListPayload } from "../src/package.js"

describe("strict JSON", () => {
  test("it parses ordinary documents", () => {
    expect(parseJsonStrict('{"a":1,"b":[true,null,"x"]}')).toEqual({
      ok: true,
      value: { a: 1, b: [true, null, "x"] },
    })
  })

  test("it rejects duplicate keys instead of taking the last one", () => {
    const result = parseJsonStrict('{"permissions":[],"permissions":["audio.microphone"]}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("duplicate key")
  })

  test("it rejects a byte-order mark", () => {
    const result = parseJsonStrict('﻿{"a":1}')
    expect(result.ok).toBe(false)
  })

  test("it rejects trailing content", () => {
    expect(parseJsonStrict('{"a":1} trailing').ok).toBe(false)
  })

  test("it rejects a raw control character in a string", () => {
    expect(parseJsonStrict('{"a":"line\nbreak"}').ok).toBe(false)
  })

  test("it rejects a trailing comma", () => {
    expect(parseJsonStrict('{"a":1,}').ok).toBe(false)
  })

  test("it rejects a single-quoted string", () => {
    expect(parseJsonStrict("{'a':1}").ok).toBe(false)
  })

  test("it rejects a leading-zero number", () => {
    expect(parseJsonStrict('{"a":007}').ok).toBe(false)
  })

  test("a __proto__ key does not pollute the prototype", () => {
    const result = parseJsonStrict('{"__proto__":{"polluted":true}}')
    expect(result.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("it handles deep but legal nesting and refuses absurd nesting", () => {
    expect(parseJsonStrict("[".repeat(60) + "]".repeat(60)).ok).toBe(true)
    expect(parseJsonStrict("[".repeat(200) + "]".repeat(200)).ok).toBe(false)
  })

  test("canonical stringify sorts keys and is stable", () => {
    const a = stringifyJsonCanonical({ b: 1, a: { d: 2, c: 3 } })
    const b = stringifyJsonCanonical({ a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a.endsWith("\n")).toBe(true)
  })
})

describe("semver", () => {
  test("it accepts and rejects the expected shapes", () => {
    expect(isSemVer("1.0.0")).toBe(true)
    expect(isSemVer("1.0.0-rc.1")).toBe(true)
    expect(isSemVer("1.0.0+build.5")).toBe(true)
    expect(isSemVer("1.0")).toBe(false)
    expect(isSemVer("v1.0.0")).toBe(false)
    expect(isSemVer("01.0.0")).toBe(false)
  })

  test("a prerelease sorts below its release", () => {
    expect(compareVersionStrings("1.0.0-rc.1", "1.0.0")).toBeLessThan(0)
    expect(compareVersionStrings("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0)
    expect(compareVersionStrings("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0)
  })

  test("build metadata is ignored when comparing", () => {
    expect(compareVersionStrings("1.0.0+a", "1.0.0+b")).toBe(0)
  })

  test("windows are inclusive at min and exclusive at max", () => {
    const window = { min: "1.0.0", max_exclusive: "2.0.0" }
    expect(satisfiesWindow("1.0.0", window).satisfied).toBe(true)
    expect(satisfiesWindow("1.9.9", window).satisfied).toBe(true)
    expect(satisfiesWindow("2.0.0", window).satisfied).toBe(false)
    expect(satisfiesWindow("0.9.9", window).satisfied).toBe(false)
  })

  test("an open-ended window has no upper bound", () => {
    expect(satisfiesWindow("99.0.0", { min: "1.0.0" }).satisfied).toBe(true)
  })

  test("a malformed version never satisfies a window", () => {
    const result = satisfiesWindow("not-a-version", { min: "1.0.0" })
    expect(result.satisfied).toBe(false)
    if (!result.satisfied) expect(result.reason).toBe("invalid_version")
  })
})

function record(overrides: Partial<InstalledAppRecord> = {}): InstalledAppRecord {
  const activePackage = {
    app_version: "1.0.0",
    archive_digest: `sha256:${"a".repeat(64)}`,
    manifest_digest: `sha256:${"b".repeat(64)}`,
    source: {
      repository: "https://github.com/different-ai/openwork-station",
      release_tag: "v1.0.0",
      commit: "c".repeat(40),
    },
    directory: "1.0.0",
    installed_at: 0,
    permissions: [],
  }
  return {
    app_id: "com.openworklabs.station",
    installation: "installed",
    setup: "ready",
    enablement: "enabled",
    compatibility: "compatible",
    active: activePackage,
    previous: null,
    pending: null,
    granted_permissions: [],
    crash_count: 0,
    trusted_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

describe("lifecycle gates", () => {
  test("a fully ready, enabled app is active", () => {
    expect(checkActivation(record())).toEqual({ active: true })
  })

  test("installing without setup does not activate", () => {
    expect(checkActivation(record({ setup: "setup_required" }))).toEqual({
      active: false,
      blocked_by: "setup",
    })
  })

  test("an installed but disabled app does not activate", () => {
    expect(checkActivation(record({ enablement: "disabled" }))).toEqual({
      active: false,
      blocked_by: "enablement",
    })
  })

  test("a quarantined app does not activate even when enabled", () => {
    expect(checkActivation(record({ installation: "quarantined" }))).toEqual({
      active: false,
      blocked_by: "installation",
    })
  })

  test("an incompatible app does not activate", () => {
    expect(checkActivation(record({ compatibility: "engine_incompatible" }))).toEqual({
      active: false,
      blocked_by: "compatibility",
    })
  })

  test("rollback needs a retained previous package", () => {
    expect(canRollBack(record())).toBe(false)
    const withPrevious = record()
    expect(canRollBack({ ...withPrevious, previous: withPrevious.active })).toBe(true)
  })

  test("policy constants are set to sane values", () => {
    expect(INSTALL_CANDIDATE_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000)
    expect(CRASH_QUARANTINE_THRESHOLD).toBeGreaterThan(1)
  })
})

describe("canonical file list", () => {
  test("it is independent of input order", () => {
    const files = [
      { path: "b.txt", size: 2, digest: `sha256:${"2".repeat(64)}` },
      { path: "a.txt", size: 1, digest: `sha256:${"1".repeat(64)}` },
    ]
    expect(canonicalFileListPayload(files)).toBe(canonicalFileListPayload([...files].reverse()))
  })

  test("it changes when a digest changes", () => {
    const base = [{ path: "a.txt", size: 1, digest: `sha256:${"1".repeat(64)}` }]
    const tampered = [{ path: "a.txt", size: 1, digest: `sha256:${"3".repeat(64)}` }]
    expect(canonicalFileListPayload(base)).not.toBe(canonicalFileListPayload(tampered))
  })
})
