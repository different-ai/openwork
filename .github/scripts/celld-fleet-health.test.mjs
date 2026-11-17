import assert from "node:assert/strict"
import { test } from "node:test"
import { assessFleet, builtCelldVersion, highestPerInstance, liveLeases, renderSummary, slackText } from "./celld-fleet-health.mjs"

const MB = 1024 * 1024
const LIMIT = 4096 * MB
const node = (id, megabytes) => ({ id, memoryBytes: megabytes * MB })
const codes = (result) => result.findings.map((finding) => finding.code)
const healthySettings = {
  expectedCelldVersion: "v0.6.3",
  builtCelldVersion: "v0.6.3",
  env: { CELLD_DURABILITY: "bucket", CELLD_TTL_MS: "60000", CELLD_IDLE_EVICT_S: "900", CELLD_LTX_RETENTION_SECS: "259200" },
  healthCheckSupported: true,
  healthCheckPath: "/.well-known/celld/health",
  shutdownGraceSeconds: 90,
}

test("one full node alerts while the fleet average looks fine", () => {
  // The fleet on 17 November 2026: 33% on average, under the autoscaler's 40%, with one node closed.
  const instances = [node("xkcfv", 3540), node("dhsx5", 841), node("lv84z", 825), node("58vdj", 201)]
  const result = assessFleet({ instances, memoryLimitBytes: LIMIT, logs: { capacityRefusals: 100, capacityRefusalsCapped: true, fences: 2, windowMinutes: 20 }, settings: healthySettings })
  assert.equal(result.level, "alert")
  assert.deepEqual(codes(result), ["node_closed", "capacity_refusals", "node_fenced"])
  assert.match(result.findings[0].text, /Node xkcfv is at 86% of its memory \(3,540 of 4,096 MB\)/)
  assert.match(slackText(result, "https://example.test/run"), /xkcfv[\s\S]*100\+ requests were refused/)
  assert.doesNotMatch(slackText(result, null), /lost lease/)
  assert.match(renderSummary(result, { instances, memoryLimitBytes: LIMIT }), /\| xkcfv \| 3,540 \| 86% \|/)
})

test("a node is flagged before it closes", () => {
  assert.deepEqual(codes(assessFleet({ instances: [node("a", 3100), node("b", 200)], memoryLimitBytes: LIMIT })), ["node_memory_high"])
  const rising = assessFleet({ instances: [node("a", 2700), node("b", 200)], memoryLimitBytes: LIMIT })
  assert.equal(rising.level, "warn")
  assert.deepEqual(codes(rising), ["node_memory_rising"])
})

test("a healthy fleet with the recommended settings has nothing to report", () => {
  const result = assessFleet({ instances: [node("a", 900), node("b", 700)], memoryLimitBytes: LIMIT, logs: { capacityRefusals: 0, fences: 0, windowMinutes: 20 }, settings: healthySettings })
  assert.deepEqual(result, { level: "ok", findings: [] })
})

test("celld's own pressure flag alerts even when the memory metric has not caught up", () => {
  const leases = [
    { node: "node_fb0b1df68756d6267d09", expires_ms: 2_000, load: { pressured: true, memory_headroom: false, resident_cells: 412, owned_cells: 9000, rss_bytes: 3300 * MB } },
    { node: "node_aaaa", expires_ms: 2_000, load: { pressured: false, memory_headroom: false, resident_cells: 3 } },
    { node: "node_bbbb", expires_ms: 2_000, load: { pressured: false, memory_headroom: true, resident_cells: 5 } },
  ]
  const result = assessFleet({ instances: [node("a", 1000), node("b", 900)], memoryLimitBytes: LIMIT, leases })
  assert.deepEqual(codes(result), ["node_pressured", "node_no_headroom"])
  assert.match(result.findings[0].text, /node_fb0b1df6 under memory pressure and refusing new cells \(412 cells in memory, 9000 owned, 3,300 MB resident\)/)
})

test("only live leases of a recent fleet sample are used", () => {
  const now = 1_000_000
  const lease = (name, expires) => ({ node: name, expires_ms: expires, load: { pressured: false } })
  assert.deepEqual(liveLeases({ started_ms: now - 1_000, leases: [lease("live", now + 5_000), lease("expired", now - 1), { node: "no-load", expires_ms: now + 5_000 }] }, now).map((entry) => entry.node), ["live"])
  assert.equal(liveLeases({ started_ms: now - 10 * 60_000, leases: [lease("live", now + 5_000)] }, now), null)
  assert.equal(liveLeases({ leases: "nope" }, now), null)
  assert.equal(liveLeases(null, now), null)
})

test("settings that drifted from the runner's operations notes are warnings", () => {
  // Production on 17 November 2026.
  const settings = {
    expectedCelldVersion: "v0.6.3",
    builtCelldVersion: builtCelldVersion("mkdir -p bin && curl -fsSL https://github.com/denoland/celld/releases/download/v0.6.2/celld-x86_64-unknown-linux-gnu.gz | gunzip > bin/celld"),
    env: { CELLD_DURABILITY: "bucket", CELLD_TTL_MS: "30000", CELLD_IDLE_EVICT_S: "900", CELLD_LTX_RETENTION_SECS: "259200", CELLD_SHUTDOWN_TOTAL_MS: "60000" },
    // A Render private service has no HTTP health check to set.
    healthCheckSupported: false,
    healthCheckPath: null,
    shutdownGraceSeconds: 90,
  }
  const result = assessFleet({ instances: [node("a", 500), node("b", 400)], memoryLimitBytes: LIMIT, settings })
  assert.equal(result.level, "warn")
  assert.deepEqual(codes(result), ["celld_version", "setting_ttl"])
  // A host that does have one is told when it is not set.
  assert.deepEqual(codes(assessFleet({ instances: [node("a", 500), node("b", 400)], memoryLimitBytes: LIMIT, settings: { ...healthySettings, healthCheckPath: null } })), ["setting_health_path"])
  assert.match(result.findings[0].text, /built from celld v0\.6\.2; the repo deploys with v0\.6\.3/)
  assert.deepEqual(codes(assessFleet({ instances: [node("a", 500), node("b", 400)], memoryLimitBytes: LIMIT, settings: { ...healthySettings, env: {}, shutdownGraceSeconds: 30 } })), ["setting_durability", "setting_ttl", "setting_idle_evict", "setting_retention", "setting_shutdown_grace"])
})

test("a single node is an alert: nothing can take over", () => {
  assert.deepEqual(codes(assessFleet({ instances: [node("a", 500)], memoryLimitBytes: LIMIT })), ["single_node"])
})

test("each instance's highest sample is read from Render's memory series", () => {
  const series = [
    { labels: [{ field: "instance", value: "srv-db3-xkcfv" }, { field: "service", value: "srv-db3" }], values: [{ timestamp: "t1", value: 10 }, { timestamp: "t2", value: 30 }, { timestamp: "t3", value: 20 }] },
    { labels: [{ field: "instance", value: "srv-db3-58vdj" }], values: [{ timestamp: "t1", value: 5 }] },
    { labels: [{ field: "service", value: "srv-db3" }], values: [{ timestamp: "t1", value: 999 }] },
  ]
  assert.deepEqual(highestPerInstance(series), [{ id: "xkcfv", memoryBytes: 30 }, { id: "58vdj", memoryBytes: 5 }])
  assert.deepEqual(highestPerInstance(null), [])
})

test("the celld release is read from the build command", () => {
  assert.equal(builtCelldVersion("curl https://github.com/denoland/celld/releases/download/v0.6.3/celld.gz"), "v0.6.3")
  assert.equal(builtCelldVersion("bash build.sh"), null)
  assert.equal(builtCelldVersion(undefined), null)
})
