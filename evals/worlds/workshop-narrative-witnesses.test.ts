import test from "node:test";
import assert from "node:assert/strict";
import { observedServiceCalls, workflowWitness, sharingWitness, type NativeWorkflowObservation } from "./workshop-narrative-witnesses.ts";
import type { ObserverSnapshot } from "./workshop-narrative-contract.ts";
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
function native(): NativeWorkflowObservation { return { list: { items: [{ title: "Acme product comparison", configObjectId: "workflow", configObjectVersionId: "version" }] }, details: { currentVersion: { id: "version", codeDigest: "code" } }, grants: [], snapshots: [], runs: [], ownerMemberId: "owner", recipientMemberId: "recipient" }; }
test("saved Workflow requires actual retained test, saved run and readable snapshot", () => {
  const before = native(), after = native();
  assert.equal(workflowWitness(before, after), undefined);
  after.runs = [{ id: "test", status: "succeeded", code_digest: "code", org_membership_id: "owner", config_object_id: null, script_input_digest: "input-a" }, { id: "rerun", status: "succeeded", org_membership_id: "owner", config_object_id: "workflow", config_object_version_id: "version", script_input_digest: "input-b" }];
  assert.equal(workflowWitness(before, after), undefined);
  after.snapshots = { items: [{ receiptId: "rerun" }] };
  assert.equal(workflowWitness(before, after)?.rerun.receiptId, "rerun");
});
test("sharing rejects an owner run and requires a new viewer grant plus recipient receipt", () => {
  const before = native(), after = native();
  after.grants = { items: [{ id: "grant", orgMembershipId: "recipient", role: "viewer" }] };
  after.runs = [{ id: "run", status: "succeeded", org_membership_id: "owner", config_object_id: "workflow", config_object_version_id: "version" }];
  after.snapshots = { items: [{ receiptId: "run" }] };
  assert.equal(sharingWitness(before, after), undefined);
  after.runs[0].org_membership_id = "recipient";
  assert.equal(sharingWitness(before, after)?.executionMemberId, "recipient");
});
