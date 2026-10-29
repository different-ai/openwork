import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_AGENT_TEMPLATE, DEFAULT_WORKBOT_PROACTIVE_SETTINGS, type AgentResponsibility, type WorkbotProactiveView } from "@openwork/types/den/workbot-proactive";
import { WorkbotProactivePanel } from "./workbot-proactive-section";
import { previewTime } from "./workbot-proactive-preview";
import { WorkbotProactiveHealthTable } from "./workbot-proactive-health";
import { addSourceChange, addableTo, removeSourceChange, SourceToolPicker, WorkbotProactiveSources } from "./workbot-proactive-sources";

const ready: WorkbotProactiveView = {
  settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true },
  template: { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 },
  slackReady: true,
  runnerReady: true,
  sourceConnections: {
    calendar: [{ id: "google-workspace", name: "Google Calendar", url: "https://google.com" }],
    email: [{ id: "google-workspace", name: "Gmail", url: "https://google.com" }],
    chat: [{ id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp" }],
    other: [
      { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp" },
      { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp" },
    ],
    all: [
      { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: true, reviewed: true, slots: ["calendar", "email"] },
      { id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", native: false, reviewed: true, slots: ["calendar", "email", "chat", "other"] },
      { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp", native: false, reviewed: true, slots: ["calendar", "email", "chat", "other"] },
      { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp", native: false, reviewed: true, slots: ["calendar", "email", "chat", "other"] },
      { id: "emc_crm", name: "Acme CRM", url: "https://mcp.crm.example/mcp", native: false, reviewed: false, slots: ["calendar", "email", "chat", "other"] },
    ],
  },
};

function render(view: WorkbotProactiveView = ready, options: { canManage?: boolean; preview?: AgentResponsibility } = {}) {
  return renderToStaticMarkup(
    <WorkbotProactivePanel view={view} canManage={options.canManage ?? true} saving={false} onChange={() => undefined}
      connectorsHref="/dashboard/mcp-connections" initialPreview={options.preview} />,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function switchFor(html: string, label: string) {
  return new RegExp(`<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? null;
}

test("every setting is one labelled row with its current value, and nothing explains the page", () => {
  const view = text(render());
  for (const label of ["Agents for everyone", "Send messages to", "Morning brief", "Meeting prep", "Calendar changes", "Waiting on you", "Instructions for every agent", "Working hours", "Daily limit", "Members start", "Preview"]) {
    assert.ok(view.includes(label), label);
  }
  for (const value of ["A DM from Workbot", "15 min before", "Version 1", "Weekdays", "8 AM", "7 PM", "3 per person", "Opted in"]) assert.ok(view.includes(value), value);
  assert.match(switchFor(render(), "Agents for everyone") ?? "", /aria-checked="true"/);
  assert.match(switchFor(render(), "Waiting on you") ?? "", /aria-checked="true"/);
  assert.doesNotMatch(view, /Needs|first\./, "no lock when everything is ready");
});

test("the preview is a plain-text DM from the Workbot app, with no buttons, and follows the lead time", () => {
  assert.match(text(render()), /OpenWork 8:02 AM/);
  assert.match(text(render(ready, { preview: "meeting_prep" })), /Quarterly review starts in 15 min, with 2 people from northwind\.example\./);
  assert.match(text(render({ ...ready, settings: { ...ready.settings, leadMinutes: 60 } }, { preview: "meeting_prep" })), /starts in 1 hour/);
  assert.equal(previewTime("meeting_prep", 30), "1:30 PM");
  assert.match(text(render(ready, { preview: "waiting_on_you" })), /has waited 5 hours for your reply\. Want a draft\? Ask Workbot\./);
  assert.match(text(render()), /3 meetings today, first at 9:30 AM\./);
  const preview = /data-testid="workbot-proactive-preview"[\s\S]*$/.exec(render())?.[0] ?? "";
  assert.doesNotMatch(preview, /<button/, "no Mute, Snooze or Turn off buttons in the message");
});

test("without the Slack app the switch is locked with the reason and where to fix it", () => {
  const html = render({ ...ready, settings: DEFAULT_WORKBOT_PROACTIVE_SETTINGS, slackReady: false });
  assert.match(text(html), /Needs the Slack app\. Set it up in Connectors/);
  assert.match(text(html), /Needs the Slack app first\./);
  assert.match(html, /href="\/dashboard\/mcp-connections"/);
  assert.match(switchFor(html, "Agents for everyone") ?? "", /disabled=""/);
});

test("with nowhere to send messages the switch says to choose a destination first", () => {
  const html = render({ ...ready, settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, destination: null } });
  assert.match(text(html), /Choose where messages go first\./);
  assert.match(text(html), /Nowhere yet/);
});

test("without the headless runner the switch says who can fix it", () => {
  const html = render({ ...ready, settings: { ...ready.settings, enabled: false }, runnerReady: false });
  assert.match(text(html), /Needs the headless runner\. Ask your deployment administrator\./);
  assert.match(switchFor(html, "Agents for everyone") ?? "", /disabled=""/);
});

test("a turned-off responsibility hides its own options, and viewers see every value but can't change any", () => {
  const off = text(render({ ...ready, template: { ...ready.template, responsibilities: { ...ready.template.responsibilities, meeting_prep: false } } }));
  assert.doesNotMatch(off, /15 min before/);
  const html = render(ready, { canManage: false });
  for (const label of ["Agents for everyone", "Calendar changes", "Morning brief"]) assert.match(switchFor(html, label) ?? "", /disabled=""/, label);
  assert.ok(text(html).includes("15 min before"));
});

test("the health table shows checks, the share that stayed quiet, messages and mutes per responsibility", () => {
  const html = renderToStaticMarkup(
    <WorkbotProactiveHealthTable health={{ days: 7, members: 12, responsibilities: [
      { id: "calendar_changes", checks: 240, quiet: 228, sent: 12, muted: 1 },
      { id: "waiting_on_you", checks: 0, quiet: 0, sent: 0, muted: 0 },
    ] }} />,
  );
  const view = text(html);
  assert.match(view, /Responsibility Checks Stayed quiet Messages Muted by/);
  assert.match(view, /Calendar changes 240 95% 12 1 of 12/);
  assert.match(view, /Waiting on you 0 — 0 0 of 12/);
});

function sources(view: WorkbotProactiveView = ready, canManage = true, picking: Parameters<typeof WorkbotProactiveSources>[0]["initialPicking"] = null) {
  return renderToStaticMarkup(<WorkbotProactiveSources view={view} canManage={canManage} saving={false} onChange={() => undefined} initialPicking={picking} />);
}

function row(html: string, testId: string) {
  return text(new RegExp(`data-testid="${testId}"[\\s\\S]*?(?=data-testid="workbot-source-|$)`).exec(html)?.[0] ?? "");
}

function withSources(view: WorkbotProactiveView, change: Partial<WorkbotProactiveView["settings"]["sources"]>): WorkbotProactiveView {
  return { ...view, settings: { ...view.settings, sources: { ...view.settings.sources, ...change } } };
}

const crm = ready.sourceConnections?.all.find((option) => option.id === "emc_crm");
const legacy = { id: "google-workspace", name: "Google Workspace", url: "https://google.com" };
const personal = { id: "gws_personal", name: "Google Workspace - Personal", url: "https://google.com" };

test("what agents read: each category with its sources, Add source, and Other context with each connection's policy", () => {
  const html = sources();
  const view = text(html);
  assert.match(view, /What agents read/);
  assert.match(row(html, "workbot-source-calendar"), /Calendar On for everyone/);
  assert.match(row(html, "workbot-source-calendar-google-workspace"), /Google Workspace Remove/);
  assert.match(row(html, "workbot-source-chat-emc_slack"), /Slack Remove/);
  assert.match(html, /aria-label="Add source to Calendar"/);
  assert.match(html, /aria-label="Add source to Other context"/);
  assert.match(row(html, "workbot-source-other-emc_notes"), /Meeting notes Members choose Remove/);
  assert.match(row(html, "workbot-source-other-emc_tracker"), /Issue tracker Members choose Remove/);
  assert.match(view, /Read only\. Agents never send, edit or delete through these\./);
});

test("what agents read: a legacy and a newer Google Workspace are both listed and removable one at a time", () => {
  const two: WorkbotProactiveView = { ...ready, sourceConnections: {
    calendar: [legacy, personal], email: [legacy, personal], chat: [], other: [],
    all: [
      { ...legacy, native: true, reviewed: true, slots: ["calendar", "email"] },
      { ...personal, native: true, reviewed: true, slots: ["calendar", "email"] },
    ],
  } };
  const html = sources(two);
  assert.match(row(html, "workbot-source-calendar-google-workspace"), /Google Workspace Remove/);
  assert.match(row(html, "workbot-source-calendar-gws_personal"), /Google Workspace - Personal Remove/);
  assert.deepEqual(removeSourceChange(two, "calendar", legacy.id), { coreConnections: { calendar: [personal.id] } }, "removed from Calendar only");
  const none = sources(withSources(two, { coreConnections: { calendar: [] } }));
  assert.match(row(none, "workbot-source-calendar-empty"), /No sources/, "the last one removed: it reads nothing");
  assert.match(text(sources({ ...two, sourceConnections: two.sourceConnections && { ...two.sourceConnections, calendar: [], email: [], chat: [] } })), /Team chat On for everyone No sources/);
});

test("what agents read: Add source lists every connection not already there; one with reviewed reads is added at once", () => {
  assert.deepEqual(addableTo(ready, "calendar").map((option) => option.id), ["emc_slack", "emc_notes", "emc_tracker", "emc_crm"]);
  assert.deepEqual(addableTo(ready, "chat").map((option) => option.id), ["emc_notes", "emc_tracker", "emc_crm"], "Google can't serve team chat");
  assert.deepEqual(addableTo(ready, "other").map((option) => option.id), ["emc_slack", "emc_crm"]);
  assert.deepEqual(addSourceChange(ready, "email", "emc_notes"), { coreConnections: { email: ["google-workspace", "emc_notes"] } });
  assert.deepEqual(addSourceChange(ready, "other", "emc_crm", ["search_contacts"]), { otherConnections: ["emc_notes", "emc_tracker", "emc_crm"], readTools: { emc_crm: ["search_contacts"] } });
  assert.deepEqual(removeSourceChange(ready, "other", "emc_notes"), { otherConnections: ["emc_tracker"], connections: { emc_notes: null } });
});

test("what agents read: an MCP without reviewed reads needs its tools ticked; nothing starts ticked and writes can't be", () => {
  assert.ok(crm);
  const adding = sources(ready, true, { slot: "email", option: crm, adding: true });
  assert.match(row(adding, "workbot-source-email-adding"), /Acme CRM Not added yet/);
  assert.match(adding, /data-testid="workbot-source-tool-picker"/);
  const tools = [
    { name: "search_contacts", description: "Find contacts", readOnlyHint: true, blocked: false },
    { name: "list_deals", blocked: false },
    { name: "delete_contact", readOnlyHint: true, blocked: true },
  ];
  const picker = renderToStaticMarkup(<SourceToolPicker name="Acme CRM" tools={tools} error={null} initial={[]} saving={false} onSave={() => undefined} onCancel={() => undefined} />);
  assert.match(text(picker), /Tools agents may use in Acme CRM/);
  assert.match(text(picker), /search_contacts Marked read-only by the provider/);
  assert.equal((picker.match(/aria-pressed="true"/g) ?? []).length, 0, "nothing ticked by default");
  assert.match(/<button[^>]*data-testid="workbot-source-tool-delete_contact"[^>]*>/.exec(picker)?.[0] ?? "", /disabled=""/, "a write-named tool is listed but can't be ticked");
  assert.match(text(picker), /delete_contact Can change things/);
  assert.match(/<button[^>]*>(?:(?!<\/button>).)*Approve tools/.exec(picker)?.[0] ?? "", /disabled=""/, "saving needs at least one tool");
  const edit = renderToStaticMarkup(<SourceToolPicker name="Acme CRM" tools={tools} error={null} initial={["list_deals"]} saving={false} onSave={() => undefined} onCancel={() => undefined} />);
  assert.match(text(edit), /Approve 1 tool/);
  const loading = renderToStaticMarkup(<SourceToolPicker name="Acme CRM" tools={null} error={null} initial={[]} saving={false} onSave={() => undefined} onCancel={() => undefined} />);
  assert.match(loading, /aria-busy="true"/);

  const added = sources(withSources(ready, { coreConnections: { calendar: ["google-workspace", "emc_crm"] }, otherConnections: ["emc_crm"], readTools: { emc_crm: ["search_contacts", "list_deals", "get_deal"] } }));
  assert.match(row(added, "workbot-source-calendar-emc_crm"), /Acme CRM Read on checks; no early meeting alerts Approved by your admin: 3 tools Remove/);
  assert.match(row(added, "workbot-source-other-emc_crm"), /Acme CRM Approved by your admin: 3 tools Members choose Remove/);
  assert.doesNotMatch(row(added, "workbot-source-calendar-google-workspace"), /early meeting|Approved/, "Google's calendar wakes the agent early; reviewed reads need no approval");
});

test("what agents read: locked for people who can't manage it, and without View connections", () => {
  const locked = sources(ready, false);
  const buttons = locked.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0 && buttons.every((button) => /disabled=""/.test(button)), "every choice, Remove and Add source are locked without Manage");
  const policy = withSources(ready, { email: "members", chat: "off", connections: { emc_tracker: "off" } });
  const html = sources(policy);
  assert.match(row(html, "workbot-source-email"), /Members choose/);
  assert.match(row(html, "workbot-source-chat"), /Not allowed/);
  assert.match(row(html, "workbot-source-other-emc_tracker"), /Not allowed/);
  const hidden = text(sources({ ...ready, sourceConnections: null }));
  assert.match(hidden, /Calendar Google Calendar or Outlook On for everyone/, "without View connections: what each source reads through, not the organization's connections");
  assert.match(hidden, /Sources: Needs the “.+” permission\./);
  assert.doesNotMatch(hidden, /Meeting notes|Issue tracker|Add source/);
});
