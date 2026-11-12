import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AGENT_BRIEF,
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  type AgentConnectionToolsView,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { automaticToolsChange, ConnectionToolsButton,
  ConnectionToolsDisclosure, readToolsLine, toolChoiceChange, toolsSummary } from "./workbot-agent-tools";
import { withToolOverrides } from "./workbot-proactive-data";
import { connectionCount, otherPolicy, WorkbotProactiveSources } from "./workbot-proactive-sources";

// Manage › Workbot › What agents read with Your agent's brief on: every connection listed, each with its policy, and
// "Tools agents may use" per connection. Names are fictional.

const desk = { id: "emc_desk", name: "Lumen Support Desk", url: "https://mcp.lumen-desk.test/mcp", native: false, policy: "members" as const };
const ledger = { id: "emc_ledger", name: "Brightwater Ledger", url: "https://mcp.brightwater-ledger.test/mcp", native: false, policy: "off" as const };
const google = { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: true, policy: "members" as const };

const briefOn: WorkbotProactiveView = {
  settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true },
  template: { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 },
  slackReady: true,
  runnerReady: true,
  sourceConnections: {
    calendar: [{ id: "google-workspace", name: "Google Workspace", url: "https://google.com", connectedMembers: 4 }],
    other: [google, desk, ledger],
    all: [
      { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: true, slots: ["calendar", "other"], connectedMembers: 4 },
      { id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", native: false, slots: ["other"], connectedMembers: null },
      { ...desk, slots: ["other"], connectedMembers: null },
      { ...ledger, slots: ["other"], connectedMembers: null },
    ],
  },
  brief: { checkEveryHours: 2, dailyCap: 4, extraChecksPerDay: 3, text: DEFAULT_AGENT_BRIEF, carriedOver: [], defaultText: DEFAULT_AGENT_BRIEF },
};

const deskTools: AgentConnectionToolsView = {
  connectionId: desk.id,
  status: "ready",
  readTools: 2,
  coreSourcesElsewhere: false,
  tools: [
    { name: "list_tickets", title: null, description: "List open tickets", allowed: true, reason: "marked_read", override: null, locked: false },
    { name: "get_ticket", title: null, description: null, allowed: true, reason: "read_name", override: null, locked: false },
    { name: "close_ticket", title: null, description: null, allowed: false, reason: "write_name", override: null, locked: false },
    { name: "purge_queue", title: null, description: null, allowed: false, reason: "destructive", override: null, locked: true },
  ],
};

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

test("with the brief, Connectors lists every connection with its policy and a count, and nothing to add or remove", () => {
  const html = renderToStaticMarkup(<WorkbotProactiveSources view={briefOn} canManage saving={false} onChange={() => undefined} />);
  assert.match(text(html), /3 connections\. Read only\./);
  for (const entry of [google, desk, ledger]) assert.match(html, new RegExp(`data-testid="workbot-source-other-${entry.id}" data-policy="${entry.policy}"`));
  assert.doesNotMatch(html, /workbot-source-add-other/, "no Add source: every connection is already here");
  assert.doesNotMatch(text(html), /Remove/, "not allowed is how an admin leaves one out (P4: it stays listed)");
  assert.match(text(html), /Read only\. Agents never send, edit or delete through these\./);
});

test("the policy shown is the admin's saved choice, else the server's (a removed reviewed one stays not allowed)", () => {
  assert.equal(otherPolicy(briefOn, ledger), "off");
  const saved = { ...briefOn, settings: { ...briefOn.settings, sources: { ...briefOn.settings.sources, connections: { [ledger.id]: "everyone" as const } } } };
  assert.equal(otherPolicy(saved, ledger), "everyone");
  assert.equal(otherPolicy(briefOn, { id: "emc_new", name: "New", url: "https://x.test" }), "members");
  assert.equal(connectionCount(1), "1 connection");
});

test("Tools agents may use: the count in the summary, a row per tool, a lock and the reason where no one can allow it", () => {
  const html = renderToStaticMarkup(<ConnectionToolsDisclosure view={deskTools} failed={false} name={desk.name} connectionId={desk.id} connectHref="/library/connectors/emc_desk" disabled={false} onChange={() => undefined} />);
  assert.match(html, /^<details/, "a disclosure (S3), closed by default");
  assert.match(text(html), /Tools agents may use: 2 read tools Review/);
  assert.match(html, /data-testid="workbot-agent-tool-list_tickets" data-allowed="true" data-locked="false"/);
  assert.match(html, /aria-label="Agents may use close_ticket"/);
  assert.match(text(html), /close_ticket Changes things, by its name/);
  assert.match(html, /aria-label="purge_queue: Its provider marks it destructive\. No one can allow it\."/);
  assert.doesNotMatch(html, /aria-label="Agents may use purge_queue"/, "a locked tool has no switch");
  assert.doesNotMatch(text(html), /Use automatic choices/, "nothing chosen yet");
});

test("the summary says why the tools aren't known; Den's own provider points to its other sources", () => {
  assert.equal(toolsSummary({ ...deskTools, status: "needs_connection", tools: [], readTools: 0 }, false, desk.name), "Connect Lumen Support Desk to see its tools");
  assert.equal(toolsSummary({ ...deskTools, status: "unavailable", tools: [], readTools: 0 }, false, desk.name), "Lumen Support Desk didn't answer");
  assert.equal(toolsSummary(undefined, true, desk.name), "Couldn't load its tools");
  assert.equal(toolsSummary(undefined, false, desk.name), "");
  assert.equal(readToolsLine(0), "No read tools");
  assert.equal(readToolsLine(1), "1 read tool");
  const native = renderToStaticMarkup(<ConnectionToolsDisclosure view={{ connectionId: google.id, status: "ready", readTools: 1, coreSourcesElsewhere: true, tools: [
    { name: "listDriveFiles", title: null, description: "List Drive files", allowed: true, reason: "native_read", override: null, locked: false },
    { name: "createDriveFile", title: null, description: null, allowed: false, reason: "native_write", override: null, locked: true },
  ] }} failed={false} name={google.name} connectionId={google.id} connectHref="/x" disabled={false} onChange={() => undefined} />);
  assert.match(text(native), /The calendar is read under its own setting\./);
  const connect = renderToStaticMarkup(<ConnectionToolsDisclosure view={{ ...deskTools, status: "needs_connection", tools: [], readTools: 0 }} failed={false} name={desk.name} connectionId={desk.id} connectHref="/library/connectors/emc_desk" disabled={false} onChange={() => undefined} />);
  assert.match(connect, /href="\/library\/connectors\/emc_desk"[^>]*>Connect Lumen Support Desk</);
});

test("a switch saves the admin's choice; it shows at once, and a locked tool never changes", () => {
  assert.deepEqual(toolChoiceChange(desk.id, "close_ticket", true), { toolOverrides: { [desk.id]: { close_ticket: "allow" } } });
  assert.deepEqual(toolChoiceChange(desk.id, "get_ticket", false), { toolOverrides: { [desk.id]: { get_ticket: "deny" } } });
  assert.deepEqual(automaticToolsChange(desk.id), { toolOverrides: { [desk.id]: null } });
  const shown = withToolOverrides(deskTools, { close_ticket: "allow", get_ticket: "deny", purge_queue: "allow" });
  assert.deepEqual(shown.tools.map((tool) => [tool.name, tool.allowed, tool.override]), [["list_tickets", true, null], ["get_ticket", false, "deny"], ["close_ticket", true, "allow"], ["purge_queue", false, null]]);
  assert.equal(shown.readTools, 2);
  const html = renderToStaticMarkup(<ConnectionToolsDisclosure view={shown} failed={false} name={desk.name} connectionId={desk.id} connectHref="/x" disabled={false} onChange={() => undefined} />);
  assert.match(text(html), /Use automatic choices/);
  assert.match(text(html), /get_ticket Turned off by an admin/);
});

test("Manage tools: the row keeps the count and one button; the tools stay out of the page until it is opened", () => {
  const html = renderToStaticMarkup(<ConnectionToolsButton view={deskTools} failed={false} name={desk.name} connectionId={desk.id} connectHref="/library/connectors/emc_desk" disabled={false} onChange={() => undefined} />);
  assert.match(text(html), /2 read tools/);
  assert.doesNotMatch(text(html), /Manage tools/, "the count is the link");
  assert.match(html, /aria-label="Manage tools for Lumen Support Desk: 2 read tools"/);
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /workbot-agent-tool-list_tickets/, "closed: no tool rows in the page");
});
