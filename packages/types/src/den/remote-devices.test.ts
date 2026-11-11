import assert from "node:assert/strict"
import { test } from "node:test"
import { remoteDeviceAvailability, remoteDeviceRegisterRequestSchema, remoteDeviceDesktopReportSchema, REMOTE_DEVICE_ONLINE_WINDOW_MS } from "./remote-devices.ts"

test("stale virtual-computer activity is unknown, never evidence of a successful pause", () => {
  const now = Date.now()
  const recent = { kind: "vm", provider: "workbot", state: "ready", lastSeenAt: now, now } as const
  assert.equal(remoteDeviceAvailability(recent), "online")
  assert.equal(remoteDeviceAvailability({ ...recent, lastSeenAt: now - REMOTE_DEVICE_ONLINE_WINDOW_MS - 1 }), "unknown")
  assert.equal(remoteDeviceAvailability({ ...recent, state: "paused", lastSeenAt: null }), "paused")
  assert.equal(remoteDeviceAvailability({ ...recent, state: "unavailable" }), "offline")
  assert.equal(remoteDeviceAvailability({ ...recent, state: "setup_required" }), "needs_setup")
  assert.equal(remoteDeviceAvailability({ ...recent, provider: "freestyle", lastSeenAt: null }), "unknown")
})

test("desktop contact means online, while a missing permission remains visible", () => {
  const now = Date.now()
  const desktop = { kind: "desktop", provider: "openwork_desktop", state: "setup_required", lastSeenAt: now, now } as const
  assert.equal(remoteDeviceAvailability(desktop), "needs_setup")
  assert.equal(remoteDeviceAvailability({ ...desktop, lastSeenAt: now - REMOTE_DEVICE_ONLINE_WINDOW_MS - 1 }), "offline")
})

test("registration cannot carry provider credentials or pretend to be a desktop", () => {
  const vm = { label: "Build VM", provider: "freestyle", platform: "linux", externalId: "vm-build" }
  assert.equal(remoteDeviceRegisterRequestSchema.safeParse(vm).success, true)
  assert.equal(remoteDeviceRegisterRequestSchema.safeParse({ ...vm, apiKey: "not-a-real-key" }).success, false)
  assert.equal(remoteDeviceRegisterRequestSchema.safeParse({ ...vm, provider: "openwork_desktop" }).success, false)
  assert.equal(remoteDeviceRegisterRequestSchema.safeParse({ ...vm, externalId: "https://example.test/control" }).success, false)
})

test("a desktop report has bounded metadata, not screen contents or filesystem paths", () => {
  const report = { installId: "test-install", label: "Test Mac", platform: "darwin", appVersion: "1.0.0" }
  assert.equal(remoteDeviceDesktopReportSchema.safeParse(report).success, true)
  assert.equal(remoteDeviceDesktopReportSchema.safeParse({ ...report, screenshot: "pixels" }).success, false)
  assert.equal(remoteDeviceDesktopReportSchema.safeParse({ ...report, workspacePath: "/private/work" }).success, false)
  assert.equal(remoteDeviceDesktopReportSchema.safeParse({ ...report, label: "x".repeat(81) }).success, false)
})
