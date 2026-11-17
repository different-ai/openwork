#!/usr/bin/env node
/**
 * Checks the production runner fleet (celld nodes on Render) for what ends in refused work, per node.
 *
 * celld closes a node to new cells once its memory passes a ceiling (80% of the machine by default) and reopens it
 * only below 80% of that ceiling. A hibernated cell wakes only on the node that owns it, so every conversation a
 * closed node owns stops answering while the rest of the fleet sits idle. Render's autoscaling reads the fleet
 * average and does not see this. See ee/apps/headless-runner/OWNER-CELLS.md, "When a node is full".
 *
 * Reads only: Render's service settings, memory metrics and log counts, and (when given) celld's own fleet sample
 * from the bucket. Prints a summary; exits 1 when something needs action now.
 */
import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/** celld's defaults: a node closes at 80% of the machine's memory and reopens at 80% of that. */
export const CLOSE_RATIO = 0.8
export const REOPEN_RATIO = CLOSE_RATIO * 0.8
/** Alert before the node closes; warn once it could no longer reopen if it did. */
export const ALERT_RATIO = 0.75
export const WARN_RATIO = 0.65
const HEALTH_PATH = "/.well-known/celld/health"
const SAMPLE_MAX_AGE_MS = 5 * 60_000

const MB = 1024 * 1024
const mb = (bytes) => Math.round(bytes / MB).toLocaleString("en-US")
const percent = (ratio) => `${Math.round(ratio * 100)}%`

/** The celld release a Render build command downloads, or null when it does not name one. */
export function builtCelldVersion(buildCommand) {
  return /celld\/releases\/download\/(v\d+\.\d+\.\d+)\//.exec(buildCommand ?? "")?.[1] ?? null
}

/** Live leases of celld's fleet sample (`fleet/capacity-v1.json`), or null when it is missing, unreadable or old. */
export function liveLeases(sample, now) {
  if (!sample || typeof sample !== "object" || !Array.isArray(sample.leases)) return null
  if (typeof sample.started_ms !== "number" || now - sample.started_ms > SAMPLE_MAX_AGE_MS) return null
  return sample.leases.filter((lease) => lease && typeof lease.node === "string" && typeof lease.expires_ms === "number" && lease.expires_ms > now && lease.load && typeof lease.load === "object")
}

/**
 * `instances`: each node's highest memory in the window. `leases`: celld's own view (optional). `logs`: counts of
 * refused requests and of nodes that stopped themselves in the window. `settings`: what the service is configured with.
 * Returns findings, most serious first; `level` is the most serious one.
 */
export function assessFleet({ instances, memoryLimitBytes, leases = null, logs = {}, settings = null }) {
  const findings = []
  const add = (level, code, text) => findings.push({ level, code, text })

  for (const instance of instances) {
    if (!memoryLimitBytes) break
    const ratio = instance.memoryBytes / memoryLimitBytes
    const size = `${percent(ratio)} of its memory (${mb(instance.memoryBytes)} of ${mb(memoryLimitBytes)} MB)`
    if (ratio >= CLOSE_RATIO) add("alert", "node_closed", `Node ${instance.id} is at ${size}. celld closes a node at ${percent(CLOSE_RATIO)}: the conversations it owns stop answering until it is back under ${percent(REOPEN_RATIO)}. Restart that instance; a normal shutdown hands its cells to the other nodes.`)
    else if (ratio >= ALERT_RATIO) add("alert", "node_memory_high", `Node ${instance.id} is at ${size} and closes to new work at ${percent(CLOSE_RATIO)}.`)
    else if (ratio >= WARN_RATIO) add("warn", "node_memory_rising", `Node ${instance.id} is at ${size}. Above ${percent(REOPEN_RATIO)} a closed node cannot reopen.`)
  }

  for (const lease of leases ?? []) {
    const load = lease.load
    const detail = [
      typeof load.resident_cells === "number" ? `${load.resident_cells} cells in memory` : null,
      typeof load.owned_cells === "number" ? `${load.owned_cells} owned` : null,
      typeof load.rss_bytes === "number" ? `${mb(load.rss_bytes)} MB resident` : null,
      typeof load.in_use_bytes === "number" ? `${mb(load.in_use_bytes)} MB in use` : null,
      typeof load.cgroup_working_set_bytes === "number" ? `${mb(load.cgroup_working_set_bytes)} MB working set` : null,
      typeof load.host_websockets === "number" ? `${load.host_websockets} sockets` : null,
    ].filter(Boolean).join(", ")
    const name = lease.node.slice(0, 13)
    if (load.pressured === true) add("alert", "node_pressured", `celld reports ${name} under memory pressure and refusing new cells (${detail}).`)
    else if (load.memory_headroom === false) add("warn", "node_no_headroom", `celld reports ${name} without memory headroom (${detail}).`)
  }

  if (logs.capacityRefusals > 0) add("alert", "capacity_refusals", `${logs.capacityRefusals}${logs.capacityRefusalsCapped ? "+" : ""} requests were refused for capacity in the last ${logs.windowMinutes} minutes.`)
  if (logs.fences > 0) add("warn", "node_fenced", `${logs.fences} node stop${logs.fences === 1 ? "" : "s"} for a lost lease in the last ${logs.windowMinutes} minutes (celld exit code 3).`)

  if (instances.length > 0 && instances.length < 2) add("alert", "single_node", "Only one node is running: there is no failover.")

  if (settings) {
    const env = settings.env ?? {}
    if (settings.expectedCelldVersion && settings.builtCelldVersion && settings.builtCelldVersion !== settings.expectedCelldVersion) {
      add("warn", "celld_version", `Nodes are built from celld ${settings.builtCelldVersion}; the repo deploys with ${settings.expectedCelldVersion}.`)
    }
    if (env.CELLD_DURABILITY !== "bucket") add("warn", "setting_durability", "CELLD_DURABILITY is not bucket: on temporary disks, acknowledged writes can be lost when every node stops at once.")
    if (!(Number(env.CELLD_TTL_MS) >= 60_000)) add("warn", "setting_ttl", `CELLD_TTL_MS is ${env.CELLD_TTL_MS ?? "unset (10000)"}; 60000 keeps a short storage outage from stopping every node.`)
    if (!env.CELLD_IDLE_EVICT_S) add("warn", "setting_idle_evict", "CELLD_IDLE_EVICT_S is unset: idle cells stay in memory and never move to another node.")
    if (!env.CELLD_LTX_RETENTION_SECS) add("warn", "setting_retention", "CELLD_LTX_RETENTION_SECS is unset: each cell's bucket data grows on every wake.")
    if (settings.healthCheckPath !== HEALTH_PATH) add("warn", "setting_health_path", `The service has no health check on ${HEALTH_PATH}: a rollout does not wait for a new node to be ready.`)
    const stopMs = Number(env.CELLD_SHUTDOWN_TOTAL_MS ?? 40_000)
    if (typeof settings.shutdownGraceSeconds === "number" && settings.shutdownGraceSeconds * 1000 <= stopMs) {
      add("warn", "setting_shutdown_grace", `The shutdown grace (${settings.shutdownGraceSeconds} s) is not above CELLD_SHUTDOWN_TOTAL_MS (${stopMs} ms): a stop can cut the cell handoff.`)
    }
  }

  const order = { alert: 0, warn: 1 }
  findings.sort((a, b) => order[a.level] - order[b.level])
  const level = findings.some((finding) => finding.level === "alert") ? "alert" : findings.length > 0 ? "warn" : "ok"
  return { level, findings }
}

/** The summary as Markdown: findings, then each node's memory. */
export function renderSummary({ level, findings }, { instances, memoryLimitBytes }) {
  const title = level === "alert" ? "Runner fleet needs attention" : level === "warn" ? "Runner fleet: warnings" : "Runner fleet is healthy"
  const lines = [`### ${title}`, ""]
  for (const finding of findings) lines.push(`- ${finding.level === "alert" ? "**Alert:**" : "Warning:"} ${finding.text}`)
  if (findings.length > 0) lines.push("")
  lines.push("| Node | Memory (MB) | Of limit |", "| --- | ---: | ---: |")
  for (const instance of [...instances].sort((a, b) => b.memoryBytes - a.memoryBytes)) {
    lines.push(`| ${instance.id} | ${mb(instance.memoryBytes)} | ${memoryLimitBytes ? percent(instance.memoryBytes / memoryLimitBytes) : "?"} |`)
  }
  return lines.join("\n")
}

/** The alert as one Slack message: only what needs action. */
export function slackText({ findings }, runUrl) {
  const alerts = findings.filter((finding) => finding.level === "alert").map((finding) => `• ${finding.text}`)
  return [":rotating_light: *Cloud runner fleet needs attention*", ...alerts, runUrl ? `<${runUrl}|Details>` : ""].filter(Boolean).join("\n")
}

/** Each instance's highest value across a Render metric's series. */
export function highestPerInstance(series) {
  const highest = new Map()
  for (const entry of Array.isArray(series) ? series : []) {
    const instance = entry.labels?.find((label) => label.field === "instance")?.value
    if (typeof instance !== "string") continue
    const id = instance.split("-").at(-1)
    for (const point of entry.values ?? []) {
      if (typeof point.value === "number") highest.set(id, Math.max(highest.get(id) ?? 0, point.value))
    }
  }
  return [...highest].map(([id, memoryBytes]) => ({ id, memoryBytes }))
}

const SETTING_NAMES = ["CELLD_DURABILITY", "CELLD_TTL_MS", "CELLD_IDLE_EVICT_S", "CELLD_LTX_RETENTION_SECS", "CELLD_SHUTDOWN_TOTAL_MS"]

async function main() {
  const { RENDER_API_KEY: key, RENDER_SERVICE_ID: service, EXPECTED_CELLD_VERSION, FLEET_SAMPLE_FILE, SLACK_WEBHOOK_URL, RUN_URL, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT } = process.env
  if (!key || !service) throw new Error("RENDER_API_KEY and RENDER_SERVICE_ID are required")
  const windowMinutes = Number(process.env.WINDOW_MINUTES ?? 20)
  const now = Date.now()
  const start = new Date(now - windowMinutes * 60_000).toISOString()
  const end = new Date(now).toISOString()
  const render = async (path, params = {}) => {
    const url = new URL(`https://api.render.com/v1/${path}`)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value))
    const response = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Render ${path} answered ${response.status}`)
    return response.json()
  }

  const details = await render(`services/${service}`)
  const range = { resource: service, startTime: start, endTime: end, resolutionSeconds: 300 }
  const instances = highestPerInstance(await render("metrics/memory", range))
  const limit = await render("metrics/memory-limit", range)
  const memoryLimitBytes = limit?.[0]?.values?.at(-1)?.value ?? null
  const count = async (text) => {
    const found = await render("logs", { ownerId: details.ownerId, resource: service, startTime: start, endTime: end, text, limit: 100 })
    return Array.isArray(found.logs) ? found.logs.length : 0
  }
  // celld's own wording, and the router's (`reason: capacity_exhausted`) once it answers these itself.
  const refusedByHost = await count("CapacityExhausted")
  const refusedByRouter = await count("capacity_exhausted")
  const capacityRefusals = refusedByHost + refusedByRouter
  const fences = await count("SELF-FENCE")
  // Only the named settings are read; every other value (credentials among them) is dropped here.
  const variables = await render(`services/${service}/env-vars`, { limit: 100 })
  const env = Object.fromEntries((Array.isArray(variables) ? variables : []).map((entry) => [entry.envVar?.key, entry.envVar?.value]).filter(([name]) => SETTING_NAMES.includes(name)))

  let leases = null
  if (FLEET_SAMPLE_FILE) {
    try {
      leases = liveLeases(JSON.parse(readFileSync(FLEET_SAMPLE_FILE, "utf8")), now)
    } catch {
      // No sample this run: the memory metrics above still decide.
    }
  }

  const input = {
    instances,
    memoryLimitBytes,
    leases,
    logs: { capacityRefusals, capacityRefusalsCapped: refusedByHost >= 100 || refusedByRouter >= 100, fences, windowMinutes },
    settings: {
      expectedCelldVersion: EXPECTED_CELLD_VERSION || null,
      builtCelldVersion: builtCelldVersion(details.serviceDetails?.envSpecificDetails?.buildCommand),
      env,
      healthCheckPath: details.serviceDetails?.healthCheckPath ?? null,
      shutdownGraceSeconds: details.serviceDetails?.maxShutdownDelaySeconds ?? null,
    },
  }
  if (instances.length === 0) throw new Error("Render returned no memory series for the fleet")
  const result = assessFleet(input)
  const summary = renderSummary(result, input)
  console.log(summary)
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${summary}\n`)
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `level=${result.level}\n`)
  if (result.level === "alert" && SLACK_WEBHOOK_URL && process.env.NOTIFY !== "false") {
    const posted = await fetch(SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: slackText(result, RUN_URL) }), signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (!posted?.ok) console.log("::warning::The Slack alert could not be posted.")
  }
  if (result.level === "alert") process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // A check that cannot run is not an all-clear: fail, with the reason and nothing from the responses.
    console.error(`::error::The fleet check could not run: ${error instanceof Error ? error.message : "unknown error"}`)
    process.exitCode = 2
  })
}
