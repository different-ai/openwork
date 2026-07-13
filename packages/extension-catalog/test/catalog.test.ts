import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  BUILT_IN_OPENWORK_EXTENSION_MANIFESTS,
  builtInOpenWorkExtensionManifestById,
  DEN_MARKETPLACE_OPENWORK_EXTENSION_IDS,
  DEN_MARKETPLACE_OPENWORK_EXTENSION_MANIFESTS,
  denMarketplaceOpenWorkExtensionManifestById,
} from "../src/index.js"

function jsonFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

test("owns the exact six-item app catalog in declared order", () => {
  assert.deepEqual(
    BUILT_IN_OPENWORK_EXTENSION_MANIFESTS.map((manifest) => manifest.id),
    ["openwork-browser", "computer-use", "openai-image-gen", "openwork-voice", "google-workspace", "ollama"],
  )
  assert.equal(builtInOpenWorkExtensionManifestById("openwork-voice")?.name, "Voice Mode")
  assert.equal(builtInOpenWorkExtensionManifestById("missing"), null)
  assert.equal(Object.isFrozen(BUILT_IN_OPENWORK_EXTENSION_MANIFESTS), true)
  assert.equal(Object.isFrozen(BUILT_IN_OPENWORK_EXTENSION_MANIFESTS[0]?.resources), true)
  // Captured from the pre-convergence app constant; guards every field and order.
  assert.equal(
    jsonFingerprint(BUILT_IN_OPENWORK_EXTENSION_MANIFESTS),
    "a21dbce2596b17cad46747433ca8ceaa4b424754824b42912ea61503892b1a7b",
  )
})

test("makes the historical Den distribution policy explicit", () => {
  assert.deepEqual(
    DEN_MARKETPLACE_OPENWORK_EXTENSION_IDS,
    ["openwork-browser", "computer-use", "openai-image-gen", "google-workspace", "ollama"],
  )
  assert.equal(denMarketplaceOpenWorkExtensionManifestById("openwork-voice"), null)
  assert.equal(DEN_MARKETPLACE_OPENWORK_EXTENSION_MANIFESTS.length, 5)
})

test("preserves the Den compatibility projection without duplicating manifest bodies", () => {
  const computerUse = denMarketplaceOpenWorkExtensionManifestById("computer-use")
  assert.ok(computerUse)
  assert.equal(computerUse.preview, undefined)
  assert.deepEqual(computerUse.setup, {
    instructions: "Computer Use is Mac only. Grant Accessibility and Screen Recording permissions, then connect the local MCP server in this workspace.",
  })
  assert.deepEqual((computerUse.contributions ?? []).map((contribution) => contribution.type), ["setup-instructions", "composer-prompt"])

  const image = denMarketplaceOpenWorkExtensionManifestById("openai-image-gen")
  assert.deepEqual((image?.contributions ?? []).map((contribution) => contribution.type), ["settings-panel", "composer-prompt"])
  assert.equal(Object.isFrozen(DEN_MARKETPLACE_OPENWORK_EXTENSION_MANIFESTS), true)
  // Captured from the pre-convergence Den constant; guards its public payload.
  assert.equal(
    jsonFingerprint(DEN_MARKETPLACE_OPENWORK_EXTENSION_MANIFESTS),
    "d63d7296e1707f3f6ad18330b562d92de7c426fdb9b8072ff9e76f4c3ce2f133",
  )
})
