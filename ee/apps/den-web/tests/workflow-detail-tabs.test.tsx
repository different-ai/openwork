import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import type { WorkflowArtifactSnapshot, WorkflowDetail } from "@openwork/types/workflows";
import { WorkflowEditTab } from "../app/(den)/dashboard/_components/workflow-edit-tab";
import { WorkflowOverviewTab } from "../app/(den)/dashboard/_components/workflow-overview-tab";
import { WorkflowRunsTab } from "../app/(den)/dashboard/_components/workflow-runs-tab";
import type { WorkflowFields } from "../app/(den)/dashboard/_components/use-workflow-detail-state";

const digest = `sha256:${"a".repeat(64)}`;
const snapshot: WorkflowArtifactSnapshot = {
  receiptId: "receipt-1",
  pluginId: "plugin-1",
  configObjectId: "workflow-1",
  configObjectVersionId: "version-1",
  automationRunId: null,
  value: { answer: "Done" },
  markdown: "Done",
  codeDigest: digest,
  resultDigest: digest,
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
  rendererVersion: "codemode-markdown-v1",
  toolCalls: [{ name: "search.messages" }],
  status: "succeeded",
  errorKind: null,
  errorMessage: null,
  source: "manual",
  startedAt: "2026-09-04T10:00:00.000Z",
  finishedAt: "2026-09-04T10:01:00.000Z",
  contentDeletedAt: null,
};

const currentVersion: WorkflowDetail["currentVersion"] = {
    id: "version-1",
    code: "return { answer: input.query }",
    graph: {
      nodes: [
        { id: "input", kind: "input", label: "Input", fields: ["query"] },
        { id: "search", kind: "tool", label: "search.messages", namespace: "search", tool: "messages", scriptPath: "tools.search.messages", assignsTo: "messages", parallelGroup: null },
        { id: "return", kind: "return", label: "{ messages }" },
      ],
      edges: [
        { from: "input", to: "search", label: null, kind: "flow" },
        { from: "search", to: "return", label: null, kind: "flow" },
      ],
      parseError: null,
    },
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", title: "Search query" } },
      required: ["query"],
    },
    outputSchema: { type: "object" },
    exampleInput: { query: "renewals" },
    requiredCapabilities: [{ capabilityName: "search.messages", scriptPath: "tools.search.messages" }],
    codeDigest: digest,
    inputSchemaDigest: digest,
    outputSchemaDigest: digest,
    createdAt: "2026-09-04T09:00:00.000Z",
    automationReferences: [],
};

const detail: WorkflowDetail = {
  pluginId: "plugin-1",
  configObjectId: "workflow-1",
  title: "Weekly account review",
  description: "Review recent account activity.",
  canRun: true,
  canManage: true,
  currentVersion,
  versions: [currentVersion],
  latestSnapshot: snapshot,
  latestSuccessfulSnapshot: snapshot,
  freshness: { state: "fresh", ageMs: 60_000 },
};

const fields: WorkflowFields = {
  name: detail.title,
  description: detail.description ?? "",
  code: detail.currentVersion.code ?? "",
  input: JSON.stringify(detail.currentVersion.exampleInput, null, 2),
  inputSchema: JSON.stringify(detail.currentVersion.inputSchema, null, 2),
  outputSchema: JSON.stringify(detail.currentVersion.outputSchema, null, 2),
};

const noAction = () => undefined;

describe("Workflow detail tabs", () => {
  test("keeps run and display content in Overview without the source editor", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowOverviewTab, {
      detail,
      fields,
      views: [],
      technical: false,
      showJsonInput: false,
      parsedInputSchema: detail.currentVersion.inputSchema,
      hasInputForm: true,
      inputFormValue: { query: "renewals" },
      pending: false,
      viewPending: false,
      canManageDisplays: true,
      onTechnicalChange: noAction,
      onShowJsonInputChange: noAction,
      onInputChange: noAction,
      onRun: noAction,
      onActivateView: noAction,
      onRetireView: noAction,
    }));

    expect(markup).toContain('data-tab="overview"');
    expect(markup).toContain('data-testid="den-workflow-flow-diagram"');
    expect(markup).toContain('data-testid="den-workflow-input-form"');
    expect(markup).toContain("Custom display");
    expect(markup).not.toContain('aria-label="Workflow source"');
  });

  test("shows the source editor only in Edit", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowEditTab, {
      detail,
      fields,
      parsedInputSchema: detail.currentVersion.inputSchema,
      hasInputForm: true,
      inputFormValue: { query: "renewals" },
      tested: null,
      fingerprint: JSON.stringify(fields),
      pending: false,
      onUpdate: noAction,
      onTest: noAction,
      onSave: noAction,
    }));

    expect(markup).toContain('data-tab="edit"');
    expect(markup).toContain('aria-label="Workflow source"');
    expect(markup).toContain("return { answer: input.query }");
  });

  test("lists successful snapshots in Runs", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowRunsTab, {
      detail,
      snapshots: [snapshot],
      selectedSnapshot: snapshot,
      selectedReceiptId: snapshot.receiptId,
      technical: false,
      pending: false,
      automationCount: 0,
      automateHref: "/automations",
      onTechnicalChange: noAction,
      onSelectRun: noAction,
      onDeleteRun: noAction,
      onUpdateAutomation: noAction,
    }));

    expect(markup).toContain('data-tab="runs"');
    expect(markup).toContain("Past runs");
    expect(markup).toContain("Succeeded");
    expect(markup).toContain("Selected run");
  });
});
