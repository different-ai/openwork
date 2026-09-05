import { describe, expect, test } from "bun:test";
import type { WorkflowGraph } from "@openwork/types/workflows";
import {
  describeCondition,
  describeLoop,
  describeReturn,
  describeToolStep,
  humanizeIdentifier,
  serviceName,
  serviceTone,
  summarizeGraph,
} from "../app/(den)/dashboard/_components/workflow-plain-language";

describe("Workflow plain language", () => {
  test("turns identifiers into readable labels", () => {
    expect(humanizeIdentifier("maxEvents")).toBe("Max events");
    expect(humanizeIdentifier("getCapabilitiesGoogleWorkspaceCalendarEvents")).toBe("Get calendar events");
    expect(humanizeIdentifier("slack_read_channel")).toBe("Read channel");
    expect(humanizeIdentifier("listAutomationRuns")).toBe("List automation runs");
    expect(humanizeIdentifier("getMeOrgs")).toBe("Get my organizations");
  });

  test("names services and detects Google sub-services", () => {
    expect(serviceName("google_workspace")).toBe("Google Workspace");
    expect(serviceName("slack")).toBe("Slack");
    expect(serviceName("den")).toBe("OpenWork");
    expect(serviceName("marketplace")).toBe("Marketplace");
    expect(serviceName("$codemode")).toBe("Search");
    expect(serviceName("custom_service")).toBe("Custom service");
    expect(serviceTone("google_workspace")).toContain("amber");
    expect(serviceTone("gmail")).toContain("red");
    expect(serviceTone("calendar")).toContain("blue");
    expect(describeToolStep({
      id: "calendar",
      kind: "tool",
      label: "calendar",
      namespace: "google_workspace",
      tool: "getCapabilitiesGoogleWorkspaceCalendarEvents",
      scriptPath: "tools.google_workspace.getCapabilitiesGoogleWorkspaceCalendarEvents",
      assignsTo: "events",
      parallelGroup: null,
    })).toEqual({ title: "Get calendar events", service: "Google Calendar" });
  });

  test("describes common conditions", () => {
    expect(describeCondition("!x")).toEqual({ text: "X is missing", technical: false });
    expect(describeCondition("a && b")).toEqual({ text: "A and B are set", technical: false });
    expect(describeCondition("a > b").text).toBe("A is more than B");
    expect(describeCondition("a < b").text).toBe("A is less than B");
    expect(describeCondition("a >= b").text).toBe("A is at least B");
    expect(describeCondition("a <= b").text).toBe("A is at most B");
    expect(describeCondition("a === b").text).toBe("A is B");
    expect(describeCondition("a == b").text).toBe("A is B");
    expect(describeCondition("a !== b").text).toBe("A is not B");
    expect(describeCondition("input.foo")).toEqual({ text: "Foo is set", technical: false });
    expect(describeCondition("input && input.gmailSince")).toEqual({ text: "Gmail since is set", technical: false });
    expect(describeCondition("input?.gmailSince")).toEqual({ text: "Gmail since is set", technical: false });
    expect(describeCondition("!input.endIso")).toEqual({ text: "End ISO is missing", technical: false });
    expect(describeCondition("input.startIso && input.endIso")).toEqual({ text: "Start ISO and End ISO are set", technical: false });
    expect(describeCondition("team.length > input.minTeamSize")).toEqual({ text: "The number of team is more than Min team size", technical: false });
    expect(describeCondition("input.count < 10").text).toBe("Count is less than 10");
    expect(describeCondition("input.count >= 10").text).toBe("Count is at least 10");
    expect(describeCondition("input.count <= 10").text).toBe("Count is at most 10");
    expect(describeCondition("input.channel === 'support'").text).toBe("Channel is 'support'");
    expect(describeCondition("input.channel == 'support'").text).toBe("Channel is 'support'");
    expect(describeCondition("input.channel !== 'support'").text).toBe("Channel is not 'support'");
    expect(describeCondition("callSomething(input)")).toEqual({ text: "Check: callSomething(input)", technical: true });
  });

  test("describes finishes and repeats", () => {
    expect(describeReturn("{ a, b, c }")).toBe("Finish with: A, B, C");
    expect(describeReturn("{ window, calendarEventCount, results }")).toBe("Finish with: Window, Calendar event count, Results");
    expect(describeReturn("value")).toBe("Finish");
    expect(describeReturn("undefined")).toBe("Finish");
    expect(describeReturn("return")).toBe("Finish");
    expect(describeReturn("buildResult()")).toBe("Finish with the result");
    expect(describeLoop("input.teamMembers")).toBe("For each item in team members");
    expect(describeLoop("getItems()")).toBe("Repeat");
  });

  test("summarizes services, decisions, and parallel steps", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "input", kind: "input", label: "Input", fields: [] },
        { id: "calendar", kind: "tool", label: "calendar", namespace: "google_workspace", tool: "getCapabilitiesGoogleWorkspaceCalendarEvents", scriptPath: "tools.google_workspace.calendar", assignsTo: "events", parallelGroup: "lookup" },
        { id: "gmail", kind: "tool", label: "gmail", namespace: "gmail", tool: "searchMessages", scriptPath: "tools.gmail.searchMessages", assignsTo: "messages", parallelGroup: "lookup" },
        { id: "decision", kind: "branch", label: "events.length > 0" },
        { id: "finish", kind: "return", label: "{ events, messages }" },
      ],
      edges: [],
      parseError: null,
    };

    expect(summarizeGraph(graph)).toEqual({
      stepCount: 5,
      services: ["Google Calendar", "Gmail"],
      sentence: "Reads from Google Calendar and Gmail with one decision while some steps run at the same time, then finishes with a summary.",
    });
  });
});
