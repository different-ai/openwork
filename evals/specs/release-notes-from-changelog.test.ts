import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const script = fileURLToPath(new URL("../../scripts/release/release-notes-from-changelog.mjs", import.meta.url))

const changelog = `---
title: "Changelog"
---
<Update label="August 27th" tags={["🚀 New Features"]}>

  ## [v0.18.39](https://github.com/different-ai/openwork/compare/v0.18.38...v0.18.39): Newer release title

  - Newer bullet that must not leak into the older release.

  ## [v0.18.38](https://github.com/different-ai/openwork/compare/v0.18.37...v0.18.38): Target release title

  - First target bullet.
  - Second target bullet.

</Update>

<Update label="August 26th" tags={["🐛 Bug Fixes"]}>

  ## [v0.18.37](https://github.com/different-ai/openwork/compare/v0.18.36...v0.18.37): Older release title

  - Older bullet that must not leak into the target release.

</Update>
`

const staticBody = `## What's new

OpenWork v0.18.38 desktop release.

- Public artifacts use the openwork-* naming convention.

*Windows installers are signed using Microsoft Artifact Signing.*
`

function fixture(): { docs: string; existing: string } {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"))
  const docs = join(dir, "changelog.mdx")
  const existing = join(dir, "existing.md")
  writeFileSync(docs, changelog)
  writeFileSync(existing, staticBody)
  return { docs, existing }
}

test("release notes are extracted for exactly one version and keep the signing note", ({ evidence }) => {
  const { docs, existing } = fixture()
  const notes = execFileSync(process.execPath, [script, "v0.18.38", "--docs", docs, "--existing-body", existing], {
    encoding: "utf8",
  })

  expect(notes.startsWith("## Target release title\n")).toBe(true)
  expect(notes).toContain("- First target bullet.\n- Second target bullet.")
  expect(notes).toContain("[Compare](https://github.com/different-ai/openwork/compare/v0.18.37...v0.18.38)")
  expect(notes).toContain("https://openworklabs.com/docs/changelog")
  expect(notes.trimEnd().endsWith("*Windows installers are signed using Microsoft Artifact Signing.*")).toBe(true)

  expect(notes).not.toContain("Newer bullet")
  expect(notes).not.toContain("Older bullet")
  expect(notes).not.toContain("<Update")
  expect(notes).not.toContain("openwork-* naming convention")

  evidence.recordAssertionEvidence(
    "Generated release notes mirror one docs changelog entry",
    "The target version's title, bullets, and compare link were emitted; neighbouring versions and the static boilerplate were excluded while the Windows signing note was preserved.",
    true,
  )
})

test("release notes extraction fails loudly for an undocumented tag", ({ evidence }) => {
  const { docs } = fixture()
  const result = spawnSync(process.execPath, [script, "v0.18.40", "--docs", docs], { encoding: "utf8" })

  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("v0.18.40 is not documented")

  evidence.recordAssertionEvidence(
    "Undocumented tags never overwrite release notes",
    "The script exited non-zero with no stdout, so the workflow's `gh release edit` step cannot run with empty notes.",
    true,
  )
})
