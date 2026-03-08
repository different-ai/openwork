#!/usr/bin/env node

import fs from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const POSTHOG_KEY = process.env.POSTHOG_KEY || process.env.POSTHOG_API_KEY
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com"
const POSTHOG_LEGACY_EVENT = process.env.POSTHOG_LEGACY_EVENT || process.env.POSTHOG_EVENT || "download"
const POSTHOG_V2_EVENT = process.env.POSTHOG_V2_EVENT || "release_asset_snapshot"
const POSTHOG_DISTINCT_ID = process.env.POSTHOG_DISTINCT_ID || "openwork-download"
const GITHUB_REPO = process.env.GITHUB_REPO || "different-ai/openwork"
const STATS_FILE = process.env.STATS_FILE || "STATS.md"
const STATS_V2_FILE = process.env.STATS_V2_FILE || "STATS_V2.md"

const LEGACY_HEADER = [
  "# Download Stats",
  "",
  "Legacy cumulative release-asset totals. For classified v2 buckets, see `STATS_V2.md`.",
  "",
  "| Date | GitHub Downloads | Total |",
  "|------|------------------|-------|",
].join("\n")

const V2_HEADER = [
  "# Download Stats V2",
  "",
  "Classified GitHub release asset snapshots. `Manual installs` counts installer downloads (`.dmg`, `.msi`, `.deb`, `.rpm`). `Updater` counts updater artifacts (`latest.json`, macOS updater bundles, updater signatures). `Other` captures signatures, sidecars, and uncategorized assets.",
  "",
  "| Date | Manual Installs | Updater | Other | All Release Assets |",
  "|------|-----------------|---------|-------|--------------------|",
].join("\n")

const MANUAL_INSTALL_SUFFIXES = [".dmg", ".msi", ".deb", ".rpm", ".pkg", ".appimage", ".exe"]
const UPDATER_SUFFIXES = ["latest.json", ".blockmap", ".app.tar.gz", ".app.tar.gz.sig"]
const V2_BUCKETS = ["manual_install", "updater", "other", "all"]

async function sendToPostHog(event, properties, distinctId = POSTHOG_DISTINCT_ID) {
  if (!POSTHOG_KEY) {
    console.warn("POSTHOG_KEY not set, skipping PostHog event")
    return
  }

  const response = await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      distinct_id: distinctId,
      api_key: POSTHOG_KEY,
      event,
      properties,
    }),
  }).catch(() => null)

  if (response && !response.ok) {
    console.warn(`PostHog API error: ${response.status}`)
  }
}

function isDesktopRelease(release) {
  return typeof release?.tag_name === "string" && /^v\d/.test(release.tag_name)
}

export function classifyAsset(release, asset) {
  const name = String(asset?.name || "").toLowerCase()

  if (!name) return "other"

  if (isDesktopRelease(release)) {
    if (UPDATER_SUFFIXES.some((suffix) => name === suffix || name.endsWith(suffix))) {
      return "updater"
    }

    if (MANUAL_INSTALL_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      return "manual_install"
    }
  }

  return "other"
}

async function fetchReleases() {
  const releases = []
  let page = 1
  const perPage = 100
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "openwork-download-stats",
  }
  const token = process.env.GITHUB_TOKEN

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  while (true) {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?page=${page}&per_page=${perPage}`
    const response = await fetch(url, { headers })

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }

    const batch = await response.json()
    if (!Array.isArray(batch) || batch.length === 0) break

    releases.push(...batch)
    console.log(`Fetched page ${page} with ${batch.length} releases`)

    if (batch.length < perPage) break
    page += 1
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return releases
}

export function calculate(releases) {
  let legacyTotal = 0
  const buckets = {
    manual_install: 0,
    updater: 0,
    other: 0,
  }
  const stats = []

  for (const release of releases) {
    let downloads = 0
    const assets = []

    for (const asset of release.assets ?? []) {
      const count = Number(asset.download_count) || 0
      const bucket = classifyAsset(release, asset)

      downloads += count
      legacyTotal += count
      buckets[bucket] += count
      assets.push({
        name: asset.name,
        downloads: count,
        bucket,
      })
    }

    stats.push({
      tag: release.tag_name,
      name: release.name,
      downloads,
      assets,
    })
  }

  return {
    total: legacyTotal,
    legacyTotal,
    buckets: {
      ...buckets,
      all: legacyTotal,
    },
    stats,
  }
}

export function parseCountCell(cell) {
  const match = String(cell || "").match(/-?[\d,]+/)
  if (!match) return 0
  return parseInt(match[0].replace(/,/g, ""), 10)
}

export function parseLastDataRow(content, expectedColumns) {
  const lines = String(content || "")
    .trim()
    .split("\n")

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith("|")) continue

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)

    if (cells.length !== expectedColumns) continue
    if (cells[0] === "Date") continue
    if (cells.every((cell) => /^-+$/.test(cell))) continue

    return cells
  }

  return null
}

function formatChange(change) {
  if (change > 0) return ` (+${change.toLocaleString()})`
  if (change < 0) return ` (${change.toLocaleString()})`
  return " (+0)"
}

function withTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`
}

async function loadOrInitialize(filePath, header) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch {
    return `${header}\n`
  }
}

async function saveLegacyStats(githubTotal) {
  const date = new Date().toISOString().split("T")[0]
  let content = await loadOrInitialize(STATS_FILE, LEGACY_HEADER)

  if (!content.includes("| Date | GitHub Downloads | Total |")) {
    content = `${LEGACY_HEADER}\n`
  }

  const previous = parseLastDataRow(content, 3)
  const previousGithub = previous ? parseCountCell(previous[1]) : 0
  const previousTotal = previous ? parseCountCell(previous[2]) : 0

  const githubChange = githubTotal - previousGithub
  const totalChange = githubTotal - previousTotal
  const line = `| ${date} | ${githubTotal.toLocaleString()}${formatChange(githubChange)} | ${githubTotal.toLocaleString()}${formatChange(totalChange)} |\n`

  await fs.writeFile(STATS_FILE, `${withTrailingNewline(content)}${line}`, "utf8")

  console.log(
    `\nAppended legacy stats to ${STATS_FILE}: GitHub ${githubTotal.toLocaleString()}${formatChange(githubChange)}, Total ${githubTotal.toLocaleString()}${formatChange(totalChange)}`,
  )

  return {
    date,
    totals: {
      github: githubTotal,
      total: githubTotal,
    },
    deltas: {
      github: githubChange,
      total: totalChange,
    },
  }
}

async function saveV2Stats(totals) {
  const date = new Date().toISOString().split("T")[0]
  let content = await loadOrInitialize(STATS_V2_FILE, V2_HEADER)

  if (!content.includes("| Date | Manual Installs | Updater | Other | All Release Assets |")) {
    content = `${V2_HEADER}\n`
  }

  const previous = parseLastDataRow(content, 5)
  const previousTotals = {
    manual_install: previous ? parseCountCell(previous[1]) : 0,
    updater: previous ? parseCountCell(previous[2]) : 0,
    other: previous ? parseCountCell(previous[3]) : 0,
    all: previous ? parseCountCell(previous[4]) : 0,
  }

  const deltas = {
    manual_install: totals.manual_install - previousTotals.manual_install,
    updater: totals.updater - previousTotals.updater,
    other: totals.other - previousTotals.other,
    all: totals.all - previousTotals.all,
  }

  const line = `| ${date} | ${totals.manual_install.toLocaleString()}${formatChange(deltas.manual_install)} | ${totals.updater.toLocaleString()}${formatChange(deltas.updater)} | ${totals.other.toLocaleString()}${formatChange(deltas.other)} | ${totals.all.toLocaleString()}${formatChange(deltas.all)} |`

  await fs.writeFile(STATS_V2_FILE, `${withTrailingNewline(content)}${line}\n`, "utf8")

  console.log(
    `Appended classified stats to ${STATS_V2_FILE}: manual ${totals.manual_install.toLocaleString()}${formatChange(deltas.manual_install)}, updater ${totals.updater.toLocaleString()}${formatChange(deltas.updater)}, other ${totals.other.toLocaleString()}${formatChange(deltas.other)}, all ${totals.all.toLocaleString()}${formatChange(deltas.all)}`,
  )

  return {
    date,
    totals,
    deltas,
  }
}

async function sendClassifiedSnapshot(snapshot) {
  for (const bucket of V2_BUCKETS) {
    await sendToPostHog(
      POSTHOG_V2_EVENT,
      {
        metric_version: 2,
        bucket,
        total: snapshot.totals[bucket],
        delta: snapshot.deltas[bucket],
        source: "github",
        repo: GITHUB_REPO,
        date: snapshot.date,
      },
      `${POSTHOG_DISTINCT_ID}-${bucket}`,
    )
  }
}

export async function main() {
  console.log(`Fetching GitHub releases for ${GITHUB_REPO}...\n`)

  const releases = await fetchReleases()
  console.log(`\nFetched ${releases.length} releases total\n`)

  const { total: githubTotal, buckets } = calculate(releases)
  const legacySnapshot = await saveLegacyStats(githubTotal)
  const v2Snapshot = await saveV2Stats(buckets)

  await sendToPostHog(POSTHOG_LEGACY_EVENT, {
    count: githubTotal,
    source: "github",
    repo: GITHUB_REPO,
    date: legacySnapshot.date,
  })

  await sendClassifiedSnapshot(v2Snapshot)

  console.log("=".repeat(60))
  console.log(`TOTAL DOWNLOADS: ${githubTotal.toLocaleString()}`)
  console.log(`  Legacy all assets: ${githubTotal.toLocaleString()}`)
  console.log(`  Manual installs: ${buckets.manual_install.toLocaleString()}`)
  console.log(`  Updater: ${buckets.updater.toLocaleString()}`)
  console.log(`  Other: ${buckets.other.toLocaleString()}`)
  console.log("=".repeat(60))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
