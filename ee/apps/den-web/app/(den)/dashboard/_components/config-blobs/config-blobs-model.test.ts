import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_BLOB_MAX_BYTES, EMPTY_CONFIG_DECISIONS, type ConfigAreaDescriptor, type ConfigPlan } from "@openwork/types/den/config-blobs";
import {
  checkImportFile,
  configExportFileName,
  exportAreasParam,
  groupConfigAreas,
  isDeletable,
  planSteps,
} from "./config-blobs-model";

function area(key: ConfigAreaDescriptor["key"], path: string[], overrides: Partial<ConfigAreaDescriptor> = {}): ConfigAreaDescriptor {
  return {
    key, label: path[path.length - 1] ?? key, path, specVersion: 1, supported: true, canExport: true, canImport: true,
    containsConfidentialContent: false, secretFields: [], ...overrides,
  };
}

const areas = [
  area("ai-gateway.providers", ["AI Gateway", "AI Providers"]),
  area("ai-gateway.byok", ["AI Gateway", "Bring your own keys"]),
  area("members.teams", ["Members", "Teams"]),
  area("desktop-policies", ["Desktop policies"], { canExport: false }),
];

test("areas group by the first breadcrumb segment in registry order", () => {
  assert.deepEqual(groupConfigAreas(areas).map((group) => [group.label, group.areas.length]), [["AI Gateway", 2], ["Members", 1], ["Desktop policies", 1]]);
});

test("selecting everything exportable downloads the whole organization", () => {
  const all = new Set(areas.filter((entry) => entry.canExport).map((entry) => entry.key));
  assert.equal(exportAreasParam(areas, all), null);
  assert.equal(exportAreasParam(areas, new Set(["ai-gateway.providers", "members.teams"])), "ai-gateway.providers,members.teams");
});

test("export file name carries the org slug and the date", () => {
  assert.equal(configExportFileName("Acme Corp", new Date("2026-11-09T10:00:00Z")), "openwork-config-acme-corp-2026-11-09.json");
});

test("import file check rejects invalid JSON, foreign files and oversize files", () => {
  assert.equal(checkImportFile("{", 1).ok, false);
  assert.equal(checkImportFile(JSON.stringify({ hello: 1 }), 12).ok, false);
  assert.equal(checkImportFile("{}", CONFIG_BLOB_MAX_BYTES + 1).ok, false);
  const valid = checkImportFile(JSON.stringify({ format: "openwork.config-blob", formatVersion: 1, scope: ["members.teams"], areas: { members: { teams: { specVersion: 1, items: [] } } } }), 100);
  assert.ok(valid.ok);
  assert.equal(valid.ok && valid.areaCount, 1);
});

const plan: ConfigPlan = {
  planHash: "sha256:x",
  mode: "mirror",
  summary: { create: 1, update: 0, rename: 0, unchanged: 0, delete: 0, untouched: 1, skip: 0, blocking: 2 },
  issues: [],
  areas: [{
    area: "members.teams",
    label: "Teams",
    items: [
      { area: "members.teams", ref: "tm_1", op: "create", blob: { name: "Platform" }, matchedBy: null, flags: ["needs_mapping"], fields: [], candidates: [{ id: "tm_9", name: "Platform team", score: 0.7, reasons: [] }] },
      { area: "members.teams", ref: "target:tm_5", op: "untouched", target: { id: "tm_5", name: "Old" }, matchedBy: null, flags: [], fields: [] },
      {
        area: "members.teams", ref: "tm_2", op: "update", blob: { name: "Sales" }, target: { id: "tm_2", name: "Sales" }, matchedBy: "id", flags: ["needs_input"], fields: [],
        secrets: [{ path: "p", field: "token", targetHasValue: true, sourceHadValue: true, decision: null }],
      },
    ],
  }],
};

test("steps list only what the plan needs, with open decisions counted", () => {
  assert.deepEqual(planSteps(plan, EMPTY_CONFIG_DECISIONS).map((step) => [step.step, step.open]), [["match", 1], ["secrets", 1], ["review", 0]]);
});

test("in mirror mode target-only items are offered for removal", () => {
  const items = plan.areas[0]?.items ?? [];
  assert.deepEqual(items.map((item) => isDeletable(item, "mirror")), [false, true, false]);
  assert.deepEqual(items.map((item) => isDeletable(item, "merge")), [false, false, false]);
});
