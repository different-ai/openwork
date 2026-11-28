import { expect, test } from "bun:test"

import { buildDeviceReport } from "../src/react-app/domains/devices/device-report"

const identity = {
  installId: "test-install-id",
  label: "Test computer",
  platform: "darwin",
  appVersion: "1.2.3",
  osVersion: "15.0",
  arch: "arm64",
  machineKey: "0123456789abcdef".repeat(4),
}

const legacyReport = '{"installId":"test-install-id","label":"Test computer","platform":"darwin","appVersion":"1.2.3","osVersion":"15.0","arch":"arm64","computerUse":null}'

test("a device report with Computers off keeps the same JSON and has no machineKey property", () => {
  const report = buildDeviceReport(identity, null, null, false)
  expect(report).not.toBeNull()
  expect(report).not.toHaveProperty("machineKey")
  expect(JSON.stringify(report)).toBe(legacyReport)
})

test("a device report with Computers on includes the machineKey", () => {
  expect(buildDeviceReport(identity, null, null, true)?.machineKey).toBe(identity.machineKey)
})

test("a device report with Computers on omits an unavailable machineKey", () => {
  const report = buildDeviceReport({ ...identity, machineKey: null }, null, null, true)
  expect(report).not.toBeNull()
  expect(report).not.toHaveProperty("machineKey")
  expect(JSON.stringify(report)).toBe(legacyReport)
})
