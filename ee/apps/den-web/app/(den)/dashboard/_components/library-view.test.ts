import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryItem } from "./library-data";
import { groupLibrary, isWorkflowOnlyPlugin, LIBRARY_FILTERS, libraryFilterOf, parseLibraryFilter, workflowFailureSummary, workflowLastRunFailed } from "./library-view";

function workflow(overrides: Partial<Extract<LibraryItem, { type: "workflow" }>> = {}): LibraryItem {
  return {
    type: "workflow", id: "cob_brief", plugin: null, name: "Morning brief", description: "Email, calendar and PRs in one summary",
    role: "manager", edges: [{ kind: "mine" }] as never, state: "ready", resultState: "fresh", latestSuccessfulAt: null, failureReason: null,
    viewState: "default", activeViewTitle: null, automationCount: 0, source: { kind: "created" }, ...overrides,
  };
}

const connector = {
  type: "connection", id: "emc_slack", name: "Slack", url: "https://slack.example.test/mcp", description: null, transport: "mcp",
  provider: null, state: "connected", connectedAt: null, edges: [],
} as LibraryItem;

test("the Library has a Workflows tab and ?show=workflows opens it", () => {
  assert.ok(LIBRARY_FILTERS.some((entry) => entry.value === "workflows" && entry.label === "Workflows"));
  assert.equal(parseLibraryFilter("workflows"), "workflows");
});

test("a saved workflow belongs to the Workflows tab, so no tab hides it", () => {
  assert.equal(libraryFilterOf(workflow()), "workflows");
  const groups = (filter: Parameters<typeof groupLibrary>[0]["filter"]) => groupLibrary({ items: [workflow(), connector], filter, query: "", isMine: () => true }).mine.map((item) => item.name);
  assert.deepEqual(groups("workflows"), ["Morning brief"]);
  assert.deepEqual(groups("connectors"), ["Slack"]);
  assert.deepEqual(groups("all"), ["Morning brief", "Slack"]);
});

test("a workflow whose last run failed is flagged with a reason a person can read", () => {
  assert.equal(workflowLastRunFailed(workflow({ resultState: "needs_attention" })), true);
  assert.equal(workflowLastRunFailed(workflow({ resultState: "stale" })), false);
  assert.equal(workflowLastRunFailed(connector), false);
  assert.equal(workflowFailureSummary("connection_not_connected: gmail needs_signin"), "A connection needs you to sign in again");
  assert.equal(workflowFailureSummary("Request timed out after 30000ms"), "It took too long and stopped");
  assert.equal(workflowFailureSummary("The calendar was empty."), "The calendar was empty");
  assert.equal(workflowFailureSummary('TypeError: Cannot read properties of undefined (reading "items") at {"stack": 1}'), "Open it to see what went wrong");
  assert.equal(workflowFailureSummary(null), "Open it to see what went wrong");
  assert.equal(workflowFailureSummary("Cannot access a property on a non-object value. (line 4, col 24)"), "Open it to see what went wrong");
});

test("the plugin that only holds workflows is not listed next to them", () => {
  const container = {
    type: "plugin", id: "plg_mine", name: "My Workflows", description: "Private reusable Workflows", componentCount: 2,
    componentKinds: ["workflow"], edges: [{ kind: "mine" }],
  } as unknown as LibraryItem;
  const skills = { ...container, id: "plg_skills", name: "Writing", componentKinds: ["skill", "workflow"] } as LibraryItem;
  assert.equal(isWorkflowOnlyPlugin(container), true);
  assert.equal(isWorkflowOnlyPlugin(skills), false);
  const names = groupLibrary({ items: [container, skills, workflow()], filter: "all", query: "", isMine: () => true }).mine.map((item) => item.name);
  assert.deepEqual(names, ["Morning brief", "Writing"]);
});
