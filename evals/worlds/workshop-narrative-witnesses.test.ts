import test from "node:test";
import assert from "node:assert/strict";
import { artifactDigest } from "../../ee/apps/den-api/src/workflow-artifacts.ts";
import { observedServiceCalls, observedNativeWorkflowCalls, workflowWitness, sharingWitness, type NativeWorkflowObservation, type WorkflowWitnessContext } from "./workshop-narrative-witnesses.ts";
import { verifyWorkshopScene, type ObserverSnapshot, type SceneEvidence } from "./workshop-narrative-contract.ts";
const snapshot = (): ObserverSnapshot => ({ messages: [], atlassian: { audit: [] }, microsoft: { audit: [] }, news: { audit: [] }, workflows: { items: [] } });
test("opaque scripts need real server calls in a unique completed tool time window", () => {
  const before = snapshot(), after = snapshot();
  after.messages = [{ parts: [{ type: "tool", callID: "actual-call", tool: "openwork-cloud_execute_capability_script", state: { status: "completed", time: { start: 100, end: 200 }, input: { code: "return literal" }, output: "made-up data" } }] }];
  assert.deepEqual(observedServiceCalls(before, after), []);
  after.atlassian = { audit: [{ sequence: 1, at: 150, name: "confluence_get_page", input: { page_id: "page" }, output: { id: "page", body: "Actual provider data" }, status: "completed" }] };
  assert.equal(observedServiceCalls(before, after)[0]?.callId, "actual-call");
  before.atlassian = after.atlassian;
  assert.deepEqual(observedServiceCalls(before, after), []);
});
const testInput = { customerRequest: "Compare Atlas 2 and Atlas Lift for warehouse picking" };
const rerunInput = { customerRequest: "Compare Atlas Lift for cold-storage pallet moves" };
const recipientInput = { customerRequest: "Compare Atlas 2 for line-side replenishment" };
const pages = [
  { id: "product-a", title: "Atlas 2 – datasheet", body: "Atlas 2: 300 kg payload. Goods-to-person warehouse picking; line-side replenishment." },
  { id: "product-b", title: "Atlas Lift – datasheet", body: "Atlas Lift: 1,200 kg payload. Cold storage down to -25 °C with optional kit." },
];
const comparison = (request: string) => ({ customerRequest: request, comparison: "Atlas 2: 300 kg, warehouse picking and line-side replenishment [product-a]. Atlas Lift: 1,200 kg, cold-storage pallet moves down to -25 °C with optional kit [product-b]." });
function native(): NativeWorkflowObservation {
  return { list: { items: [{ title: "Acme product comparison", pluginId: "plugin", configObjectId: "workflow", configObjectVersionId: "version" }] }, details: { script: { configObjectId: "workflow", currentVersion: { id: "version", codeDigest: "code", inputSchemaDigest: "schema", outputSchemaDigest: null } }, workflow: { id: "workflow" }, views: [] }, grants: [], pluginGrants: [], snapshots: { owner: { items: [] }, recipient: { items: [] } }, runs: [], ownerMemberId: "owner", recipientMemberId: "recipient", boundary: { recipientDetail: { status: 200, body: { workflow: { id: "workflow", role: "viewer" }, script: { configObjectId: "workflow", canManage: false, currentVersion: { id: "version" } }, views: [] } }, outsiderMemberId: "outsider", outsiderList: { status: 200, body: { items: [] } }, outsiderDetail: { status: 403, body: { error: "forbidden" } }, outsiderSnapshots: { status: 403, body: { error: "forbidden" } } } };
}
function fixture() {
  const before = native(), after = native();
  const toolNames = [{ name: "atlassian.confluence_get_page" }];
  after.runs = [
    { id: "test", status: "succeeded", code_digest: "code", org_membership_id: "owner", config_object_id: null, config_object_version_id: null, source: "adhoc", script_input_digest: artifactDigest(testInput), result_digest: artifactDigest(comparison(testInput.customerRequest)), input_schema_digest: "schema", output_schema_digest: null, tool_calls: toolNames, started_at: 110, finished_at: 190 },
    { id: "rerun", status: "succeeded", code_digest: "code", org_membership_id: "owner", plugin_id: "plugin", config_object_id: "workflow", config_object_version_id: "version", source: "plugin:plugin:workflow", script_input_digest: artifactDigest(rerunInput), result_digest: artifactDigest(comparison(rerunInput.customerRequest)), input_schema_digest: "schema", output_schema_digest: null, tool_calls: toolNames, started_at: 310, finished_at: 390 },
    { id: "recipient-run", status: "succeeded", code_digest: "code", org_membership_id: "recipient", plugin_id: "plugin", config_object_id: "workflow", config_object_version_id: "version", source: "plugin:plugin:workflow", script_input_digest: artifactDigest(recipientInput), result_digest: artifactDigest(comparison(recipientInput.customerRequest)), input_schema_digest: "schema", output_schema_digest: null, tool_calls: toolNames, started_at: 510, finished_at: 590 },
  ];
  after.snapshots = { owner: { items: [{ receiptId: "rerun", configObjectId: "workflow", configObjectVersionId: "version", status: "succeeded", codeDigest: "code", value: comparison(rerunInput.customerRequest) }] }, recipient: { items: [{ receiptId: "recipient-run", configObjectId: "workflow", configObjectVersionId: "version", status: "succeeded", codeDigest: "code", value: comparison(recipientInput.customerRequest) }] } };
  const ownerScript = Object.fromEntries(Object.entries(after.details ?? {})).script;
  after.details = { ...Object.fromEntries(Object.entries(after.details ?? {})), script: { ...Object.fromEntries(Object.entries(ownerScript ?? {})), latestSnapshot: { receiptId: "rerun", value: comparison(rerunInput.customerRequest) } } };
  after.boundary!.recipientDetail!.body = { workflow: { id: "workflow", role: "viewer" }, script: { configObjectId: "workflow", canManage: false, currentVersion: { id: "version" }, latestSnapshot: { receiptId: "recipient-run", value: comparison(recipientInput.customerRequest) } }, views: [] };
  after.grants = { items: [{ id: "grant", orgMembershipId: "recipient", role: "viewer", orgWide: false, teamId: null, removedAt: null }] };
  const message = (member: string, start: number, receiptId: string, value: unknown) => ({ info: { id: `message-${receiptId}`, role: "assistant", sessionID: `${member}-session`, providerID: "paid-provider", modelID: "exact-model", agent: "openwork", finish: "stop", time: { completed: start + 100 } }, parts: [{ type: "tool", callID: `call-${receiptId}`, tool: "openwork-cloud_execute_capability_script", state: { status: "completed", time: { start, end: start + 100 }, output: JSON.stringify({ value, metadata: { receiptId, executionType: receiptId === "test" ? "authoring-test" : "saved-workflow", retention: { available: true, canSaveByReceipt: true } } }) } }] });
  const audit = [150, 350, 550].flatMap((at, index) => pages.map((page, pageIndex) => ({ sequence: index * 2 + pageIndex, at, name: "confluence_get_page", input: { page_id: page.id }, output: { metadata: { id: page.id, content: { value: page.body, format: "storage" } } }, status: "completed" })));
  const testMessage = message("owner", 100, "test", comparison(testInput.customerRequest));
  const rerunMessage = message("owner", 300, "rerun", comparison(rerunInput.customerRequest));
  const context: WorkflowWitnessContext = { owner: { before: snapshot(), after: { ...snapshot(), messages: [testMessage, rerunMessage], atlassian: { confluence: { pages }, audit } }, expected: { sessionId: "owner-session", providerID: "paid-provider", modelID: "exact-model" } }, recipient: { before: snapshot(), after: { ...snapshot(), messages: [message("recipient", 500, "recipient-run", comparison(recipientInput.customerRequest))], atlassian: { confluence: { pages }, audit } }, expected: { sessionId: "recipient-session", providerID: "paid-provider", modelID: "exact-model" } } };
  for (const actor of [context.owner, context.recipient]) if (actor) actor.inference = { upstreamModel: "actual-upstream", requests: [{ upstreamModel: "actual-upstream", status: "completed", httpStatus: 200 }] };
  return { before, after, context, authoringState: testMessage.parts[0].state, rerunState: rerunMessage.parts[0].state };
}
test("native authoring test is not mislabeled as a second saved execution; exact inputs are digest-corroborated", () => {
  const { before, after, context } = fixture();
  const witness = workflowWitness(before, after, context);
  assert.deepEqual(witness?.test.input, testInput);
  assert.deepEqual(witness?.rerun.input, rerunInput);
  assert.equal(witness?.verification.testExecutionType, "authoring-test");
  assert.equal(witness?.verification.rerunExecutionType, "saved-version");
  assert.deepEqual(witness?.authoringResultValue, comparison(testInput.customerRequest));
  assert.equal(artifactDigest(witness?.authoringResultValue), witness?.verification.testResultDigest);
});
test("native Code Mode saved execution is correlated without treating its script/stdout as a provider call", () => {
  const { before, after, context } = fixture();
  const actor = context.owner!;
  const messages = Array.isArray(actor.after.messages) ? actor.after.messages : [];
  actor.after.messages = [messages[0], { info: { id: "creation-message", role: "assistant", sessionID: "owner-session", providerID: "paid-provider", modelID: "exact-model", agent: "openwork", finish: "tool-calls", time: { completed: 250 } }, parts: [{ type: "tool", callID: "save-call", tool: "workflow_create", state: { status: "completed", time: { start: 200, end: 250 }, output: JSON.stringify({ configObjectId: "workflow", configObjectVersionId: "version" }) } }] }, messages[1]];
  actor.after.workflows = after.list;
  const check: SceneEvidence = { id: "T02", before: actor.before, after: actor.after, expected: actor.expected, elapsedMs: 1000, workflow: workflowWitness(before, after, context), serviceCalls: observedServiceCalls(actor.before, actor.after) };
  assert.deepEqual(verifyWorkshopScene(check).reasons, ["Model must actually rerun the saved native Workflow"], "Fixture reproduces the incomplete fixture-only observer");
  const nativeCalls = observedNativeWorkflowCalls(before, after, context);
  assert.ok(nativeCalls.some((call) => call.callId === "call-rerun" && call.name === "plugin:plugin:workflow" && JSON.stringify(call.output).includes('"receiptId":"rerun"')));
  check.serviceCalls = [...(check.serviceCalls ?? []), ...nativeCalls];
  assert.equal(verifyWorkshopScene(check).status, "PASS");
  check.serviceCalls = nativeCalls.map((call) => ({ ...call, callId: "fabricated-tool-id" }));
  assert.ok(verifyWorkshopScene(check).reasons.includes("Model must actually rerun the saved native Workflow"), "Native records still require the actual completed caller tool ID");
});

test("native execution normalization rejects missing actor evidence and altered backend receipts", () => {
  const first = fixture();
  assert.deepEqual(observedNativeWorkflowCalls(first.before, first.after, {}), []);
  for (const key of ["source", "result_digest", "code_digest", "script_input_digest"]) {
    const { before, after, context } = fixture();
    after.runs[1][key] = "forged";
    assert.ok(!observedNativeWorkflowCalls(before, after, context).some((call) => call.callId === "call-rerun"), key);
  }
});

test("native execution normalization keeps freshness, caller, actor, source and snapshot boundaries", () => {
  const mutations: [string, (state: ReturnType<typeof fixture>) => void][] = [
    ["no native row", ({ after }) => { after.runs = []; }],
    ["already observed receipt", ({ before, after }) => { before.runs.push({ ...after.runs[1] }); }],
    ["receipt only in code", ({ rerunState }) => { rerunState.output = JSON.stringify({ code: JSON.stringify({ receiptId: "rerun" }) }); }],
    ["receipt only in stdout", ({ rerunState }) => { rerunState.output = JSON.stringify({ stdout: JSON.stringify({ receiptId: "rerun" }) }); }],
    ["receipt absent from actual caller output", ({ rerunState }) => { rerunState.output = "No native receipt"; }],
    ["outside caller window", ({ after }) => { after.runs[1].started_at = 5000; after.runs[1].finished_at = 5100; }],
    ["wrong member", ({ after }) => { after.runs[1].org_membership_id = "recipient"; }],
    ["missing full source reads", ({ context }) => { context.owner!.after.atlassian = { confluence: { pages }, audit: [] }; }],
    ["schema mismatch", ({ after }) => { after.runs[1].input_schema_digest = "different-schema"; }],
    ["snapshot missing", ({ after }) => { after.snapshots = { owner: { items: [] }, recipient: { items: [] } }; }],
    ["actor inference absent", ({ context }) => { delete context.owner!.inference; }],
  ];
  for (const [name, mutate] of mutations) {
    const state = fixture(); mutate(state);
    assert.ok(!observedNativeWorkflowCalls(state.before, state.after, state.context).some((call) => call.callId === "call-rerun"), name);
  }
  const recipient = fixture(); recipient.after.runs[2].org_membership_id = "owner";
  assert.ok(!observedNativeWorkflowCalls(recipient.before, recipient.after, recipient.context).some((call) => call.callId === "call-recipient-run"), "recipient owner fallback");
});

const workflowMutations: [string, (after: NativeWorkflowObservation, context: WorkflowWitnessContext) => void][] = [
  ["later example run supersedes the required cold-storage rerun", (after) => { after.details = { script: { configObjectId: "workflow", currentVersion: { id: "version", codeDigest: "code", inputSchemaDigest: "schema", outputSchemaDigest: null }, latestSnapshot: { receiptId: "later-example", value: comparison(testInput.customerRequest) } } }; }],
  ["arbitrary distinct digests", (after) => { after.runs[0].script_input_digest = "different-a"; after.runs[1].script_input_digest = "different-b"; }],
  ["wrong exact request", (after) => { after.runs[1].script_input_digest = artifactDigest({ customerRequest: "Compare Atlas Lift" }); }],
  ["extra unrequested inputs", (after) => { after.runs[1].script_input_digest = artifactDigest({ ...rerunInput, ownerFallback: true }); }],
  ["different saved code", (after) => { after.runs[1].code_digest = "other-code"; }],
  ["different input schema", (after) => { after.runs[1].input_schema_digest = "other-schema"; }],
  ["wrong output digest", (after) => { after.runs[1].result_digest = "invented-result"; }],
  ["unchanged result reused for another input", (after) => { after.runs[1].result_digest = after.runs[0].result_digest; after.snapshots = { owner: { items: [{ receiptId: "rerun", configObjectId: "workflow", configObjectVersionId: "version", status: "succeeded", codeDigest: "code", value: comparison(testInput.customerRequest) }] } }; }],
  ["echoed request without comparison semantics", (after) => { after.runs[1].result_digest = artifactDigest(rerunInput); after.snapshots = { owner: { items: [{ receiptId: "rerun", configObjectId: "workflow", configObjectVersionId: "version", status: "succeeded", codeDigest: "code", value: rerunInput }] } }; }],
  ["paid provenance missing", (_after, context) => { delete context.owner!.inference; }],
  ["upstream fallback", (_after, context) => { context.owner!.inference!.upstreamModel = "fallback-upstream"; }],
  ["preflight only, no actor-window inference", (_after, context) => { context.owner!.inference!.requests = []; }],
  ["snapshot id without actual value", (after) => { after.snapshots = { owner: { items: [{ receiptId: "rerun" }] } }; }],
  ["no actual source dispatch", (after) => { after.runs[1].tool_calls = []; }],
  ["authoring test claimed as saved execution", (after) => { after.runs[0].config_object_id = "workflow"; }],
  ["unretained authoring source", (_after, context) => { context.owner!.after.messages = []; }],
  ["wrong backend model", (_after, context) => { context.owner!.expected.modelID = "fallback-model"; }],
  ["wrong session actor", (_after, context) => { context.owner!.expected.sessionId = "recipient-session"; }],
  ["search snippets instead of full source bodies", (_after, context) => { context.owner!.after.atlassian = { confluence: { pages }, audit: [{ sequence: 1, at: 350, name: "confluence_search", status: "completed", output: pages }] }; }],
  ["audit source reads outside execution", (_after, context) => { context.owner!.after.atlassian = { confluence: { pages }, audit: pages.map((page) => ({ at: 999, name: "confluence_get_page", status: "completed", output: page })) }; }],
];
for (const [name, mutate] of workflowMutations) test(`workflow rejects ${name}`, () => {
  const { before, after, context } = fixture(); mutate(after, context);
  assert.equal(workflowWitness(before, after, context), undefined);
});
test("sharing accepts the native Plugin viewer grant path and records its wider resource scope", () => {
  const { before, after, context } = fixture();
  after.grants = [];
  after.pluginGrants = [{ pluginId: "plugin", access: { items: [{ id: "plugin-grant", orgMembershipId: "recipient", role: "viewer", orgWide: false, teamId: null, removedAt: null }] } }];
  const witness = sharingWitness(before, after, context);
  assert.equal(witness?.grantId, "plugin-grant");
  assert.equal(witness?.verification.grantScope, "plugin");
  assert.equal(witness?.verification.grantedResourceId, "plugin");
});
test("sharing accepts an actual direct Workflow viewer grant", () => {
  const { before, after, context } = fixture();
  assert.equal(sharingWitness(before, after, context)?.executionMemberId, "recipient");
});
test("native authoring MCP response can keep result and retention metadata in separate text parts", () => {
  const { before, after, context, authoringState } = fixture();
  const metadata = { receiptId: "test", executionType: "authoring-test", retention: { available: true, canSaveByReceipt: true } };
  authoringState.output = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(comparison(testInput.customerRequest)) }, { type: "text", text: JSON.stringify({ metadata }) }] });
  assert.equal(workflowWitness(before, after, context)?.test.receiptId, "test");
});
test("a native joined JSON text response is decoded without treating code or logs as backend evidence", () => {
  const { before, after, context, authoringState } = fixture();
  const metadata = { receiptId: "test", executionType: "authoring-test", retention: { available: true, canSaveByReceipt: true } };
  authoringState.output = JSON.stringify(comparison(testInput.customerRequest), null, 2) + "\n" + JSON.stringify({ metadata });
  assert.equal(workflowWitness(before, after, context)?.test.receiptId, "test");
  authoringState.output = JSON.stringify({ code: authoringState.output });
  assert.equal(workflowWitness(before, after, context), undefined);
});
test("Plugin sharing explicitly records other visible Workflows in that Plugin", () => {
  const { before, after, context } = fixture();
  after.list = { items: [{ title: "Acme product comparison", pluginId: "plugin", configObjectId: "workflow", configObjectVersionId: "version" }, { title: "Other saved workflow", pluginId: "plugin", configObjectId: "other-workflow", configObjectVersionId: "other-version" }] };
  after.grants = [];
  after.pluginGrants = [{ pluginId: "plugin", access: { items: [{ id: "plugin-grant", orgMembershipId: "recipient", role: "viewer" }] } }];
  assert.deepEqual(sharingWitness(before, after, context)?.verification.visibleWorkflowIdsInGrantedPlugin, ["workflow", "other-workflow"]);
});
const sharingMutations: [string, (after: NativeWorkflowObservation, context: WorkflowWitnessContext) => void][] = [
  ["recipient detail shows a different latest result", (after) => { after.boundary!.recipientDetail!.body = { workflow: { id: "workflow", role: "viewer" }, script: { configObjectId: "workflow", canManage: false, currentVersion: { id: "version" }, latestSnapshot: { receiptId: "later-other", value: comparison(testInput.customerRequest) } } }; }],
  ["owner fallback", (after) => { after.runs[2].org_membership_id = "owner"; }],
  ["no second app execution provenance", (_after, context) => { delete context.recipient; }],
  ["recipient token/session confused with owner", (_after, context) => { context.recipient!.expected.sessionId = "owner-session"; }],
  ["owner-only snapshot readback", (after) => { after.snapshots = { owner: { items: [{ receiptId: "recipient-run" }] }, recipient: { items: [] } }; }],
  ["organization-wide blast radius", (after) => { after.grants = { items: [{ id: "grant", orgMembershipId: "recipient", role: "viewer", orgWide: true }] }; }],
  ["outsider can read exact workflow", (after) => { after.boundary!.outsiderDetail = { status: 200, body: { configObjectId: "workflow" } }; }],
  ["outsider snapshot boundary was not probed", (after) => { delete after.boundary!.outsiderSnapshots; }],
  ["outsider listing exposes workflow", (after) => { after.boundary!.outsiderList = { status: 200, body: { items: [{ configObjectId: "workflow" }] } }; }],
  ["recipient cannot read workflow", (after) => { after.boundary!.recipientDetail = { status: 403, body: {} }; }],
  ["recipient ran wrong input", (after) => { after.runs[2].script_input_digest = artifactDigest(rerunInput); }],
  ["recipient inference not observed", (_after, context) => { delete context.recipient!.inference; }],
  ["removed viewer grant", (after) => { after.grants = { items: [{ id: "grant", orgMembershipId: "recipient", role: "viewer", removedAt: "2026-10-16T10:00:00Z" }] }; }],
  ["manager privilege disguised by a viewer grant", (after) => { after.pluginGrants = [{ pluginId: "plugin", access: { items: [{ id: "manager-grant", orgMembershipId: "recipient", role: "manager" }] } }]; }],
  ["unrelated Plugin grant", (after) => { after.grants = []; after.pluginGrants = [{ pluginId: "unrelated-plugin", access: { items: [{ id: "grant", orgMembershipId: "recipient", role: "viewer" }] } }]; }],
  ["outsider unauthenticated rather than forbidden", (after) => { after.boundary!.outsiderDetail = { status: 401, body: {} }; }],
];
for (const [name, mutate] of sharingMutations) test(`sharing rejects ${name}`, () => {
  const { before, after, context } = fixture(); mutate(after, context);
  assert.equal(sharingWitness(before, after, context), undefined);
});
