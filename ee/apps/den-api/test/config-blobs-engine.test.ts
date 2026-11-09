/**
 * The config-blob engine (src/config-blobs/engine) against fake areas:
 * teams (unique name natural key, people refs), providers (team refs, a
 * secret, keyed and ordered arrays) and an MCP area available on cloud only.
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { z } from "zod"
import type {
  ConfigAreaKey,
  ConfigBlobArea,
  ConfigDecisions,
  ConfigPlan,
  ConfigPlanItem,
  ConfigSecretInput,
  ConfigSpec,
  ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { EMPTY_CONFIG_DECISIONS } from "@openwork/types/den/config-blobs"
import type { ConfigApplyOp, ConfigArea, ConfigAreaContext, ConfigItem } from "../src/config-blobs/area.js"
import {
  baseHash,
  buildPlan,
  canonicalJson,
  executePlan,
  matchArea,
  secretsNeedingValues,
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
      items: structuredClone(store.get(key) ?? []).map((item) => ({ id: item.id, key: item.key ?? null, name: item.name, rev: specRev(area, item.spec), spec: item.spec })),
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
      "create members.teams tem_SRC_ML",
      "create members.teams tem_FREE",
      "create ai-gateway.providers ipr_NEW",
    ])

    const secrets = new Map<string, ResolvedConfigSecret>([[secretPath, { $secret: secretPath, decision: "value", value: "sk-live" }]])
    const result = await executePlan(execution, areas, ctx, secrets, { isIdFree: async (id) => id === "tem_FREE" || id === "ipr_NEW" })
    assert.equal(result.ok, true)
    assert.deepEqual(result.items.map((entry) => entry.status), ["applied", "applied", "applied"])
    const mlId = result.created.find((entry) => entry.ref === "tem_SRC_ML")?.localId
    assert.ok(mlId && mlId !== "tem_SRC_ML")
    assert.deepEqual(result.aliases, [{ area: "members.teams", sourceId: "tem_SRC_ML", localId: mlId }])
    assert.equal(result.created.find((entry) => entry.ref === "tem_FREE")?.localId, "tem_FREE")

    const teamCreate = calls[0]!.op
    assert.equal(teamCreate.kind, "create")
    if (teamCreate.kind !== "create") return
    assert.equal(teamCreate.preferredId, undefined)
    assert.deepEqual(teamCreate.item.spec.members, [{ $ref: "people/ada@example.com", id: "om_ada" }, { $ref: "people/new@example.com", invite: true }])
    const providerCreate = calls[2]!.op
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
    assert.deepEqual(failed.items.map((entry) => entry.status), ["failed", "skipped"])
    assert.equal(failed.items[0]?.error, "boom")

    const working = makeAreas(store, calls)
    const applied = await executePlan(execution, working, ctx, new Map())
    assert.equal(applied.ok, true)
    const update = calls.find((call) => call.area === "ai-gateway.providers")?.op
    assert.equal(update?.kind, "update")
    if (update?.kind !== "update") return
    assert.deepEqual(update.item.spec.credentials, { apiKey: { $secret: keepKey.path, decision: "keep" } })
    assert.equal(update.previous.id, "ipr_A")
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
