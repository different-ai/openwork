#!/usr/bin/env node
// Waits until every instance of a celld fleet's Render service has logged adopting a deployed version:
//
//   RENDER_API_KEY=… RENDER_OWNER_ID=tea-… RENDER_SERVICE_ID=srv-… node scripts/celld-wait-adopted.mjs <version>
//
// Nodes poll the bucket every 30 seconds and log `deployment_adopted` with the version. Exits 0 once as many
// instances have logged it as the service runs, 1 if they have not within CELLD_ADOPT_WAIT_S seconds (default 300).
// CELLD_ADOPT_SINCE (an ISO time, default five minutes ago) is where the log search starts. In GitHub Actions it also
// writes `adopted` and `instances` as step outputs.
import { appendFileSync } from "node:fs"

const version = process.argv[2] ?? ""
const { RENDER_API_KEY: key, RENDER_OWNER_ID: owner, RENDER_SERVICE_ID: service } = process.env
if (!/^[0-9a-f]{8,64}$/u.test(version) || !key || !owner || !service) {
  console.error("Pass the deployed version, and set RENDER_API_KEY, RENDER_OWNER_ID and RENDER_SERVICE_ID.")
  process.exit(2)
}
const waitSeconds = Number(process.env.CELLD_ADOPT_WAIT_S ?? 300)
const since = process.env.CELLD_ADOPT_SINCE || new Date(Date.now() - 5 * 60_000).toISOString()

async function render(path, query = {}) {
  const url = new URL(`https://api.render.com/v1/${path}`)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Render answered ${response.status} for ${path}`)
  return response.json()
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

const instances = (await render(`services/${service}`)).serviceDetails?.numInstances
if (!Number.isInteger(instances) || instances < 1) throw new Error("Render did not say how many instances the service runs")
output("instances", instances)

const deadline = Date.now() + waitSeconds * 1000
let adopted = 0
for (;;) {
  try {
    const { logs = [] } = await render("logs", { ownerId: owner, resource: service, text: "deployment_adopted", startTime: since, limit: "100" })
    adopted = new Set(logs
      .filter((entry) => typeof entry.message === "string" && entry.message.includes(`version=${version}`))
      .map((entry) => entry.labels?.find((label) => label.name === "instance")?.value)
      .filter(Boolean)).size
  } catch (cause) {
    // A failed log read counts as no progress this round rather than ending the wait.
    console.log(`could not read the logs: ${cause instanceof Error ? cause.message : "unknown error"}`)
  }
  console.log(`adopted on ${adopted} of ${instances} nodes`)
  if (adopted >= instances || Date.now() >= deadline) break
  await new Promise((resolve) => setTimeout(resolve, 10_000))
}
output("adopted", adopted)
if (adopted < instances) {
  console.error(`Not every node adopted ${version} within ${waitSeconds} seconds.`)
  process.exit(1)
}
