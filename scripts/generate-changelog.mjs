#!/usr/bin/env node

import fs from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const TRACKER_PATH = resolve(ROOT, "changelog/release-tracker.md")
const OUTPUT_PATH = resolve(ROOT, "packages/docs/changelog.mdx")
const COMPARE_BASE = "https://github.com/different-ai/openwork/compare"

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
 * Determine the tag for a release.
 *
 * Pick the category with the highest count.
 * Ties are broken by priority: Feature > Bug > Deprecated.
 * If all counts are 0, return "Misc".
 *
 * Returns exactly one of: "New" | "Improved" | "Adjusted" | "Misc"
 */
function resolveTag(features, bugs, deprecated) {
  if (features === 0 && bugs === 0 && deprecated === 0) return "Misc"

  const max = Math.max(features, bugs, deprecated)

  // Priority order: features first, then bugs, then deprecated
  if (features >= max) return "New"
  if (bugs >= max) return "Improved"
  return "Adjusted"
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse release-tracker.md into structured release objects.
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

  const features = parseInt(s["Number of major improvements"] || "0", 10)
  const bugs = parseInt(s["Number of major bugs resolved"] || "0", 10)
  const deprecated = parseInt(s["Number of deprecated features"] || "0", 10)

  const tag = resolveTag(features, bugs, deprecated)

  // Build compare URL from consecutive versions: v0.11.200...v0.11.201
  const compareUrl = prevVersion
    ? `${COMPARE_BASE}/${prevVersion}...${release.version}`
    : ""

  return {
    version: release.version,
    date,
    isMajor,
    tag,
    oneLiner,
    mainChanges,
    compareUrl,
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderEntry(entry) {
  const lines = []

  // Version description with optional compare link
  const description = entry.compareUrl
    ? `[${entry.version}](${entry.compareUrl})`
    : entry.version

  // Open <Update> with date label, version description, and tag
  lines.push(`<Update label="${entry.date}" description="${description}" tags={["${entry.tag}"]}>`)
  lines.push("")

  // Body: major → bullet points, minor → one-liner
  if (entry.isMajor && entry.mainChanges) {
    lines.push(entry.mainChanges)
  } else {
    lines.push(entry.oneLiner)
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

  const body = entries
    .filter((e) => e.date !== null) // skip unparseable dates
    .reverse() // newest first
    .map(renderEntry)
    .join("\n\n")

  return header + body + "\n"
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const raw = await fs.readFile(TRACKER_PATH, "utf-8")
  const releases = parseTracker(raw)
  const entries = releases.map((r, i) => toEntry(r, i > 0 ? releases[i - 1].version : null))
  const output = renderChangelog(entries)

  await fs.writeFile(OUTPUT_PATH, output, "utf-8")
  console.log(`Wrote ${entries.length} entries to ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
