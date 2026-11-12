import { expect, spyOn, test } from "bun:test"
import type { ComputerDevicesSnapshot, DesktopDeviceIdentity } from "@openwork/types/desktop-ipc"
import { DenApiError, createDenClient } from "../src/app/lib/den"
import {
  DEVICE_REPORT_BACKOFF_MS,
  buildDeviceReport,
  createDeviceReporter,
  deviceReportBackoffMs,
  deviceReportFailure,
  deviceReportKey,
  reportedComputerUse,
  type DeviceReportOutcome,
} from "../src/react-app/domains/devices/device-report"

const identity: DesktopDeviceIdentity = {
  installId: "3d0a0b6e-install", label: "Ada's MacBook Pro", platform: "darwin", appVersion: "0.14.2", osVersion: "15.1", arch: "arm64",
}
const snapshot = (change: Partial<ComputerDevicesSnapshot> = {}): ComputerDevicesSnapshot => ({
  enabled: true, remoteEnabled: true, selectedId: "this-mac", permissions: { accessibility: true, screenRecording: false },
  computers: [
    { id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off.", provider: null, externalId: null },
    { id: "freestyle-vm", label: "Freestyle VM", placement: "remote", readiness: null, detail: null, provider: "freestyle", externalId: "vm-1" },
  ],
  ...change,
})

test("a report names the desktop and its computers, nothing else", () => {
  expect(buildDeviceReport(identity, snapshot())).toEqual({
    installId: "3d0a0b6e-install", label: "Ada's MacBook Pro", platform: "darwin", appVersion: "0.14.2", osVersion: "15.1", arch: "arm64",
    computerUse: {
      enabled: true, remoteEnabled: true, selectedId: "this-mac", permissions: { accessibility: true, screenRecording: false },
      computers: [
        { id: "this-mac", label: "This Mac", placement: "local", readiness: "setup-required", detail: "Screen Recording is off.", provider: null, externalId: null },
        { id: "freestyle-vm", label: "Freestyle VM", placement: "remote", readiness: null, detail: null, provider: "freestyle", externalId: "vm-1" },
      ],
    },
  })
})

test("computer use off, or a snapshot that failed, reports no computer use", () => {
  expect(buildDeviceReport(identity, snapshot({ enabled: false }))?.computerUse).toBeNull()
  expect(buildDeviceReport(identity, null)?.computerUse).toBeNull()
  expect(reportedComputerUse(null)).toBeNull()
})

test("the install's own runner id stands in until the runner is configured, and no id means no report", () => {
  expect(buildDeviceReport({ ...identity, installId: null }, null, " local-runner-id ")?.installId).toBe("local-runner-id")
  expect(buildDeviceReport({ ...identity, installId: "configured-runner" }, null, "local-runner-id")?.installId).toBe("configured-runner")
  expect(buildDeviceReport({ ...identity, installId: null }, snapshot())).toBeNull()
  expect(buildDeviceReport({ ...identity, installId: "short" }, snapshot())).toBeNull()
  expect(buildDeviceReport({ ...identity, platform: "freebsd" }, snapshot())).toBeNull()
})

test("long names are cut to what the list accepts and a ready computer carries no detail", () => {
  const report = buildDeviceReport(
    { ...identity, label: `  ${"L".repeat(120)}  `, appVersion: " ", osVersion: "", arch: null },
    snapshot({ computers: [
      { id: "this-mac", label: "M".repeat(100), placement: "local", readiness: "ready", detail: "Ready", provider: null, externalId: null },
      { id: "vm", label: " ", placement: "remote", readiness: "unavailable", detail: `  ${"d".repeat(400)}`, provider: "daytona", externalId: " sandbox-1 " },
    ] }),
  )
  expect(report?.label).toBe("L".repeat(80))
  expect(report?.appVersion).toBe("unknown")
  expect(report?.osVersion).toBeNull()
  expect(report?.arch).toBeNull()
  expect(report?.computerUse?.computers).toEqual([
    { id: "this-mac", label: "M".repeat(80), placement: "local", readiness: "ready", detail: null, provider: null, externalId: null },
    { id: "vm", label: "vm", placement: "remote", readiness: "unavailable", detail: "d".repeat(300), provider: "daytona", externalId: "sandbox-1" },
  ])
})

test("a VM the list cannot name is reported without its provider, and more than twelve computers are cut", () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    id: `vm-${index}`, label: `VM ${index}`, placement: "remote" as const, readiness: null, detail: null,
    provider: "freestyle" as const, externalId: index === 0 ? "x".repeat(200) : `id-${index}`,
  }))
  const computers = reportedComputerUse(snapshot({ computers: many }))?.computers ?? []
  expect(computers).toHaveLength(12)
  expect(computers[0]).toMatchObject({ id: "vm-0", provider: null, externalId: null })
  expect(computers[1]).toMatchObject({ id: "vm-1", provider: "freestyle", externalId: "id-1" })
  expect(buildDeviceReport(identity, snapshot({ computers: many }))?.computerUse?.computers).toHaveLength(12)
})

test("the change key moves with readiness, permissions, the chosen computer and the flags, not with wording", () => {
  const key = (change: Partial<ComputerDevicesSnapshot> = {}) => deviceReportKey(reportedComputerUse(snapshot(change)))
  const base = key()
  expect(key()).toBe(base)
  const [local, vm] = snapshot().computers
  expect(key({ computers: [{ ...local, detail: "Turn on Screen Recording in System Settings." }, vm] })).toBe(base)
  expect(key({ computers: [{ ...local, readiness: "ready", detail: null }, vm] })).not.toBe(base)
  expect(key({ permissions: { accessibility: true, screenRecording: true } })).not.toBe(base)
  expect(key({ selectedId: "freestyle-vm" })).not.toBe(base)
  expect(key({ remoteEnabled: false })).not.toBe(base)
  expect(key({ computers: [local] })).not.toBe(base)
  expect(key({ enabled: false })).toBe("off")
  expect(deviceReportKey(null)).toBe("off")
})

test("failed reports wait one, two, then five minutes", () => {
  expect(DEVICE_REPORT_BACKOFF_MS).toEqual([60_000, 120_000, 300_000])
  expect([0, 1, 2, 3, 4, 40].map(deviceReportBackoffMs)).toEqual([60_000, 60_000, 120_000, 300_000, 300_000, 300_000])
})

function harness(outcomes: DeviceReportOutcome[] = []) {
  let time = 1_000_000
  let current = snapshot()
  let pending: { run: () => void; at: number } | null = null
  const sent: Array<{ at: number; key: string }> = []
  const reported: string[] = []
  const signals: string[] = []
  let snapshots = 0
  const start = time
  const reporter = createDeviceReporter({
    readIdentity: async () => identity,
    readSnapshot: async () => { snapshots++; return current },
    send: async (report) => {
      sent.push({ at: time - start, key: deviceReportKey(report.computerUse) })
      return outcomes.shift() ?? { kind: "sent", deviceId: "device-1", reportAfterSeconds: 300 }
    },
    onReported: (id) => { reported.push(id) },
    onDisconnected: () => { signals.push("disconnected") },
    onSignInRefused: () => { signals.push("sign_in_refused") },
    now: () => time,
    timers: {
      set: (run, ms) => { pending = { run, at: time + ms }; return pending },
      clear: (handle) => { if (pending === handle) pending = null },
    },
  })
  const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() }
  /** Moves the clock, running every timer that comes due on the way. */
  const advance = async (ms: number) => {
    const end = time + ms
    await settle()
    while (pending && pending.at <= end) {
      const due = pending
      pending = null
      time = Math.max(time, due.at)
      due.run()
      await settle()
    }
    time = end
  }
  return {
    reporter, sent, reported, signals, advance, settle,
    change: (next: Partial<ComputerDevicesSnapshot>) => { current = snapshot(next) },
    waiting: () => pending !== null,
    snapshots: () => snapshots,
  }
}

test("it reports at start, then when the server asks, and marks which device this computer is", async () => {
  const h = harness()
  h.reporter.start()
  await h.advance(0)
  expect(h.sent.map((entry) => entry.at)).toEqual([0])
  expect(h.reported).toEqual(["device-1"])
  await h.advance(299_000)
  expect(h.sent).toHaveLength(1)
  await h.advance(1_000)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 300_000])
})

test("a change is sent after a short wait, at most once per half minute, and a change that reverts is not sent", async () => {
  const h = harness()
  h.reporter.start()
  await h.advance(60_000)
  h.change({ permissions: { accessibility: true, screenRecording: true } })
  await h.reporter.check()
  await h.advance(4_999)
  expect(h.sent).toHaveLength(1)
  await h.advance(1)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 65_000])
  expect(h.sent[1].key).not.toBe(h.sent[0].key)

  // Right after a report, the next change waits out the half minute.
  h.change({ selectedId: "freestyle-vm" })
  await h.reporter.check()
  await h.advance(29_999)
  expect(h.sent).toHaveLength(2)
  await h.advance(1)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 65_000, 95_000])

  await h.advance(60_000)
  h.change({ selectedId: "this-mac" })
  await h.reporter.check()
  h.change({ selectedId: "freestyle-vm" })
  await h.reporter.check()
  await h.advance(60_000)
  expect(h.sent).toHaveLength(3)
})

test("a rate limit waits as long as the server said, and failures back off without stopping", async () => {
  const h = harness([{ kind: "rate_limited", retryAfterSeconds: 90 }, { kind: "failed" }, { kind: "failed" }])
  h.reporter.start()
  await h.advance(89_999)
  expect(h.sent.map((entry) => entry.at)).toEqual([0])
  await h.advance(1)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 90_000])
  await h.advance(60_000)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 90_000, 150_000])
  await h.advance(120_000)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 90_000, 150_000, 270_000])
  expect(h.reported).toEqual(["device-1"])
})

test("a server retry delay longer than one hour is honored in full", async () => {
  const h = harness([{ kind: "rate_limited", retryAfterSeconds: 7200 }])
  h.reporter.start()
  await h.advance(7_199_999)
  expect(h.sent).toHaveLength(1)
  await h.advance(1)
  expect(h.sent.map(entry => entry.at)).toEqual([0, 7_200_000])
})

test("the feature turned off in the organization stops reporting for good", async () => {
  const h = harness([{ kind: "feature_off" }])
  h.reporter.start()
  await h.advance(0)
  expect(h.waiting()).toBe(false)
  await h.reporter.check()
  await h.advance(3_600_000)
  expect(h.sent).toHaveLength(1)
  expect(h.reported).toEqual([])
})

test("a computer disconnected from its organization stops reporting for good and says so once", async () => {
  const h = harness([{ kind: "disconnected" }])
  h.reporter.start()
  await h.advance(0)
  expect(h.signals).toEqual(["disconnected"])
  expect(h.waiting()).toBe(false)
  h.change({ selectedId: "freestyle-vm" })
  await h.reporter.check()
  await h.advance(3_600_000)
  expect(h.sent).toHaveLength(1)
  expect(h.reported).toEqual([])
  expect(h.signals).toEqual(["disconnected"])
})

test("a refused sign-in asks for the sign-in to be checked and waits like any failure", async () => {
  const h = harness([{ kind: "sign_in_refused" }, { kind: "sign_in_refused" }])
  h.reporter.start()
  await h.advance(59_999)
  expect(h.sent.map((entry) => entry.at)).toEqual([0])
  expect(h.signals).toEqual(["sign_in_refused"])
  await h.advance(1)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 60_000])
  expect(h.signals).toEqual(["sign_in_refused", "sign_in_refused"])
  await h.advance(120_000)
  expect(h.sent.map((entry) => entry.at)).toEqual([0, 60_000, 180_000])
  expect(h.reported).toEqual(["device-1"])
  expect(h.signals).toHaveLength(2)
})

test("Den's refusals are told apart: disconnected, sign-in refused, rate limited, feature off, anything else", () => {
  const limited = new DenApiError(429, "rate_limited", "Slow down")
  limited.retryAfterSeconds = 90
  expect(deviceReportFailure(new DenApiError(403, "computer_disconnected", "This computer was disconnected."))).toEqual({ kind: "disconnected" })
  expect(deviceReportFailure(new DenApiError(401, "unauthorized", "Sign in again."))).toEqual({ kind: "sign_in_refused" })
  expect(deviceReportFailure(limited)).toEqual({ kind: "rate_limited", retryAfterSeconds: 90 })
  expect(deviceReportFailure(new DenApiError(429, "rate_limited", "Slow down"))).toEqual({ kind: "rate_limited", retryAfterSeconds: null })
  expect(deviceReportFailure(new DenApiError(404, "feature_disabled", "Off"))).toEqual({ kind: "feature_off" })
  // A 403 for another reason, a 401 a proxy made up and a network error are not verdicts on this computer.
  expect(deviceReportFailure(new DenApiError(403, "forbidden", "No"))).toEqual({ kind: "failed" })
  expect(deviceReportFailure(new DenApiError(401, "request_failed", "Proxy"))).toEqual({ kind: "failed" })
  expect(deviceReportFailure(new DenApiError(401, "computer_disconnected", "Odd"))).toEqual({ kind: "failed" })
  expect(deviceReportFailure(new TypeError("fetch failed"))).toEqual({ kind: "failed" })
})

test("stopping while identity is being read prevents sending the old sign-in's report", async () => {
  let resolveIdentity!: (value: DesktopDeviceIdentity) => void
  const reading = new Promise<DesktopDeviceIdentity>(resolve => { resolveIdentity = resolve })
  let run!: () => void
  let sends = 0
  const reporter = createDeviceReporter({
    readIdentity: () => reading,
    readSnapshot: async () => snapshot(),
    send: async () => { sends++; return { kind: "sent", deviceId: "old-device", reportAfterSeconds: 300 } },
    onReported: () => { throw new Error("Stopped reporter must not publish an identity") },
    timers: { set: next => { run = next }, clear: () => {} },
  })
  reporter.start(); run(); reporter.stop(); resolveIdentity(identity)
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  expect(sends).toBe(0)
})

test("stopping cancels the next report and ignores one already on its way", async () => {
  const h = harness()
  h.reporter.start()
  h.reporter.stop()
  await h.advance(600_000)
  expect(h.sent).toHaveLength(0)
  expect(h.snapshots()).toBe(0)

  const late = harness()
  late.reporter.start()
  await late.advance(0)
  late.reporter.stop()
  await late.reporter.check()
  await late.advance(600_000)
  expect(late.sent).toHaveLength(1)
})

test("an older Den, which knows nothing of disconnecting, still lists devices and takes this desktop's report", async () => {
  // What a Den from before disconnecting sends: no `disconnectedAt`, no `canDisconnect`.
  const device = {
    id: "device-1", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin",
    label: "Ada's MacBook Pro", access: "mine", availability: "online", state: "ready", statusDetail: null,
    lastSeenAt: "2026-11-10T10:00:00Z", createdAt: "2026-11-10T09:00:00Z", appVersion: "0.14.2",
    computerId: "3d0a0b6e-install", workbotChat: null, canRename: true, canRemove: true,
  }
  const requests: string[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    requests.push(`${init?.method ?? "GET"} ${path.slice(path.indexOf("/v1/"))}`)
    return path.endsWith("/v1/remote-devices/this-computer")
      ? Response.json({ device, reportAfterSeconds: 300 })
      : Response.json({ devices: [device] })
  })
  try {
    const client = createDenClient({ baseUrl: "https://den.example.test", token: "fixture-token" })
    expect(await client.listRemoteDevices("org_fixture")).toEqual([{ ...device, disconnectedAt: null, canDisconnect: false, remoteAccess: null }])
    const report = buildDeviceReport(identity, snapshot())
    const answer = await client.reportThisComputer("org_fixture", report!)
    expect(answer.reportAfterSeconds).toBe(300)
    expect(answer.device).toEqual({ ...device, disconnectedAt: null, canDisconnect: false, remoteAccess: null })
    expect(requests).toEqual(["GET /v1/remote-devices", "PUT /v1/remote-devices/this-computer"])
  } finally { fetch.mockRestore() }
})
