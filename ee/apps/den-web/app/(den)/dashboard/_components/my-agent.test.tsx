import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_RESPONSIBILITIES, AGENT_RESPONSIBILITY_COPY, type MemberAgentCheck, type MemberAgentLimits, type MemberAgentSource, type MemberAgentView } from "@openwork/types/den/workbot-proactive";
import { AccountPickerOptions, MyAgentPanel, MyAgentRow, MyAgentRowError, type MyAgentLinks } from "./my-agent";
import { myAgentStateLine, sentTodayLabel, whenPhrase } from "./my-agent-view";

const TZ = "America/New_York";
// Tuesday 2026-10-20, 1:45 PM in New York.
const NOW = Date.parse("2026-10-20T17:45:00Z");
const at = (local: string) => new Date(Date.parse(`${local}-04:00`)).toISOString();

function check(overrides: Partial<MemberAgentCheck> & Pick<MemberAgentCheck, "at" | "outcome" | "reason" | "summary">): MemberAgentCheck {
  const colon = overrides.summary.indexOf(": ");
  return { id: overrides.at, kind: "scheduled", headline: colon > 0 ? overrides.summary.slice(0, colon) : overrides.summary.replace(/\.$/, ""), responsibilities: [], sources: [], slackUrl: null, fix: null, ...overrides };
}

const quietCheck = check({ at: at("2026-10-20T11:20:00"), outcome: "quiet", reason: "nothing_new", summary: "Stayed quiet: nothing new." });
const sentCheck = check({ at: at("2026-10-20T08:02:00"), kind: "morning", outcome: "sent", reason: "sent", summary: "Sent you a message about morning brief.", responsibilities: ["morning_brief"], slackUrl: "https://example.slack.com/archives/D0DM/p1" });

const baseLimits: MemberAgentLimits = { workingDays: "weekdays", startHour: 8, endHour: 19, dailyCap: 3, quietWindow: { startHour: 12, endHour: 14 }, admin: { startHour: 8, endHour: 19, dailyCap: 3 }, narrowed: { hours: false, dailyCap: false } };

const googleApp = { id: "google-workspace", name: "Google Workspace", url: "https://google.com", state: "connected" as const };
const microsoftApp = { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", state: "needs_connection" as const };
const emailSource: MemberAgentSource = { id: "email", kind: "email", name: "Email", connections: [{ id: "google-workspace", name: "Gmail", url: "https://google.com", state: "connected" }], options: [googleApp], chosenBy: "auto", policy: "everyone", on: true, instruction: "", lastReadAt: at("2026-10-20T11:20:00") };

const base: MemberAgentView = {
  available: true,
  on: true,
  snoozedUntil: null,
  responsibilities: AGENT_RESPONSIBILITIES.map((id) => ({ id, ...AGENT_RESPONSIBILITY_COPY[id], enabled: id !== "waiting_on_you", muted: id === "calendar_changes" })),
  destination: { kind: "workbot_dm", name: "Workbot DM", blocked: null },
  workingHours: { workingDays: "weekdays", startHour: 8, endHour: 19, dailyCap: 3 },
  nextCheckAt: at("2026-10-20T14:20:00"),
  timeZone: TZ,
  lastCheck: quietCheck,
  todayChecks: [quietCheck, sentCheck],
  sentToday: 1,
  preferences: { always: "", never: "", when: "Between 12 and 2, only urgent things", how: "" },
  limits: baseLimits,
  changes: [
    { id: "chg_2", field: "quietWindow", summary: "Only urgent messages 12 PM–2 PM", sourceId: null, source: "chat", at: at("2026-10-20T11:22:00"), undone: false },
    { id: "chg_1", field: "calendar_changes", summary: "Stopped: Calendar changes", sourceId: null, source: "chat", at: at("2026-10-20T11:22:00"), undone: false },
    { id: "chg_0", field: "when", summary: "When: “Between 12 and 2, only urgent things”", sourceId: null, source: "chat", at: at("2026-10-20T11:22:00"), undone: false },
    { id: "chg_s", field: "sourceInstruction", sourceId: "emc_notes", summary: "Meeting notes: “Use my meeting notes for context and action items.”", source: "chat", at: at("2026-10-20T10:42:00"), undone: false },
  ],
  sources: [
    { id: "calendar", kind: "calendar", name: "Calendar", connections: [{ id: "google-workspace", name: "Google Calendar", url: "https://google.com", state: "connected" }], options: [googleApp], chosenBy: "auto", policy: "everyone", on: true, instruction: "", lastReadAt: at("2026-10-20T11:20:00") },
    emailSource,
    { id: "chat", kind: "chat", name: "Team chat", connections: [{ id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", state: "connected" }], options: [{ id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", state: "connected" }], chosenBy: "auto", policy: "members", on: true, instruction: "", lastReadAt: at("2026-10-20T11:20:00") },
    { id: "emc_notes", kind: "other", name: "Meeting notes", connections: [{ id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp", state: "connected" }], options: [], chosenBy: null, policy: "members", on: true, instruction: "Use my meeting notes for context and action items.", lastReadAt: null },
    { id: "emc_tracker", kind: "other", name: "Issue tracker", connections: [{ id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp", state: "needs_connection" }], options: [], chosenBy: null, policy: "members", on: true, instruction: "", lastReadAt: null },
    { id: "emc_wiki", kind: "other", name: "Wiki", connections: [{ id: "emc_wiki", name: "Wiki", url: "https://mcp.notion.com/mcp", state: "connected" }], options: [], chosenBy: null, policy: "off", on: false, instruction: "", lastReadAt: null },
  ],
  link: "https://den.example/dashboard/library/my-agent",
};

const links: MyAgentLinks = {
  library: "/dashboard/library",
  google: { href: "/dashboard/library/connectors/emc_google", status: "Ready" },
  connector: (id) => `/dashboard/library/connectors/${id}?from=my-agent`,
  catalog: "/dashboard/library/connectors/new?from=my-agent",
};

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
}

function row(view: MemberAgentView) {
  return renderToStaticMarkup(<MyAgentRow view={view} href="/dashboard/library/my-agent" now={NOW} saving={false} onToggle={() => undefined} />);
}

function page(view: MemberAgentView = base, earlier: { open?: boolean; checks?: MemberAgentCheck[] | null } = {}) {
  return renderToStaticMarkup(
    <MyAgentPanel view={view} now={NOW} links={links} saving={false} error={null} onChange={() => undefined}
      earlier={{ open: earlier.open ?? false, onToggle: () => undefined, checks: earlier.checks ?? null, loading: false, error: null }} />,
  );
}

function switchFor(html: string, label: string) {
  return new RegExp(`<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? null;
}

test("the Library row reports a real state: the last check and what came of it, today's count, the switch and the way in", () => {
  const html = row(base);
  assert.match(text(html), /My bot Last check at 11:20 AM\. Stayed quiet\. 1 of 3 today/);
  assert.match(switchFor(html, "My bot") ?? "", /aria-checked="true"/);
  assert.match(html, /aria-label="Open My bot"/);
  assert.match(html, /href="\/dashboard\/library\/my-agent"/);
  assert.equal(sentTodayLabel(base), "1 of 3 today");
});

test("the Library row before the first check, off, snoozed, failing, and locked by the admin", () => {
  assert.equal(myAgentStateLine({ ...base, lastCheck: null }, NOW), "No checks yet. First check at 2:20 PM.");
  assert.equal(myAgentStateLine({ ...base, on: false }, NOW), "Off.");
  assert.equal(myAgentStateLine({ ...base, snoozedUntil: at("2026-10-21T08:00:00") }, NOW), "Snoozed until 8:00 AM.");
  const failed = check({ at: at("2026-10-19T17:05:00"), outcome: "failed", reason: "google_disconnected", summary: "Couldn't read Gmail: reconnect Google.", fix: "reconnect_google" });
  assert.equal(myAgentStateLine({ ...base, lastCheck: failed }, NOW), "Last check yesterday at 5:05 PM. Couldn't read Gmail.");
  const off = row({ ...base, on: false });
  assert.doesNotMatch(text(off), /of 3 today/, "no count while it's off");
  assert.match(switchFor(off, "My bot") ?? "", /aria-checked="false"/);
  const locked = row({ ...base, available: false });
  assert.match(text(locked), /Turned off by your admin in Manage › Workbot\./);
  assert.match(switchFor(locked, "My bot") ?? "", /disabled=""/);
  assert.match(locked, /data-state="locked"/);
  const error = renderToStaticMarkup(<MyAgentRowError message="Couldn't load your agent." retrying={false} onRetry={() => undefined} />);
  assert.match(text(error), /My bot Couldn't load your agent\. Try again/);
});

test("the page's focal line is the last check with its outcome, the next check and today's count", () => {
  const html = page();
  const focal = /data-testid="my-agent-last-check"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.match(text(focal), /Last check at 11:20 AM Stayed quiet: nothing new\. Next check at 2:20 PM 1 of 3 sent today/);
  assert.match(focal, /<h2/);
  const failing = page({ ...base, lastCheck: check({ at: at("2026-10-20T13:05:00"), outcome: "failed", reason: "google_disconnected", summary: "Couldn't read Gmail: reconnect Google.", fix: "reconnect_google" }) });
  assert.match(text(failing), /Couldn't read Gmail: reconnect Google\. .*Reconnect Google/);
  assert.match(failing, /href="\/dashboard\/library\/connectors\/emc_google"/);
  assert.match(text(page({ ...base, available: false })), /Turned off by your admin Your admin turns it on in Manage › Workbot\./);
});

test("today's checks: time, what happened, a pill, Open in Slack when it sent; earlier this week is collapsed", () => {
  const html = page();
  const today = /data-testid="my-agent-today"[\s\S]*?data-testid="my-agent-earlier"/.exec(html)?.[0] ?? "";
  assert.match(text(today), /11:20 AM Stayed quiet: nothing new\. Quiet/);
  assert.match(text(today), /8:02 AM Sent you a message about morning brief\. Open in Slack Sent/);
  assert.match(today, /href="https:\/\/example\.slack\.com\/archives\/D0DM\/p1"/);
  assert.equal((today.match(/Open in Slack/g) ?? []).length, 1, "only a sent check links to Slack");
  assert.doesNotMatch(html, /<details[^>]*data-testid="my-agent-earlier"[^>]*open=""/, "collapsed by default");
  const earlier = page(base, { open: true, checks: [quietCheck, check({ at: at("2026-10-19T15:00:00"), outcome: "waited", reason: "outside_hours", summary: "Waited: outside your hours (9 AM–1 PM)." })] });
  assert.match(text(earlier), /Earlier this week Mon 3:00 PM Waited: outside your hours \(9 AM–1 PM\)\. Waited/);
  const checks = /data-testid="my-agent-today"[\s\S]*?data-testid="my-agent-responsibilities"/.exec(earlier)?.[0] ?? "";
  assert.equal((text(checks).match(/11:20 AM Stayed quiet/g) ?? []).length, 1, "today's checks aren't repeated under earlier");;
  assert.match(text(page({ ...base, todayChecks: [] })), /No checks yet today\./);
});

test("what it tells you about: a muted one shows where the change came from with Undo; one the admin turned off is locked with the reason", () => {
  const html = page();
  assert.match(switchFor(html, "Calendar changes") ?? "", /aria-checked="false"/);
  const calendar = /data-testid="my-agent-calendar_changes"[\s\S]*?data-testid="my-agent-waiting_on_you"/.exec(html)?.[0] ?? "";
  assert.match(text(calendar), /Saved from chat at 11:22 AM\. Undo/);
  const waiting = /data-testid="my-agent-waiting_on_you"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.match(text(waiting), /Turned off by your admin in Manage › Workbot\./);
  assert.match(switchFor(waiting, "Waiting on you") ?? "", /disabled=""/);
  assert.match(switchFor(html, "Morning brief") ?? "", /aria-checked="true"/);
});

test("in your words: the four fields, what was saved from chat, and Undo", () => {
  const html = page();
  const words = /data-testid="my-agent-words"[\s\S]*?data-testid="my-agent-uses"/.exec(html)?.[0] ?? "";
  for (const label of ["Always tell me about", "Never tell me about", "When", "How"]) assert.ok(text(words).includes(label), label);
  assert.match(words, />Between 12 and 2, only urgent things<\/textarea>/);
  assert.match(text(/data-testid="my-agent-words-when"[\s\S]*?data-testid="my-agent-words-how"/.exec(words)?.[0] ?? ""), /Saved from chat at 11:22 AM\. Undo/);
  assert.match(words, /placeholder="Newsletters and automated alerts"/);
});

function source(html: string, id: string) {
  return new RegExp(`data-testid="my-agent-source-${id}"[\\s\\S]*?(?=data-testid="my-agent-source-(?!instruction)|data-testid="my-agent-limits"|$)`).exec(html)?.[0] ?? "";
}

test("uses: each core row has its category icon, a state line and the app it reads; on for everyone means no switch and no lock", () => {
  const html = page();
  const calendar = source(html, "calendar");
  assert.match(text(calendar), /Calendar Last read at 11:20 AM Google Workspace/, "the state under the label, the app on the right");
  const header = /data-testid="my-agent-source-calendar"[\s\S]*?data-testid="my-agent-state-calendar"/.exec(calendar)?.[0] ?? "";
  assert.doesNotMatch(header, /<img/, "the category's own icon, never an app logo");
  assert.match(header, /<svg/);
  assert.equal(switchFor(calendar, "Calendar"), null, "on for everyone: no switch");
  assert.doesNotMatch(calendar, /On for everyone, set by your admin/, "and no lock");
  assert.doesNotMatch(calendar, /my-agent-picker-calendar/, "one app allowed: no picker");
  assert.match(calendar, /data-testid="my-agent-app-calendar"/);
  assert.match(source(html, "emc_notes"), /<img|<svg/, "another source keeps its own logo");
  assert.match(text(/data-testid="my-agent-sources-locked"[\s\S]*?<\/p>/.exec(html)?.[0] ?? ""), /Locked sources are set by your admin in Manage › Workbot\./);
  const chat = source(html, "chat");
  assert.doesNotMatch(switchFor(chat, "Team chat") ?? "", /disabled=""/, "members choose: their switch");
  const wiki = source(html, "emc_wiki");
  assert.match(text(wiki), /Wiki Not allowed/);
  assert.match(wiki, /aria-label="Not allowed by your admin"/);
  assert.match(switchFor(wiki, "Wiki") ?? "", /disabled=""/);
  assert.doesNotMatch(wiki, /instruction for Wiki/, "nothing to steer on a source it may not read");
});

test("uses: the member's instruction in their own words, where it was saved and Edit; a Connect action when their account isn't ready", () => {
  const html = page();
  const notes = source(html, "emc_notes");
  assert.match(text(notes), /Meeting notes Not read yet/);
  assert.match(text(notes), /“Use my meeting notes for context and action items\.” Saved from chat at 10:42 AM\./);
  assert.match(notes, /aria-label="Edit the instruction for Meeting notes"/);
  const tracker = source(html, "emc_tracker");
  assert.match(text(tracker), /Issue tracker Connect Issue tracker/);
  assert.match(tracker, /href="\/dashboard\/library\/connectors\/emc_tracker\?from=my-agent"/);
  assert.match(source(html, "chat"), /aria-label="Add an instruction for Team chat"/);
  const reconnect = page({ ...base, sources: [{ ...emailSource, connections: [{ id: "google-workspace", name: "Gmail", url: "https://google.com", state: "reconnect" }], options: [{ ...googleApp, state: "reconnect" }] }] });
  assert.match(text(source(reconnect, "email")), /Email Reconnect Gmail/);
});

test("uses: with two apps allowed, a picker shows the app it reads; the menu lists them with a check and Connect", () => {
  const two: MemberAgentSource = { ...emailSource, options: [googleApp, microsoftApp] };
  const email = source(page({ ...base, sources: [two] }), "email");
  assert.match(email, /data-testid="my-agent-picker-email"/);
  assert.match(email, /aria-label="Read your email from: Google Workspace"/);
  assert.match(text(email), /Email Last read at 11:20 AM Google Workspace/);
  assert.doesNotMatch(text(email), /Connect|Microsoft 365/, "the member isn't asked to connect an app they don't use");
  assert.equal(switchFor(email, "Email"), null, "on for everyone: the picker is the only control");

  const picked: string[] = [];
  const menu = renderToStaticMarkup(<AccountPickerOptions kind="email" options={two.options} chosen={googleApp} onPick={(id) => picked.push(id)} />);
  assert.match(text(menu), /Read your email from Google Workspace Microsoft 365 Connect/);
  assert.match(menu, /role="menu" aria-label="Read your email from"/);
  assert.match(menu, /<button[^>]*role="menuitemradio"[^>]*aria-checked="true"[^>]*aria-label="Google Workspace"/);
  assert.match(menu, /<button[^>]*role="menuitemradio"[^>]*aria-checked="false"[^>]*aria-label="Microsoft 365"/);
  assert.match(text(renderToStaticMarkup(<AccountPickerOptions kind="chat" options={two.options} chosen={null} onPick={() => undefined} />)), /^ ?Read your team chat from/);

  const chose = page({ ...base, sources: [{ ...two, connections: [{ id: "m365_main", name: "Outlook mail", url: "https://microsoft.com", state: "needs_connection" }], chosenBy: "member" }] });
  const chosen = source(chose, "email");
  assert.match(chosen, /aria-label="Read your email from: Microsoft 365"/);
  assert.match(text(chosen), /Email Connect Outlook mail/, "the app picked needs connecting: the Connect link on the row");
  assert.match(chosen, /href="\/dashboard\/library\/connectors\/m365_main\?from=my-agent"/);
});

test("uses: where members choose, a core row keeps its switch next to the picker; not allowed stays locked", () => {
  const members = source(page({ ...base, sources: [{ ...emailSource, policy: "members", options: [googleApp, microsoftApp] }] }), "email");
  assert.match(members, /data-testid="my-agent-picker-email"/);
  assert.doesNotMatch(switchFor(members, "Email") ?? "", /disabled=""/);
  const off = source(page({ ...base, sources: [{ ...emailSource, policy: "off", on: false, options: [googleApp, microsoftApp] }] }), "email");
  assert.match(text(off), /Email Not allowed/);
  assert.match(off, /aria-label="Not allowed by your admin"/);
  assert.match(switchFor(off, "Email") ?? "", /disabled=""/);
  assert.doesNotMatch(off, /my-agent-picker-email/, "nothing to pick on a source it may not read");
});

test("limits: their hours inside the admin's, the only-urgent window, and the cap locked by the admin", () => {
  const html = page();
  const limits = /data-testid="my-agent-limits"[\s\S]*$/.exec(html)?.[0] ?? "";
  assert.match(text(limits), /Hours Weekdays/);
  assert.match(text(limits), /Only urgent 12 PM–2 PM Saved from chat at 11:22 AM\. Undo/);
  assert.match(text(limits), /Daily limit 3 a day Set by your admin in Manage › Workbot\./);
  const narrowed = page({ ...base, limits: { ...baseLimits, dailyCap: 1, narrowed: { hours: false, dailyCap: true } }, changes: [{ id: "chg_9", field: "dailyCap", summary: "Daily limit: 1 a day", sourceId: null, source: "page", at: at("2026-10-20T09:00:00"), undone: false }] });
  assert.match(text(narrowed), /Daily limit 1 a day Saved here at 9:00 AM\. Undo Your admin allows 3 a day\./);
  assert.equal(whenPhrase(at("2026-10-21T08:00:00"), TZ, NOW), "tomorrow at 8:00 AM");
});
