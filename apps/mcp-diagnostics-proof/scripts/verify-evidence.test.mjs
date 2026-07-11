import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  chapters,
  evidenceAssetNames,
  proofMetadata,
  proofBoundaries,
  releaseStatus,
} from "../src/story.ts"
import { chapterIdFromHash } from "../src/chapter-hash.ts"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const evidenceRoot = join(packageRoot, "src", "assets", "evidence")
const canonicalHashes = {
  "step-01-setup.png": "69a27c86281801f7d69ae4c81e42940c56137e59fb91b3cf4adf8b21baf55f54",
  "step-02-network-failure.png": "72ee8d0ba3bef1d6d45b9f24a15ee7b65beef4c0c46a00df9a3282db320cb7d6",
  "step-03-oauth-callback.png": "15baf06744ceb6c1d9c616d821bce866badb25bf2657d444105d4043e6211dfa",
  "step-04-oauth-connected.png": "e165c994586df69a0ecf89e11cf20a84f0421f3eab51026bd98021ffac5714a8",
  "step-05-catalog-test.png": "2ff340e05e3be21313796529a59f02e4d0bd441307d51d3751321639b1ae7410",
  "step-06-version-fault.png": "701a64b9d86058aee54f4f37c87e6e22532bbc60c1c86d23656d413306e26104",
  "step-07-catalog-repaired.png": "8d027a2b9d0bedab9ac6862539d9d97c92666c12af31dc56b2a0b94e5d47bfb9",
  "step-08-provider-denial.png": "391f13af89d4a1f7d94c4198e5f2d1c483dbe18ab3a31089bfd032f1b5f46d4a",
  "step-09-cleanup.png": "b312b7c0adbce00dfe7509e2919dc70bce53e9e9f19e03c05cb87897300bd42e",
}

test("the managerial story has eight chapters and nine unique frames", () => {
  assert.equal(chapters.length, 8)
  const frames = chapters.flatMap((chapter) => chapter.frames)
  assert.equal(frames.length, 9)
  assert.deepEqual(
    new Set(frames.map((frame) => frame.asset)),
    new Set(evidenceAssetNames),
  )
  assert.equal(new Set(chapters.map((chapter) => chapter.id)).size, chapters.length)
  assert.equal(new Set(frames.map((frame) => frame.id)).size, frames.length)
})

test("chapter hashes fail safely and canonically", () => {
  const ids = chapters.map((chapter) => chapter.id)
  assert.equal(chapterIdFromHash("#provider-denial", ids), "provider-denial")
  assert.equal(chapterIdFromHash("#unknown-chapter", ids), null)
  assert.equal(chapterIdFromHash("#%", ids), null)
})

test("every evidence asset is a real, unique PNG from the canonical replay", () => {
  const hashes = new Set()
  for (const assetName of evidenceAssetNames) {
    const path = join(evidenceRoot, assetName)
    assert.equal(existsSync(path), true, `Missing evidence asset: ${assetName}`)
    const content = readFileSync(path)
    assert.equal(content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${assetName} is not a PNG`)
    assert.ok(content.length > 20_000, `${assetName} is unexpectedly small`)
    const hash = createHash("sha256").update(content).digest("hex")
    assert.equal(hash, canonicalHashes[assetName], `${assetName} does not match the canonical run`)
    hashes.add(hash)
  }
  assert.equal(hashes.size, evidenceAssetNames.length, "Evidence frames must not be duplicates")
})

test("provenance and controlled-release status remain explicit", () => {
  assert.equal(proofMetadata.branch, "feature/mcp-diagnostics-integration-rehearsal")
  assert.equal(proofMetadata.baselineHead, "b44089ce")
  assert.equal(proofMetadata.baselineRun, "2026-07-11T21-25-52-239Z")
  assert.equal(proofMetadata.automatedResult, "272 tests · 1,443 expectations")
  assert.equal(proofMetadata.browserResult, "8 operational chapters · 66 assertions · 9 evidence frames")
  assert.ok(proofBoundaries.proves.some((claim) => claim.includes("Work IQ") && claim.includes("Agent 365")))
  assert.deepEqual(
    releaseStatus.map(({ label, value }) => [label, value]),
    [
      ["Agent verified", "Passed"],
      ["Jalil verification", "Not started"],
      ["Controlled parent", "None integrated"],
    ],
  )
})

test("the chapter sources point to the controlled PR set", () => {
  const sources = chapters.flatMap((chapter) => (chapter.source ? [chapter.source] : []))
  assert.deepEqual(
    [...new Set(sources.map((source) => source.url))].sort(),
    [
      "https://github.com/different-ai/openwork/pull/2669",
      "https://github.com/different-ai/openwork/pull/2670",
      "https://github.com/different-ai/openwork/pull/2672",
      "https://github.com/different-ai/openwork/pull/2675",
    ],
  )
  assert.ok(sources.some((source) => source.url.endsWith("/2669") && source.revision === "source head 7b99407c"))
  assert.ok(sources.some((source) => source.url.endsWith("/2670") && source.revision === "source head e1569ec3"))
  assert.ok(sources.some((source) => source.url.endsWith("/2672") && source.revision === "source head 3e84bd30"))
  assert.ok(
    sources.some(
      (source) => source.url.endsWith("/2675") && source.revision === "product baseline b44089ce",
    ),
  )
  assert.ok(
    sources
      .filter((source) => source.url.endsWith("/2675"))
      .every((source) => source.label === "Independent rehearsal #2675"),
  )
  assert.equal(proofMetadata.parentPr.url, "https://github.com/different-ai/openwork/pull/2674")
  assert.equal(proofMetadata.rehearsalPr.url, "https://github.com/different-ai/openwork/pull/2675")
})

test("Step 6 keeps screenshot proof separate from API denial evidence", () => {
  const chapter = chapters.find((entry) => entry.id === "provider-denial")
  assert.ok(chapter)
  assert.ok(chapter.visibleProof.some((claim) => claim.includes("Connected")))
  assert.ok(chapter.visibleProof.some((claim) => claim.includes("API denial payload")))
  assert.ok(chapter.apiEvidence?.includes("category: provider_policy_denied"))
  assert.ok(chapter.apiEvidence?.includes("phase: PROVIDER_AUTHORIZATION"))
  assert.deepEqual(chapter.frames[0].lookFor, ["Connected", "Protocol ready", "4 tools across 2 pages"])
})

test("the checked-in explanation contains no synthetic credential values", () => {
  const serialized = JSON.stringify({ chapters, proofMetadata, releaseStatus })
  for (const forbidden of [
    "mock-preregistered-secret",
    "mock-access-token",
    "mock-refresh-token",
    "OpenWorkDemo123!",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Found forbidden value: ${forbidden}`)
  }
})
