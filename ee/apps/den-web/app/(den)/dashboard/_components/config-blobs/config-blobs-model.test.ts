import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_BLOB_MAX_BYTES, EMPTY_CONFIG_DECISIONS, type ConfigApplyReport, type ConfigAreaDescriptor, type ConfigPlan } from "@openwork/types/den/config-blobs";
import {
  approvalState,
  canRestoreRequest,
  checkImportFile,
  deletesHeading,
  configExportFileName,
  exportAreasParam,
  formatApplyStep,
  formatDuration,
  formatFieldChange,
  formatFieldPath,
  formatRunCounts,
  runDurationMs,
  runFailure,
  runIrreversible,
  runRequester,
  groupConfigAreas,
  isDeletable,
  keepableSecrets,
  planSteps,
  refEntries,
  requestIssues,
  splitRestoreIssues,
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
  assert.deepEqual(keepableSecrets(plan), ["p"]);
});

test("a reference to an item the same file adds needs no decision", () => {
  const withRefs: ConfigPlan = { ...plan, areas: [{ area: "connectors.mcp", label: "MCP", items: [{
    area: "connectors.mcp", ref: "#0", op: "create", blob: { name: "Docs" }, matchedBy: null, flags: [], fields: [],
    refs: [
      { path: "access.teams[0]", ref: "members.teams/platform", name: "Platform", resolvedId: null, via: "planned" },
      { path: "access.teams[1]", ref: "members.teams/gone", name: "Gone", resolvedId: null, via: null },
    ],
  }] }] };
  assert.deepEqual(refEntries(withRefs).map((entry) => entry.reference.name), ["Gone"]);
  assert.deepEqual(planSteps(withRefs, EMPTY_CONFIG_DECISIONS).map((step) => [step.step, step.open]), [["references", 1], ["review", 0]]);
});

test("in mirror mode target-only items are offered for removal", () => {
  const items = plan.areas[0]?.items ?? [];
  assert.deepEqual(items.map((item) => isDeletable(item, "mirror")), [false, true, false]);
  assert.deepEqual(items.map((item) => isDeletable(item, "merge")), [false, false, false]);
});

test("field paths read as breadcrumbs; keyed elements show their key", () => {
  assert.equal(formatFieldPath("models[id=gpt-5].config.temperature"), "Models › gpt-5 › Config › Temperature");
  assert.equal(formatFieldPath("access.allMembers"), "Access › All members");
  assert.equal(formatFieldPath("credentialSets[0].credential"), "Credential sets › 0 › Credential");
  assert.equal(formatFieldPath("credentials.apiKey"), "Credentials › API key");
  assert.equal(formatFieldPath("oauth.client.clientId"), "OAuth › Client › Client ID");
  assert.equal(formatFieldPath("(spec)"), "Settings");
});

test("set changes show what is removed now and what the file adds", () => {
  assert.deepEqual(formatFieldChange({ path: "access.teams", added: ["Design"], removed: ["Support", "Sales"] }), { now: "Removes Support, Sales", file: "Adds Design" });
  assert.deepEqual(formatFieldChange({ path: "name", from: "A", to: "B" }), { now: "A", file: "B" });
  assert.deepEqual(formatFieldChange({ path: "models[id=gpt-5-mini]", from: { id: "gpt-5-mini" } }), { now: "gpt-5-mini", file: "Removed" });
  assert.deepEqual(formatFieldChange({ path: "models[id=gpt-5-nano]", to: { id: "gpt-5-nano" } }), { now: "Not here", file: "gpt-5-nano" });
});

test("item-level validation errors stay on the item, request-level issues stay on top", () => {
  const withIssues: ConfigPlan = { ...plan, issues: [
    { level: "error", message: 'Teams "Platform": managedBy: Invalid option', area: "members.teams" },
    { level: "info", message: "Roles: in scope but not in the blob, treated as empty" },
  ] };
  assert.deepEqual(requestIssues(withIssues).map((issue) => issue.level), ["info"]);
});

test("a restore's can't-undo warnings read as one list", () => {
  const { cantUndo, rest } = splitRestoreIssues([
    { level: "warning", message: `These can't be undone by restoring: People "Ada": An invitation email is sent to ada@example.com.`, area: "members.people" },
    { level: "info", message: "Credentials are never stored in snapshots." },
  ]);
  assert.deepEqual(cantUndo, [`People "Ada": An invitation email is sent to ada@example.com.`]);
  assert.deepEqual(rest.map((issue) => issue.level), ["info"]);
});

test("restore is offered once per applied change, again after a withdrawn restore", () => {
  assert.equal(canRestoreRequest({ status: "applied", revertedByChangeRequestId: null }, 1), true);
  assert.equal(canRestoreRequest({ status: "failed", revertedByChangeRequestId: null }, 1), true);
  // den-api links only a restore that is open or ran; a cancelled one comes back as null.
  assert.equal(canRestoreRequest({ status: "applied", revertedByChangeRequestId: "ccr_1" }, 1), false);
  assert.equal(canRestoreRequest({ status: "applied", revertedByChangeRequestId: null }, 0), false);
  assert.equal(canRestoreRequest({ status: "cancelled", revertedByChangeRequestId: null }, 1), false);
});

test("a restore's removals are named as what the restored change added", () => {
  assert.equal(deletesHeading(false), "Not in the file: remove?");
  assert.equal(deletesHeading(true), "Added by the change being restored: remove?");
});

test("approval rules match den-api: one approval each, second approver not the uploader", () => {
  assert.deepEqual(approvalState({ approvals: [], createdByMemberId: "m1", memberId: "m1", requireSecondApprover: true }), { needed: 2, canApprove: true, reason: null });
  assert.equal(approvalState({ approvals: [{ memberId: "m1" }], createdByMemberId: "m1", memberId: "m1", requireSecondApprover: true }).canApprove, false);
  assert.equal(approvalState({ approvals: [{ memberId: "m2" }], createdByMemberId: "m1", memberId: "m1", requireSecondApprover: true }).canApprove, false);
  assert.equal(approvalState({ approvals: [{ memberId: "m1" }], createdByMemberId: "m1", memberId: "m2", requireSecondApprover: true }).canApprove, true);
  assert.equal(approvalState({ approvals: [{ memberId: "m1" }], createdByMemberId: "m1", memberId: "m1", requireSecondApprover: false }).reason, null);
});

const failedRun: ConfigApplyReport = {
  runId: "car_1",
  attempt: 2,
  status: "failed",
  startedAt: "2026-11-09T10:00:00.000Z",
  finishedAt: "2026-11-09T10:00:03.500Z",
  requestedBy: { memberId: "om_1", name: "Ada", apiKeyName: "CI" },
  runsAs: { memberId: "om_2", name: "Grace" },
  counts: { applied: 1, noop: 1, failed: 1, not_reached: 2, skipped: 0 },
  failure: null,
  warnings: [],
  items: [
    { area: "members.teams", ref: "tem_1", name: "Platform", op: "update", localId: "tem_1", status: "applied", steps: [{ action: "add", target: "members", detail: "Ada" }], warnings: [], irreversible: ["Ada was emailed"], startedAt: "2026-11-09T10:00:00.000Z", durationMs: 120 },
    { area: "members.teams", ref: "tem_2", name: "Design", op: "update", localId: "tem_2", status: "noop", steps: [], warnings: [], irreversible: [], startedAt: "2026-11-09T10:00:00.200Z", durationMs: 0 },
    {
      area: "ai-gateway.providers", ref: "ipr_1", name: "OpenAI", op: "update", localId: "ipr_1", status: "failed",
      steps: [{ action: "update", target: "models[id=gpt-5]" }],
      failure: { code: "invalid_url", message: "The base URL isn't reachable.", field: "baseUrl", step: { action: "set", target: "baseUrl" }, status: 400 },
      warnings: [], irreversible: [], startedAt: "2026-11-09T10:00:00.300Z", durationMs: 900,
    },
    { area: "ai-gateway.providers", ref: "ipr_2", name: "Anthropic", op: "create", localId: null, status: "not_reached", steps: [], warnings: [], irreversible: [], startedAt: null, durationMs: null },
    { area: "connectors.mcp", ref: "mcp_1", name: "Docs", op: "delete", localId: "mcp_1", status: "not_reached", steps: [], warnings: [], irreversible: ["Members' sign-ins are revoked"], startedAt: null, durationMs: null },
  ],
};
const labels = (key: string) => ({ "members.teams": "Teams", "ai-gateway.providers": "AI Providers", "connectors.mcp": "MCP" }[key] ?? key);

test("apply steps read as plain sentences", () => {
  assert.equal(formatApplyStep({ action: "add", target: "access.teams", detail: "Platform" }), "Added Access › Teams: Platform");
  assert.equal(formatApplyStep({ action: "update", target: "models[id=gpt-5]" }), "Updated Models › gpt-5");
  assert.equal(formatApplyStep({ action: "create", target: "" }), "Created");
  assert.equal(formatApplyStep({ action: "create", target: "connection", detail: "Docs" }, "attempted"), "Create Connection: Docs");
});

test("a run's counts, duration and who ran it", () => {
  assert.equal(formatRunCounts(failedRun.counts), "1 done, 1 already up to date, 1 failed, 2 not reached");
  assert.equal(formatRunCounts({ applied: 0, noop: 0, failed: 0, not_reached: 0, skipped: 0 }), "Nothing to apply");
  assert.equal(formatDuration(runDurationMs(failedRun)), "3.5 s");
  assert.equal(formatDuration(350), "350 ms");
  assert.equal(formatDuration(125_000), "2 min 5 s");
  assert.equal(formatDuration(null), "");
  assert.equal(runRequester(failedRun), 'Ada with the token "CI"');
});

test("the failed item is explained: where, what, what was written, what was not reached", () => {
  const failure = runFailure(failedRun, labels);
  assert.ok(failure);
  assert.equal(failure.where, "AI Providers › OpenAI › Base URL");
  assert.equal(failure.message, "The base URL isn't reachable.");
  assert.equal(failure.failedStep, "Set Base URL");
  assert.deepEqual(failure.written, ["Updated Models › gpt-5"]);
  assert.deepEqual(failure.notReached.map((item) => item.name), ["Anthropic", "Docs"]);
  assert.equal(failure.interrupted, false);
  assert.equal(runFailure({ ...failedRun, items: failedRun.items.filter((item) => item.status !== "failed") }, labels), null);
});

test("only effects that happened are listed as impossible to undo", () => {
  assert.deepEqual(runIrreversible(failedRun, labels), ["Teams › Platform: Ada was emailed"]);
});
