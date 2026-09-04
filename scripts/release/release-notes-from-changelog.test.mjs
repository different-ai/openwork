import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./release-notes-from-changelog.mjs", import.meta.url))

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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"))
  const docs = join(dir, "changelog.mdx")
  const existing = join(dir, "existing.md")
  writeFileSync(docs, changelog)
  writeFileSync(existing, staticBody)
  return { docs, existing }
}

test("release notes are extracted for exactly one version and keep the signing note", () => {
  const { docs, existing } = fixture()
  try {
    const notes = execFileSync(process.execPath, [script, "v0.18.38", "--docs", docs, "--existing-body", existing], {
      encoding: "utf8",
    })

    assert(notes.startsWith("## Target release title\n"))
    assert(notes.includes("- First target bullet.\n- Second target bullet."))
    const links = new Set(notes.match(/https?:\/\/[^\s)]+/g))
    assert(links.has("https://github.com/different-ai/openwork/compare/v0.18.37...v0.18.38"))
    assert(links.has("https://openworklabs.com/docs/changelog"))
    assert(notes.trimEnd().endsWith("*Windows installers are signed using Microsoft Artifact Signing.*"))

    assert(!notes.includes("Newer bullet"))
    assert(!notes.includes("Older bullet"))
    assert(!notes.includes("<Update"))
    assert(!notes.includes("openwork-* naming convention"))
  } finally {
    rmSync(join(docs, ".."), { recursive: true, force: true })
  }
})

test("release notes extraction fails loudly for an undocumented tag", () => {
  const { docs } = fixture()
  try {
    const result = spawnSync(process.execPath, [script, "v0.18.40", "--docs", docs], { encoding: "utf8" })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert(result.stderr.includes("v0.18.40 is not documented"))
  } finally {
    rmSync(join(docs, ".."), { recursive: true, force: true })
  }
})
