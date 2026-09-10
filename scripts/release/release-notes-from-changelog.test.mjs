import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

function fixture(existingBody = staticBody) {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"))
  const docs = join(dir, "changelog.mdx")
  const existing = join(dir, "existing.md")
  writeFileSync(docs, changelog)
  writeFileSync(existing, existingBody)
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

test("regenerating notes preserves pending and sent notification markers without duplicating them", () => {
  const pending = "<!-- openwork-slack-release:pending -->"
  const sent = "<!-- openwork-slack-release:sent -->"
  for (const markers of [[pending], [sent], [pending, sent]]) {
    const { docs, existing } = fixture(`${staticBody}\n${markers.join("\n")}\n${markers.join("\n")}\n`)
    try {
      const args = [script, "v0.18.38", "--docs", docs, "--existing-body", existing]
      const notes = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 })
      assert(notes.startsWith("## Target release title\n"))
      assert(notes.includes("*Windows installers are signed using Microsoft Artifact Signing.*"))
      assert(!notes.includes("openwork-* naming convention"))
      for (const marker of [pending, sent]) {
        assert.equal(notes.split(marker).length - 1, markers.includes(marker) ? 1 : 0)
      }
      writeFileSync(existing, notes)
      assert.equal(execFileSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 }), notes)
    } finally {
      rmSync(join(docs, ".."), { recursive: true, force: true })
    }
  }
})

test("Slack notification runs in a fresh non-blocking job after changelog, under per-tag concurrency", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/changelog.yml", import.meta.url), "utf8")
  const [changelog, notification] = workflow.split(/^  notify-slack:\n/m)
  assert(notification)
  assert(!changelog.includes("SLACK_BOT_TOKEN"))
  assert(changelog.includes("outputs:\n      stable: ${{ steps.guard.outputs.stable }}"))
  const update = changelog.split(/^      - name: /m).at(-1)
  const notify = notification.split(/^      - name: /m).at(-1)
  assert(update?.startsWith("Update GitHub Release notes\n"))
  assert(update.includes('gh release edit "$TAG" --notes-file /tmp/release_notes.md'))
  assert(update.includes("--existing-body /tmp/existing_release_body.md"))
  assert(notify?.startsWith("Notify Slack of published release\n"))
  assert.match(notification, /^    needs: changelog$/m)
  assert.match(notification, /^    if: needs\.changelog\.outputs\.stable == 'true'$/m)
  assert.match(notification, /^    continue-on-error: true$/m)
  assert.match(notification, /^    timeout-minutes: 3$/m)
  assert(notification.includes("permissions:\n      contents: write"))
  assert(notification.includes("uses: actions/checkout@v6\n        with:\n          ref: dev\n          persist-credentials: false"))
  assert(!notification.includes("download-artifact"))
  assert.match(notify, /^        timeout-minutes: 2$/m)
  assert(notify.includes("TAG: ${{ github.event.release.tag_name || inputs.tag }}"))
  assert(notify.includes("GITHUB_TOKEN: ${{ github.token }}"))
  assert(notify.includes("SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}"))
  assert(notify.includes("SLACK_RELEASE_CHANNEL_ID: ${{ vars.SLACK_RELEASE_CHANNEL_ID }}"))
  assert.match(notify, /^        run: node scripts\/release\/notify-slack\.mjs$/m)
  assert(workflow.includes("concurrency:\n  group: changelog-${{ github.event.release.tag_name || inputs.tag }}\n  cancel-in-progress: false\n"))
})
