import assert from "node:assert/strict"
import test from "node:test"

import {
  parseArgs,
  pruneDaytonaDevSnapshots,
  pruneDaytonaSnapshots,
  selectDevSnapshotPrunes,
  selectReleaseSnapshotPrunes,
} from "./prune-daytona-dev-snapshots.mjs"

const apiKey = "test-daytona-api-key"
const apiUrl = "https://app.daytona.io/api"

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), init)
}

function snapshot(id, name, createdAt, state = "inactive") {
  return { id, name, state, createdAt }
}

function inventoryFetch(snapshots, sandboxes = []) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.includes("/snapshots?")) {
      return jsonResponse({ items: snapshots, total: snapshots.length })
    }
    if (url.includes("/sandbox?")) {
      return jsonResponse(sandboxes)
    }
    return jsonResponse({})
  }
  return { calls, fetchImpl }
}

test("selection prunes only unprotected dev snapshots", () => {
  const snapshots = [
    snapshot("old", "openwork-dev-old", "2026-01-01T00:00:00Z"),
    snapshot("stopped", "openwork-dev-stopped", "2026-01-02T00:00:00Z"),
    snapshot("explicit", "openwork-dev-explicit", "2026-01-03T00:00:00Z"),
    snapshot("pulling", "openwork-dev-pulling", "2026-01-04T00:00:00Z", "pulling"),
    snapshot("active", "openwork-dev-active-ref", "2026-01-05T00:00:00Z"),
    snapshot("recent-1", "openwork-dev-recent-1", "2026-01-06T00:00:00Z"),
    snapshot("recent-2", "openwork-dev-recent-2", "2026-01-07T00:00:00Z"),
    snapshot("release", "openwork-0.18.23", "2026-01-08T00:00:00Z"),
    snapshot("base", "daytonaio/sandbox:0.8.0", "2026-01-09T00:00:00Z"),
    snapshot("windows", "windows-small", "2026-01-10T00:00:00Z"),
  ]
  const sandboxes = [
    { id: "started", state: "started", snapshot: "openwork-dev-active-ref" },
    { id: "stopped", state: "stopped", snapshot: "openwork-dev-stopped" },
    { id: "archived", state: "archived", snapshot: "openwork-dev-stopped" },
  ]

  const result = selectDevSnapshotPrunes({
    snapshots,
    sandboxes,
    nameBase: "openwork",
    keepNames: ["openwork-dev-explicit"],
    keepCount: 2,
  })

  assert.deepEqual(result.prune.map((item) => item.name), [
    "openwork-dev-old",
    "openwork-dev-stopped",
  ])
  assert.deepEqual(result.keep.map((item) => [item.name, item.reason]), [
    ["openwork-dev-explicit", "explicit"],
    ["openwork-dev-pulling", "in-flight"],
    ["openwork-dev-active-ref", "active-ref"],
    ["openwork-dev-recent-1", "recent"],
    ["openwork-dev-recent-2", "recent"],
  ])
  assert.equal(result.prune.some((item) => !item.name.startsWith("openwork-dev-")), false)
})

test("release selection prunes only unprotected release snapshots", () => {
  const snapshots = [
    snapshot("old", "openwork-0.18.1", "2026-01-01T00:00:00Z"),
    snapshot("rc", "openwork-0.18.2-rc.1", "2026-01-02T00:00:00Z"),
    snapshot("explicit", "openwork-0.18.3", "2026-01-03T00:00:00Z"),
    snapshot("pulling", "openwork-0.18.4", "2026-01-04T00:00:00Z", "pulling"),
    snapshot("active", "openwork-0.18.5", "2026-01-05T00:00:00Z"),
    snapshot("recent-1", "openwork-0.18.6", "2026-01-06T00:00:00Z"),
    snapshot("recent-2", "openwork-0.18.7", "2026-01-07T00:00:00Z"),
    snapshot("dev", "openwork-dev-abc1234", "2026-01-08T00:00:00Z"),
    snapshot("base", "daytonaio/sandbox:0.8.0", "2026-01-09T00:00:00Z"),
    snapshot("windows", "windows-small", "2026-01-10T00:00:00Z"),
  ]
  const sandboxes = [
    { id: "started", state: "started", snapshot: "openwork-0.18.5" },
    { id: "stopped", state: "stopped", snapshot: "openwork-0.18.1" },
  ]

  const result = selectReleaseSnapshotPrunes({
    snapshots,
    sandboxes,
    nameBase: "openwork",
    keepNames: ["openwork-0.18.3"],
    keepCount: 2,
  })

  assert.deepEqual(result.prune.map((item) => item.name), [
    "openwork-0.18.1",
    "openwork-0.18.2-rc.1",
  ])
  assert.deepEqual(result.keep.map((item) => [item.name, item.reason]), [
    ["openwork-0.18.3", "explicit"],
    ["openwork-0.18.4", "in-flight"],
    ["openwork-0.18.5", "active-ref"],
    ["openwork-0.18.6", "recent"],
    ["openwork-0.18.7", "recent"],
  ])
  assert.equal(
    result.prune.concat(result.keep).some((item) => item.name.includes("-dev-")),
    false,
  )
})

test("release channel defaults to keeping the 20 newest release snapshots", async () => {
  const snapshots = Array.from({ length: 21 }, (_, index) =>
    snapshot(
      `release-${index}`,
      `openwork-0.18.${index}`,
      `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    ),
  )
  const { calls, fetchImpl } = inventoryFetch(snapshots)

  const result = await pruneDaytonaSnapshots({
    apiKey,
    channel: "release",
    keepNames: ["openwork-0.18.20"],
    fetchImpl,
    log: () => {},
  })

  assert.deepEqual(result.prune.map((item) => item.name), ["openwork-0.18.0"])
  assert.equal(result.keep.length, 20)
  assert.deepEqual(
    calls.filter((call) => call.options.method === "DELETE").map((call) => call.url),
    [`${apiUrl}/snapshots/release-0`],
  )
})

test("release channel never deletes dev snapshots even when unprotected", async () => {
  const snapshots = [
    snapshot("dev-old", "openwork-dev-old", "2026-01-01T00:00:00Z"),
    snapshot("release-old", "openwork-0.18.1", "2026-01-02T00:00:00Z"),
    snapshot("release-new", "openwork-0.18.2", "2026-01-03T00:00:00Z"),
  ]
  const { calls, fetchImpl } = inventoryFetch(snapshots)

  await pruneDaytonaSnapshots({
    apiKey,
    channel: "release",
    keepNames: ["openwork-0.18.2"],
    keepCount: 1,
    fetchImpl,
    log: () => {},
  })

  assert.deepEqual(
    calls.filter((call) => call.options.method === "DELETE").map((call) => call.url),
    [`${apiUrl}/snapshots/release-old`],
  )
})

test("parseArgs resolves channel and rejects unknown channels", () => {
  const options = parseArgs([
    "--channel",
    "release",
    "--keep",
    "openwork-0.18.2",
  ])
  assert.equal(options.channel, "release")
  assert.equal(options.keepCount, undefined)

  assert.equal(parseArgs(["--keep", "openwork-dev-a"]).channel, "dev")
  assert.throws(
    () => parseArgs(["--channel", "nightly", "--keep", "openwork-dev-a"]),
    /Invalid channel/,
  )
})

test("exactly keepCount in-scope snapshots prunes nothing", () => {
  const snapshots = [
    snapshot("one", "openwork-dev-one", "2026-01-01T00:00:00Z"),
    snapshot("two", "openwork-dev-two", "2026-01-02T00:00:00Z"),
  ]
  const result = selectDevSnapshotPrunes({
    snapshots,
    sandboxes: [],
    nameBase: "openwork",
    keepNames: [],
    keepCount: 2,
  })

  assert.deepEqual(result.prune, [])
})

test("dry-run fetches inventory but sends no DELETE requests", async () => {
  const snapshots = [
    snapshot("old", "openwork-dev-old", "2026-01-01T00:00:00Z"),
    snapshot("new", "openwork-dev-new", "2026-01-02T00:00:00Z"),
  ]
  const { calls, fetchImpl } = inventoryFetch(snapshots)

  const result = await pruneDaytonaDevSnapshots({
    apiKey,
    keepNames: ["openwork-dev-new"],
    keepCount: 1,
    dryRun: true,
    fetchImpl,
    log: () => {},
  })

  assert.deepEqual(result.prune.map((item) => item.id), ["old"])
  assert.equal(calls.filter((call) => call.options.method === "DELETE").length, 0)
  assert.equal(calls.filter((call) => call.options.method === "GET").length, 2)
})

test("real run deletes every selected id and no kept ids", async () => {
  const snapshots = [
    snapshot("old-1", "openwork-dev-old-1", "2026-01-01T00:00:00Z"),
    snapshot("old-2", "openwork-dev-old-2", "2026-01-02T00:00:00Z"),
    snapshot("new", "openwork-dev-new", "2026-01-03T00:00:00Z"),
  ]
  const { calls, fetchImpl } = inventoryFetch(snapshots)

  await pruneDaytonaDevSnapshots({
    apiKey,
    keepNames: ["openwork-dev-new"],
    keepCount: 1,
    fetchImpl,
    log: () => {},
  })

  assert.deepEqual(
    calls.filter((call) => call.options.method === "DELETE").map((call) => call.url),
    [`${apiUrl}/snapshots/old-1`, `${apiUrl}/snapshots/old-2`],
  )
})

test("pagination protects newest snapshots and reads all sandbox pages", async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) =>
    snapshot(
      `old-${index}`,
      `openwork-dev-old-${String(index).padStart(3, "0")}`,
      `2025-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    ),
  )
  const newest = snapshot("newest", "openwork-dev-newest", "2026-01-01T00:00:00Z")
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.includes("/snapshots?")) {
      const page = Number(new URL(url).searchParams.get("page"))
      return jsonResponse({
        items: page === 1 ? firstPage : [newest],
        total: 201,
      })
    }
    if (url.includes("/sandbox?")) {
      const cursor = new URL(url).searchParams.get("cursor")
      return jsonResponse(
        cursor
          ? {
              items: [
                { id: "active", state: "started", snapshot: firstPage[0].name },
              ],
              nextCursor: null,
            }
          : {
              items: Array.from({ length: 200 }, (_, index) => ({
                id: `sandbox-${index}`,
                state: "stopped",
                snapshot: null,
              })),
              nextCursor: "cursor-2",
            },
      )
    }
    return jsonResponse({})
  }

  const result = await pruneDaytonaDevSnapshots({
    apiKey,
    keepNames: [newest.name],
    keepCount: 1,
    fetchImpl,
    log: () => {},
  })

  assert.equal(result.keep.some((item) => item.id === "newest"), true)
  assert.equal(result.keep.some((item) => item.id === "old-0"), true)
  assert.equal(result.prune.length, 199)
  assert.equal(calls.some((call) => call.url.includes("/snapshots/newest")), false)
  assert.equal(calls.some((call) => call.url.includes("/snapshots/old-0")), false)
  assert.equal(calls.some((call) => call.url.endsWith("/snapshots/old-1")), true)
  const sandboxCalls = calls.filter((call) => call.url.includes("/sandbox?"))
  assert.equal(sandboxCalls.length, 2)
  assert.equal(sandboxCalls[1].url.includes("cursor=cursor-2"), true)
  assert.equal(sandboxCalls[1].url.includes("page="), false)
})

test("a failed DELETE does not prevent later deletes and rejects with the result", async () => {
  const snapshots = [
    snapshot("old-1", "openwork-dev-old-1", "2026-01-01T00:00:00Z"),
    snapshot("old-2", "openwork-dev-old-2", "2026-01-02T00:00:00Z"),
    snapshot("new", "openwork-dev-new", "2026-01-03T00:00:00Z"),
  ]
  const calls = []
  const messages = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.includes("/snapshots?")) {
      return jsonResponse({ items: snapshots, total: snapshots.length })
    }
    if (url.includes("/sandbox?")) {
      return jsonResponse([])
    }
    if (url.endsWith("/old-1")) {
      return new Response("upstream exploded", { status: 500 })
    }
    return jsonResponse({})
  }

  await assert.rejects(
    pruneDaytonaDevSnapshots({
      apiKey,
      keepNames: ["openwork-dev-new"],
      keepCount: 1,
      fetchImpl,
      log: (message) => messages.push(message),
    }),
    (error) => {
      assert.equal(error.result.failures.length, 1)
      assert.equal(
        error.result.summary,
        "summary: pruned=1 kept=1 out-of-scope=0 failed=1",
      )
      return true
    },
  )
  assert.deepEqual(
    calls.filter((call) => call.options.method === "DELETE").map((call) => call.url),
    [`${apiUrl}/snapshots/old-1`, `${apiUrl}/snapshots/old-2`],
  )
  assert.equal(messages.at(-1), "summary: pruned=1 kept=1 out-of-scope=0 failed=1")
})
