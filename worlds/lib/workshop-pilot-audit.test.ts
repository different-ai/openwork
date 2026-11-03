import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineSessionProbePart } from "../../evals/packages/behaviors/src/engine-session-probe.ts";
import { validateAuditedPilotRead } from "./workshop-pilot-audit.ts";

const part: EngineSessionProbePart = { type: "tool", tool: "execute", callId: "fixture-call", status: "completed", input: { code: "const result = await tools['openwork-direct-workshop-jira-fixture'].jira_search({jql:'text ~ Northwind'}); console.log(result)" }, text: "", output: "Printed result is not trusted as the service audit", error: "" };
const title = "Localization drift near reflective tape (Northwind, dock 4)";
const audit = [{ service: "atlassian", entry: { sequence: 9, name: "jira_search", status: "completed", input: { jql: "text ~ Northwind" }, output: JSON.stringify({ issues: [{ fields: { summary: title } }] }) } }];
const final = `Northwind lookup succeeded: “${title}”. WORKSHOP_READY`;
test("Code Mode needs both a real completed MCP invocation and independent fresh provider output matching its final quote", () => {
  const proof = validateAuditedPilotRead([part], final, [], audit);
  assert.equal(proof.title, title); assert.equal(proof.engineTool, "execute"); assert.equal(proof.source, "independent-member-service-audit");
  assert.throws(() => validateAuditedPilotRead([], final, [], audit));
  assert.throws(() => validateAuditedPilotRead([part], final, [], []));
  assert.throws(() => validateAuditedPilotRead([part], final, [], [...audit, { service: "atlassian", entry: { name: "jira_update_issue", status: "completed" } }]));
  assert.throws(() => validateAuditedPilotRead([part], final, [], [...audit, ...audit, ...audit]));
  assert.throws(() => validateAuditedPilotRead([{ ...part, status: "error" }], final, [], audit));
  assert.throws(() => validateAuditedPilotRead([part], "Northwind is ready WORKSHOP_READY", [], audit));
  assert.throws(() => validateAuditedPilotRead([part], final, [], [{ service: "atlassian", entry: { ...audit[0]?.entry, status: "error" } }]));
  assert.throws(() => validateAuditedPilotRead([{ ...part, input: { code: "fetch('https://example.invalid'); // workshop-jira jira_search Northwind" } }], final, [], audit));
  assert.throws(() => validateAuditedPilotRead([part], final, [], [{ service: "atlassian", entry: { ...audit[0]?.entry, input: { jql: "all issues" } } }]));
});
