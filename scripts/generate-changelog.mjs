#!/usr/bin/env node

import fs from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const TRACKER_DIR = resolve(ROOT, "changelog")
const OUTPUT_PATH = resolve(ROOT, "packages/docs/changelog.mdx")
const COMPARE_BASE = "https://github.com/different-ai/openwork/compare"
const TRACKER_FILE_PATTERN = /^release-tracker-\d{4}-\d{2}-\d{2}\.md$/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORDINAL_RULES = new Map([
  [1, "st"], [2, "nd"], [3, "rd"],
  [21, "st"], [22, "nd"], [23, "rd"],
  [31, "st"],
])

function ordinal(day) {
  return ORDINAL_RULES.get(day) || "th"
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/** "2026-02-19T17:49:05Z" → "February 19th" */
function formatDate(raw) {
  // Handle non-standard values like "Unreleased draft release. Tagged at `2026-03-22T09:29:16-07:00`."
  const isoMatch = raw.match(/(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)/)
  if (!isoMatch) return null

  const d = new Date(isoMatch[1])
  if (isNaN(d.getTime())) return null

  const month = MONTHS[d.getUTCMonth()]
  const day = d.getUTCDate()
  return `${month} ${day}${ordinal(day)}`
}

/**
 * Build an array of applicable tags for a release.
 *
 * Returns all categories that have count > 0.
 * If none apply, returns ["Misc"].
 */
function resolveTags(features, bugs, deprecated) {
  const tags = []
  if (features > 0) tags.push("🚀 New Features")
  if (bugs > 0) tags.push("🐛 Bug Fixes")
  if (deprecated > 0) tags.push("🏗️ Refactoring")
  return tags.length > 0 ? tags : ["🔧 Misc"]
}

function inferPreviousVersion(version) {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null

  const [major, minor, patch] = match.slice(1).map(Number)
  if (patch <= 0) return null

  return `v${major}.${minor}.${patch - 1}`
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a release-tracker file into structured release objects.
 *
 * Splits on `## v` headings, then extracts `#### ` subsections inside each.
 */
function parseTracker(text) {
  // Split into release blocks. First element is the file header.
  const blocks = text.split(/^## /m).slice(1)

  return blocks.map((block) => {
    const lines = block.split("\n")
    const versionLine = lines[0].trim() // e.g. "v0.11.100"
    const version = versionLine

    // Extract subsections keyed by their #### title
    const sections = {}
    let currentKey = null
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const heading = line.match(/^#### (.+)/)
      if (heading) {
        currentKey = heading[1].trim()
        sections[currentKey] = []
      } else if (currentKey !== null) {
        sections[currentKey].push(line)
      }
    }

    // Trim and join each section's content
    for (const key of Object.keys(sections)) {
      sections[key] = sections[key].join("\n").trim()
    }

    return { version, sections }
  })
}

/**
 * Transform a parsed release into a changelog entry object.
 *
 * @param {object} release  - parsed release block
 * @param {string|null} prevVersion - previous version string for compare URL
 */
function toEntry(release, prevVersion) {
  const s = release.sections

  const releasedAt = s["Released at"]?.replace(/`/g, "").trim() || ""
  const date = releasedAt ? formatDate(releasedAt) : null

  const importance = (s["Release importance"] || "").toLowerCase()
  const isMajor = importance.startsWith("major")

  const oneLiner = s["One-line summary"]?.trim() || ""
  const mainChanges = s["Main changes"]?.trim() || ""
  const title = s["Title"]?.trim() || ""

  const features = parseInt(s["Number of major improvements"] || "0", 10)
  const bugs = parseInt(s["Number of major bugs resolved"] || "0", 10)
  const deprecated = parseInt(s["Number of deprecated features"] || "0", 10)

  const tags = resolveTags(features, bugs, deprecated)

  // Build compare URL from consecutive versions: v0.11.200...v0.11.201
  const compareBaseVersion = prevVersion || inferPreviousVersion(release.version)
  const compareUrl = compareBaseVersion
    ? `${COMPARE_BASE}/${compareBaseVersion}...${release.version}`
    : ""

  return {
    version: release.version,
    date,
    isMajor,
    tags,
    title,
    oneLiner,
    mainChanges,
    compareUrl,
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render a single version block (used inside a grouped day).
 */
function renderVersionBlock(entry) {
  const lines = []

  // Version is the linked heading; title is appended after it.
  if (entry.compareUrl) {
    lines.push(
      entry.title
        ? `  ## [${entry.version}](${entry.compareUrl}): ${entry.title}`
        : `  ## [${entry.version}](${entry.compareUrl})`,
    )
  } else {
    lines.push(entry.title ? `  ## ${entry.version}: ${entry.title}` : `  ## ${entry.version}`)
  }

  lines.push("")

  // Body: major → bullet points, minor → one-liner
  if (entry.isMajor && entry.mainChanges) {
    const indented = entry.mainChanges
      .split("\n")
      .map((l) => (l.length > 0 ? `  ${l}` : ""))
      .join("\n")
    lines.push(indented)
  } else {
    lines.push(`  ${entry.oneLiner}`)
  }

  return lines.join("\n")
}

/**
 * Group entries by date and render each group as a single <Update>.
 * Tags are unioned across all entries in the day.
 * "🔧 Misc" is dropped if any real tag exists.
 */
function renderDayGroup(dayEntries) {
  // Union tags, dedup, drop Misc if real tags exist
  const allTags = [...new Set(dayEntries.flatMap((e) => e.tags))]
  const filtered = allTags.filter((t) => t !== "🔧 Misc")
  const tags = filtered.length > 0 ? filtered : ["🔧 Misc"]

  const tagsJsx = tags.map((t) => `"${t}"`).join(", ")
  const date = dayEntries[0].date

  const lines = []
  lines.push(`<Update label="${date}" tags={[${tagsJsx}]}>`)

  for (const entry of dayEntries) {
    lines.push("")
    lines.push(renderVersionBlock(entry))
  }

  lines.push("")
  lines.push("</Update>")

  return lines.join("\n")
}

function renderChangelog(entries) {
  const header = [
    "---",
    'title: "Changelog"',
    "---",
    "",
  ].join("\n")

  // Filter, reverse (newest first), then group by date
  const valid = entries.filter((e) => e.date !== null).reverse()
  const grouped = []
  for (const entry of valid) {
    const last = grouped[grouped.length - 1]
    if (last && last[0].date === entry.date) {
      last.push(entry)
    } else {
      grouped.push([entry])
    }
  }

  const body = grouped
    .map(renderDayGroup)
    .join("\n\n")

  return header + body + "\n"
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadTrackerReleases() {
  const entries = await fs.readdir(TRACKER_DIR, { withFileTypes: true })
  const trackerFiles = entries
    .filter((entry) => entry.isFile() && TRACKER_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  if (trackerFiles.length === 0) {
    throw new Error(`No tracker files found in ${TRACKER_DIR}`)
  }

  const releases = []
  for (const fileName of trackerFiles) {
    const raw = await fs.readFile(resolve(TRACKER_DIR, fileName), "utf-8")
    releases.push(...parseTracker(raw))
  }

  return { trackerFiles, releases }
}

async function main() {
  const { trackerFiles, releases } = await loadTrackerReleases()
  const entries = releases.map((r, i) => toEntry(r, i > 0 ? releases[i - 1].version : null))
  const output = renderChangelog(entries)

  await fs.writeFile(OUTPUT_PATH, output, "utf-8")
  console.log(`Wrote ${entries.length} entries from ${trackerFiles.length} tracker files to ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
