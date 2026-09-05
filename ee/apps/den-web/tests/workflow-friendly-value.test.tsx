import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import type { WorkflowArtifactSnapshot } from "@openwork/types/workflows";
import { WorkflowArtifactResult } from "../app/(den)/dashboard/_components/workflow-artifact-result";

const value = {
  calendarEventCount: 4,
  matchedEventCount: 3,
  results: [
    {
      emailMatchCount: 3,
      end: "2026-08-19T16:30:00+02:00",
      start: "2026-08-19T16:00:00+02:00",
      title: "Enterprise (Jordan Example)",
      matchTerms: ['"Jordan Example"'],
      evidence: [
        { date: "Tue, 18 Aug 2026 14:45:55 +0200", matchedOn: '"Jordan Example"', snippet: "Hey! I&#39;m in town until Monday.", subject: "Re: Intro call" },
        { date: "x", matchedOn: "y", snippet: "z", subject: "w" },
        { date: "x2", matchedOn: "y2", snippet: "z2", subject: "w2" },
      ],
    },
    {
      emailMatchCount: 0,
      end: "2026-08-20T07:30:00+02:00",
      start: "2026-08-20T07:00:00+02:00",
      title: "Enterprise (Sam Placeholder)",
      matchTerms: ['"Acme Robotics"'],
      evidence: [],
    },
  ],
};

const digest = `sha256:${"a".repeat(64)}`;
const snapshot: WorkflowArtifactSnapshot = {
  receiptId: "receipt-1",
  pluginId: "plugin-1",
  configObjectId: "workflow-1",
  configObjectVersionId: "version-1",
  automationRunId: null,
  value,
  markdown: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
  codeDigest: digest,
  resultDigest: digest,
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
  rendererVersion: "codemode-markdown-v1",
  toolCalls: [],
  status: "succeeded",
  errorKind: null,
  errorMessage: null,
  source: "manual",
  startedAt: "2026-08-19T09:01:00.000Z",
  finishedAt: "2026-08-19T09:02:00.000Z",
  contentDeletedAt: null,
};

describe("Workflow friendly result", () => {
  test("renders nested workflow data for non-technical readers", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowArtifactResult, { snapshot, lastSuccessful: true }));

    expect(markup).toContain('data-testid="den-workflow-friendly-value"');
    expect(markup).toContain("Calendar event count");
    expect(markup).toContain(">4<");
    expect(markup).toContain("Enterprise (Jordan Example)");
    expect(markup).toContain("Aug 19");
    expect(markup).toContain("Evidence");
    expect(markup).toContain("3 items");
    expect(markup).toContain("I&#x27;m in town until Monday");
    expect(markup).not.toContain("{&quot;");
    expect(markup).not.toContain("calendarEventCount");
  });

  test("keeps raw output behind technical details", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowArtifactResult, { snapshot, technical: true }));

    expect(markup).toContain("Technical details");
    expect(markup).toContain("calendarEventCount");
    expect(markup).toContain("Workflow version");
    expect(markup).toContain("Result digest");
  });
});
