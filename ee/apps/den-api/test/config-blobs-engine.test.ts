/**
 * The config-blob engine (src/config-blobs/engine) against fake areas:
 * teams (unique name natural key, people refs), providers (team refs, a
 * secret, keyed and ordered arrays) and an MCP area available on cloud only.
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { z } from "zod"
import type {
  ConfigApplyReport,
  ConfigAreaKey,
  ConfigBlobArea,
  ConfigDecisions,
  ConfigPlan,
  ConfigPlanItem,
  ConfigSecretInput,
  ConfigSpec,
  ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { CONFIG_AREA_KEYS, EMPTY_CONFIG_DECISIONS, flattenConfigAreas } from "@openwork/types/den/config-blobs"
import { ConfigApplyItemError, type ConfigApplyOp, type ConfigArea, type ConfigAreaContext, type ConfigItem } from "../src/config-blobs/area.js"
import {
  baseHash,
  buildPlan,
  canonicalJson,
  checkWrittenItems,
  executePlan,
  interruptReport,
  parseStoredExecution,
  preflightKey,
  readItemsFor,
  runPreflight,
  type ApplyRead,
  matchArea,
  rewriteRefs,
  secretsNeedingValues,
  itemRev,
  sortAreas,
  specRev,
  type BuildPlanInput,
} from "../src/config-blobs/engine/index.js"

// ---------------------------------------------------------------------------
// Fake areas over an in-memory store

type Store = Map<ConfigAreaKey, ConfigItem[]>
type Call = { area: ConfigAreaKey; op: ConfigApplyOp }

const specSchema: z.ZodType<ConfigSpec> = z.record(z.string(), z.unknown())
const normalizedName = (item: { name: string }) => item.name.trim().toLowerCase()

function makeAreas(store: Store, calls: Call[], overrides: Partial<Record<ConfigAreaKey, Partial<ConfigArea>>> = {}): ConfigArea[] {
  let counter = 0
  const base = (key: ConfigAreaKey, prefix: string, extra: Partial<ConfigArea>): ConfigArea => ({
    key,
    label: key,
    path: [key],
    specVersion: 1,
    specSchema,
    dependsOn: [],
    deployments: ["cloud", "self_hosted"],
    viewPermission: "teams.view",
    managePermission: "teams.manage",
    tables: [],
    naturalKeys: [],
    secretFields: [],
    transactional: true,
    exportItems: async () => store.get(key) ?? [],
    apply: async (_ctx, op) => {
      calls.push({ area: key, op })
      const items = store.get(key) ?? []
      store.set(key, items)
      if (op.kind === "delete") {
        store.set(key, items.filter((item) => item.id !== op.targetId))
        return { localId: op.targetId }
      }
      if (op.kind === "update") {
        const index = items.findIndex((item) => item.id === op.targetId)
        items[index] = { id: op.targetId, key: op.item.key ?? null, name: op.item.name, spec: op.item.spec }
        return { localId: op.targetId }
      }
      counter += 1
      const localId = op.preferredId ?? `${prefix}_new${counter}`
      items.push({ id: localId, key: op.item.key ?? null, name: op.item.name, spec: op.item.spec })
      return { localId }
    },
    ...extra,
    ...overrides[key],
  })
  return [
    base("ai-gateway.providers", "ipr", {
      dependsOn: ["members.teams"],
      secretFields: ["credentials.apiKey"],
      orderedArrays: ["fallback"],
      naturalKeys: [],
      viewPermission: "gateway_providers.view",
      managePermission: "gateway_providers.manage",
    }),
    base("members.teams", "tem", {
      naturalKeys: [{ label: "name", get: normalizedName }],
      uniqueFields: [{ label: "name", get: normalizedName }],
    }),
    base("connectors.mcp", "mcp", { deployments: ["cloud"] }),
    base("members.people", "om", {
      dependsOn: ["members.teams"],
      naturalKeys: [{ label: "email", get: (person) => (typeof person.spec.email === "string" ? person.spec.email : null) }],
      informationalName: true,
      informationalFields: ["status"],
      specSchema: z.object({
        email: z.string().email(),
        role: z.string(),
        status: z.enum(["active", "invited"]).default("invited"),
        teams: z.array(z.object({ $ref: z.string(), name: z.string().optional() }).strict()).default([]),
        managedBy: z.enum(["manual", "sso", "scim"]).default("manual"),
      }).strict(),
    }),
  ]
}

const ada = { $ref: "people/ada@example.com" }

function seed(): Store {
  return new Map<ConfigAreaKey, ConfigItem[]>([
    ["members.teams", [
      { id: "tem_A", key: "platform", name: "Platform", spec: { description: "core", members: [ada] } },
      { id: "tem_B", key: null, name: "Design", spec: { description: "", members: [] } },
    ]],
    ["ai-gateway.providers", [
      {
        id: "ipr_A",
        key: "anthropic-prod",
        name: "Anthropic (prod)",
        spec: {
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com",
          models: [
            { id: "ipm_1", modelId: "claude-sonnet", enabled: true },
            { id: "ipm_2", modelId: "claude-opus", enabled: false },
          ],
          fallback: ["claude-sonnet", "claude-opus"],
          access: { orgWide: false, teams: [{ $ref: "members.teams/tem_A", name: "Platform" }] },
          credentials: { apiKey: { $secret: "ai-gateway.providers/ipr_A/credentials.apiKey", set: true } },
        },
      },
    ]],
    ["connectors.mcp", []],
  ])
}

function exportBlob(store: Store, areas: ConfigArea[], keys: ConfigAreaKey[]): Partial<Record<ConfigAreaKey, ConfigBlobArea>> {
  const out: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {}
  for (const key of keys) {
    const area = areas.find((candidate) => candidate.key === key)!
    out[key] = {
      specVersion: 1,
      items: structuredClone(store.get(key) ?? []).map((item) => ({ id: item.id, key: item.key ?? null, name: item.name, rev: itemRev(area, item), spec: item.spec })),
    }
  }
  return out
}

function planInput(store: Store, areas: ConfigArea[], blobAreas: Partial<Record<ConfigAreaKey, ConfigBlobArea>>, extra: Partial<BuildPlanInput> = {}): BuildPlanInput {
  return {
    areas,
    blobAreas,
    scope: Object.keys(blobAreas).filter((key): key is ConfigAreaKey => areas.some((area) => area.key === key)),
    mode: "merge",
    targetItems: new Map(structuredClone([...store.entries()])),
    people: new Map([["ada@example.com", "om_ada"]]),
    deployment: "cloud",
    features: {},
    ...extra,
  }
}

function items(plan: ConfigPlan, area: ConfigAreaKey): ConfigPlanItem[] {
  return plan.areas.find((entry) => entry.area === area)?.items ?? []
}

function item(plan: ConfigPlan, area: ConfigAreaKey, ref: string): ConfigPlanItem {
  const found = items(plan, area).find((entry) => entry.ref === ref)
  assert.ok(found, `no plan item ${area} ${ref}`)
  return found
}

function decisions(partial: Partial<ConfigDecisions>): ConfigDecisions {
  return { ...EMPTY_CONFIG_DECISIONS, ...partial }
}

// A test-only context: the fake adapters never touch the database.
const ctx = { db: undefined, organizationId: "org_target", actor: { userId: "usr_1", memberId: "om_ada" }, deployment: "cloud", features: {} } as unknown as ConfigAreaContext

const keepKey: ConfigSecretInput = { path: "ai-gateway.providers/ipr_A/credentials.apiKey", decision: "keep" }

// ---------------------------------------------------------------------------

describe("canonical JSON and hashes", () => {
  const layout = { orderedArrays: ["fallback"], arrayKeys: { "entries[].limits": "kind" } }

  test("key order and set order do not matter, ordered arrays do", () => {
    const a = { b: 1, a: [{ id: "y" }, { id: "x" }], fallback: ["1", "2"], tags: ["b", "a"] }
    const b = { tags: ["a", "b"], fallback: ["1", "2"], a: [{ id: "x" }, { id: "y" }], b: 1 }
    assert.equal(canonicalJson(layout, a), canonicalJson(layout, b))
    assert.notEqual(specRev(layout, a), specRev(layout, { ...b, fallback: ["2", "1"] }))
    assert.match(specRev(layout, a), /^sha256:[a-f0-9]{64}$/)
  })

  test("arrayKeys sort nested sets; integer-like keys are sorted as strings", () => {
    const a = { entries: [{ id: "e", limits: [{ kind: "b", n: 1 }, { kind: "a", n: 2 }] }], "10": 1, "2": 2 }
    const b = { "2": 2, "10": 1, entries: [{ id: "e", limits: [{ kind: "a", n: 2 }, { kind: "b", n: 1 }] }] }
    assert.equal(canonicalJson(layout, a), canonicalJson(layout, b))
    assert.ok(canonicalJson(layout, a).startsWith('{"10":1,"2":2'))
  })

  test("ref name hints and secret decisions are not hashed", () => {
    const exported = { team: { $ref: "members.teams/tem_A", name: "Platform" }, key: { $secret: "x/ipr_A/key", set: true } }
    const edited = { team: { $ref: "members.teams/tem_A", name: "Renamed" }, key: { $secret: "x/ipr_A/key", keep: true } }
    assert.equal(specRev({}, exported), specRev({}, edited))
    assert.notEqual(specRev({}, exported), specRev({}, { ...edited, team: { $ref: "members.teams/tem_B" } }))
  })

  test("baseHash ignores entry order", () => {
    const rows = [{ area: "members.teams" as const, id: "a", rev: "r1" }, { area: "members.teams" as const, id: "b", rev: "r2" }]
    assert.equal(baseHash(rows), baseHash([...rows].reverse()))
  })
})

describe("plan", () => {
  test("round trip: an unedited export of the same org is all unchanged, with a stable hash", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["members.teams", "ai-gateway.providers"])
    const first = buildPlan(planInput(store, areas, blob, { sameOrganization: true }))
    const second = buildPlan(planInput(store, areas, structuredClone(blob), { sameOrganization: true }))
    assert.deepEqual(first.errors, [])
    assert.equal(first.plan.summary.unchanged, 3)
    assert.equal(first.plan.summary.blocking, 0)
    assert.equal(first.execution.ops.length, 0)
    assert.equal(first.plan.planHash, second.plan.planHash)
    assert.ok(first.plan.areas.flatMap((area) => area.items).every((entry) => entry.matchedBy === "id"))
    // Teams come before providers (dependency order) even though the registry lists providers first.
    assert.deepEqual(first.plan.areas.map((area) => area.area), ["members.teams", "ai-gateway.providers"])
  })

  test("id match: field-level diff, ref removals are destructive, the secret needs a decision", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["ai-gateway.providers"])
    const provider = blob["ai-gateway.providers"]!.items[0]!
    provider.spec = { ...provider.spec, models: [{ id: "ipm_1", modelId: "claude-sonnet", enabled: true }, { id: "ipm_2", modelId: "claude-opus", enabled: true }], access: { orgWide: false, teams: [] } }
    const { plan } = buildPlan(planInput(store, areas, blob))
    const entry = item(plan, "ai-gateway.providers", "ipr_A")
    assert.equal(entry.op, "update")
    assert.equal(entry.matchedBy, "id")
    assert.deepEqual(entry.fields.find((field) => field.path === "models[id=ipm_2].enabled"), { path: "models[id=ipm_2].enabled", from: false, to: true })
    assert.deepEqual(entry.fields.find((field) => field.path === "access.teams"), { path: "access.teams", added: [], removed: ["Platform"] })
    assert.ok(entry.flags.includes("destructive"))
    assert.ok(entry.flags.includes("needs_input"))
    assert.deepEqual(entry.secrets, [{ path: "ai-gateway.providers/ipr_A/credentials.apiKey", field: "credentials.apiKey", targetHasValue: true, sourceHadValue: true, decision: null }])

    const kept = buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey] }))
    const keptEntry = item(kept.plan, "ai-gateway.providers", "ipr_A")
    assert.ok(!keptEntry.flags.includes("needs_input"))
    assert.equal(keptEntry.secrets?.[0]?.decision, "keep")
    assert.equal(kept.plan.summary.blocking, 0)
    assert.notEqual(kept.plan.planHash, plan.planHash)
  })

  test("key match, natural-key match and refs rewritten across orgs", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [
        { id: "tem_SRC1", key: "platform", name: "Platform", spec: { description: "core", members: [ada] } },
        { id: "tem_SRC2", name: "design", spec: { description: "", members: [] } },
      ] },
      "ai-gateway.providers": { specVersion: 1, items: [
        { id: "ipr_SRC", key: "anthropic-prod", name: "Anthropic (prod)", spec: { ...seed().get("ai-gateway.providers")![0]!.spec, access: { orgWide: false, teams: [{ $ref: "members.teams/tem_SRC1", name: "Platform" }] }, credentials: { apiKey: { $secret: "ai-gateway.providers/ipr_SRC/credentials.apiKey", set: true } } } },
      ] },
    }
    const { plan } = buildPlan(planInput(store, areas, blob))
    assert.equal(item(plan, "members.teams", "tem_SRC1").matchedBy, "key")
    assert.equal(item(plan, "members.teams", "tem_SRC1").op, "unchanged")
    const design = item(plan, "members.teams", "tem_SRC2")
    assert.equal(design.matchedBy, "natural")
    assert.equal(design.target?.id, "tem_B")
    assert.equal(design.op, "rename")
    assert.ok(design.reasons?.includes("matched by name"))
    const provider = item(plan, "ai-gateway.providers", "ipr_SRC")
    assert.equal(provider.matchedBy, "key")
    // The team ref resolves to tem_A, so access is not a change; the secret differs only in path.
    assert.equal(provider.op, "unchanged")
    assert.deepEqual(provider.refs, [{ path: "access.teams[0]", ref: "members.teams/tem_SRC1", name: "Platform", resolvedId: "tem_A", via: "target" }])
  })

  test("ambiguous natural keys and same-name blob items are proposals, never matches", () => {
    const store = seed()
    store.set("members.teams", [
      { id: "tem_O1", key: null, name: "Ops", spec: { description: "east", members: [] } },
      { id: "tem_O2", key: null, name: "Ops", spec: { description: "west", members: [] } },
      { id: "tem_D", key: null, name: "Docs", spec: { description: "", members: [] } },
    ])
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [
        { name: "Ops", spec: { description: "east", members: [] } },
        { key: "docs-1", name: "Docs", spec: { description: "", members: [] } },
        { key: "docs-2", name: "Docs", spec: { description: "", members: [] } },
      ] },
    }
    const { plan } = buildPlan(planInput(store, areas, blob))
    const ops = item(plan, "members.teams", "#0")
    assert.equal(ops.op, "create")
    assert.equal(ops.matchedBy, "proposed")
    assert.ok(ops.flags.includes("needs_mapping"))
    assert.deepEqual(ops.candidates?.map((candidate) => candidate.id).sort(), ["tem_O1", "tem_O2"])
    for (const ref of ["key:docs-1", "key:docs-2"]) {
      const docs = item(plan, "members.teams", ref)
      assert.equal(docs.target, undefined)
      assert.ok(docs.flags.includes("needs_mapping"))
      assert.equal(docs.candidates?.[0]?.id, "tem_D")
    }
    assert.equal(plan.summary.blocking, 3)

    const decided = buildPlan(planInput(store, areas, blob, { decisions: decisions({ matches: [
      { area: "members.teams", ref: "#0", targetId: "tem_O1" },
      { area: "members.teams", ref: "key:docs-1", targetId: "tem_D" },
      { area: "members.teams", ref: "key:docs-2", targetId: "create" },
    ] }) }))
    assert.equal(item(decided.plan, "members.teams", "#0").matchedBy, "decision")
    assert.equal(item(decided.plan, "members.teams", "#0").op, "unchanged")
    assert.equal(item(decided.plan, "members.teams", "key:docs-1").target?.id, "tem_D")
    const created = item(decided.plan, "members.teams", "key:docs-2")
    assert.equal(created.op, "create")
    // A second "Docs" breaks the unique team name.
    assert.ok(created.flags.includes("collision.unique"))
    const renamed = buildPlan(planInput(store, areas, blob, { decisions: decisions({
      matches: [
        { area: "members.teams", ref: "#0", targetId: "tem_O1" },
        { area: "members.teams", ref: "key:docs-1", targetId: "tem_D" },
        { area: "members.teams", ref: "key:docs-2", targetId: "create" },
      ],
      renames: [{ area: "members.teams", ref: "key:docs-2", name: "Docs 2" }],
    }) }))
    assert.equal(renamed.plan.summary.blocking, 0)
    assert.equal(item(renamed.plan, "members.teams", "key:docs-2").blob?.name, "Docs 2")
    assert.notEqual(renamed.plan.planHash, decided.plan.planHash)
  })

  test("a clearly better proposal is suggested but still needs confirmation", () => {
    const result = matchArea({
      area: { key: "members.teams", naturalKeys: [] },
      blobItems: [{ name: "Anthropic production", spec: { url: "https://a", region: "eu" } }],
      targetItems: [
        { id: "x", name: "Anthropic production", spec: { url: "https://a", region: "eu" } },
        { id: "y", name: "Zebra", spec: { url: "https://z" } },
      ],
    })
    const match = result.matches[0]!
    assert.equal(match.target, null)
    assert.equal(match.suggestedTargetId, "x")
    assert.deepEqual(match.flags, ["needs_mapping"])
  })

  test("conflict.identity when id and key point at different items", () => {
    const store = seed()
    store.get("members.teams")![1]!.key = "design"
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [{ id: "tem_A", key: "design", name: "Platform", spec: { description: "core", members: [ada] } }] },
    }
    const { plan } = buildPlan(planInput(store, areas, blob))
    const entry = item(plan, "members.teams", "tem_A")
    assert.ok(entry.flags.includes("conflict.identity"))
    assert.deepEqual(entry.candidates?.map((candidate) => candidate.id), ["tem_A", "tem_B"])
    assert.equal(plan.summary.blocking, 1)
    const confirmed = buildPlan(planInput(store, areas, blob, { decisions: decisions({ matches: [{ area: "members.teams", ref: "tem_A", targetId: "tem_A" }] }) }))
    const confirmedEntry = item(confirmed.plan, "members.teams", "tem_A")
    assert.ok(!confirmedEntry.flags.includes("conflict.identity"))
    assert.equal(confirmedEntry.matchedBy, "id")
  })

  test("duplicate ids or keys in one blob area are validation errors", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [
        { id: "tem_X", name: "One", spec: {} },
        { id: "tem_X", name: "Two", spec: {} },
        { key: "k", name: "Three", spec: {} },
        { key: "k", name: "Four", spec: {} },
      ] },
    }
    const { errors, plan } = buildPlan(planInput(store, areas, blob))
    assert.equal(errors.length, 2)
    assert.ok(plan.issues.some((issue) => issue.level === "error" && issue.message.includes('same id "tem_X"')))
  })

  test("invalid specs and newer spec versions are errors", () => {
    const store = seed()
    const areas = makeAreas(store, [], { "members.teams": { specSchema: z.object({ description: z.string(), members: z.array(z.unknown()) }).strict() } })
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [{ name: "New", spec: { descripton: "typo", members: [] } }] },
      "ai-gateway.providers": { specVersion: 9, items: [] },
    }
    const { errors, plan } = buildPlan(planInput(store, areas, blob))
    assert.equal(errors.length, 2)
    assert.ok(item(plan, "members.teams", "#0").flags.includes("blocked"))
  })

  describe("three-way", () => {
    function drifted() {
      const store = seed()
      const areas = makeAreas(store, [])
      const blob = exportBlob(store, areas, ["members.teams"])
      // Someone edits Platform on the target after the export.
      store.get("members.teams")![0]!.spec = { description: "core team", members: [ada] }
      return { store, areas, blob }
    }

    test("target changed, blob not edited: untouched", () => {
      const { store, areas, blob } = drifted()
      const { plan } = buildPlan(planInput(store, areas, blob, { sameOrganization: true }))
      const entry = item(plan, "members.teams", "tem_A")
      assert.equal(entry.op, "untouched")
      assert.equal(plan.summary.blocking, 0)
    })

    test("without sameOrganization the rev is ignored: two-way update", () => {
      const { store, areas, blob } = drifted()
      const { plan } = buildPlan(planInput(store, areas, blob))
      assert.equal(item(plan, "members.teams", "tem_A").op, "update")
    })

    test("both changed: drift, with field conflicts when the base spec is known; override clears it", () => {
      const { store, areas, blob } = drifted()
      const base = structuredClone(blob["members.teams"]!.items[0]!.spec)
      blob["members.teams"]!.items[0]!.spec = { description: "platform", members: [] }
      const input = planInput(store, areas, blob, { sameOrganization: true, baseSpecs: new Map([["members.teams/tem_A", base]]) })
      const { plan } = buildPlan(input)
      const entry = item(plan, "members.teams", "tem_A")
      assert.equal(entry.op, "update")
      assert.ok(entry.flags.includes("drift"))
      assert.deepEqual(entry.fields.find((field) => field.path === "description"), { path: "description", from: "core team", to: "platform", base: "core", conflict: true })
      assert.equal(entry.fields.find((field) => field.path === "members")?.conflict, false)
      const overridden = buildPlan({ ...input, decisions: decisions({ overrides: [{ area: "members.teams", ref: "tem_A" }] }) })
      assert.ok(!item(overridden.plan, "members.teams", "tem_A").flags.includes("drift"))
      assert.equal(overridden.plan.summary.blocking, 0)
    })
  })

  test("mirror mode: unticked deletes stay untouched, ticked ones delete, protected ones never", () => {
    const store = seed()
    const areas = makeAreas(store, [], { "members.teams": { protectedFromDelete: (team) => (team.id === "tem_A" ? "the applier's own team" : null) } })
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = { "members.teams": { specVersion: 1, items: [] } }
    const merge = buildPlan(planInput(store, areas, blob))
    assert.deepEqual(items(merge.plan, "members.teams").map((entry) => entry.op), ["untouched", "untouched"])
    const unticked = buildPlan(planInput(store, areas, blob, { mode: "mirror" }))
    assert.equal(item(unticked.plan, "members.teams", "target:tem_B").reasons?.[0], "not in the blob — tick to delete")
    const ticked = buildPlan(planInput(store, areas, blob, { mode: "mirror", ctx, decisions: decisions({ deletes: [{ area: "members.teams", targetId: "tem_A" }, { area: "members.teams", targetId: "tem_B" }] }) }))
    assert.equal(item(ticked.plan, "members.teams", "target:tem_A").op, "untouched")
    const deleted = item(ticked.plan, "members.teams", "target:tem_B")
    assert.equal(deleted.op, "delete")
    assert.ok(deleted.flags.includes("destructive"))
    assert.deepEqual(ticked.execution.ops.map((op) => [op.kind, op.targetId]), [["delete", "tem_B"]])
    assert.notEqual(ticked.plan.planHash, unticked.plan.planHash)
  })

  test("unsupported areas are skipped with a reason", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = { "connectors.mcp": { specVersion: 1, items: [{ id: "mcp_1", name: "Linear", spec: { url: "https://mcp.linear.app" } }] } }
    const { plan, execution } = buildPlan(planInput(store, areas, blob, { deployment: "self_hosted" }))
    const entry = item(plan, "connectors.mcp", "mcp_1")
    assert.equal(entry.op, "skip")
    assert.match(entry.reasons?.[0] ?? "", /self-hosted/)
    assert.equal(execution.ops.length, 0)
  })

  test("secrets: missing, keep without a value, env allowlist, value", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const secretPath = "ai-gateway.providers/ipr_NEW/credentials.apiKey"
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "ai-gateway.providers": { specVersion: 1, items: [{ id: "ipr_NEW", name: "OpenAI", spec: { providerId: "openai", baseUrl: "https://api.openai.com", models: [], fallback: [], access: { orgWide: true, teams: [] }, credentials: { apiKey: { $secret: secretPath, set: true } } } }] },
    }
    const reasonsFor = (secretInputs: ConfigSecretInput[], allowEnv?: (name: string) => boolean) => {
      const entry = item(buildPlan(planInput(store, areas, blob, { secretInputs, allowEnv })).plan, "ai-gateway.providers", "ipr_NEW")
      return { needsInput: entry.flags.includes("needs_input"), reasons: entry.reasons ?? [], secret: entry.secrets?.[0] }
    }
    assert.equal(reasonsFor([]).needsInput, true)
    assert.equal(reasonsFor([{ path: secretPath, decision: "keep" }]).needsInput, true)
    assert.ok(reasonsFor([{ path: secretPath, decision: "keep" }]).reasons.some((reason) => reason.includes("no current value")))
    assert.equal(reasonsFor([{ path: secretPath, decision: "env", env: "OPENAI_KEY" }]).needsInput, true)
    const env = reasonsFor([{ path: secretPath, decision: "env", env: "OPENAI_KEY" }], (name) => name === "OPENAI_KEY")
    assert.equal(env.needsInput, false)
    assert.equal(env.secret?.env, "OPENAI_KEY")
    assert.equal(reasonsFor([{ path: secretPath, decision: "unset" }]).needsInput, false)

    const withValue = buildPlan(planInput(store, areas, blob, { secretInputs: [{ path: secretPath, decision: "value", value: "sk-very-secret" }] }))
    assert.equal(withValue.plan.summary.blocking, 0)
    assert.ok(!JSON.stringify(withValue).includes("sk-very-secret"))
    assert.deepEqual(secretsNeedingValues(withValue.execution), [{ area: "ai-gateway.providers", ref: "ipr_NEW", path: secretPath, decision: "value" }])
    const otherValue = buildPlan(planInput(store, areas, blob, { secretInputs: [{ path: secretPath, decision: "value", value: "sk-other" }] }))
    assert.equal(otherValue.plan.planHash, withValue.plan.planHash)

    // An unset placeholder written in the blob itself is a decision too.
    const inline = structuredClone(blob)
    inline["ai-gateway.providers"]!.items[0]!.spec.credentials = { apiKey: { $secret: secretPath, unset: true } }
    assert.equal(buildPlan(planInput(store, areas, inline)).plan.summary.blocking, 0)
  })

  test("people refs: member, unknown (unresolved), invite and drop decisions", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [{ id: "tem_A", key: "platform", name: "Platform", spec: { description: "core", members: [ada, { $ref: "people/Bob@Example.com" }, { $ref: "people/eve@example.com" }] } }] },
    }
    const { plan } = buildPlan(planInput(store, areas, blob))
    const entry = item(plan, "members.teams", "tem_A")
    assert.ok(entry.flags.includes("ref_unresolved"))
    assert.deepEqual(entry.refs?.map((ref) => [ref.path, ref.resolvedId, ref.via]), [
      ["members[0]", "om_ada", "target"],
      ["members[1]", null, null],
      ["members[2]", null, null],
    ])
    const decided = buildPlan(planInput(store, areas, blob, { decisions: decisions({ refs: [
      { area: "members.teams", ref: "tem_A", path: "members[1]", resolution: { invite: true } },
      { area: "members.teams", ref: "tem_A", path: "members[2]", resolution: { drop: true } },
    ] }) }))
    const decidedEntry = item(decided.plan, "members.teams", "tem_A")
    assert.equal(decided.plan.summary.blocking, 0)
    assert.deepEqual(decidedEntry.refs?.map((ref) => ref.decision ?? null), [null, "invite", "drop"])
    assert.equal(decidedEntry.refs?.[1]?.via, "planned")
    // The invite is a real planned create in members.people, run first.
    const invite = item(decided.plan, "members.people", "invite:bob@example.com")
    assert.equal(invite.op, "create")
    assert.deepEqual(decided.execution.ops.map((op) => `${op.kind} ${op.area} ${op.ref}`), ["create members.people invite:bob@example.com", "update members.teams tem_A"])
    assert.deepEqual(decided.execution.ops[0]?.item?.spec, { email: "bob@example.com", role: "member", status: "invited", teams: [], managedBy: "manual" })

    // Without a people area to plan into, an invite decision stays unresolved.
    const noPeople = makeAreas(store, []).filter((area) => area.key !== "members.people")
    const refused = buildPlan(planInput(store, noPeople, blob, { decisions: decisions({ refs: [
      { area: "members.teams", ref: "tem_A", path: "members[1]", resolution: { invite: true } },
      { area: "members.teams", ref: "tem_A", path: "members[2]", resolution: { drop: true } },
    ] }) }))
    assert.ok(item(refused.plan, "members.teams", "tem_A").flags.includes("ref_unresolved"))
    assert.ok(refused.execution.ops.every((op) => op.area !== "members.people"))
  })

  test("an invite for a person the blob already creates resolves to that create", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [{ id: "tem_A", key: "platform", name: "Platform", spec: { description: "core", members: [ada, { $ref: "people/bob@example.com" }] } }] },
      "members.people": { specVersion: 1, items: [{ id: "om_BOB", name: "Bob", spec: { email: "bob@example.com", role: "admin" } }] },
    }
    const { plan, execution } = buildPlan(planInput(store, areas, blob, { decisions: decisions({ refs: [
      { area: "members.teams", ref: "tem_A", path: "members[1]", resolution: { invite: true } },
    ] }) }))
    assert.equal(plan.summary.blocking, 0)
    assert.equal(item(plan, "members.teams", "tem_A").refs?.[1]?.via, "planned")
    assert.deepEqual(items(plan, "members.people").map((entry) => entry.ref), ["om_BOB"])
    assert.deepEqual(execution.ops.map((op) => `${op.kind} ${op.area} ${op.ref}`), ["update members.teams tem_A", "create members.people om_BOB"])
  })
})

describe("execute", () => {
  test("creates run in dependency order and refs to planned creates get the new ids", async () => {
    const store = seed()
    const calls: Call[] = []
    const areas = makeAreas(store, calls)
    const secretPath = "ai-gateway.providers/ipr_NEW/credentials.apiKey"
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "ai-gateway.providers": { specVersion: 1, items: [{ id: "ipr_NEW", name: "OpenAI", spec: {
        providerId: "openai",
        models: [],
        fallback: [],
        access: { orgWide: false, teams: [{ $ref: "members.teams/tem_SRC_ML", name: "ML" }, { $ref: "members.teams/tem_A", name: "Platform" }] },
        credentials: { apiKey: { $secret: secretPath, set: true } },
      } }] },
      "members.teams": { specVersion: 1, items: [
        { id: "tem_SRC_ML", name: "ML", spec: { description: "", members: [ada, { $ref: "people/new@example.com" }, { $ref: "people/gone@example.com" }] } },
        { id: "tem_FREE", name: "Free id", spec: { description: "", members: [] } },
      ] },
    }
    const { plan, execution } = buildPlan(planInput(store, areas, blob, {
      secretInputs: [{ path: secretPath, decision: "value", value: "sk-live" }],
      decisions: decisions({ refs: [
        { area: "members.teams", ref: "tem_SRC_ML", path: "members[1]", resolution: { invite: true } },
        { area: "members.teams", ref: "tem_SRC_ML", path: "members[2]", resolution: { drop: true } },
      ] }),
    }))
    assert.equal(plan.summary.blocking, 0)
    const provider = item(plan, "ai-gateway.providers", "ipr_NEW")
    assert.deepEqual(provider.refs?.map((ref) => [ref.via, ref.resolvedId]), [["planned", null], ["target", "tem_A"]])
    assert.deepEqual(execution.ops.map((op) => `${op.kind} ${op.area} ${op.ref}`), [
      "create members.people invite:new@example.com",
      "create members.teams tem_SRC_ML",
      "create members.teams tem_FREE",
      "create ai-gateway.providers ipr_NEW",
    ])

    const secrets = new Map<string, ResolvedConfigSecret>([[secretPath, { $secret: secretPath, decision: "value", value: "sk-live" }]])
    const asked: string[] = []
    const result = await executePlan(execution, areas, ctx, secrets, { isIdFree: async (id, area) => {
      asked.push(`${area} ${id}`)
      return id === "tem_FREE" || id === "ipr_NEW"
    } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.items.map((entry) => entry.status), ["applied", "applied", "applied", "applied"])
    // Only ids that look like the area's ids are offered: "tem_SRC_ML" has the TypeID prefix "tem_SRC", not "tem".
    assert.deepEqual(asked, ["members.teams tem_FREE", "ai-gateway.providers ipr_NEW"])
    const invitedId = result.created.find((entry) => entry.ref === "invite:new@example.com")?.localId
    assert.ok(invitedId)
    const mlId = result.created.find((entry) => entry.ref === "tem_SRC_ML")?.localId
    assert.ok(mlId && mlId !== "tem_SRC_ML")
    assert.deepEqual(result.aliases, [{ area: "members.teams", sourceId: "tem_SRC_ML", localId: mlId }])
    assert.equal(result.created.find((entry) => entry.ref === "tem_FREE")?.localId, "tem_FREE")

    const teamCreate = calls[1]!.op
    assert.equal(teamCreate.kind, "create")
    if (teamCreate.kind !== "create") return
    assert.equal(teamCreate.preferredId, undefined)
    // Never `{ invite: true }` without an id: the reference points at the person just invited.
    assert.deepEqual(teamCreate.item.spec.members, [{ $ref: "people/ada@example.com", id: "om_ada" }, { $ref: "people/new@example.com", id: invitedId }])
    const providerCreate = calls[3]!.op
    assert.equal(providerCreate.kind, "create")
    if (providerCreate.kind !== "create") return
    assert.equal(providerCreate.preferredId, "ipr_NEW")
    assert.deepEqual(providerCreate.item.spec.access, { orgWide: false, teams: [{ $ref: "members.teams/tem_SRC_ML", name: "ML", id: mlId }, { $ref: "members.teams/tem_A", name: "Platform", id: "tem_A" }] })
    assert.deepEqual(providerCreate.item.spec.credentials, { apiKey: { $secret: secretPath, decision: "value", value: "sk-live" } })
  })

  test("updates get keep secrets; a failure stops the run; blocking plans never run", async () => {
    const store = seed()
    const calls: Call[] = []
    const areas = makeAreas(store, calls, { "members.teams": { apply: async () => { throw new Error("boom") } } })
    const blob = exportBlob(store, areas, ["members.teams", "ai-gateway.providers"])
    blob["members.teams"]!.items[1]!.spec = { description: "design team", members: [] }
    blob["ai-gateway.providers"]!.items[0]!.spec = { ...blob["ai-gateway.providers"]!.items[0]!.spec, baseUrl: "https://proxy.example.com" }

    const blocked = buildPlan(planInput(store, areas, blob))
    assert.equal(blocked.execution.blocking, 1)
    const refused = await executePlan(blocked.execution, areas, ctx, new Map())
    assert.equal(refused.ok, false)
    assert.equal(calls.length, 0)

    const { execution } = buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey] }))
    const failed = await executePlan(execution, areas, ctx, new Map())
    assert.equal(failed.ok, false)
    assert.deepEqual(failed.items.map((entry) => entry.status), ["failed", "not_reached"])
    assert.deepEqual(failed.items[0]?.failure, { code: "error", message: "boom" })
    assert.equal(failed.items[1]?.startedAt, null, "never started")

    const working = makeAreas(store, calls)
    const applied = await executePlan(execution, working, ctx, new Map())
    assert.equal(applied.ok, true)
    const update = calls.find((call) => call.area === "ai-gateway.providers")?.op
    assert.equal(update?.kind, "update")
    if (update?.kind !== "update") return
    assert.deepEqual(update.item.spec.credentials, { apiKey: { $secret: keepKey.path, decision: "keep" } })
    assert.equal(update.previous.id, "ipr_A")
    assert.deepEqual(update.changes.map((change) => change.path), ["baseUrl"], "only the plan's changes are handed over")
    assert.deepEqual(update.secretPaths, [], "keep writes no credential")
  })

  test("a new credential value: the update names the secret by its spec path, never by its $secret handle", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["ai-gateway.providers"])
    const { plan, execution } = buildPlan(planInput(store, areas, blob, { secretInputs: [{ path: keepKey.path, decision: "value", value: "sk-new" }] }))
    assert.equal(item(plan, "ai-gateway.providers", "ipr_A").op, "update")
    const [update] = execution.ops
    assert.deepEqual(update?.changes, [])
    assert.deepEqual(update?.secretPaths, ["credentials.apiKey"])
    assert.ok(!JSON.stringify(execution).includes("sk-new"), "values never enter the execution plan")
  })

  test("report: names, steps, a ConfigApplyItemError's failure and steps done, not_reached after it, progress after every item", async () => {
    const store = seed()
    const calls: Call[] = []
    const areas = makeAreas(store, calls, {
      "members.teams": {
        apply: async (_ctx, op) => {
          calls.push({ area: "members.teams", op })
          if (op.kind === "update" && op.item.name === "Designers") {
            throw new ConfigApplyItemError(
              { code: "team_name_taken", message: "That name is taken.", field: "name", step: { action: "set", target: "name", detail: "Designers" } },
              [{ action: "add", target: "members", detail: "Ada" }],
            )
          }
          return { localId: op.kind === "create" ? "tem_new" : op.kind === "update" || op.kind === "delete" ? op.targetId : "", steps: [{ action: "set", target: "description" }] }
        },
        irreversible: (op) => (op.kind === "update" ? [`Members of ${op.item.name} were notified`] : []),
      },
    })
    const blob = exportBlob(store, areas, ["members.teams", "ai-gateway.providers"])
    blob["members.teams"]!.items[0]!.spec = { description: "core platform", members: [ada] }
    blob["members.teams"]!.items[1]!.name = "Designers"
    blob["ai-gateway.providers"]!.items[0]!.spec = { ...blob["ai-gateway.providers"]!.items[0]!.spec, baseUrl: "https://proxy.example.com" }
    const { plan, execution } = buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey] }))
    assert.deepEqual(item(plan, "members.teams", "tem_B").irreversible, ["Members of Designers were notified"], "shown before approval")
    const snapshots: string[][] = []
    const result = await executePlan(execution, areas, ctx, new Map(), {
      onProgress: async (entries) => { snapshots.push(entries.map((entry) => entry.status)) },
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.items.map((entry) => [entry.name, entry.op, entry.status]), [
      ["Platform", "update", "applied"],
      ["Designers", "rename", "failed"],
      ["Anthropic (prod)", "update", "not_reached"],
    ])
    const [applied, failed, notReached] = result.items
    assert.deepEqual(applied?.steps, [{ action: "set", target: "description" }])
    assert.deepEqual(applied?.irreversible, ["Members of Platform were notified"])
    assert.equal(failed?.failure?.code, "team_name_taken")
    assert.equal(failed?.failure?.field, "name")
    assert.deepEqual(failed?.steps, [{ action: "add", target: "members", detail: "Ada" }], "what was already written for the failed item")
    assert.deepEqual(failed?.irreversible, ["Members of Designers were notified"])
    assert.equal(notReached?.startedAt, null)
    assert.ok(typeof applied?.durationMs === "number")
    assert.equal(calls.some((call) => call.area === "ai-gateway.providers"), false)
    // Each item reports when it starts and when it ends: a crash leaves the in-flight item visible.
    assert.deepEqual(snapshots.map((entry) => entry.join(",")), [
      "not_reached,not_reached,not_reached",
      "applied,not_reached,not_reached",
      "applied,not_reached,not_reached",
      "applied,failed,not_reached",
    ])
    const interrupted = interruptReport({ ...emptyReport(), items: [applied!, { ...failed!, status: "not_reached", failure: undefined }, notReached!] }, new Date(), "stopped")
    assert.deepEqual(interrupted.items.map((entry) => entry.status), ["applied", "failed", "not_reached"])
    assert.equal(interrupted.failure?.failure.code, "interrupted")
    assert.equal(interrupted.status, "interrupted")
    assert.deepEqual(interrupted.counts, { applied: 1, noop: 0, failed: 1, not_reached: 1, skipped: 0 })
  })

  test("an update with no changes and no credential is never sent: reported noop", async () => {
    const store = seed()
    const calls: Call[] = []
    const areas = makeAreas(store, calls)
    const blob = exportBlob(store, areas, ["members.teams"])
    blob["members.teams"]!.items[1]!.spec = { description: "design team", members: [] }
    const { execution } = buildPlan(planInput(store, areas, blob))
    const emptied = { ...execution, ops: execution.ops.map((op) => ({ ...op, changes: [] })) }
    const result = await executePlan(emptied, areas, ctx, new Map())
    assert.equal(result.ok, true)
    assert.deepEqual(result.items.map((entry) => entry.status), ["noop"])
    assert.equal(calls.length, 0)
    // An adapter that reports no steps found nothing to write either.
    const quiet = makeAreas(store, calls, { "members.teams": { apply: async (_ctx, op) => ({ localId: op.kind === "create" ? "x" : op.targetId, steps: [] }) } })
    const second = await executePlan(execution, quiet, ctx, new Map())
    assert.deepEqual(second.items.map((entry) => entry.status), ["noop"])
  })
})

describe("apply reads only what it writes", () => {
  test("drift is checked on the written items alone; untouched areas are never exported; the before-snapshot holds only written items", async () => {
    const store = seed()
    store.set("members.teams", [...(store.get("members.teams") ?? []), { id: "tem_C", key: null, name: "Sales", spec: { description: "", members: [] } }])
    const calls: Call[] = []
    const exportsByArea = new Map<ConfigAreaKey, number>()
    const readsByArea = new Map<ConfigAreaKey, string[][]>()
    const counted = (key: ConfigAreaKey, withReadItems: boolean): Partial<ConfigArea> => ({
      exportItems: async () => {
        exportsByArea.set(key, (exportsByArea.get(key) ?? 0) + 1)
        return structuredClone(store.get(key) ?? [])
      },
      ...(withReadItems ? {
        readItems: async (_ctx: ConfigAreaContext, ids: string[]) => {
          readsByArea.set(key, [...(readsByArea.get(key) ?? []), ids])
          return structuredClone((store.get(key) ?? []).filter((entry) => ids.includes(entry.id)))
        },
      } : {}),
    })
    const areas = makeAreas(store, calls, {
      "ai-gateway.providers": counted("ai-gateway.providers", true),
      "members.teams": counted("members.teams", true),
      "connectors.mcp": counted("connectors.mcp", false),
      "members.people": counted("members.people", false),
    })
    const blob = exportBlob(store, areas, ["ai-gateway.providers"])
    blob["ai-gateway.providers"]!.items[0]!.spec = { ...blob["ai-gateway.providers"]!.items[0]!.spec, baseUrl: "https://proxy.example.com" }
    const { execution } = buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey] }))
    exportsByArea.clear()

    const checked = await checkWrittenItems(execution, areas, ctx)
    assert.deepEqual(checked.problems, [])
    assert.deepEqual([...exportsByArea.entries()], [], "no area is exported")
    assert.deepEqual(readsByArea.get("ai-gateway.providers"), [["ipr_A"]], "only the written provider")
    assert.deepEqual(readsByArea.get("members.teams"), [["tem_A"]], "only the team the provider references")
    assert.deepEqual(checked.reads.map((read) => `${read.kind} ${read.area} ${read.ids}`), ["read ai-gateway.providers 1", "read members.teams 1"])
    assert.deepEqual([...checked.before.entries()].map(([key, entries]) => [key, entries.map((entry) => entry.id)]), [["ai-gateway.providers", ["ipr_A"]]])

    // The written item changed since the plan: stale. A change elsewhere in the org is not drift.
    store.get("members.teams")![2]!.name = "Sales EMEA"
    assert.deepEqual((await checkWrittenItems(execution, areas, ctx)).problems, [])
    store.get("ai-gateway.providers")![0]!.name = "Renamed meanwhile"
    assert.deepEqual((await checkWrittenItems(execution, areas, ctx)).problems, ['ai-gateway.providers "Anthropic (prod)" changed since the plan was made'])
    store.get("ai-gateway.providers")![0]!.name = "Anthropic (prod)"
    store.set("members.teams", (store.get("members.teams") ?? []).filter((entry) => entry.id !== "tem_A"))
    assert.match((await checkWrittenItems(execution, areas, ctx)).problems.join("\n"), /access\.teams\[0\] points at an item that no longer exists/)
  })

  test("a create whose unique name was taken since the plan is stale (the only check that reads a whole area)", async () => {
    const store = seed()
    const calls: Call[] = []
    const areas = makeAreas(store, calls)
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = { "members.teams": { specVersion: 1, items: [{ id: "tem_SRC", name: "Research", spec: { description: "", members: [] } }] } }
    const { execution } = buildPlan(planInput(store, areas, blob))
    const fine = await checkWrittenItems(execution, areas, ctx)
    assert.deepEqual(fine.problems, [])
    assert.deepEqual(fine.reads.map((read) => `${read.kind} ${read.area}`), ["export members.teams"])
    store.get("members.teams")!.push({ id: "tem_R", key: null, name: "research", spec: { description: "", members: [] } })
    assert.deepEqual((await checkWrittenItems(execution, areas, ctx)).problems, ['members.teams "Research": another item now has name "research"'])
  })

  test("readItemsFor: readItems when the area has it, else the export filtered", async () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const teams = areas.find((area) => area.key === "members.teams")!
    const reads: ApplyRead[] = []
    assert.deepEqual((await readItemsFor(teams, ctx, ["tem_B", "tem_B", "tem_missing"], reads)).map((entry) => entry.id), ["tem_B"])
    assert.deepEqual(reads, [{ area: "members.teams", kind: "export", ids: 2 }])
    assert.deepEqual(await readItemsFor(teams, ctx, [], reads), [])
    assert.equal(reads.length, 1, "nothing to read: no call")
  })

  test("the stored execution plan round-trips; another plan hash or a malformed one is refused", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["members.teams"])
    blob["members.teams"]!.items[1]!.spec = { description: "design team", members: [] }
    const { execution } = buildPlan(planInput(store, areas, blob))
    const stored: unknown = JSON.parse(JSON.stringify(execution))
    assert.deepEqual(parseStoredExecution(stored, execution.planHash), execution)
    assert.equal(parseStoredExecution(stored, "sha256:other"), null)
    assert.equal(parseStoredExecution({ planHash: execution.planHash, ops: [{ nope: true }] }, execution.planHash), null)
    assert.equal(parseStoredExecution(null, execution.planHash), null)
  })
})

function emptyReport(): ConfigApplyReport {
  return { runId: "car_1", attempt: 1, status: "running", startedAt: new Date(0).toISOString(), finishedAt: null, requestedBy: null, runsAs: null, counts: { applied: 0, noop: 0, failed: 0, not_reached: 0, skipped: 0 }, failure: null, items: [], warnings: [] }
}

describe("security limits", () => {
  const team = (index: number) => ({ id: `tem_${String(index).padStart(6, "0")}`, name: `Team ${index}`, spec: { description: "", members: [] } })

  test("more than 2,000 items in one area, or 20,000 in all, is invalid", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const big = buildPlan(planInput(store, areas, { "members.teams": { specVersion: 1, items: Array.from({ length: 2001 }, (_, index) => team(index)) } }))
    assert.ok(big.fatalErrors.some((error) => error.includes("2,001 items is more than the 2,000 allowed in one area")))
    assert.equal(items(big.plan, "members.teams").filter((entry) => entry.ref.startsWith("tem_")).length, 0)

    const huge: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {}
    for (const key of CONFIG_AREA_KEYS) huge[key] = { specVersion: 1, items: Array.from({ length: 1900 }, (_, index) => team(index)) }
    const tooMany = buildPlan(planInput(store, areas, huge))
    assert.ok(tooMany.fatalErrors.some((error) => error.includes("more than the 20,000 allowed")))
    assert.equal(tooMany.execution.ops.length, 0)

    const tree = { members: { teams: { specVersion: 1, items: Array.from({ length: 2001 }, (_, index) => team(index)) } } }
    assert.ok(flattenConfigAreas(tree).errors.some((error) => error.includes("more than the 2,000 allowed")))
  })

  test("too many pairs to score: no proposals, every unmatched item needs a manual choice", () => {
    const store = seed()
    store.set("connectors.mcp", Array.from({ length: 200 }, (_, index) => ({ id: `mcp_T${index}`, key: null, name: `Target ${index}`, spec: { url: `https://t${index}.example.com` } })))
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "connectors.mcp": { specVersion: 1, items: Array.from({ length: 300 }, (_, index) => ({ name: `Blob ${index}`, spec: { url: `https://b${index}.example.com` } })) },
    }
    const started = Date.now()
    const { plan } = buildPlan(planInput(store, areas, blob))
    assert.ok(Date.now() - started < 5000)
    const blobItems = items(plan, "connectors.mcp").filter((entry) => entry.blob)
    assert.equal(blobItems.length, 300)
    assert.ok(blobItems.every((entry) => entry.flags.includes("needs_mapping") && !entry.candidates && entry.reasons?.includes("too many items to suggest matches; choose manually")))
  })

  test("forbidden keys and deep nesting are rejected; copies never touch a prototype", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const polluted: ConfigSpec = JSON.parse('{"description":"","members":[],"extra":{"__proto__":{"polluted":true}}}')
    const withProto = buildPlan(planInput(store, areas, { "members.teams": { specVersion: 1, items: [{ name: "Bad", spec: polluted }] } }))
    assert.ok(withProto.fatalErrors.some((error) => error.includes('the key "__proto__" is not allowed')))
    const withConstructor = buildPlan(planInput(store, areas, { "members.teams": { specVersion: 1, items: [{ name: "Bad", spec: { description: "", members: [], constructor: { prototype: {} } } }] } }))
    assert.ok(withConstructor.fatalErrors.some((error) => error.includes('"constructor"')))

    let deep: ConfigSpec = { leaf: true }
    for (let depth = 0; depth < 40; depth += 1) deep = { next: deep }
    const tooDeep = buildPlan(planInput(store, areas, { "members.teams": { specVersion: 1, items: [{ name: "Deep", spec: deep }] } }))
    assert.ok(tooDeep.fatalErrors.some((error) => error.includes("nested more than 32 levels deep")))

    // The envelope parser checks the raw input, before schema parsing can drop a `__proto__` key.
    const raw: unknown = JSON.parse('{"members":{"teams":{"specVersion":1,"items":[{"name":"Bad","spec":{"__proto__":{"polluted":true}}}]}}}')
    assert.ok(flattenConfigAreas(raw).errors.some((error) => error.includes('"__proto__"')))

    const copy = rewriteRefs(JSON.parse('{"a":{"__proto__":{"polluted":true}},"b":{"$ref":"members.teams/tem_A"}}'), (_path, ref) => ({ ...ref, id: "x" }))
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false)
    assert.deepEqual(copy, { a: {}, b: { $ref: "members.teams/tem_A", id: "x" } })
  })

  test("a secret pasted into a secret field is redacted everywhere and makes the request invalid", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["ai-gateway.providers"])
    blob["ai-gateway.providers"]!.items[0]!.spec.credentials = { apiKey: "sk-pasted-secret-value" }
    const result = buildPlan(planInput(store, areas, blob))
    assert.ok(result.fatalErrors.includes('ai-gateway.providers "Anthropic (prod)": a secret value was pasted into credentials.apiKey; use the inputs step instead'))
    assert.ok(!JSON.stringify(result).includes("sk-pasted-secret-value"))
    const entry = item(result.plan, "ai-gateway.providers", "ipr_A")
    assert.ok(entry.flags.includes("blocked"))
    assert.equal(entry.fields.find((field) => field.path === "credentials.apiKey")?.to, "[redacted]")
  })
})

describe("security fixes in planning", () => {
  test("an explicit value or env decision writes an otherwise unchanged item", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["ai-gateway.providers"])
    assert.equal(item(buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey] })).plan, "ai-gateway.providers", "ipr_A").op, "unchanged")
    const replaced = buildPlan(planInput(store, areas, blob, { secretInputs: [{ path: keepKey.path, decision: "value", value: "sk-new" }] }))
    const entry = item(replaced.plan, "ai-gateway.providers", "ipr_A")
    assert.equal(entry.op, "update")
    assert.ok(entry.reasons?.includes("credential will be replaced"))
    assert.deepEqual(replaced.execution.ops.map((op) => `${op.kind} ${op.targetId}`), ["update ipr_A"])
    assert.deepEqual(secretsNeedingValues(replaced.execution).map((secret) => secret.path), [keepKey.path])
    const env = buildPlan(planInput(store, areas, blob, { secretInputs: [{ path: keepKey.path, decision: "env", env: "KEY" }], allowEnv: () => true }))
    assert.equal(item(env.plan, "ai-gateway.providers", "ipr_A").op, "update")
  })

  test("revs cover name and key: a target rename after export is left alone, a blob-only rename applies", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const teamsArea = areas.find((area) => area.key === "members.teams")!
    const platform = store.get("members.teams")![0]!
    assert.notEqual(itemRev(teamsArea, platform), itemRev(teamsArea, { ...platform, name: "Platform team" }))
    assert.notEqual(itemRev(teamsArea, platform), itemRev(teamsArea, { ...platform, key: "other" }))

    const blob = exportBlob(store, areas, ["members.teams"])
    const renamedOnTarget = seed()
    renamedOnTarget.get("members.teams")![0]!.name = "Platform team"
    const targetRename = item(buildPlan(planInput(renamedOnTarget, areas, blob, { sameOrganization: true })).plan, "members.teams", "tem_A")
    assert.equal(targetRename.op, "untouched")

    const edited = structuredClone(blob)
    edited["members.teams"]!.items[0]!.name = "Platform crew"
    const blobRename = item(buildPlan(planInput(store, areas, edited, { sameOrganization: true })).plan, "members.teams", "tem_A")
    assert.equal(blobRename.op, "rename")
    assert.deepEqual(blobRename.fields, [{ path: "name", from: "Platform", to: "Platform crew" }])

    const both = item(buildPlan(planInput(renamedOnTarget, areas, edited, { sameOrganization: true })).plan, "members.teams", "tem_A")
    assert.ok(both.flags.includes("drift"))
  })

  test("a chosen ref target must exist among the referenced area's loaded items", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "ai-gateway.providers": { specVersion: 1, items: [{ id: "ipr_NEW", name: "OpenAI", spec: {
        access: { orgWide: false, teams: [{ $ref: "members.teams/tem_GONE", name: "Gone" }] },
        connector: { $ref: "connectors.mcp/mcp_X" },
      } }] },
    }
    const choose = (targetId: string, path: string) => ({ area: "ai-gateway.providers" as const, ref: "ipr_NEW", path, resolution: { targetId } })
    const resolved = (decided: ReturnType<typeof choose>[], targetItems?: BuildPlanInput["targetItems"]) =>
      item(buildPlan(planInput(store, areas, blob, { decisions: decisions({ refs: decided }), ...(targetItems ? { targetItems } : {}) })).plan, "ai-gateway.providers", "ipr_NEW").refs ?? []
    assert.equal(resolved([choose("tem_B", "access.teams[0]")])[0]?.resolvedId, "tem_B")
    assert.equal(resolved([choose("tem_ELSEWHERE", "access.teams[0]")])[0]?.resolvedId, null)
    // connectors.mcp is not loaded: a chosen id can't be checked, so it is not accepted.
    const withoutMcp = new Map([...structuredClone([...store.entries()])].filter(([key]) => key !== "connectors.mcp"))
    assert.equal(resolved([choose("mcp_X", "connector")], withoutMcp)[1]?.resolvedId, null)
  })

  test("schema defaults fill fields a hand-written item leaves out", () => {
    const store = seed()
    store.set("members.people", [{ id: "om_ada", key: null, name: "Ada", spec: { email: "ada@example.com", role: "member", status: "active", teams: [], managedBy: "manual" } }])
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.people": { specVersion: 1, items: [{ name: "ada@example.com", spec: { email: "ada@example.com", role: "member" } }] },
    }
    const { plan, errors } = buildPlan(planInput(store, areas, blob))
    assert.deepEqual(errors, [])
    const entry = item(plan, "members.people", "#0")
    assert.equal(entry.matchedBy, "natural")
    assert.equal(entry.op, "unchanged")
  })

  test("references into areas the caller can't view keep their id but lose names", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob = exportBlob(store, areas, ["ai-gateway.providers"])
    const provider = blob["ai-gateway.providers"]!.items[0]!
    provider.spec = { ...provider.spec, access: { orgWide: false, teams: [{ $ref: "members.teams/tem_B", name: "Design" }] } }
    const visible = buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey] }))
    assert.deepEqual(item(visible.plan, "ai-gateway.providers", "ipr_A").fields.find((field) => field.path === "access.teams"), { path: "access.teams", added: ["Design"], removed: ["Platform"] })

    const hidden = buildPlan(planInput(store, areas, blob, { secretInputs: [keepKey], visibleAreas: new Set<ConfigAreaKey>(["ai-gateway.providers"]) }))
    const entry = item(hidden.plan, "ai-gateway.providers", "ipr_A")
    assert.deepEqual(entry.fields.find((field) => field.path === "access.teams"), { path: "access.teams", added: ["members.teams/tem_B"], removed: ["members.teams/tem_A"] })
    assert.deepEqual(entry.refs, [{ path: "access.teams[0]", ref: "members.teams/tem_B", resolvedId: "tem_B", via: "target" }])
    assert.ok(!JSON.stringify(hidden.plan).includes("Platform"))
    assert.equal(hidden.execution.ops[0]?.refs[0]?.resolution.kind, "target")
  })
})

describe("ordering", () => {
  test("dependencies first; cycles throw", () => {
    const area = (key: ConfigAreaKey, dependsOn: ConfigAreaKey[]) => ({ key, dependsOn })
    assert.deepEqual(sortAreas([area("desktop-policies", ["connectors.mcp", "members.teams"]), area("connectors.mcp", ["connectors.oauth-clients"]), area("connectors.oauth-clients", []), area("members.teams", [])]).map((entry) => entry.key), [
      "connectors.oauth-clients",
      "connectors.mcp",
      "members.teams",
      "desktop-policies",
    ])
    assert.throws(() => sortAreas([area("members.teams", ["members.roles"]), area("members.roles", ["members.teams"])]), /cycle/)
  })

  test("deletes run after creates and updates, dependents first", () => {
    const store = seed()
    const areas = makeAreas(store, [])
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [{ name: "New team", spec: { description: "", members: [] } }] },
      "ai-gateway.providers": { specVersion: 1, items: [] },
    }
    const { execution } = buildPlan(planInput(store, areas, blob, { mode: "mirror", decisions: decisions({ deletes: [
      { area: "members.teams", targetId: "tem_B" },
      { area: "ai-gateway.providers", targetId: "ipr_A" },
    ] }) }))
    assert.deepEqual(execution.ops.map((op) => `${op.kind} ${op.area}`), [
      "create members.teams",
      "delete ai-gateway.providers",
      "delete members.teams",
    ])
  })
})

describe("preflight", () => {
  test("skip, block and warnings from the areas' preflight shape the plan; skipped items never execute", async () => {
    const store = seed()
    const seen: string[] = []
    const areas = makeAreas(store, [], {
      "members.teams": {
        preflight: async (_ctx, op) => {
          if (op.kind !== "create") return null
          seen.push(op.item.name)
          if (op.item.name === "Synced") return { skip: "comes from a source here" }
          if (op.item.name === "Needs setup") return { block: "connect GitHub first", warnings: ["checked"] }
          if (op.item.name === "Boom") throw new Error("database down")
          return null
        },
      },
    })
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {
      "members.teams": { specVersion: 1, items: [
        { id: "tem_S", name: "Synced", spec: { description: "", members: [] } },
        { id: "tem_N", name: "Needs setup", spec: { description: "", members: [] } },
        { id: "tem_F", name: "Fine", spec: { description: "", members: [] } },
        { id: "tem_X", name: "Boom", spec: { description: "", members: [] } },
      ] },
      "ai-gateway.providers": { specVersion: 1, items: [{ id: "ipr_N", name: "Uses synced", spec: { providerId: "openai", access: { teams: [{ $ref: "members.teams/tem_S", name: "Synced" }] } } }] },
    }
    const input = planInput(store, areas, blob)
    const first = buildPlan(input)
    assert.equal(first.plan.summary.create, 5)
    const verdicts = await runPreflight(first.execution, areas, ctx)
    assert.deepEqual(seen.sort(), ["Boom", "Fine", "Needs setup", "Synced"])
    assert.deepEqual([...verdicts.keys()].sort(), [preflightKey("members.teams", "tem_N"), preflightKey("members.teams", "tem_S"), preflightKey("members.teams", "tem_X")].sort())
    const second = buildPlan({ ...input, preflight: verdicts })
    assert.notEqual(second.plan.planHash, first.plan.planHash)

    const synced = item(second.plan, "members.teams", "tem_S")
    assert.equal(synced.op, "skip")
    assert.deepEqual(synced.flags, [])
    assert.ok(synced.reasons?.includes("comes from a source here"))
    const blocked = item(second.plan, "members.teams", "tem_N")
    assert.equal(blocked.op, "create")
    assert.ok(blocked.flags.includes("blocked"))
    assert.ok(blocked.reasons?.includes("connect GitHub first") && blocked.reasons.includes("warning: checked"))
    // A check that throws never blocks: the apply does the real check.
    const boom = item(second.plan, "members.teams", "tem_X")
    assert.ok(!boom.flags.includes("blocked") && boom.reasons?.some((reason) => reason.startsWith("warning: ")))
    // A reference to the skipped item is unresolved, as for an admin's skip.
    const provider = item(second.plan, "ai-gateway.providers", "ipr_N")
    assert.ok(provider.flags.includes("ref_unresolved"), JSON.stringify(provider))
    assert.ok(!second.execution.ops.some((op) => op.ref === "tem_S"))
    assert.equal(second.plan.summary.skip, 1)

    // The admin skips the blocked item and drops the reference: nothing blocks, the preflight skip stays.
    const resolved = buildPlan({ ...input, preflight: verdicts, decisions: decisions({
      skips: [{ area: "members.teams", ref: "tem_N" }],
      refs: [{ area: "ai-gateway.providers", ref: "ipr_N", path: "access.teams[0]", resolution: { drop: true } }],
    }) })
    assert.equal(resolved.plan.summary.blocking, 0, JSON.stringify(resolved.plan.areas))
    assert.equal(item(resolved.plan, "members.teams", "tem_N").reasons?.at(-1), "excluded from this import")
    assert.deepEqual(resolved.execution.ops.map((op) => op.ref).sort(), ["ipr_N", "tem_F", "tem_X"])
  })

  test("preflight on a delete: skip leaves the item untouched, block flags it", async () => {
    const store = seed()
    const areas = makeAreas(store, [], {
      "members.teams": { preflight: async (_ctx, op) => (op.kind === "delete" ? (op.targetId === "tem_A" ? { skip: "still used" } : { block: "check first" }) : null) },
    })
    const blob: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = { "members.teams": { specVersion: 1, items: [] } }
    const input = planInput(store, areas, blob, { mode: "mirror", decisions: decisions({ deletes: [{ area: "members.teams", targetId: "tem_A" }, { area: "members.teams", targetId: "tem_B" }] }) })
    const first = buildPlan(input)
    const second = buildPlan({ ...input, preflight: await runPreflight(first.execution, areas, ctx) })
    assert.equal(item(second.plan, "members.teams", "target:tem_A").op, "untouched")
    assert.ok(item(second.plan, "members.teams", "target:tem_A").reasons?.[0]?.includes("still used"))
    assert.equal(item(second.plan, "members.teams", "target:tem_B").op, "delete")
    assert.ok(item(second.plan, "members.teams", "target:tem_B").flags.includes("blocked"))
    assert.deepEqual(second.execution.ops.map((op) => op.targetId), ["tem_B"])
  })
})
