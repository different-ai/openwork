import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AGENT_BRIEF,
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  mergeAgentTemplate,
  mergeWorkbotProactiveSettings,
  type AgentResponsibility,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import {
  agentPolicyPath,
  agentPolicyQueryKey,
  agentPolicyRestoreChange,
  AGENTS_SWITCH_LABEL,
  agentToolsPath,
  agentToolsQueryKey,
  agentToolsRootQueryKey,
  type AgentPolicyScope,
} from "./workbot-agent-scope";
import { WorkbotProactivePanel } from "./workbot-proactive-section";
import { previewTime } from "./workbot-proactive-preview";
import { WorkbotProactiveHealthTable } from "./workbot-proactive-health";
import { addConnectionChange, addableConnections, AgentCalendarPolicy, calendarStateLine, filterConnections, listedConnections, otherConnectionAdded, otherConnectionsRestLine, removeConnectionChange, WorkbotProactiveSources } from "./workbot-proactive-sources";

const ready: WorkbotProactiveView = {
  settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true },
  template: { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 },
  slackReady: true,
  runnerReady: true,
  sourceConnections: {
    calendar: [{ id: "google-workspace", name: "Google Workspace", url: "https://google.com", connectedMembers: 4 }],
    other: [
      { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp" },
      { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp" },
    ],
    all: [
      { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: true, slots: ["calendar"], connectedMembers: 4 },
      { id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", native: false, slots: ["other"], connectedMembers: null },
      { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp", native: false, slots: ["other"], connectedMembers: null },
      { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp", native: false, slots: ["other"], connectedMembers: null },
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
  for (const label of ["Proactive Mode", "Send messages to", "Morning brief", "Meeting prep", "Calendar changes", "Waiting on you", "Instructions for every agent", "Working hours", "Daily limit", "Members start", "Preview"]) {
    assert.ok(view.includes(label), label);
  }
  for (const value of ["A DM from Workbot", "15 min before", "Version 1", "Weekdays", "8 AM", "7 PM", "3 per person", "Opted in"]) assert.ok(view.includes(value), value);
  assert.match(switchFor(render(), "Proactive Mode") ?? "", /aria-checked="true"/);
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
  assert.match(switchFor(html, "Proactive Mode") ?? "", /disabled=""/);
});

test("with nowhere to send messages the switch says to choose a destination first", () => {
  const html = render({ ...ready, settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, destination: null } });
  assert.match(text(html), /Choose where messages go first\./);
  assert.match(text(html), /Nowhere yet/);
});

test("without the headless runner the switch says who can fix it", () => {
  const html = render({ ...ready, settings: { ...ready.settings, enabled: false }, runnerReady: false });
  assert.match(text(html), /Needs the headless runner\. Ask your deployment administrator\./);
  assert.match(switchFor(html, "Proactive Mode") ?? "", /disabled=""/);
});

test("a turned-off responsibility hides its own options, and viewers see every value but can't change any", () => {
  const off = text(render({ ...ready, template: { ...ready.template, responsibilities: { ...ready.template.responsibilities, meeting_prep: false } } }));
  assert.doesNotMatch(off, /15 min before/);
  const html = render(ready, { canManage: false });
  for (const label of ["Proactive Mode", "Calendar changes", "Morning brief"]) assert.match(switchFor(html, label) ?? "", /disabled=""/, label);
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

function withSources(view: WorkbotProactiveView, change: Partial<WorkbotProactiveView["settings"]["sources"]>): WorkbotProactiveView {
  return { ...view, settings: { ...view.settings, sources: { ...view.settings.sources, ...change } } };
}

test("the calendar is one picklist with what it reads through, and nothing to pick", () => {
  const calendar = (view: WorkbotProactiveView, disabled = false) => renderToStaticMarkup(<AgentCalendarPolicy view={view} disabled={disabled} onChange={() => undefined} />);
  const html = calendar(ready);
  assert.match(html, /data-testid="workbot-source-calendar" data-policy="everyone"/);
  assert.ok(text(html).includes("On for everyone"), "the choice in use");
  assert.ok(text(calendar(withSources(ready, { calendar: "members" }))).includes("Members choose"));
  assert.doesNotMatch(text(html), /Add app|Set as default|Remove|Default/);
  assert.match(calendar(ready, true), /disabled=""/);
  assert.match(calendar(withSources(ready, { calendar: "off" })), /data-policy="off"/);

  assert.equal(calendarStateLine(ready), "Uses Google Workspace");
  const microsoft = { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", connectedMembers: 9 };
  const connections = ready.sourceConnections!;
  assert.equal(calendarStateLine({ ...ready, sourceConnections: { ...connections, calendar: [...connections.calendar, microsoft] } }), "Uses Google Workspace or Microsoft 365");
  assert.equal(calendarStateLine({ ...ready, sourceConnections: { ...connections, calendar: [] } }), "No calendar app connected");
  assert.equal(calendarStateLine({ ...ready, sourceConnections: null }), "Uses Google Calendar or Outlook", "without View connections: what it reads through, not the organization's connections");
  assert.equal(calendarStateLine(withSources(ready, { calendar: "off" })), "Agents don't read it");
});

test("connectors: each connection agents read with its own policy and Remove, no Calendar, Email or Team chat rows", () => {
  const html = sources();
  const view = text(html);
  assert.match(view, /Connectors/);
  for (const gone of ["What agents read", "Other context", "Calendar", "Email", "Team chat", "Add app", "Set as default"]) assert.ok(!view.includes(gone), gone);
  assert.doesNotMatch(html, /aria-label="About/, "no tooltips: the rows explain themselves");
  assert.match(row(html, "workbot-source-other-emc_notes"), /Meeting notes .*Members choose.* Remove/);
  assert.match(row(html, "workbot-source-other-emc_tracker"), /Issue tracker/);
  assert.match(view, /Add connector/);
  assert.match(view, /Read only\. Agents never send, edit or delete through these\./);
  assert.match(row(sources(withSources(ready, { connections: { emc_tracker: "off" } })), "workbot-source-other-emc_tracker"), /Not allowed/);
});

test("connectors: Add connector lists the ones agents can read that aren't listed yet, and adds or removes one at once", () => {
  assert.deepEqual(listedConnections(ready).map((option) => option.id), ["emc_notes", "emc_tracker"]);
  assert.deepEqual(addableConnections(ready).map((option) => option.id), ["emc_slack"], "Google Workspace serves the calendar only before the brief");
  assert.deepEqual(addConnectionChange(ready, "emc_slack"), { otherConnections: ["emc_notes", "emc_tracker", "emc_slack"] });
  assert.deepEqual(removeConnectionChange(ready, "emc_tracker"), { otherConnections: ["emc_notes"], connections: { emc_tracker: null } });
  const picked = withSources(ready, { otherConnections: ["emc_tracker"] });
  assert.deepEqual(listedConnections(picked).map((option) => option.id), ["emc_tracker"]);
  assert.deepEqual(addableConnections(picked).map((option) => option.id), ["emc_slack", "emc_notes"]);
  assert.match(text(sources(withSources(ready, { otherConnections: [] }))), /No connectors/);
});

test("connectors: locked for people who can't manage it, and without View connections", () => {
  const locked = sources(ready, false);
  const buttons = locked.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0 && buttons.every((button) => /disabled=""/.test(button)), "every choice, Remove and Add connector are locked without Manage");
  const hidden = text(sources({ ...ready, sourceConnections: null }));
  assert.match(hidden, /Connectors: Needs the “.+” permission\./);
  assert.doesNotMatch(hidden, /Meeting notes|Issue tracker|Add connector/);
});

// ---- Your agent's brief (workbotAgentBrief) -------------------------------------------------------------------------

const briefSettings: NonNullable<WorkbotProactiveView["brief"]> = { checkEveryHours: 2, dailyCap: 4, extraChecksPerDay: 3, text: `${DEFAULT_AGENT_BRIEF}\n\nDon't send meeting prep.`, defaultText: DEFAULT_AGENT_BRIEF, carriedOver: ["text"] };
const briefOn: WorkbotProactiveView = { ...ready, brief: briefSettings };

test("with the brief: one rhythm, the daily limit, extra checks and what to tell people replace the message types", () => {
  const html = render(briefOn);
  const view = text(html);
  for (const label of ["Proactive Mode", "Send messages to", "Check", "Messages per person per day", "Extra checks agents may ask for", "Members start", "What to tell people", "Preview"]) assert.ok(view.includes(label), label);
  for (const value of ["Every 2 hours", "8 AM", "7 PM", "Weekdays", "3 a day", "Reset to default", "From your earlier settings."]) assert.ok(view.includes(value), value);
  for (const gone of ["Morning brief", "Meeting prep", "Calendar changes", "Waiting on you", "15 min before", "Instructions for every agent", "Version 1"]) assert.ok(!view.includes(gone), gone);
  assert.match(html, /Don&#x27;t send meeting prep\.<\/textarea>/);
  assert.match(view, /Before your 2 PM with Northwind Labs: Dana asked in Slack for the updated pricing sheet/);
});

test("with the brief at its default, it says Default instead of offering a reset", () => {
  const view = text(render({ ...briefOn, brief: { ...briefSettings, text: DEFAULT_AGENT_BRIEF, carriedOver: [] } }));
  assert.ok(view.includes("Default"));
  assert.ok(!view.includes("Reset to default"));
  assert.ok(!view.includes("From your earlier settings."));
});

test("with the brief, health is one row of checks on the rhythm", () => {
  const html = renderToStaticMarkup(<WorkbotProactiveHealthTable health={{ days: 7, members: 5, responsibilities: [], rhythm: { checks: 120, quiet: 96, sent: 31 } }} />);
  assert.match(text(html), /All members 120 80% 31/);
  assert.doesNotMatch(text(html), /Muted by/);
});

// ---- Everyone's policy, or one team's (workbotTeamSettings) ---------------------------------------------------------

const everyoneScope: AgentPolicyScope = { kind: "everyone" };
const supportScope: AgentPolicyScope = { kind: "team", teamId: "team/a" };

test("Everyone's policy keeps the organization's routes and keys; a team's has its own under them", () => {
  assert.equal(agentPolicyPath(everyoneScope), "/v1/org/workbot-settings/proactive");
  assert.equal(agentToolsPath(everyoneScope, "emc notes"), "/v1/org/workbot-settings/proactive/sources/emc%20notes/tools");
  assert.deepEqual(agentPolicyQueryKey("org_1", everyoneScope), ["org-workbot-proactive", "org_1"]);
  assert.deepEqual(agentToolsQueryKey("org_1", "emc_notes", everyoneScope), ["org-workbot-agent-tools", "org_1", "emc_notes"]);

  assert.equal(agentPolicyPath(supportScope), "/v1/org/workbot-settings/teams/team%2Fa/agent");
  assert.equal(agentToolsPath(supportScope, "emc notes"), "/v1/org/workbot-settings/teams/team%2Fa/agent/sources/emc%20notes/tools");
  const teamKey = agentPolicyQueryKey("org_1", supportScope);
  const teamToolsKey = agentToolsQueryKey("org_1", "emc_notes", supportScope);
  assert.deepEqual(teamKey, ["org-workbot-proactive", "org_1", "teams", "team/a"]);
  assert.deepEqual(teamToolsKey, ["org-workbot-agent-tools", "org_1", "emc_notes", "teams", "team/a"]);
  // A change to Everyone's policy refreshes everything under its key: the teams that follow it too.
  assert.deepEqual(teamKey.slice(0, 2), agentPolicyQueryKey("org_1", everyoneScope));
  assert.deepEqual(teamToolsKey.slice(0, 3), agentToolsQueryKey("org_1", "emc_notes", everyoneScope));
  assert.deepEqual(teamToolsKey.slice(0, 2), agentToolsRootQueryKey("org_1"));
  assert.notDeepEqual(agentPolicyQueryKey("org_1", { kind: "team", teamId: "team_b" }), teamKey);
});

test("a team's panel has the same rows and the same switch as Everyone's", () => {
  assert.equal(AGENTS_SWITCH_LABEL, "Proactive Mode");
  for (const view of [ready, briefOn]) {
    const html = renderToStaticMarkup(
      <WorkbotProactivePanel view={view} canManage saving={false} onChange={() => undefined} connectorsHref="/dashboard/mcp-connections" scope={supportScope} />,
    );
    assert.match(switchFor(html, "Proactive Mode") ?? "", /aria-checked="true"/);
    assert.equal(text(html), text(render(view)));
  }
});

test("Undo for Use Everyone's saves the team's policy back as a change to Everyone's", () => {
  const everyone: WorkbotProactiveView = {
    ...briefOn,
    settings: {
      ...ready.settings,
      enabled: false,
      sources: {
        calendar: "everyone",
        otherConnections: ["emc_notes"],
        connections: { emc_notes: "everyone", emc_tracker: "off" },
        toolOverrides: { emc_notes: { search: "allow", remove: "deny" }, emc_tracker: { list: "allow" } },
      },
      brief: { dailyCap: 6 },
    },
    brief: { ...briefSettings, dailyCap: 6, carriedOver: ["checkEveryHours", "extraChecksPerDay", "text"] },
  };
  const team: WorkbotProactiveView = {
    ...briefOn,
    settings: {
      ...ready.settings,
      enabled: true,
      workingDays: "everyday",
      startHour: 9,
      endHour: 17,
      dailyCap: 5,
      membersStart: "opted_out",
      sources: {
        calendar: "members",
        otherConnections: ["emc_notes", "emc_tracker"],
        connections: { emc_notes: "off" },
        toolOverrides: { emc_notes: { search: "deny", read: "allow" } },
      },
      brief: { checkEveryHours: 3, text: "Only tell people about customers." },
    },
    template: { ...ready.template, responsibilities: { ...ready.template.responsibilities, meeting_prep: false }, instructions: "Ignore newsletters.", version: 4, versionId: "cov_team" },
    brief: { ...briefSettings, checkEveryHours: 3, dailyCap: 5, text: "Only tell people about customers.", carriedOver: ["dailyCap", "extraChecksPerDay"] },
  };

  const change = agentPolicyRestoreChange(team, everyone);
  // Only what differs is sent for sources: null takes away what Everyone has and the team didn't.
  assert.deepEqual(change.sources, {
    calendar: "members",
    otherConnections: ["emc_notes", "emc_tracker"],
    connections: { emc_notes: "off", emc_tracker: null },
    toolOverrides: { emc_notes: { search: "deny", remove: null, read: "allow" }, emc_tracker: null },
  });
  // The team's first save starts from Everyone's policy: the change on top of it is the team's policy again.
  const restored = mergeWorkbotProactiveSettings(everyone.settings, change);
  assert.deepEqual(restored, { ...team.settings, brief: { checkEveryHours: 3, dailyCap: 5, text: "Only tell people about customers." } });
  assert.deepEqual(mergeAgentTemplate(everyone.template, change), { responsibilities: team.template.responsibilities, instructions: "Ignore newsletters." });

  // The same policy as Everyone's still makes it the team's own, and sends nothing the server could refuse.
  const same = agentPolicyRestoreChange(everyone, everyone);
  assert.deepEqual(same.sources, { calendar: "everyone" });
  assert.equal(same.enabled, false);
  // With the brief off the server refuses `brief`, so it is left out.
  assert.equal(agentPolicyRestoreChange(ready, ready).brief, undefined);
  assert.deepEqual(agentPolicyRestoreChange(everyone, everyone).brief, { dailyCap: 6 });
});

// ---- Grouped rows (workbotSettingsTabs) ---------------------------------------------------------------------------

function renderGrouped(view: WorkbotProactiveView) {
  return renderToStaticMarkup(
    <WorkbotProactivePanel view={view} canManage saving={false} onChange={() => undefined} connectorsHref="/dashboard/mcp-connections" grouped />,
  );
}

test("grouped: yes or no settings are switches, the schedule is one row per setting, and only rows that need explaining have help", () => {
  const html = renderGrouped(briefOn);
  const view = text(html);
  for (const label of ["Proactive Mode", "On for members by default", "Messages", "Send messages in Slack", "Daily message limit", "Schedule", "Check for updates", "Working hours", "Working days", "Extra checks", "Agent instructions", "Edit", "Example message", "Want me to draft a reply?"]) assert.ok(view.includes(label), label);
  assert.doesNotMatch(html, /<textarea/, "the instructions are text until Edit is clicked");
  for (const gone of ["Send messages to", "Nowhere yet", "Members start", "Must opt in", "Messages per person per day", "Extra checks agents may ask for", "What to tell people", "Preview"]) assert.ok(!view.includes(gone), gone);
  assert.match(switchFor(html, "Send messages in Slack") ?? "", /aria-checked="true"/);
  assert.match(switchFor(html, "On for members by default") ?? "", /aria-checked="true"/);
  for (const about of ["On for members by default", "Extra checks", "Example message"]) assert.ok(html.includes(`aria-label="About ${about}"`), about);
  for (const plain of ["Proactive Mode", "Send messages in Slack", "Daily message limit", "Check for updates", "Working hours", "Working days", "Agent instructions"]) assert.ok(!html.includes(`aria-label="About ${plain}"`), plain);
});

test("the send check is one switch, off until an admin turns it on, in both layouts, and absent while its feature is off", () => {
  const label = "Check each message before sending";
  for (const layout of [render, renderGrouped]) {
    assert.ok(!text(layout(briefOn)).includes(label), "no row while the server doesn't offer it");
    const offered = layout({ ...briefOn, sendCheck: { ready: true } });
    assert.match(switchFor(offered, label) ?? "", /aria-checked="false"/);
    assert.doesNotMatch(switchFor(offered, label) ?? "", /disabled=""/);
    assert.match(switchFor(layout({ ...briefOn, settings: { ...briefOn.settings, sendCheck: true }, sendCheck: { ready: true } }), label) ?? "", /aria-checked="true"/);
  }
  assert.ok(renderGrouped({ ...briefOn, sendCheck: { ready: true } }).includes(`aria-label="About ${label}"`), "the grouped row explains itself");
});

test("where the deployment can't run the send check, its switch is locked with who can fix it, but can still be turned off", () => {
  const label = "Check each message before sending";
  for (const layout of [render, renderGrouped]) {
    const locked = layout({ ...briefOn, sendCheck: { ready: false } });
    assert.match(switchFor(locked, label) ?? "", /disabled=""/);
    assert.ok(text(locked).includes("Not set up on this deployment. Ask your deployment administrator."));
    const on = layout({ ...briefOn, settings: { ...briefOn.settings, sendCheck: true }, sendCheck: { ready: false } });
    assert.doesNotMatch(switchFor(on, label) ?? "", /disabled=""/);
  }
});

test("the check gate is one switch, off until an admin turns it on, in both layouts, and absent while its feature is off", () => {
  const label = "Skip checks when nothing new arrived";
  for (const layout of [render, renderGrouped]) {
    assert.ok(!text(layout(briefOn)).includes(label), "no row while the server doesn't offer it");
    const offered = layout({ ...briefOn, checkGate: { model: false } });
    assert.match(switchFor(offered, label) ?? "", /aria-checked="false"/);
    assert.doesNotMatch(switchFor(offered, label) ?? "", /disabled=""/);
    assert.match(switchFor(layout({ ...briefOn, settings: { ...briefOn.settings, checkGate: true }, checkGate: { model: true } }), label) ?? "", /aria-checked="true"/);
  }
  assert.ok(renderGrouped({ ...briefOn, checkGate: { model: true } }).includes(`aria-label="About ${label}"`), "the grouped row explains itself");
});

test("each threshold is a select shown only while its switch is on: the default, the saved choice, or one set through the API", () => {
  const gate = "Skip only when the chance new mail matters is at most";
  const send = "Hold a message only when at least this sure";
  /** The value a row's select shows: the closed field reads as its selected option. */
  const selected = (html: string, testId: string) => new RegExp(`data-testid="${testId}"[\\s\\S]*?title="(\\d+%)"`).exec(html)?.[1] ?? null;
  const offered = { ...briefOn, checkGate: { model: true }, sendCheck: { ready: true } };
  for (const layout of [render, renderGrouped]) {
    const off = text(layout(offered));
    assert.ok(!off.includes(gate) && !off.includes(send), "no threshold rows while the switches are off");
    const on = layout({ ...offered, settings: { ...offered.settings, checkGate: true, sendCheck: true } });
    assert.ok(text(on).includes(gate) && text(on).includes(send));
    assert.deepEqual([selected(on, "workbot-agent-check-gate-threshold"), selected(on, "workbot-agent-send-check-threshold")], ["20%", "80%"], "the defaults");
    const tuned = layout({ ...offered, settings: { ...offered.settings, checkGate: true, checkGateThreshold: 0.4, sendCheck: true, sendCheckThreshold: 0.65 } });
    assert.deepEqual([selected(tuned, "workbot-agent-check-gate-threshold"), selected(tuned, "workbot-agent-send-check-threshold")], ["40%", "65%"], "saved, including one off the list");
  }
});

test("Undo for Use Everyone's carries the team's check gate choice only while the server offers it", () => {
  const team = { ...briefOn, settings: { ...briefOn.settings, checkGate: true } };
  assert.equal(agentPolicyRestoreChange({ ...team, checkGate: { model: true } }, briefOn).checkGate, true);
  assert.equal("checkGate" in agentPolicyRestoreChange(team, briefOn), false);
  const tuned = agentPolicyRestoreChange({ ...team, settings: { ...team.settings, checkGateThreshold: 0.3, sendCheck: true, sendCheckThreshold: 0.9 }, checkGate: { model: true }, sendCheck: { ready: true } }, briefOn);
  assert.deepEqual([tuned.checkGateThreshold, tuned.sendCheck, tuned.sendCheckThreshold], [0.3, true, 0.9]);
});

test("grouped: with messages going nowhere and members opting in themselves, both switches are off", () => {
  const html = renderGrouped({ ...briefOn, settings: { ...briefOn.settings, enabled: false, destination: null, membersStart: "opted_out" } });
  assert.match(switchFor(html, "Send messages in Slack") ?? "", /aria-checked="false"/);
  assert.match(switchFor(html, "On for members by default") ?? "", /aria-checked="false"/);
  assert.ok(text(html).includes("Turn on Send messages in Slack first."));
});

test("grouped rows need the brief: without it the message types stay as they are", () => {
  assert.ok(text(renderGrouped(ready)).includes("Send messages to"));
});

test("filtering connections matches part of a name, whatever its case", () => {
  const list = [{ name: "Google Workspace" }, { name: "Granola" }, { name: "Stripe" }];
  assert.deepEqual(filterConnections(list, " gr ").map((entry) => entry.name), ["Granola"]);
  assert.deepEqual(filterConnections(list, "G").map((entry) => entry.name), ["Google Workspace", "Granola"]);
  assert.equal(filterConnections(list, "").length, 3);
});

test("connectors in a tab, with the brief: only added connections are listed; the rest are behind Add connector", () => {
  const notes = { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp" };
  const tracker = { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp" };
  const view = { ...briefOn, settings: { ...briefOn.settings, sources: { ...briefOn.settings.sources, connections: { [notes.id]: "everyone" as const } } } };
  assert.equal(otherConnectionAdded(view, notes), true);
  assert.equal(otherConnectionAdded(view, tracker), false);
  assert.equal(otherConnectionAdded(view, { ...tracker, policy: "off" }), true, "one the server holds back stays listed");
  const html = renderToStaticMarkup(<WorkbotProactiveSources view={view} canManage saving={false} onChange={() => undefined} help heading={false} />);
  assert.match(html, /data-testid="workbot-source-other-emc_notes"/);
  assert.doesNotMatch(html, /data-testid="workbot-source-other-emc_tracker"/);
  assert.doesNotMatch(html, /aria-label="About/, "no tooltips");
  assert.doesNotMatch(html, /<h2/, "the tab already says Connectors");
  const shown = text(html);
  assert.ok(shown.includes("Add connector"));
  assert.ok(shown.includes("1 other connection is up to each member."));
  assert.ok(shown.includes("2 connections. Read only."));
  assert.equal(otherConnectionsRestLine(58), "58 other connections are up to each member.");
  const none = renderToStaticMarkup(<WorkbotProactiveSources view={briefOn} canManage saving={false} onChange={() => undefined} help heading={false} />);
  assert.ok(text(none).includes("No connectors added"));
});
