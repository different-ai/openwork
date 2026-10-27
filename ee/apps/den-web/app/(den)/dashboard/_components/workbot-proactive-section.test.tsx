import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_AGENT_TEMPLATE, DEFAULT_WORKBOT_PROACTIVE_SETTINGS, type AgentResponsibility, type WorkbotProactiveView } from "@openwork/types/den/workbot-proactive";
import { WorkbotProactivePanel } from "./workbot-proactive-section";
import { previewTime } from "./workbot-proactive-preview";
import { WorkbotProactiveHealthTable } from "./workbot-proactive-health";

const ready: WorkbotProactiveView = {
  settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true },
  template: { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 },
  slackReady: true,
  runnerReady: true,
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
  assert.match(text(html), /Needs OpenWork's headless runner\. Ask your OpenWork operator to set it up\./);
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
