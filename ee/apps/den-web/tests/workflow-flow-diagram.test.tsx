import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import type { WorkflowGraph } from "@openwork/types/workflows";
import { WorkflowFlowDiagram } from "../app/(den)/dashboard/_components/workflow-flow-diagram";

const graph: WorkflowGraph = {
  nodes: [
    { id: "input", kind: "input", label: "Input", fields: ["query"] },
    { id: "slack", kind: "tool", label: "slack.search", namespace: "slack", tool: "search", scriptPath: "tools.slack.search", assignsTo: "channels", parallelGroup: "p1" },
    { id: "gmail", kind: "tool", label: "gmail.search", namespace: "gmail", tool: "search", scriptPath: "tools.gmail.search", assignsTo: "messages", parallelGroup: "p1" },
    { id: "branch", kind: "branch", label: "channels.length > 0" },
    { id: "return", kind: "return", label: "{ channels, messages }" },
    { id: "orgs", kind: "tool", label: "den.getMeOrgs", namespace: "den", tool: "getMeOrgs", scriptPath: "tools.den.getMeOrgs", assignsTo: "orgs", parallelGroup: null },
    { id: "final-return", kind: "return", label: "{ orgs }" },
  ],
  edges: [
    { from: "input", to: "slack", label: null, kind: "flow" },
    { from: "input", to: "gmail", label: null, kind: "flow" },
    { from: "input", to: "slack", label: "input.query", kind: "data" },
    { from: "slack", to: "branch", label: null, kind: "flow" },
    { from: "gmail", to: "branch", label: null, kind: "flow" },
    { from: "branch", to: "return", label: "yes", kind: "flow" },
    { from: "branch", to: "orgs", label: "no", kind: "flow" },
    { from: "orgs", to: "final-return", label: null, kind: "flow" },
  ],
  parseError: null,
};

describe("Workflow flow diagram", () => {
  test("renders parallel tools in one row with branch labels", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowFlowDiagram, { graph }));

    expect(markup).toContain('data-testid="den-workflow-flow-diagram"');
    expect(markup).toContain('data-node-ids="slack,gmail"');
    expect(markup).toContain('data-parallel-group="p1"');
    expect(markup).toContain('data-node-kind="branch"');
    expect(markup).toContain("The number of channels is more than 0");
    expect(markup).toContain('data-lane="yes"');
    expect(markup).toContain('data-lane="no"');
    expect(markup).toContain('data-step-number="1">1<');
    expect(markup).toContain('data-step-number="7">7<');
    expect(markup).toContain('data-terminal="true"');
    expect(markup.match(/data-connector="flow"/g)).toHaveLength(5);
  });

  test("only shows raw tool paths and conditions with technical details", () => {
    const plainMarkup = renderToStaticMarkup(createElement(WorkflowFlowDiagram, { graph }));
    const technicalMarkup = renderToStaticMarkup(createElement(WorkflowFlowDiagram, { graph, technical: true }));

    expect(plainMarkup).not.toContain("tools.slack.search");
    expect(plainMarkup).not.toContain("channels.length &gt; 0");
    expect(technicalMarkup).toContain("tools.slack.search");
    expect(technicalMarkup).toContain("channels.length &gt; 0");
  });

  test("marks the last started tool failed and later tools not reached", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowFlowDiagram, {
      graph,
      run: { toolCalls: [{ name: "slack.search" }], status: "failed", errorMessage: "Slack stopped responding", finishedAt: "2026-09-04T10:00:00.000Z" },
    }));

    expect(markup).toContain('data-node-id="slack" data-node-kind="tool" data-run-state="failed"');
    expect(markup).toContain('data-node-id="gmail" data-node-kind="tool" data-run-state="not_reached"');
    expect(markup).toContain('data-node-id="orgs" data-node-kind="tool" data-run-state="not_reached"');
    expect(markup).toContain("This run: ✗ stopped here");
    expect(markup).toContain("This run: skipped");
    expect(markup).toContain("Slack stopped responding");
  });

  test("matches succeeded parallel calls in either order", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowFlowDiagram, {
      graph,
      run: { toolCalls: [{ name: "gmail.search" }, { name: "slack.search" }], status: "succeeded", errorMessage: null, finishedAt: "2026-09-04T10:00:00.000Z" },
    }));

    expect(markup).toContain('data-node-id="slack" data-node-kind="tool" data-run-state="ran"');
    expect(markup).toContain('data-node-id="gmail" data-node-kind="tool" data-run-state="ran"');
  });
});
