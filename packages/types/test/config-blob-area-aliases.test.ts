import assert from "node:assert/strict"
import { test } from "node:test"
import {
  CONFIG_AREA_KEYS,
  CONFIG_AREA_KEY_ALIASES,
  canonicalizeConfigBlobAreaKeys,
  configBlobSchema,
  flattenConfigAreas,
  nestConfigAreas,
  parseConfigRef,
  resolveConfigAreaKey,
} from "@openwork/types/den/config-blobs"

const flags = { specVersion: 1, items: [{ id: "sessionTree", name: "Session tree", spec: { enabled: true } }] }

function file(scope: string[], areas: Record<string, unknown>) {
  return { format: "openwork.config-blob", formatVersion: 1, scope, areas }
}

test("an alias never shadows a real area key", () => {
  for (const [alias, key] of Object.entries(CONFIG_AREA_KEY_ALIASES)) {
    assert.equal(CONFIG_AREA_KEYS.some((entry) => entry === alias), false, alias)
    assert.ok(CONFIG_AREA_KEYS.some((entry) => entry === key), key)
  }
  assert.equal(resolveConfigAreaKey("settings.preview_flags"), "settings.features")
  assert.equal(resolveConfigAreaKey("settings.features"), "settings.features")
  assert.equal(resolveConfigAreaKey("settings.previews"), null)
})

test("a file that says settings.features imports as before", () => {
  const raw = file(["settings.features"], { settings: { features: flags } })
  assert.deepEqual(canonicalizeConfigBlobAreaKeys(raw), raw)
  const parsed = configBlobSchema.parse(canonicalizeConfigBlobAreaKeys(raw))
  assert.deepEqual(flattenConfigAreas(parsed.areas), { areas: { "settings.features": flags }, errors: [] })
})

test("a file that says settings.preview_flags is read as settings.features", () => {
  const raw = file(["settings.preview_flags", "members.teams"], { settings: { preview_flags: flags }, members: { teams: { specVersion: 1, items: [] } } })
  assert.equal(configBlobSchema.safeParse(raw).success, false, "the alias is not a key the format itself lists")
  const parsed = configBlobSchema.parse(canonicalizeConfigBlobAreaKeys(raw))
  assert.deepEqual(parsed.scope, ["settings.features", "members.teams"])
  const flat = flattenConfigAreas(parsed.areas)
  assert.deepEqual(flat.errors, [])
  assert.deepEqual(flat.areas["settings.features"], flags)
  assert.deepEqual(Object.keys(nestConfigAreas(flat.areas).settings ?? {}), ["features"], "what is written back uses the area's own key")
})

test("secrets, omitted areas and references may use the alias too", () => {
  const raw = {
    ...file(["settings.preview_flags", "settings.features"], { settings: { preview_flags: flags } }),
    secrets: [{ path: "areas.settings.preview_flags.items[0].spec.token", area: "settings.preview_flags", itemName: "Session tree", field: "token", set: false }],
    omitted: [{ area: "settings.preview_flags", reason: "not exported" }],
  }
  const parsed = configBlobSchema.parse(canonicalizeConfigBlobAreaKeys(raw))
  assert.deepEqual(parsed.scope, ["settings.features"], "both names are one area")
  assert.equal(parsed.secrets?.[0]?.area, "settings.features")
  assert.equal(parsed.omitted?.[0]?.area, "settings.features")
  assert.deepEqual(parseConfigRef("settings.preview_flags/sessionTree"), { area: "settings.features", target: "sessionTree" })
})

test("a file that holds the area under both names is refused", () => {
  const flat = flattenConfigAreas({ settings: { features: flags, preview_flags: flags } })
  assert.deepEqual(flat.errors, ["areas.settings.features and areas.settings.preview_flags are the same area: keep one"])
})

test("an unknown area is still refused, and other values pass through untouched", () => {
  assert.deepEqual(flattenConfigAreas({ settings: { previews: flags } }).errors, ['unknown area "settings.previews"'])
  assert.equal(configBlobSchema.safeParse(canonicalizeConfigBlobAreaKeys(file(["settings.previews"], {}))).success, false)
  assert.equal(canonicalizeConfigBlobAreaKeys(null), null)
  assert.equal(canonicalizeConfigBlobAreaKeys("text"), "text")
  assert.deepEqual(canonicalizeConfigBlobAreaKeys({ scope: "settings.preview_flags" }), { scope: "settings.preview_flags" })
})
