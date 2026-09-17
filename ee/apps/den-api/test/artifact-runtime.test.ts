import { expect, test } from "bun:test"
import { artifactRunInputSchema, artifactRuntime } from "../src/artifact-runtime.js"

test("today follows the caller timezone and rolls over on each run", () => {
  const before = artifactRuntime("America/Los_Angeles", new Date("2026-09-15T06:59:59Z"))
  const after = artifactRuntime("America/Los_Angeles", new Date("2026-09-15T07:00:00Z"))
  expect(before.today).toBe("2026-09-14")
  expect(after.today).toBe("2026-09-15")
  expect(after.now).toBe("2026-09-15T07:00:00.000Z")
  expect(artifactRuntime("Asia/Tokyo", new Date(before.now)).today).toBe("2026-09-15")
})

test("day bounds follow DST instead of assuming 24 hours", () => {
  const spring = artifactRuntime("America/New_York", new Date("2026-03-08T12:00:00Z"))
  const fall = artifactRuntime("America/New_York", new Date("2026-11-01T12:00:00Z"))
  expect(spring.dayStart).toBe("2026-03-08T05:00:00.000Z")
  expect(spring.dayEnd).toBe("2026-03-09T04:00:00.000Z")
  expect(Date.parse(fall.dayEnd) - Date.parse(fall.dayStart)).toBe(25 * 60 * 60_000)
})

test("Los Angeles fall-back keeps both repeated hours in one 25-hour day and rolls over at midnight", () => {
  const timeZone = "America/Los_Angeles"
  for (const now of ["2026-11-01T07:00:00.000Z", "2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z", "2026-11-02T07:59:59.999Z"]) {
    expect(artifactRuntime(timeZone, new Date(now))).toEqual({
      now, today: "2026-11-01", timeZone,
      dayStart: "2026-11-01T07:00:00.000Z", dayEnd: "2026-11-02T08:00:00.000Z",
    })
  }
  expect(artifactRuntime(timeZone, new Date("2026-11-01T06:59:59.999Z"))).toMatchObject({
    today: "2026-10-31", dayEnd: "2026-11-01T07:00:00.000Z",
  })
  expect(artifactRuntime(timeZone, new Date("2026-11-02T08:00:00.000Z"))).toEqual({
    now: "2026-11-02T08:00:00.000Z", today: "2026-11-02", timeZone,
    dayStart: "2026-11-02T08:00:00.000Z", dayEnd: "2026-11-03T08:00:00.000Z",
  })
})

test("fractional offsets and midnight transitions resolve to the actual day", () => {
  const kathmandu = artifactRuntime("Asia/Kathmandu", new Date("2026-09-14T12:00:00Z"))
  expect(kathmandu.dayStart).toBe("2026-09-13T18:15:00.000Z")
  const santiago = artifactRuntime("America/Santiago", new Date("2026-09-06T12:00:00Z"))
  expect(santiago.dayStart).toBe("2026-09-06T04:00:00.000Z")
  expect(santiago.dayEnd).toBe("2026-09-07T03:00:00.000Z")
})

test("run input rejects receipt IDs, invalid zones, and protected runtime overrides", () => {
  expect(artifactRunInputSchema.parse({})).toEqual({})
  for (const input of [
    { timeZone: "invalid/zone" },
    { now: "2020-01-01" },
    { runtime: { today: "2020-01-01" } },
    { input: { timeZone: "UTC" } },
    { receiptId: "another-receipt" },
  ]) {
    expect(artifactRunInputSchema.safeParse(input).success).toBe(false)
  }
  expect(artifactRuntime(undefined, new Date("2026-09-14T12:00:00Z")).timeZone).toBe("UTC")
})
