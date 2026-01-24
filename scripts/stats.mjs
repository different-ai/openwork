#!/usr/bin/env node

const POSTHOG_KEY = process.env.POSTHOG_KEY || process.env.POSTHOG_API_KEY
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com"
const POSTHOG_EVENT = process.env.POSTHOG_EVENT || "download"
const POSTHOG_DISTINCT_ID = process.env.POSTHOG_DISTINCT_ID || "openwork-download"
const GITHUB_REPO = process.env.GITHUB_REPO || "different-ai/openwork"
const STATS_FILE = process.env.STATS_FILE || "STATS.md"

async function sendToPostHog(event, properties) {
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
      distinct_id: POSTHOG_DISTINCT_ID,
      api_key: POSTHOG_KEY,
      event,
      properties,
    }),
  }).catch(() => null)

  if (response && !response.ok) {
    console.warn(`PostHog API error: ${response.status}`)
  }
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

function calculate(releases) {
  let total = 0
  const stats = []

  for (const release of releases) {
    let downloads = 0
    const assets = []

    for (const asset of release.assets ?? []) {
      downloads += asset.download_count
      assets.push({
        name: asset.name,
        downloads: asset.download_count,
      })
    }

    total += downloads
    stats.push({
      tag: release.tag_name,
      name: release.name,
      downloads,
      assets,
    })
  }

  return { total, stats }
}

async function save(githubTotal) {
  const date = new Date().toISOString().split("T")[0]
  const total = githubTotal

  let previousGithub = 0
  let previousTotal = 0
  let content = ""

  try {
    const file = await import("node:fs/promises")
    content = await file.readFile(STATS_FILE, "utf8")
    const lines = content.trim().split("\n")

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      if (line.startsWith("|") && !line.includes("Date") && !line.includes("---")) {
        const match = line.match(
          /\|\s*[\d-]+\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|\s*([\d,]+)\s*(?:\([^)]*\))?\s*\|/,
        )
        if (match) {
          previousGithub = parseInt(match[1].replace(/,/g, ""), 10)
          previousTotal = parseInt(match[2].replace(/,/g, ""), 10)
          break
        }
      }
    }
  } catch {
    content =
      "# Download Stats\n\n| Date | GitHub Downloads | Total |\n|------|------------------|-------|\n"
  }

  const githubChange = githubTotal - previousGithub
  const totalChange = total - previousTotal

  const githubChangeStr =
    githubChange > 0
      ? ` (+${githubChange.toLocaleString()})`
      : githubChange < 0
        ? ` (${githubChange.toLocaleString()})`
        : " (+0)"
  const totalChangeStr =
    totalChange > 0
      ? ` (+${totalChange.toLocaleString()})`
      : totalChange < 0
        ? ` (${totalChange.toLocaleString()})`
        : " (+0)"
  const line = `| ${date} | ${githubTotal.toLocaleString()}${githubChangeStr} | ${total.toLocaleString()}${totalChangeStr} |\n`

  if (!content.includes("# Download Stats")) {
    content =
      "# Download Stats\n\n| Date | GitHub Downloads | Total |\n|------|------------------|-------|\n"
  }

  const file = await import("node:fs/promises")
  await file.writeFile(STATS_FILE, content + line, "utf8")

  console.log(
    `\nAppended stats to ${STATS_FILE}: GitHub ${githubTotal.toLocaleString()}${githubChangeStr}, Total ${total.toLocaleString()}${totalChangeStr}`,
  )
}

console.log(`Fetching GitHub releases for ${GITHUB_REPO}...\n`)

const releases = await fetchReleases()
console.log(`\nFetched ${releases.length} releases total\n`)

const { total: githubTotal } = calculate(releases)

await save(githubTotal)

await sendToPostHog(POSTHOG_EVENT, {
  count: githubTotal,
  source: "github",
  repo: GITHUB_REPO,
})

console.log("=".repeat(60))
console.log(`TOTAL DOWNLOADS: ${githubTotal.toLocaleString()}`)
console.log(`  GitHub: ${githubTotal.toLocaleString()}`)
console.log("=".repeat(60))
