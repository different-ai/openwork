import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_AGENT_TEMPLATE, DEFAULT_WORKBOT_PROACTIVE_SETTINGS, type AgentResponsibility, type WorkbotProactiveView } from "@openwork/types/den/workbot-proactive";
import { WorkbotProactivePanel } from "./workbot-proactive-section";
import { previewTime } from "./workbot-proactive-preview";
import { WorkbotProactiveHealthTable } from "./workbot-proactive-health";
import { corePickChange, WorkbotProactiveSources } from "./workbot-proactive-sources";

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

function sources(view: WorkbotProactiveView = ready, canManage = true) {
  return renderToStaticMarkup(<WorkbotProactiveSources view={view} canManage={canManage} saving={false} onChange={() => undefined} />);
}

function row(html: string, testId: string) {
  return text(new RegExp(`data-testid="${testId}"[\\s\\S]*?(?=data-testid="workbot-source-|$)`).exec(html)?.[0] ?? "");
}

test("what agents read: calendar, email and team chat on for everyone by default, the connections behind them, other connections up to members", () => {
  const html = sources();
  const view = text(html);
  assert.match(view, /What agents read/);
  assert.match(row(html, "workbot-source-calendar"), /Calendar Google Calendar On for everyone/);
  assert.match(row(html, "workbot-source-email"), /Email Gmail On for everyone/);
  assert.match(row(html, "workbot-source-chat"), /Team chat Slack On for everyone/);
  assert.match(view, /Other connections \(2\)/);
  assert.match(row(html, "workbot-source-emc_notes"), /Meeting notes Members choose/);
  assert.match(row(html, "workbot-source-emc_tracker"), /Issue tracker Members choose/);
  assert.match(view, /Read only\. Agents never send, edit or delete through these\./);
  assert.match(html, /<details[^>]*data-testid="workbot-source-others"/);
  assert.doesNotMatch(html, /<details[^>]*open=""[^>]*data-testid="workbot-source-others"|<details[^>]*data-testid="workbot-source-others"[^>]*open=""/, "other connections start collapsed");
})

test("what agents read: each row shows the admin's choice, and is locked for people who can't manage it", () => {
  const view: WorkbotProactiveView = { ...ready, settings: { ...ready.settings, sources: { calendar: "everyone", email: "members", chat: "off", connections: { emc_tracker: "off" } } } };
  const html = sources(view);
  assert.match(row(html, "workbot-source-email"), /Members choose/);
  assert.match(row(html, "workbot-source-chat"), /Not allowed/);
  assert.match(row(html, "workbot-source-emc_tracker"), /Not allowed/);
  assert.match(row(html, "workbot-source-emc_notes"), /Members choose/);
  const locked = sources(view, false);
  assert.equal((locked.match(/<button[^>]*disabled=""/g) ?? []).length, 5, "every choice is locked without Manage");
  assert.match(text(sources({ ...ready, sourceConnections: { calendar: [], email: [], chat: [], other: [] } })), /No team chat connected .*Other connections \(0\)/);
  const hidden = text(sources({ ...ready, sourceConnections: null }));
  assert.match(hidden, /Calendar Google Calendar or Outlook On for everyone/, "without View connections: what each source reads through, not the organization's connections");
  assert.match(hidden, /Other connections: Needs the “.+” permission\./);
  assert.doesNotMatch(hidden, /Meeting notes|Issue tracker|mcp\./);
})

test("what agents read: with two Google connections, the admin picks which one each source reads through", () => {
  const work = { id: "gws_work", name: "Acme Google", url: "https://google.com" };
  const personal = { id: "gws_personal", name: "Personal Google", url: "https://google.com" };
  const two: WorkbotProactiveView = { ...ready, sourceConnections: { calendar: [work, personal], email: [work, personal], chat: [{ id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp" }], other: [] } };
  const all = sources(two);
  assert.match(row(all, "workbot-source-email"), /Email Acme Google and Personal Google On for everyone/);
  assert.match(switchFor(all, "Email through Personal Google") ?? "", /aria-checked="true"/);
  assert.equal(switchFor(all, "Team chat through Slack"), null, "one connection: nothing to pick");

  const picked = sources({ ...two, settings: { ...two.settings, sources: { ...two.settings.sources, coreConnections: { email: [work.id] } } } });
  assert.match(row(picked, "workbot-source-email"), /Email Acme Google On for everyone/);
  assert.match(switchFor(picked, "Email through Personal Google") ?? "", /aria-checked="false"/);
  assert.match(switchFor(picked, "Email through Acme Google") ?? "", /disabled=""/, "the last one stays on; Not allowed turns the source off");
  assert.match(switchFor(picked, "Calendar through Personal Google") ?? "", /aria-checked="true"/, "each source is picked on its own");

  assert.deepEqual(corePickChange("email", [work, personal], null, personal.id, false), { coreConnections: { email: [work.id] } });
  assert.deepEqual(corePickChange("email", [work, personal], [work.id], personal.id, true), { coreConnections: { email: null } }, "all picked: back to every connection");
})
