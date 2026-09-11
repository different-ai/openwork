import assert from "node:assert/strict"
import { test } from "node:test"

import { parseSentryLogLevel, parseUnitIntervalEnv } from "../src/instrumentation.js"

test("parses Sentry trace sampling with a low default", () => {
  assert.equal(parseUnitIntervalEnv(undefined, "SENTRY_TRACES_SAMPLE_RATE", 0.01), 0.01)
  assert.equal(parseUnitIntervalEnv("0.25", "SENTRY_TRACES_SAMPLE_RATE", 0.01), 0.25)
  assert.throws(
    () => parseUnitIntervalEnv("2", "SENTRY_TRACES_SAMPLE_RATE", 0.01),
    /SENTRY_TRACES_SAMPLE_RATE/,
  )
})

test("parses Sentry log level with warn as the default", () => {
  assert.equal(parseSentryLogLevel(undefined), "warn")
  assert.equal(parseSentryLogLevel("info"), "info")
  assert.equal(parseSentryLogLevel(" OFF "), "off")
  assert.throws(() => parseSentryLogLevel("verbose"), /SENTRY_LOG_LEVEL/)
})
