import { beforeAll, describe, expect, test } from "bun:test"

let schemas: typeof import("../src/routes/org/plugin-system/schemas.js")

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  schemas = await import("../src/routes/org/plugin-system/schemas.js")
})

describe("Den extension manifest contract", () => {
  test("uses the canonical v1 vocabulary at the API boundary", () => {
    const manifest = schemas.extensionManifestSchema.parse({
      schemaVersion: 1,
      id: "plg_01kxd8pdm8esga5gjzqhch7389",
      name: "Image Tools",
      description: "Adds an image command.",
      preview: true,
      source: {
        format: "claude-plugin",
        origin: "den",
        reference: "plg_01kxd8pdm8esga5gjzqhch7389",
        trusted: false,
        futureSourceField: "ignored",
      },
      resources: [{
        type: "command",
        id: "plg_01kxd8pdm8esga5gjzqhch7389:command",
        required: true,
      }],
      contributions: [{
        type: "setup-instructions",
        ref: "den.claudePlugin.setup",
        location: "settings-detail",
      }],
      enablement: [{
        type: "toggle-enabled",
        ref: "plg_01kxd8pdm8esga5gjzqhch7389",
        label: "Enabled",
      }],
      defaultEnabled: false,
      defaultHidden: true,
      platform: ["linux", "web"],
      futureTopLevelField: "ignored",
    })

    expect(manifest.preview).toBe(true)
    expect(manifest.enablement?.[0]?.type).toBe("toggle-enabled")
    expect(manifest.defaultEnabled).toBe(false)
    expect(manifest.defaultHidden).toBe(true)
    expect(manifest.platform).toEqual(["linux", "web"])
    expect(manifest).not.toHaveProperty("futureTopLevelField")
    expect(manifest.source).not.toHaveProperty("futureSourceField")
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.resources)).toBe(true)
  })

  test("shares source formats and rejects unknown descriptor vocabulary", () => {
    expect(schemas.extensionSourceFormatSchema.parse("openwork-extension-manifest"))
      .toBe("openwork-extension-manifest")

    expect(() => schemas.extensionManifestSchema.parse({
      schemaVersion: 1,
      id: "plugin-test",
      name: "Plugin Test",
      description: "A test plugin.",
      source: { format: "manual", trusted: false },
      resources: [{ type: "future-resource", id: "future" }],
    })).toThrow()
  })
})
