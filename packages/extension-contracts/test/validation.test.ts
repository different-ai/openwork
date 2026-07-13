import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  validateOpenWorkExtensionManifest,
  validateOpenWorkExtensionManifestCatalog,
} from "../src/index.js"
import { currentAppManifestFixtures, currentDenManifestFixture } from "./fixtures.js"

describe("normalized OpenWork extension validation", () => {
  it("returns an immutable domain result for valid manifests", () => {
    const result = validateOpenWorkExtensionManifest(currentDenManifestFixture)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.deepEqual(result.value, currentDenManifestFixture)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.value), true)
    assert.equal(Object.isFrozen(result.value.resources), true)
  })

  it("normalizes schema failures without exposing a Zod error", () => {
    const result = validateOpenWorkExtensionManifest({
      ...currentAppManifestFixtures[0],
      id: "not valid",
    })
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.deepEqual(result.error, {
      code: "OPENWORK_EXTENSION_CONTRACT_INVALID",
      contract: "openwork-extension-manifest-v1",
      issues: [{
        code: "invalid_format",
        message: "Extension identifiers must start with an ASCII letter or digit and contain only letters, digits, dots, underscores, colons, or hyphens.",
        path: ["id"],
      }],
      message: "Invalid openwork-extension-manifest-v1.",
    })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.error), true)
    assert.equal(Object.isFrozen(result.error.issues), true)
    assert.equal(Object.isFrozen(result.error.issues[0]?.path), true)
    assert.equal("name" in result.error, false)
    assert.doesNotThrow(() => JSON.stringify(result.error))
  })

  it("normalizes duplicate catalog identities with a precise path", () => {
    const result = validateOpenWorkExtensionManifestCatalog([
      currentAppManifestFixtures[0],
      currentAppManifestFixtures[0],
    ])
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.equal(result.error.contract, "openwork-extension-manifest-catalog-v1")
    assert.deepEqual(result.error.issues, [{
      code: "duplicate",
      message: "Duplicate extension manifest id \"openwork-browser\"; first declared at index 0.",
      path: [1, "id"],
    }])
  })

  it("normalizes type and size failures into OpenWork issue codes", () => {
    const typeResult = validateOpenWorkExtensionManifest({
      ...currentAppManifestFixtures[0],
      resources: false,
    })
    assert.equal(typeResult.ok, false)
    if (!typeResult.ok) {
      assert.equal(typeResult.error.issues[0]?.code, "invalid_type")
      assert.deepEqual(typeResult.error.issues[0]?.path, ["resources"])
    }

    const sizeResult = validateOpenWorkExtensionManifest({
      ...currentAppManifestFixtures[0],
      name: "x".repeat(256),
    })
    assert.equal(sizeResult.ok, false)
    if (!sizeResult.ok) {
      assert.equal(sizeResult.error.issues[0]?.code, "size_limit")
      assert.deepEqual(sizeResult.error.issues[0]?.path, ["name"])
    }
  })
})
