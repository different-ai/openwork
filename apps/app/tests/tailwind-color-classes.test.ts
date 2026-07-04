import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { radixColors } from "../src/styles/tailwind-colors"

// The app's Tailwind theme replaces the default palette entirely with the
// Radix families in tailwind-colors.ts (steps 1-12 plus a1-a12). Any class
// using a family or step outside that set compiles to no CSS rule at all and
// the element silently renders unstyled. This test scans source for color
// utility classes and fails on ones that cannot resolve.

const SRC_DIR = join(import.meta.dir, "..", "src")

const COLOR_PREFIXES =
  "bg|text|border|ring|outline|divide|decoration|accent|caret|fill|stroke|shadow|from|via|to"

// e.g. bg-emerald-500, text-amber-11/70, via-sky-300
const COLOR_CLASS = new RegExp(`\\b(?:${COLOR_PREFIXES})-([a-z]+)-(a?\\d+)(?:/\\d+)?\\b`, "g")

const RADIX_FAMILIES = new Set(Object.keys(radixColors))

// Default Tailwind families that do not exist in the Radix palette. Only
// these are treated as errors when seen with a numeric step; other unmatched
// words (t, x, y, ...) are directional modifiers, not colors.
const REMOVED_TAILWIND_FAMILIES = new Set([
  "zinc",
  "neutral",
  "stone",
  "emerald",
  "rose",
  "fuchsia",
])

const VALID_STEPS = new Set(
  Array.from({ length: 12 }, (_, i) => `${i + 1}`).concat(
    Array.from({ length: 12 }, (_, i) => `a${i + 1}`),
  ),
)

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe("Tailwind color classes", () => {
  test("every color class resolves to a token in the Radix palette", () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, "utf8")
      for (const match of content.matchAll(COLOR_CLASS)) {
        const [cls, family, step] = match
        const familyExists = RADIX_FAMILIES.has(family)
        if (familyExists && VALID_STEPS.has(step)) continue
        if (!familyExists && !REMOVED_TAILWIND_FAMILIES.has(family)) continue
        const line = content.slice(0, match.index).split("\n").length
        offenders.push(`${file}:${line} ${cls}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
