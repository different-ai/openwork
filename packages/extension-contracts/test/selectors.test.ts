import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  extensionContribution,
  extensionEnablementCondition,
  extensionManifestById,
  extensionResource,
  isTrustedBuiltInExtension,
  openWorkExtensionManifestCatalogV1Schema,
  openWorkExtensionManifestV1Schema,
} from "../src/index.js"
import { currentAppManifestFixtures, currentDenManifestFixture } from "./fixtures.js"

describe("extension manifest selectors", () => {
  it("selects resources, contributions, conditions, and manifests by stable vocabulary", () => {
    const catalog = openWorkExtensionManifestCatalogV1Schema.parse(currentAppManifestFixtures)
    const computerUse = extensionManifestById(catalog, "computer-use")
    assert.ok(computerUse)

    assert.equal(extensionResource(computerUse, "mcp"), computerUse.resources[0])
    assert.equal(
      extensionContribution(computerUse, "native-capability"),
      computerUse.contributions?.[1],
    )
    assert.equal(
      extensionEnablementCondition(computerUse, "permission-granted", "screenRecording"),
      computerUse.enablement?.[2],
    )
    assert.equal(extensionManifestById(catalog, "missing"), undefined)
  })

  it("preserves existing first-match semantics without mutating a manifest", () => {
    const manifest = openWorkExtensionManifestV1Schema.parse({
      ...currentDenManifestFixture,
      resources: [
        { id: "first-tool", type: "tool" },
        { id: "second-tool", type: "tool" },
      ],
      contributions: [
        { ref: "first.settings", type: "settings-panel" },
        { ref: "second.settings", type: "settings-panel" },
      ],
    })
    const before = JSON.stringify(manifest)

    assert.equal(extensionResource(manifest, "tool")?.id, "first-tool")
    assert.equal(extensionContribution(manifest, "settings-panel")?.ref, "first.settings")
    assert.equal(JSON.stringify(manifest), before)
  })

  it("handles absent manifests and distinguishes trusted built-ins from projections", () => {
    const builtIn = openWorkExtensionManifestV1Schema.parse(currentAppManifestFixtures[0])
    const den = openWorkExtensionManifestV1Schema.parse(currentDenManifestFixture)

    assert.equal(extensionResource(undefined, "mcp"), undefined)
    assert.equal(extensionContribution(null, "settings-panel"), undefined)
    assert.equal(extensionEnablementCondition(undefined, "env-set"), undefined)
    assert.equal(isTrustedBuiltInExtension(undefined), false)
    assert.equal(isTrustedBuiltInExtension(builtIn), true)
    assert.equal(isTrustedBuiltInExtension(den), false)
  })
})
