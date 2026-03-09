import test from "node:test"
import assert from "node:assert/strict"

import { calculate, classifyAsset, parseCountCell, parseLastDataRow } from "./stats.mjs"

test("classifyAsset buckets manual installer assets", () => {
  const release = { tag_name: "v0.11.135" }

  assert.equal(classifyAsset(release, { name: "openwork-desktop-darwin-aarch64.dmg" }), "manual_install")
  assert.equal(classifyAsset(release, { name: "openwork-desktop-windows-x64.msi" }), "manual_install")
  assert.equal(classifyAsset(release, { name: "openwork-desktop-linux-amd64.deb" }), "manual_install")
})

test("classifyAsset buckets updater and non-desktop assets separately", () => {
  const desktopRelease = { tag_name: "v0.11.135" }
  const sidecarRelease = { tag_name: "openwork-orchestrator-v0.11.135" }

  assert.equal(classifyAsset(desktopRelease, { name: "latest.json" }), "updater")
  assert.equal(classifyAsset(desktopRelease, { name: "openwork-desktop-darwin-aarch64.app.tar.gz" }), "updater")
  assert.equal(classifyAsset(desktopRelease, { name: "openwork-desktop-darwin-aarch64.app.tar.gz.sig" }), "updater")
  assert.equal(classifyAsset(desktopRelease, { name: "openwork-desktop-linux-aarch64.rpm.sig" }), "other")
  assert.equal(classifyAsset(sidecarRelease, { name: "openwork-server-darwin-arm64" }), "other")
})

test("calculate aggregates legacy total and v2 buckets", () => {
  const releases = [
    {
      tag_name: "v0.11.135",
      assets: [
        { name: "openwork-desktop-darwin-aarch64.dmg", download_count: 10 },
        { name: "openwork-desktop-darwin-aarch64.app.tar.gz", download_count: 4 },
        { name: "latest.json", download_count: 6 },
        { name: "openwork-desktop-linux-aarch64.rpm.sig", download_count: 3 },
      ],
    },
    {
      tag_name: "openwork-orchestrator-v0.11.135",
      assets: [{ name: "openwork-server-darwin-arm64", download_count: 8 }],
    },
  ]

  const result = calculate(releases)

  assert.equal(result.total, 31)
  assert.deepEqual(result.buckets, {
    manual_install: 10,
    updater: 10,
    other: 11,
    all: 31,
  })
})

test("table helpers parse formatted rows with deltas", () => {
  const content = [
    "# Download Stats V2",
    "",
    "| Date | Manual Installs | Updater | Other | All Release Assets |",
    "|------|-----------------|---------|-------|--------------------|",
    "| 2026-03-07 | 1,234 (+12) | 567 (+5) | 89 (+1) | 1,890 (+18) |",
  ].join("\n")

  const row = parseLastDataRow(content, 5)

  assert.deepEqual(row, ["2026-03-07", "1,234 (+12)", "567 (+5)", "89 (+1)", "1,890 (+18)"])
  assert.equal(parseCountCell(row[1]), 1234)
  assert.equal(parseCountCell(row[4]), 1890)
})
