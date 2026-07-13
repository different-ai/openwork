import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  OPEN_WORK_EXTENSION_MANIFEST_LIMITS,
  openWorkExtensionManifestCatalogV1Schema,
  openWorkExtensionManifestV1Schema,
  type OpenWorkExtensionManifest,
  type OpenWorkExtensionResource,
} from "../src/index.js"
import { currentAppManifestFixtures, currentDenManifestFixture } from "./fixtures.js"

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const nested of Object.values(value)) assertDeepFrozen(nested)
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return
  for (const nested of Object.values(value)) deepFreeze(nested)
  Object.freeze(value)
}

function makeResource(index: number): OpenWorkExtensionResource {
  return { id: `resource-${index}`, type: "tool" }
}

function compileTimeReadonly(manifest: OpenWorkExtensionManifest): void {
  // @ts-expect-error Parsed manifest fields are immutable.
  manifest.name = "Changed"
  // @ts-expect-error Parsed manifest collections are immutable.
  manifest.resources.push({ id: "changed", type: "tool" })
  // @ts-expect-error Parsed nested descriptors are immutable.
  manifest.source.trusted = false
}
void compileTimeReadonly

describe("OpenWork extension manifest v1 schema", () => {
  it("round-trips every current app built-in without trimming or reordering values", () => {
    assert.deepEqual(currentAppManifestFixtures.map((manifest) => manifest.id), [
      "openwork-browser",
      "computer-use",
      "openai-image-gen",
      "openwork-voice",
      "google-workspace",
      "ollama",
    ])
    for (const fixture of currentAppManifestFixtures) {
      const snapshot = structuredClone(fixture)
      deepFreeze(fixture)

      const parsed = openWorkExtensionManifestV1Schema.parse(fixture)

      assert.deepEqual(parsed, snapshot)
      assert.notEqual(parsed, fixture)
      assert.notEqual(parsed.resources, fixture.resources)
      assertDeepFrozen(parsed)
    }

    const browser = openWorkExtensionManifestV1Schema.parse(currentAppManifestFixtures[0])
    assert.equal(browser.composer?.prompt.endsWith(" "), true)
    assert.equal(browser.contributions?.[2]?.prompt?.endsWith(" "), true)
  })

  it("accepts the current Den projection vocabulary", () => {
    const parsed = openWorkExtensionManifestV1Schema.parse(currentDenManifestFixture)
    assert.deepEqual(parsed, currentDenManifestFixture)
    assert.equal(parsed.id, "plg_01kxd8pdm8esga5gjzqhch7389")
    assert.equal(parsed.resources[0]?.id, "plg_01kxd8pdm8esga5gjzqhch7389:command")
    assert.equal(parsed.contributions?.[0]?.ref, "den.claudePlugin.setup")
  })

  it("preserves preview, enablement, default, hidden, and platform metadata", () => {
    const catalog = openWorkExtensionManifestCatalogV1Schema.parse(currentAppManifestFixtures)
    const browser = catalog.find((manifest) => manifest.id === "openwork-browser")
    const computerUse = catalog.find((manifest) => manifest.id === "computer-use")
    const voice = catalog.find((manifest) => manifest.id === "openwork-voice")
    assert.ok(browser)
    assert.ok(computerUse)
    assert.ok(voice)

    assert.equal(browser.defaultEnabled, true)
    assert.equal(computerUse.preview, true)
    assert.deepEqual(computerUse.platform, ["darwin"])
    assert.deepEqual(voice.enablement, [
      { type: "toggle-enabled", ref: "openwork-voice", label: "Enabled" },
      { type: "env-set", ref: "OPENAI_API_KEY", label: "OpenAI API key" },
    ])

    const hidden = openWorkExtensionManifestV1Schema.parse({
      ...currentDenManifestFixture,
      defaultEnabled: false,
      defaultHidden: true,
      platform: ["linux", "windows", "web"],
    })
    assert.equal(hidden.defaultEnabled, false)
    assert.equal(hidden.defaultHidden, true)
    assert.deepEqual(hidden.platform, ["linux", "windows", "web"])
  })

  it("strips unknown properties into a normalized copy without mutating input", () => {
    const input = {
      ...currentDenManifestFixture,
      futureTopLevelValue: "ignored by v1",
      source: {
        ...currentDenManifestFixture.source,
        futureSourceValue: true,
      },
      resources: [{
        ...currentDenManifestFixture.resources[0],
        futureResourceValue: 42,
      }],
    }
    const snapshot = structuredClone(input)

    const parsed = openWorkExtensionManifestV1Schema.parse(input)

    assert.deepEqual(input, snapshot)
    assert.deepEqual(parsed, currentDenManifestFixture)
    assert.equal("futureTopLevelValue" in parsed, false)
    assert.equal("futureSourceValue" in parsed.source, false)
    assert.equal("futureResourceValue" in parsed.resources[0], false)
  })

  it("rejects malformed and unversioned identities", () => {
    const base = currentAppManifestFixtures[0]
    for (const id of ["", "contains whitespace", "/absolute", "unsafe/id"]) {
      assert.equal(openWorkExtensionManifestV1Schema.safeParse({ ...base, id }).success, false)
    }
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({ ...base, schemaVersion: 2 }).success, false)
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({ ...base, source: null }).success, false)
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({ ...base, resources: "not-an-array" }).success, false)
  })

  it("bounds identifiers, text, commands, and descriptor collections", () => {
    const base = currentAppManifestFixtures[0]
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({
      ...base,
      id: "x".repeat(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.identifierLength + 1),
    }).success, false)
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({
      ...base,
      description: "x".repeat(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.descriptionLength + 1),
    }).success, false)
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({
      ...base,
      resources: Array.from(
        { length: OPEN_WORK_EXTENSION_MANIFEST_LIMITS.resourceCount + 1 },
        (_, index) => makeResource(index),
      ),
    }).success, false)
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({
      ...base,
      resources: [{
        id: "bounded-command",
        type: "mcp",
        command: Array.from(
          { length: OPEN_WORK_EXTENSION_MANIFEST_LIMITS.commandArgumentCount + 1 },
          (_, index) => `argument-${index}`,
        ),
      }],
    }).success, false)
    assert.equal(openWorkExtensionManifestV1Schema.safeParse({
      ...base,
      contributions: Array.from(
        { length: OPEN_WORK_EXTENSION_MANIFEST_LIMITS.contributionCount + 1 },
        (_, index) => ({ type: "settings-panel", ref: `settings.${index}` }),
      ),
    }).success, false)
  })

  it("rejects duplicate resource identities and bounded-set duplicates", () => {
    const base = currentAppManifestFixtures[0]
    const resource = base.resources[0]
    assert.ok(resource)

    const duplicateResource = openWorkExtensionManifestV1Schema.safeParse({
      ...base,
      resources: [resource, { ...resource }],
    })
    assert.equal(duplicateResource.success, false)
    if (!duplicateResource.success) {
      assert.deepEqual(duplicateResource.error.issues[0]?.path, ["resources", 1, "id"])
    }

    const duplicateNestedValues = [
      { ...base, setup: { requiredEnv: ["OPENAI_API_KEY", "OPENAI_API_KEY"] } },
      { ...base, lifecycle: { reload: ["config", "config"] } },
      { ...base, lifecycle: { detection: ["env:KEY", "env:KEY"] } },
      { ...base, platform: ["web", "web"] },
      {
        ...base,
        enablement: [
          { type: "env-set", ref: "OPENAI_API_KEY", label: "First" },
          { type: "env-set", ref: "OPENAI_API_KEY", label: "Second" },
        ],
      },
    ]
    for (const input of duplicateNestedValues) {
      assert.equal(openWorkExtensionManifestV1Schema.safeParse(input).success, false)
    }
  })

  it("accepts catalogs in order and rejects duplicate or oversized manifest ids", () => {
    const parsed = openWorkExtensionManifestCatalogV1Schema.parse(currentAppManifestFixtures)
    assert.deepEqual(parsed.map((manifest) => manifest.id), currentAppManifestFixtures.map((manifest) => manifest.id))
    assertDeepFrozen(parsed)

    const duplicate = openWorkExtensionManifestCatalogV1Schema.safeParse([
      currentAppManifestFixtures[0],
      currentAppManifestFixtures[0],
    ])
    assert.equal(duplicate.success, false)
    if (!duplicate.success) assert.deepEqual(duplicate.error.issues[0]?.path, [1, "id"])

    const oversized = Array.from(
      { length: OPEN_WORK_EXTENSION_MANIFEST_LIMITS.manifestCount + 1 },
      (_, index) => ({ ...currentDenManifestFixture, id: `manifest-${index}` }),
    )
    assert.equal(openWorkExtensionManifestCatalogV1Schema.safeParse(oversized).success, false)
  })
})
