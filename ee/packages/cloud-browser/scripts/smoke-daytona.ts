/**
 * End-to-end smoke for the cloud browser on a real host. Prints timings, never
 * secrets or endpoint URLs.
 *
 * Daytona (creates a throwaway member sandbox and deletes it afterwards):
 *   DAYTONA_API_URL=https://app.daytona.io/api DAYTONA_API_KEY=... \
 *     pnpm --filter @openwork-ee/cloud-browser smoke:daytona -- --snapshot <name>
 *   ... -- --build-snapshot   builds a temporary snapshot from
 *                             packaging/docker/Dockerfile.cloud-browser and deletes it after
 *   ... -- --keep             keeps the sandbox (and a built snapshot)
 *
 * Local Chrome (same flow, no cloud):
 *   pnpm --filter @openwork-ee/cloud-browser smoke:daytona -- --host local
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Daytona, Image } from "@daytonaio/sdk"
import { createDaytonaProvider } from "@openwork-ee/cloud-runtime-daytona"
import { createCloudBrowser } from "../src/browser"
import type { BrowserHost, BrowserKey } from "../src/contract"
import { createDaytonaBrowserHost, daytonaBrowserSandboxName } from "../src/hosts/daytona"
import { createLocalBrowserHost } from "../src/hosts/local"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const timings: Record<string, number> = {}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await run()
  } finally {
    timings[label] = Math.round(performance.now() - started)
    console.log(`${label}: ${timings[label]} ms`)
  }
}

async function exercise(host: BrowserHost, key: BrowserKey, options: { warmStart: boolean }) {
  const browser = createCloudBrowser(host)
  console.log("status before open:", JSON.stringify(await browser.status(key)))
  const opened = await timed("cold open (start box + Chrome + load example.com)", () => browser.open(key, { url: "https://example.com/" }))
  console.log("opened:", JSON.stringify(opened))
  const observation = await timed("first observe (with screenshot)", () => browser.observe(key))
  console.log("observed:", JSON.stringify({ title: observation.title, url: observation.url, elements: observation.elements.length, image: observation.image ? `${Math.round(observation.image.data.length * 0.75 / 1024)} KB jpeg` : observation.imageOmitted }))
  await timed("second observe (text only)", () => browser.observe(key, { includeImage: false }))
  const frame = await timed("live-view frame", () => browser.screenshot(key, { quality: 50 }))
  console.log("frame:", frame ? `${Math.round(frame.length / 1024)} KB` : "none")
  await timed("live-view, 5 more frames", async () => {
    for (let index = 0; index < 5; index += 1) await browser.screenshot(key, { quality: 50 })
  })
  console.log("status:", JSON.stringify(await timed("status", () => browser.status(key))))
  await timed("take-over input (click, type, key)", () => browser.input(key, [
    { type: "click", x: 200, y: 200 },
    { type: "text", text: "smoke" },
    { type: "key", key: "Tab" },
  ]))
  console.log("remembered:", JSON.stringify(await timed("remember logins", () => browser.rememberLogins(key))))
  if (!options.warmStart || !host.stop) return
  await timed("stop (Chrome close + box stop)", () => host.stop?.(key) ?? Promise.resolve())
  console.log("status after stop:", JSON.stringify(await browser.status(key)))
  await timed("warm open (start stopped box + Chrome + load)", () => browser.open(key, { url: "https://example.com/" }))
  await timed("observe after warm start", () => browser.observe(key, { includeImage: false }))
}

async function runLocal() {
  const host = createLocalBrowserHost({ profileRoot: mkdtempSync(join(tmpdir(), "owb-smoke-")) })
  try {
    await exercise(host, { organizationId: "org_smoke", memberId: `om_${randomUUID()}` }, { warmStart: true })
  } finally {
    await host.close()
  }
}

async function runDaytona() {
  const apiKey = process.env.DAYTONA_API_KEY?.trim()
  if (!apiKey) throw new Error("Set DAYTONA_API_KEY (and DAYTONA_API_URL) to run the Daytona smoke.")
  const apiUrl = process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api"
  const target = process.env.DAYTONA_TARGET?.trim() || undefined
  const daytona = new Daytona({ apiKey, apiUrl, ...(target ? { target } : {}) })
  let snapshot = option("--snapshot") ?? process.env.CLOUD_BROWSER_DAYTONA_SNAPSHOT?.trim()
  let builtSnapshot: string | null = null
  if (!snapshot) {
    if (!flag("--build-snapshot")) throw new Error("Pass --snapshot <name> or --build-snapshot.")
    builtSnapshot = `openwork-cloud-browser-smoke-${Date.now().toString(36)}`
    snapshot = builtSnapshot
    await timed("snapshot build (server side)", () => daytona.snapshot.create({
      name: builtSnapshot ?? "",
      image: Image.fromDockerfile(join(repoRoot, "packaging/docker/Dockerfile.cloud-browser")),
      resources: { cpu: 1, memory: 2, disk: 4 },
    }, { onLogs: (chunk) => process.stdout.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`), timeout: 1_200 }))
  }
  const provider = createDaytonaProvider({
    apiKey,
    apiUrl,
    target,
    snapshot,
    image: "unused",
    resources: { cpu: 1, memoryGb: 2, diskGb: 4 },
    pollIntervalMs: 1_000,
    helperCreateTimeoutMs: 120_000,
  })
  const prefix = "owb-smoke"
  const host = createDaytonaBrowserHost({ provider, snapshot, namePrefix: prefix, startTimeoutMs: 180_000 })
  const key: BrowserKey = { organizationId: "org_smoke", memberId: `om_${randomUUID()}` }
  const name = daytonaBrowserSandboxName(key, prefix)
  console.log(`sandbox: ${name} (snapshot ${snapshot})`)
  try {
    await exercise(host, key, { warmStart: true })
  } finally {
    if (!flag("--keep")) {
      await daytona.get(name).then((sandbox) => sandbox.delete(120)).then(() => console.log("sandbox deleted"), (error: unknown) => console.log("sandbox delete failed:", error instanceof Error ? error.message : String(error)))
      if (builtSnapshot) {
        await daytona.snapshot.get(builtSnapshot).then((built) => daytona.snapshot.delete(built)).then(() => console.log("snapshot deleted"), (error: unknown) => console.log("snapshot delete failed:", error instanceof Error ? error.message : String(error)))
      }
    }
  }
}

try {
  await (option("--host") === "local" ? runLocal() : runDaytona())
  console.log("timings:", JSON.stringify(timings))
} catch (error) {
  console.log("timings:", JSON.stringify(timings))
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
}
