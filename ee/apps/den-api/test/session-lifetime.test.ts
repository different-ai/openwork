import { expect, test } from "bun:test"
import {
  DEN_SESSION_EXPIRES_IN_DAYS,
  DEN_SESSION_EXPIRES_IN_SECONDS,
  DEN_SESSION_UPDATE_AGE_IN_SECONDS,
} from "../src/session-lifetime.js"

test("den auth sessions have explicit finite lifetimes", () => {
  expect(DEN_SESSION_EXPIRES_IN_DAYS).toBe(7)
  expect(DEN_SESSION_EXPIRES_IN_SECONDS).toBe(7 * 24 * 60 * 60)
  expect(DEN_SESSION_UPDATE_AGE_IN_SECONDS).toBe(24 * 60 * 60)
})
