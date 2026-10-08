#!/usr/bin/env node
// Demo workspace MCP servers for preview worlds: Slack, Notion, Linear, Google Calendar and Gmail for the
// fictional Acme Robotics team, each at /<service>/mcp (Streamable HTTP, JSON responses).
//
// Every service starts from realistic seeded data and keeps all changes in memory: what an agent writes
// (a Slack message, a Linear issue, a calendar event, a Gmail draft) is readable right after. Nothing leaves
// this process and nothing is persisted; restarting the process restores the seed.
//
// Self-contained on purpose (no imports outside Node): worlds upload it verbatim into a Daytona sandbox.
//
//   HOST=127.0.0.1 PORT=3990 node demo-workspace-mcp.mjs
//   GET  /health            liveness
//   GET  /state             every service's current data (debugging a demo)
//   POST /reset             restore the seed
//   POST /<service>/mcp     MCP JSON-RPC: initialize, tools/list, tools/call, ping
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3990);
const TIME_ZONE = process.env.DEMO_TIME_ZONE || "America/Los_Angeles";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ── Time helpers: seed data is placed relative to "now" so a demo is always about this week. ────────────

function zoneOffsetMinutes(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - date.getTime()) / 60000);
}
/** Today's date in the demo time zone, as y/m/d. */
function localToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((part) => [part.type, part.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}
/** Wall-clock time `dayOffset` days from today in the demo time zone, as an ISO string with its offset. */
function at(dayOffset, hour, minute = 0) {
  const today = localToday();
  const guess = new Date(Date.UTC(today.y, today.m - 1, today.d + dayOffset, hour, minute));
  const offset = zoneOffsetMinutes(guess);
  const instant = new Date(guess.getTime() - offset * 60000);
  const finalOffset = zoneOffsetMinutes(instant);
  const corrected = new Date(guess.getTime() - finalOffset * 60000);
  return isoWithOffset(corrected);
}
function isoWithOffset(date) {
  const offset = zoneOffsetMinutes(date);
  const local = new Date(date.getTime() + offset * 60000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${local.toISOString().slice(0, 19)}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
/** Day offset of the nth working day: 0 is today on a weekday (else the next Monday), -1 the working day before it. */
function biz(n) {
  const weekday = (offset) => { const day = new Date(at(offset, 12)).getUTCDay(); return day !== 0 && day !== 6; };
  let offset = 0;
  while (!weekday(offset)) offset += 1;
  const step = n < 0 ? -1 : 1;
  for (let remaining = Math.abs(n); remaining > 0;) { offset += step; if (weekday(offset)) remaining -= 1; }
  return offset;
}
/** "Oct 28" / "Thursday" for the nth working day, so seeded text agrees with the seeded calendar. */
const D = (n) => new Date(at(biz(n), 12)).toLocaleDateString("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" });
const W = (n) => new Date(at(biz(n), 12)).toLocaleDateString("en-US", { timeZone: TIME_ZONE, weekday: "long" });
/** A Slack-style ts (seconds.micro) for `minutesAgo` before now; unique within a process. */
let tsCounter = 0;
function slackTs(minutesAgo) {
  const seconds = Math.floor(Date.now() / 1000 - minutesAgo * 60);
  tsCounter = (tsCounter + 1) % 1000000;
  return `${seconds}.${String(tsCounter).padStart(6, "0")}`;
}
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
/** Stable Slack-looking IDs (U07K3M9QZ2B) derived from a name. */
const slackId = (prefix, name) => `${prefix}0${BigInt(`0x${createHash("sha256").update(name).digest("hex").slice(0, 16)}`).toString(36).toUpperCase().slice(0, 9)}`;
const shortId = () => randomUUID().replace(/-/g, "").slice(0, 12);

// ── People: the same Acme Robotics team as the demo-org seed. The signed-in person is Alex Chen. ─────────

const DOMAIN = "acme.test";
const PEOPLE = [
  ["alex", "Alex Chen", "CEO"], ["priya", "Priya Shah", "VP Engineering"], ["mateo", "Mateo Rivera", "VP Sales"],
  ["morgan", "Morgan Lee", "Product Designer"], ["nora", "Nora Patel", "Product Manager"], ["jamal", "Jamal Brooks", "Staff Engineer"],
  ["sofia", "Sofia Garcia", "Engineering Manager, Fleet"], ["ivy", "Ivy Nguyen", "Design Lead"], ["liam", "Liam O'Connor", "Account Executive"],
  ["olivia", "Olivia Martin", "Head of Marketing"], ["harper", "Harper Wilson", "Support Lead"], ["kenji", "Kenji Tanaka", "Field Operations"],
  ["zoe", "Zoe Kim", "Content Marketing"], ["sam", "Sam Okafor", "Finance Manager"], ["maya", "Maya Singh", "Legal Counsel"],
  ["ezra", "Ezra Cohen", "Data Engineer"], ["camila", "Camila Torres", "People Operations"],
].map(([handle, name, title]) => ({ id: slackId("U", handle), handle, name, title, email: `${handle}@${DOMAIN}` }));
const person = (handle) => {
  const found = PEOPLE.find((entry) => entry.handle === handle);
  if (!found) throw new Error(`Unknown person ${handle}`);
  return found;
};
const ME = person("alex");
function findPerson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const needle = value.trim().toLowerCase().replace(/^@/, "");
  return PEOPLE.find((entry) => [entry.id.toLowerCase(), entry.handle, entry.email, entry.name.toLowerCase()].includes(needle))
    ?? PEOPLE.find((entry) => entry.name.toLowerCase().split(" ")[0] === needle) ?? null;
}

// ── Seed data ───────────────────────────────────────────────────────────────────────────────────────────

function seedSlack() {
  const channels = [
    ["general", "Company-wide announcements and work-based matters", ["alex", "priya", "mateo", "morgan", "nora", "jamal", "sofia", "ivy", "liam", "olivia", "harper", "kenji", "zoe", "sam", "maya", "ezra", "camila"]],
    ["eng-fleet", "Fleet 2.0 firmware, navigation and fleet manager", ["priya", "jamal", "sofia", "ezra", "nora", "alex"]],
    ["launch-fleet-2", `Fleet 2.0 launch, ${D(15)}. Owners: Nora (product), Olivia (marketing)`, ["alex", "nora", "olivia", "zoe", "priya", "mateo", "harper", "morgan"]],
    ["sales", "Pipeline, deals and customer asks", ["mateo", "liam", "olivia", "alex", "sam"]],
    ["support-escalations", "Customer issues that need engineering", ["harper", "kenji", "jamal", "sofia", "priya"]],
    ["design", "Design reviews and critiques", ["ivy", "morgan", "nora", "olivia"]],
    ["random", "Non-work banter", ["alex", "jamal", "ivy", "zoe", "kenji", "camila", "ezra"]],
  ].map(([name, purpose, members], index) => ({
    id: slackId("C", name), name, purpose, is_private: false,
    members: members.map((handle) => person(handle).id), created: ago(60 * 24 * (400 - index * 30)),
  }));
  const channel = (name) => channels.find((entry) => entry.name === name).id;
  const messages = [];
  const post = (channelName, handle, minutesAgo, text, extra = {}) => {
    const message = { channel: channel(channelName), ts: slackTs(minutesAgo), user: person(handle).id, text, reactions: [], ...extra };
    messages.push(message);
    return message;
  };
  const reply = (parent, handle, minutesAgo, text) => post(Object.values(channels).find((c) => c.id === parent.channel).name, handle, minutesAgo, text, { thread_ts: parent.ts });

  post("general", "camila", 60 * 26, "Reminder: open enrollment for benefits closes Friday. Questions → #people-ops or DM me :blush:", { reactions: [{ name: "white_check_mark", users: [person("sam").id, person("ivy").id] }] });
  post("general", "alex", 60 * 5, "Huge thanks to everyone who stayed late for the Northwind pilot install. Their ops lead said it was the smoothest robot rollout they've done. :rocket:", { reactions: [{ name: "tada", users: [person("kenji").id, person("mateo").id, person("priya").id, person("harper").id] }] });

  const flaky = post("eng-fleet", "jamal", 60 * 20, "Seeing intermittent localization drift on the Atlas units at Northwind dock 4 — pose error jumps ~30cm after the reflective tape section. Repro'd twice on the bench with the dock-4 map. Filed ENG-342.");
  reply(flaky, "sofia", 60 * 19, "Thanks Jamal. Is this the 2.0-rc3 firmware or still rc2?");
  reply(flaky, "jamal", 60 * 19 - 10, "rc3. rc2 didn't have the new lidar filter so it might be related.");
  reply(flaky, "ezra", 60 * 18, "I can pull the pose logs from the fleet telemetry warehouse for the last 7 days if that helps — I'll drop a notebook in the thread.");
  reply(flaky, "priya", 60 * 3, "This is a launch blocker until we know the cause. Sofia can you make sure it's on the Fleet 2.0 launch checklist?");
  post("eng-fleet", "sofia", 60 * 2, `Standup notes: rc4 build cut ${W(1)} 10am. Remaining blockers: ENG-342 (localization drift), ENG-351 (battery telemetry gaps). Everything else on the board is green.`);

  const launch = post("launch-fleet-2", "nora", 60 * 30, `Launch plan v3 is up in Notion (Fleet 2.0 Launch Plan). Big changes: press embargo moves to ${D(15)} 9am PT, and we're adding a customer webinar on ${D(17)}.`);
  reply(launch, "olivia", 60 * 29, "Love it. I'll update the press brief and the blog draft today.");
  reply(launch, "mateo", 60 * 28, `Can sales get the pricing one-pager by ${D(6)}? Liam has two renewals that want to see Fleet 2.0 pricing.`);
  reply(launch, "nora", 60 * 27, `Yes — pricing one-pager is LAUNCH-18 in Linear, due ${D(5)}.`);
  post("launch-fleet-2", "zoe", 60 * 4, `First draft of the launch blog post is ready for review: \"Meet Fleet 2.0: robots that learn your warehouse.\" Comments welcome by ${W(3)}!`, { reactions: [{ name: "eyes", users: [person("olivia").id, person("nora").id] }] });
  post("launch-fleet-2", "olivia", 45, `@Alex do you have 20 min to record the CEO quote for the press release? ${W(2)} afternoon works best for the PR agency.`);

  const deal = post("sales", "liam", 60 * 22, "Northwind Logistics wants to expand from 12 to 40 robots across 3 sites if we can commit to the Fleet 2.0 multi-site dashboard by Q1. Draft order form is ~$1.4M ARR.", { reactions: [{ name: "moneybag", users: [person("mateo").id, person("sam").id] }] });
  reply(deal, "mateo", 60 * 21, "Great news. Let's get Alex and Priya on a call with their VP Ops — Liam can you set it up for next week?");
  reply(deal, "liam", 60 * 21 - 15, "On it. They proposed Tuesday or Wednesday morning.");
  post("sales", "sam", 60 * 6, "Q3 bookings closed at $3.2M (108% of plan). Q4 forecast review is Monday — please update your commits in the CRM before then.");

  const esc = post("support-escalations", "harper", 60 * 8, "Blue Harbor Foods: 2 robots stuck in 'charging' state since this morning, dock shows full charge. Customer is on rc2. Kenji is on site. Severity: high (picking SLA at risk).");
  reply(esc, "kenji", 60 * 7, "On site now. Power-cycled one unit and it recovered. The other is still stuck; grabbing logs.");
  reply(esc, "jamal", 60 * 6, "Sounds like the BMS handshake bug fixed in rc3 (ENG-318). Can we OTA them to rc3 tonight?");
  post("design", "ivy", 60 * 10, `Fleet dashboard v2 high-fi mocks are in Figma; design crit ${W(1)} 2pm. Main open question: map view vs. list view as the default for multi-site.`);
  post("random", "kenji", 60 * 12, "Robot-of-the-week: Atlas #117 at Blue Harbor picked 4,212 items yesterday without a single exception :trophy:", { reactions: [{ name: "robot_face", users: [person("jamal").id, person("zoe").id, person("alex").id] }] });

  const dms = [{ id: slackId("D", "priya"), user: person("priya").id }, { id: slackId("D", "mateo"), user: person("mateo").id }];
  messages.push({ channel: dms[0].id, ts: slackTs(90), user: person("priya").id, text: "Hey — can we move our 1:1 to Thursday? I want to bring the rc4 go/no-go criteria.", reactions: [] });
  return { team: { id: slackId("T", "acme-robotics"), name: "Acme Robotics", domain: "acme-robotics" }, channels, dms, messages };
}

function seedNotion() {
  const pages = [];
  const page = (title, icon, parent, markdown, extra = {}) => {
    const entry = { id: `${shortId()}${shortId()}`.slice(0, 32), object: "page", title, icon, parent, markdown,
      created_by: extra.created_by ?? ME.name, created_time: extra.created_time ?? ago(60 * 24 * 30), last_edited_by: extra.last_edited_by ?? ME.name,
      last_edited_time: extra.last_edited_time ?? ago(60 * 24 * 2), properties: extra.properties ?? {}, comments: [] };
    pages.push(entry);
    return entry;
  };
  const wiki = page("Acme Robotics Wiki", "🤖", { type: "workspace" }, "Home for how Acme works.\n\n- Company handbook\n- Engineering\n- Product launches\n- Meeting notes", { created_by: "Camila Torres" });
  const launches = page("Product launches", "🚀", { type: "page", id: wiki.id }, "Launch plans, briefs and retros for every release.", { created_by: "Nora Patel" });
  const plan = page("Fleet 2.0 Launch Plan", "🚀", { type: "page", id: launches.id }, [
    "# Fleet 2.0 Launch Plan (v3)",
    `**Owner:** Nora Patel · **Launch date:** ${D(15)}, 9:00 AM PT (press embargo lifts)`,
    "## Goals",
    "- 25 new Fleet 2.0 sites signed by end of Q1",
    `- Upgrade 80% of existing customers to Fleet 2.0 firmware by ${D(45)}`,
    "- Press: 3 tier-1 robotics/logistics publications",
    "## Timeline",
    "| Date | Milestone | Owner |",
    "|---|---|---|",
    `| ${D(1)} | rc4 firmware build | Sofia Garcia |`,
    `| ${D(5)} | Pricing one-pager final | Mateo Rivera |`,
    `| ${D(8)} | Go / no-go review | Priya Shah |`,
    `| ${D(15)} | Launch + press release | Olivia Martin |`,
    `| ${D(17)} | Customer webinar | Nora Patel |`,
    "## Launch blockers",
    "- ENG-342 Localization drift near reflective surfaces",
    "- ENG-351 Battery telemetry gaps in fleet manager",
    "## Open questions",
    `- Do we offer a discount for customers upgrading before ${D(35)}?`,
    "- Default view for the multi-site dashboard: map or list?",
  ].join("\n"), { created_by: "Nora Patel", last_edited_by: "Nora Patel", last_edited_time: ago(60 * 30) });
  page("Fleet 2.0 Press Brief", "📰", { type: "page", id: launches.id }, `# Press brief\n**Embargo:** ${D(15)}, 9:00 AM PT\n\n## Key messages\n1. Fleet 2.0 robots learn a new warehouse layout in under 2 hours.\n2. One dashboard for every site.\n3. 30% more picks per hour than Fleet 1.x in customer pilots.\n\n## CEO quote\n_TBD — Alex to record by ${W(2)}._`, { created_by: "Olivia Martin", last_edited_by: "Olivia Martin", last_edited_time: ago(60 * 5) });
  const eng = page("Engineering", "🛠️", { type: "page", id: wiki.id }, "Engineering practices, on-call and architecture.", { created_by: "Priya Shah" });
  page("On-call runbook: robots stuck charging", "📟", { type: "page", id: eng.id }, "# Robots stuck in 'charging'\n1. Check firmware version (rc2 has the BMS handshake bug ENG-318).\n2. Power-cycle the robot from the fleet manager.\n3. If still stuck, collect `/var/log/bms` and escalate in #support-escalations.\n4. Fix: OTA to rc3 or later.", { created_by: "Jamal Brooks" });
  page("Handbook: Expenses & travel", "💳", { type: "page", id: wiki.id }, "# Expenses\n- Submit within 30 days in the finance tool.\n- Customer travel: book through the travel portal; economy for flights under 6 hours.\n- Meals with customers up to $120/person.", { created_by: "Sam Okafor" });

  const meetings = { id: `${shortId()}${shortId()}`.slice(0, 32), object: "database", title: "Meeting notes", icon: "🗒️", parent: { type: "page", id: wiki.id },
    schema: { Name: "title", Date: "date", Attendees: "people", Type: "select" }, created_time: ago(60 * 24 * 300), last_edited_time: ago(60 * 24) };
  const roadmap = { id: `${shortId()}${shortId()}`.slice(0, 32), object: "database", title: "Product roadmap", icon: "🗺️", parent: { type: "page", id: wiki.id },
    schema: { Name: "title", Status: "status", Quarter: "select", Owner: "people", Priority: "select" }, created_time: ago(60 * 24 * 200), last_edited_time: ago(60 * 24 * 3) };
  const databases = [meetings, roadmap];
  const row = (database, title, properties, markdown = "", extra = {}) => page(title, undefined, { type: "database", id: database.id }, markdown, { properties, ...extra });
  row(meetings, "Weekly leadership sync", { Date: at(biz(-3), 9).slice(0, 10), Attendees: ["Alex Chen", "Priya Shah", "Mateo Rivera", "Sam Okafor"], Type: "Recurring" },
    `## Notes\n- Q3 bookings $3.2M (108%)\n- Fleet 2.0 go/no-go on ${D(8)}\n- Hiring: 2 field ops roles approved\n## Action items\n- [ ] Alex: record CEO quote for press release\n- [ ] Mateo: Northwind expansion call\n- [x] Sam: Q4 forecast template`);
  row(meetings, "Northwind Logistics QBR", { Date: at(biz(-8), 13).slice(0, 10), Attendees: ["Mateo Rivera", "Liam O'Connor", "Kenji Tanaka"], Type: "Customer" },
    "## Summary\nNorthwind is happy with pilot (12 robots, 2 sites). Wants multi-site dashboard and 40 robots across 3 sites.\n## Risks\n- Needs SSO for the dashboard\n- Dock 4 localization issue");
  row(meetings, "Design crit: fleet dashboard v1", { Date: at(biz(-10), 14).slice(0, 10), Attendees: ["Ivy Nguyen", "Morgan Lee", "Nora Patel"], Type: "Review" }, "Decided to prototype map view and list view; test with 3 customers.");
  row(roadmap, "Multi-site fleet dashboard", { Status: "In progress", Quarter: "Q4", Owner: "Nora Patel", Priority: "P0" });
  row(roadmap, "Self-serve warehouse mapping", { Status: "In progress", Quarter: "Q4", Owner: "Sofia Garcia", Priority: "P0" });
  row(roadmap, "SSO for fleet dashboard", { Status: "Not started", Quarter: "Q1", Owner: "Priya Shah", Priority: "P1" });
  row(roadmap, "Predictive battery maintenance", { Status: "Not started", Quarter: "Q1", Owner: "Ezra Cohen", Priority: "P2" });
  row(roadmap, "Pick-rate analytics export", { Status: "Done", Quarter: "Q3", Owner: "Ezra Cohen", Priority: "P1" });
  return { pages, databases };
}

function seedLinear() {
  const teams = [{ id: "team-eng", key: "ENG", name: "Engineering" }, { id: "team-launch", key: "LAUNCH", name: "Launch" }, { id: "team-sup", key: "SUP", name: "Support" }];
  const states = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"];
  const projects = [
    { id: "proj-fleet2", name: "Fleet 2.0", lead: "Sofia Garcia", status: "In Progress", target_date: at(25, 9).slice(0, 10), progress: 0.72 },
    { id: "proj-dashboard", name: "Multi-site dashboard", lead: "Nora Patel", status: "In Progress", target_date: at(40, 9).slice(0, 10), progress: 0.41 },
    { id: "proj-launch", name: "Fleet 2.0 launch", lead: "Olivia Martin", status: "In Progress", target_date: at(25, 9).slice(0, 10), progress: 0.55 },
  ];
  const counters = { ENG: 350, LAUNCH: 17, SUP: 88 };
  const issues = [];
  const issue = (teamKey, title, fields) => {
    counters[teamKey] += 1;
    const team = teams.find((entry) => entry.key === teamKey);
    const entry = { id: randomUUID(), identifier: `${teamKey}-${counters[teamKey]}`, team: team.name, title, description: fields.description ?? "",
      state: fields.state ?? "Todo", priority: fields.priority ?? 3, assignee: fields.assignee ?? null, labels: fields.labels ?? [], project: fields.project ?? null,
      due_date: fields.due_date ?? null, creator: fields.creator ?? ME.name, created_at: fields.created_at ?? ago(60 * 24 * 7), updated_at: fields.updated_at ?? ago(60 * 24), comments: [] };
    issues.push(entry);
    return entry;
  };
  counters.ENG = 317;
  issue("ENG", "BMS handshake fails after deep sleep on rc2", { state: "Done", priority: 1, assignee: "Jamal Brooks", labels: ["bug", "firmware"], project: "Fleet 2.0", created_at: ago(60 * 24 * 30) });
  counters.ENG = 341;
  const drift = issue("ENG", "Localization drift near reflective tape (dock 4, Northwind)", { state: "In Progress", priority: 1, assignee: "Jamal Brooks", labels: ["bug", "navigation", "launch-blocker"], project: "Fleet 2.0",
    description: "Pose error jumps ~30cm after robots cross the reflective tape section at Northwind dock 4. Repro on bench with dock-4 map on rc3. Suspect new lidar intensity filter.", created_at: ago(60 * 20), creator: "Jamal Brooks" });
  drift.comments.push({ id: randomUUID(), author: "Ezra Cohen", body: "Pose logs for the last 7 days are in the telemetry notebook; drift only happens when intensity > 0.85.", created_at: ago(60 * 17) });
  issue("ENG", "Lidar intensity filter: make threshold configurable per site", { state: "Todo", priority: 2, assignee: "Sofia Garcia", labels: ["navigation"], project: "Fleet 2.0" });
  counters.ENG = 350;
  issue("ENG", "Battery telemetry gaps in fleet manager", { state: "In Review", priority: 1, assignee: "Ezra Cohen", labels: ["bug", "telemetry", "launch-blocker"], project: "Fleet 2.0" });
  issue("ENG", "Cut rc4 firmware build", { state: "Todo", priority: 2, assignee: "Sofia Garcia", labels: ["release"], project: "Fleet 2.0", due_date: at(biz(1), 10).slice(0, 10) });
  issue("ENG", "Dashboard: site switcher keyboard navigation", { state: "Backlog", priority: 4, assignee: "Morgan Lee", labels: ["dashboard", "a11y"], project: "Multi-site dashboard" });
  issue("ENG", "Dashboard: map view clustering for >50 robots", { state: "In Progress", priority: 2, assignee: "Jamal Brooks", labels: ["dashboard"], project: "Multi-site dashboard" });
  issue("LAUNCH", "Pricing one-pager for Fleet 2.0", { state: "In Progress", priority: 2, assignee: "Mateo Rivera", labels: ["sales-enablement"], project: "Fleet 2.0 launch", due_date: at(biz(5), 17).slice(0, 10) });
  issue("LAUNCH", "Record CEO quote for press release", { state: "Todo", priority: 2, assignee: "Alex Chen", labels: ["press"], project: "Fleet 2.0 launch", due_date: at(biz(2), 17).slice(0, 10), creator: "Olivia Martin" });
  issue("LAUNCH", "Launch blog post: Meet Fleet 2.0", { state: "In Review", priority: 3, assignee: "Zoe Kim", labels: ["content"], project: "Fleet 2.0 launch" });
  issue("LAUNCH", `Customer webinar logistics (${D(17)})`, { state: "Todo", priority: 3, assignee: "Nora Patel", labels: ["events"], project: "Fleet 2.0 launch" });
  issue("SUP", "Blue Harbor Foods: 2 robots stuck charging (rc2)", { state: "In Progress", priority: 1, assignee: "Kenji Tanaka", labels: ["customer", "escalation"], created_at: ago(60 * 8), creator: "Harper Wilson" });
  issue("SUP", "Northwind: request for SSO on dashboard", { state: "Backlog", priority: 3, assignee: "Harper Wilson", labels: ["customer", "feature-request"] });
  return { teams, states, projects, counters, issues };
}

function seedCalendar() {
  const calendars = [
    { id: ME.email, summary: "Alex Chen", primary: true, access_role: "owner", time_zone: TIME_ZONE },
    { id: "launches@acme.test", summary: "Launch calendar", primary: false, access_role: "reader", time_zone: TIME_ZONE },
  ];
  const events = [];
  const event = (calendarId, summary, startDay, startHour, startMinute, durationMinutes, attendees, extra = {}) => {
    const start = at(biz(startDay), startHour, startMinute);
    const end = isoWithOffset(new Date(new Date(start).getTime() + durationMinutes * 60000));
    events.push({ id: shortId() + shortId(), calendar_id: calendarId, summary, start, end, attendees: attendees.map((handle) => ({ email: person(handle).email, name: person(handle).name, response_status: "accepted" })),
      organizer: extra.organizer ?? ME.email, location: extra.location ?? "Google Meet", description: extra.description ?? "", recurrence: extra.recurrence ?? null, status: "confirmed", created: ago(60 * 24 * 10), updated: ago(60 * 24) });
  };
  for (let day = -2; day <= 8; day += 1) {
    event(ME.email, "Exec standup", day, 9, 0, 15, ["alex", "priya", "mateo", "sam"], { recurrence: "Weekdays", description: "Blockers and decisions only." });
  }
  event(ME.email, "1:1 Alex / Priya", 0, 11, 0, 30, ["alex", "priya"], { organizer: person("priya").email });
  event(ME.email, "Fleet 2.0 go/no-go prep", 0, 14, 0, 45, ["alex", "priya", "sofia", "nora"], { organizer: person("nora").email, description: "Review rc4 criteria and launch blockers ENG-342, ENG-351.", location: "HQ – Boardroom" });
  event(ME.email, "Lunch with Olivia", 1, 12, 30, 60, ["alex", "olivia"], { location: "Tartine, Mission St" });
  event(ME.email, "Design crit: fleet dashboard v2", 1, 14, 0, 60, ["ivy", "morgan", "nora", "alex"], { organizer: person("ivy").email });
  event(ME.email, "Board prep with Sam", 2, 10, 0, 60, ["alex", "sam"], { description: "Q3 actuals, Q4 forecast, hiring plan." });
  event(ME.email, "Weekly leadership sync", 3, 9, 30, 60, ["alex", "priya", "mateo", "sam", "olivia"], { recurrence: "Weekly", location: "HQ – Boardroom" });
  event(ME.email, "Customer call: Blue Harbor Foods", 3, 15, 0, 30, ["alex", "harper", "kenji"], { description: "Follow up on charging escalation; offer rc3 upgrade." });
  event(ME.email, "All-hands", 4, 16, 0, 45, PEOPLE.map((entry) => entry.handle), { location: "HQ – Cafe + Google Meet" });
  event(ME.email, "Recruiting: Field Ops Lead final round", 6, 13, 0, 60, ["alex", "kenji", "camila"]);
  event("launches@acme.test", "Fleet 2.0 rc4 build cut", 1, 10, 0, 30, ["sofia", "jamal"], { organizer: person("sofia").email });
  event("launches@acme.test", "Fleet 2.0 go/no-go", 8, 10, 0, 60, ["alex", "priya", "sofia", "nora", "olivia", "mateo"], { organizer: person("priya").email });
  return { calendars, events: events.sort((a, b) => a.start.localeCompare(b.start)) };
}

function seedGmail() {
  const threads = [];
  const thread = (subject, labels, messages) => {
    const id = shortId() + shortId().slice(0, 4);
    threads.push({ id, subject, labels, messages: messages.map(([from, to, minutesAgo, body, cc = []]) => ({
      id: shortId() + shortId().slice(0, 4), from, to, cc, date: ago(minutesAgo), subject, body, snippet: body.replace(/\s+/g, " ").slice(0, 120),
    })) });
  };
  const addr = (handle) => `${person(handle).name} <${person(handle).email}>`;
  const me = addr("alex");
  thread("Northwind expansion — next steps", ["INBOX", "UNREAD", "IMPORTANT"], [
    ["Dana Whitfield <dana.whitfield@northwind-logistics.example>", [me, addr("mateo")], 60 * 9, "Hi Alex, Mateo,\n\nThanks again for the great pilot. Our board approved budget for expanding to 40 robots across Reno, Sparks and Stockton, contingent on the multi-site dashboard being live by end of Q1 and SSO support.\n\nCould we find 45 minutes next Tuesday or Wednesday morning with your engineering lead?\n\nBest,\nDana Whitfield\nVP Operations, Northwind Logistics"],
  ]);
  thread("Re: CEO quote for Fleet 2.0 press release", ["INBOX", "UNREAD"], [
    [addr("olivia"), [me], 60 * 3, `Hi Alex — the PR agency needs your quote by ${W(2)} EOD. Draft below, feel free to rewrite:\n\n\"Fleet 2.0 is the first warehouse robot that learns your building in an afternoon. Our customers told us onboarding was the bottleneck; we fixed it.\"\n\nThanks!\nOlivia`],
  ]);
  thread("Q4 forecast review — please update commits", ["INBOX"], [
    [addr("sam"), [addr("mateo"), addr("liam"), me], 60 * 6, "Team,\n\nQ3 closed at $3.2M bookings (108% of plan). Q4 forecast review is Monday 10am. Please update your commits by Friday.\n\nSam"],
  ]);
  thread("Blue Harbor Foods escalation summary", ["INBOX", "IMPORTANT"], [
    [addr("harper"), [me, addr("priya")], 60 * 5, `Alex, Priya — quick summary: 2 robots stuck charging at Blue Harbor (rc2 BMS bug). Kenji recovered one on site; OTA to rc3 scheduled tonight. Customer is calm but wants a call this week. I put 30 min on your calendar ${W(3)} 3pm.\n\nHarper`],
    [addr("priya"), [addr("harper"), me], 60 * 4, "Thanks Harper. Let's also offer them early access to rc4 once it passes go/no-go."],
  ]);
  thread("Your invoice from CloudRack Hosting", ["INBOX", "CATEGORY_UPDATES"], [
    ["CloudRack Billing <billing@cloudrack.example>", [me], 60 * 30, "Your invoice for September is $18,240.55 and will be charged on the 15th. View invoice in your billing portal."],
  ]);
  thread("Offer accepted: Field Ops Lead", ["INBOX"], [
    [addr("camila"), [me, addr("kenji")], 60 * 26, `Great news — Riley Hart accepted our offer for Field Ops Lead! Start date ${D(20)}. I'll set up onboarding.`],
  ]);
  thread("Robotics Summit — speaker confirmation", ["INBOX", "UNREAD"], [
    ["Events Team <speakers@robotics-summit.example>", [me], 60 * 40, `Hi Alex, please confirm your keynote slot on ${D(28)} at 10:30 AM and send a headshot and 80-word bio by ${D(5)}.`],
  ]);
  thread("Board deck draft", ["SENT"], [
    [me, [addr("sam")], 60 * 50, "Sam — first pass of the board deck attached in Drive. Can you check the cash runway slide?"],
  ]);
  return { threads, drafts: [], sent: [] };
}

function seed() {
  return { slack: seedSlack(), notion: seedNotion(), linear: seedLinear(), calendar: seedCalendar(), gmail: seedGmail() };
}
let state = seed();
/**
 * Seed data is relative to today. A world can resume from a snapshot (Freestyle) or run past midnight, so untouched
 * data is re-seeded for the new day; once a demo has written anything, its data is kept as is.
 */
const dayKey = () => Object.values(localToday()).join("-");
let seededDay = dayKey();
let touched = false;
function refreshSeed() {
  if (touched || dayKey() === seededDay) return;
  state = seed();
  seededDay = dayKey();
  log("re-seeded for a new day");
}
function reset() { state = seed(); seededDay = dayKey(); touched = false; }

// ── Tool helpers ────────────────────────────────────────────────────────────────────────────────────────

class ToolError extends Error {}
const str = (args, key, required = true) => {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolError(`Missing required argument "${key}".`);
    return undefined;
  }
  // Models often send ids and timestamps as numbers; accept them like a lenient real API would.
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string.`);
  return value;
};
const num = (args, key, fallback) => {
  const value = args?.[key];
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ToolError(`"${key}" must be a number.`);
  return parsed;
};
const list = (args, key) => {
  const value = args?.[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter(Boolean);
  throw new ToolError(`"${key}" must be a list of strings.`);
};
const matches = (haystack, query) => {
  if (!query) return true;
  const text = haystack.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
};
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const S = (description) => ({ type: "string", description });
const N = (description) => ({ type: "number", description });
const A = (description) => ({ type: "array", items: { type: "string" }, description });
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// ── Slack ───────────────────────────────────────────────────────────────────────────────────────────────

function slackChannel(value) {
  const needle = String(value ?? "").trim().replace(/^#/, "");
  const channel = state.slack.channels.find((entry) => entry.id === needle || entry.name === needle);
  if (channel) return channel;
  const dm = state.slack.dms.find((entry) => entry.id === needle);
  if (dm) return { id: dm.id, name: `dm-${PEOPLE.find((p) => p.id === dm.user)?.handle}`, is_im: true, members: [ME.id, dm.user] };
  const target = findPerson(needle);
  if (target) {
    let found = state.slack.dms.find((entry) => entry.user === target.id);
    if (!found) { found = { id: slackId("D", target.handle), user: target.id }; state.slack.dms.push(found); }
    return { id: found.id, name: `dm-${target.handle}`, is_im: true, members: [ME.id, target.id] };
  }
  throw new ToolError(`Channel "${value}" not found. Use slack_list_channels to see channels.`);
}
const userName = (id) => PEOPLE.find((entry) => entry.id === id)?.name ?? id;
function slackMessageView(message) {
  const channel = state.slack.channels.find((entry) => entry.id === message.channel);
  const replies = message.thread_ts ? undefined : state.slack.messages.filter((entry) => entry.thread_ts === message.ts);
  return {
    channel: channel ? `#${channel.name}` : message.channel, channel_id: message.channel, ts: message.ts, user: userName(message.user), text: message.text,
    ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
    ...(replies && replies.length ? { reply_count: replies.length, latest_reply: replies.at(-1).ts } : {}),
    ...(message.reactions.length ? { reactions: message.reactions.map((reaction) => ({ name: reaction.name, count: reaction.users.length })) } : {}),
    permalink: `https://acme-robotics.slack.com/archives/${message.channel}/p${message.ts.replace(".", "")}`,
  };
}
const byTsDesc = (a, b) => Number(b.ts) - Number(a.ts);
/** Matches "1791055334.000025", the same number, or a permalink-style "p1791055334000025". */
const sameTs = (ts, value) => {
  const wanted = String(value).trim().replace(/^p(\d{10})(\d{6})$/, "$1.$2");
  return ts === wanted || Math.abs(Number(ts) - Number(wanted)) < 0.0000005;
};
function slackMessage(channelValue, ts) {
  const channel = channelValue ? slackChannel(channelValue) : null;
  const message = state.slack.messages.find((m) => (!channel || m.channel === channel.id) && sameTs(m.ts, ts));
  if (!message) throw new ToolError(`No message with ts ${ts}${channel ? ` in ${channel.name}` : ""}. Use the ts value returned by slack_read_channel or slack_search_messages.`);
  return message;
}

const slackTools = [
  { name: "slack_list_channels", title: "List channels", description: "List public channels in the Acme Robotics Slack workspace with purpose and member count.", annotations: read,
    inputSchema: schema({ query: S("Optional filter on channel name or purpose") }),
    run: (args) => ({ channels: state.slack.channels.filter((c) => matches(`${c.name} ${c.purpose}`, str(args, "query", false))).map((c) => ({ id: c.id, name: `#${c.name}`, purpose: c.purpose, member_count: c.members.length })) }) },
  { name: "slack_search_messages", title: "Search messages", description: "Search messages across channels and DMs. Supports words plus in:#channel and from:@person filters.", annotations: read,
    inputSchema: schema({ query: S("Search text, e.g. \"rc4 in:#eng-fleet from:@sofia\""), limit: N("Maximum results (default 20)") }, ["query"]),
    run: (args) => {
      let query = str(args, "query");
      const inMatch = /\bin:#?([\w-]+)/.exec(query); const fromMatch = /\bfrom:@?([\w.@-]+)/.exec(query);
      query = query.replace(/\bin:#?[\w-]+/, "").replace(/\bfrom:@?[\w.@-]+/, "").trim();
      const channel = inMatch ? slackChannel(inMatch[1]) : null; const from = fromMatch ? findPerson(fromMatch[1]) : null;
      const results = state.slack.messages.filter((m) => (!channel || m.channel === channel.id) && (!from || m.user === from.id) && matches(`${m.text} ${userName(m.user)}`, query)).sort(byTsDesc);
      return { total: results.length, messages: results.slice(0, num(args, "limit", 20)).map(slackMessageView) };
    } },
  { name: "slack_read_channel", title: "Read channel history", description: "Read the most recent top-level messages in a channel or DM (newest first), with thread reply counts.", annotations: read,
    inputSchema: schema({ channel: S("Channel name (e.g. #launch-fleet-2), channel ID, or a person for a DM"), limit: N("Number of messages (default 20)") }, ["channel"]),
    run: (args) => { const channel = slackChannel(str(args, "channel")); return { channel: channel.is_im ? channel.name : `#${channel.name}`, channel_id: channel.id,
      messages: state.slack.messages.filter((m) => m.channel === channel.id && !m.thread_ts).sort(byTsDesc).slice(0, num(args, "limit", 20)).map(slackMessageView) }; } },
  { name: "slack_read_thread", title: "Read thread", description: "Read a message and all of its thread replies in order.", annotations: read,
    inputSchema: schema({ channel: S("Channel name or ID"), thread_ts: S("ts of the parent message, e.g. \"1791055334.000025\"") }, ["thread_ts"]),
    run: (args) => { const found = slackMessage(str(args, "channel", false), str(args, "ts", false) ?? str(args, "thread_ts"));
      const parent = found.thread_ts ? slackMessage(found.channel, found.thread_ts) : found;
      return { parent: slackMessageView(parent), replies: state.slack.messages.filter((m) => m.thread_ts === parent.ts).sort((a, b) => Number(a.ts) - Number(b.ts)).map(slackMessageView) }; } },
  { name: "slack_send_message", title: "Send message", description: "Post a message as Alex Chen to a channel or DM, optionally as a thread reply.", annotations: write,
    inputSchema: schema({ channel: S("Channel name, channel ID, or a person for a DM"), text: S("Message text (Slack mrkdwn)"), thread_ts: S("Reply in this thread") }, ["channel", "text"]),
    run: (args) => { const channel = slackChannel(str(args, "channel")); const threadValue = str(args, "thread_ts", false);
      // Replying to a reply lands in its thread, as in Slack.
      const parent = threadValue ? slackMessage(channel.id, threadValue) : null; const threadTs = parent ? parent.thread_ts ?? parent.ts : null;
      const message = { channel: channel.id, ts: slackTs(0), user: ME.id, text: str(args, "text"), reactions: [], ...(threadTs ? { thread_ts: threadTs } : {}) };
      state.slack.messages.push(message); return { ok: true, message: slackMessageView(message) }; } },
  { name: "slack_add_reaction", title: "Add reaction", description: "Add an emoji reaction (as Alex Chen) to a message.", annotations: write,
    inputSchema: schema({ channel: S("Channel name or ID"), ts: S("Message ts"), emoji: S("Emoji name without colons, e.g. white_check_mark") }, ["channel", "ts", "emoji"]),
    run: (args) => { const message = slackMessage(str(args, "channel"), str(args, "ts")); const name = str(args, "emoji").replace(/:/g, "");
      let reaction = message.reactions.find((r) => r.name === name); if (!reaction) { reaction = { name, users: [] }; message.reactions.push(reaction); }
      if (!reaction.users.includes(ME.id)) reaction.users.push(ME.id); return { ok: true, message: slackMessageView(message) }; } },
  { name: "slack_list_users", title: "List people", description: "List people in the workspace with titles and emails.", annotations: read,
    inputSchema: schema({ query: S("Optional name, title or email filter") }),
    run: (args) => ({ users: PEOPLE.filter((p) => matches(`${p.name} ${p.title} ${p.email} ${p.handle}`, str(args, "query", false))).map((p) => ({ id: p.id, name: p.name, handle: `@${p.handle}`, title: p.title, email: p.email })) }) },
];

// ── Notion ──────────────────────────────────────────────────────────────────────────────────────────────

function notionFind(id) {
  const clean = String(id ?? "").replace(/-/g, "").trim();
  return state.notion.pages.find((p) => p.id === clean) ?? state.notion.databases.find((d) => d.id === clean)
    ?? state.notion.pages.find((p) => p.title.toLowerCase() === String(id).toLowerCase()) ?? state.notion.databases.find((d) => d.title.toLowerCase() === String(id).toLowerCase());
}
const notionUrl = (entry) => `https://www.notion.so/acme-robotics/${entry.title.replace(/[^A-Za-z0-9]+/g, "-")}-${entry.id}`;
const notionSummary = (entry) => ({ id: entry.id, object: entry.object, title: entry.title, url: notionUrl(entry), parent: entry.parent, last_edited_time: entry.last_edited_time,
  ...(entry.object === "page" && Object.keys(entry.properties).length ? { properties: entry.properties } : {}) });
const notionTools = [
  { name: "notion_search", title: "Search", description: "Search pages and databases in the Acme Robotics Notion workspace by title and content.", annotations: read,
    inputSchema: schema({ query: S("Search text"), filter: { type: "string", enum: ["page", "database"], description: "Only return pages or databases" } }, ["query"]),
    run: (args) => { const query = str(args, "query"); const filter = str(args, "filter", false);
      const all = [...state.notion.pages, ...state.notion.databases].filter((e) => (!filter || e.object === filter) && matches(`${e.title} ${e.markdown ?? ""} ${JSON.stringify(e.properties ?? {})}`, query));
      return { results: all.sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time)).slice(0, 20).map(notionSummary) }; } },
  { name: "notion_fetch", title: "Fetch page or database", description: "Read a page's full content as Markdown (with properties, child pages and comments), or a database's schema and rows.", annotations: read,
    inputSchema: schema({ id: S("Page or database ID (or exact title)") }, ["id"]),
    run: (args) => { const entry = notionFind(str(args, "id")); if (!entry) throw new ToolError("Page or database not found.");
      if (entry.object === "database") return { ...notionSummary(entry), schema: entry.schema, rows: state.notion.pages.filter((p) => p.parent.id === entry.id).map(notionSummary) };
      return { ...notionSummary(entry), created_by: entry.created_by, last_edited_by: entry.last_edited_by, content: entry.markdown,
        children: state.notion.pages.filter((p) => p.parent.id === entry.id).map((p) => ({ id: p.id, title: p.title })),
        child_databases: state.notion.databases.filter((d) => d.parent.id === entry.id).map((d) => ({ id: d.id, title: d.title })), comments: entry.comments }; } },
  { name: "notion_query_database", title: "Query database", description: "List rows of a database, optionally filtered by property values and text.", annotations: read,
    inputSchema: schema({ database_id: S("Database ID or title, e.g. Product roadmap"), filter: { type: "object", description: "Property equality filters, e.g. {\"Status\": \"In progress\"}", additionalProperties: { type: "string" } }, query: S("Optional text filter") }, ["database_id"]),
    run: (args) => { const database = notionFind(str(args, "database_id")); if (!database || database.object !== "database") throw new ToolError("Database not found.");
      const filter = args.filter && typeof args.filter === "object" ? args.filter : {};
      return { database: database.title, rows: state.notion.pages.filter((p) => p.parent.id === database.id
        && Object.entries(filter).every(([key, value]) => String(Array.isArray(p.properties[key]) ? p.properties[key].join(", ") : p.properties[key] ?? "").toLowerCase().includes(String(value).toLowerCase()))
        && matches(`${p.title} ${JSON.stringify(p.properties)}`, str(args, "query", false))).map(notionSummary) }; } },
  { name: "notion_create_page", title: "Create page", description: "Create a page (Markdown content) under a parent page, or a new row in a database with properties.", annotations: write,
    inputSchema: schema({ parent_id: S("Parent page or database ID (or exact title)"), title: S("Page title"), content: S("Markdown body"), properties: { type: "object", description: "Database row properties", additionalProperties: true }, icon: S("Emoji icon") }, ["parent_id", "title"]),
    run: (args) => { const parent = notionFind(str(args, "parent_id")); if (!parent) throw new ToolError("Parent not found.");
      const entry = { id: `${shortId()}${shortId()}`.slice(0, 32), object: "page", title: str(args, "title"), icon: str(args, "icon", false), parent: { type: parent.object === "database" ? "database" : "page", id: parent.id },
        markdown: str(args, "content", false) ?? "", created_by: ME.name, created_time: new Date().toISOString(), last_edited_by: ME.name, last_edited_time: new Date().toISOString(),
        properties: args.properties && typeof args.properties === "object" ? args.properties : {}, comments: [] };
      state.notion.pages.push(entry); return { ok: true, page: notionSummary(entry) }; } },
  { name: "notion_update_page", title: "Update page", description: "Update a page's title or properties, replace its content, or append Markdown to it.", annotations: write,
    inputSchema: schema({ page_id: S("Page ID (or exact title)"), title: S("New title"), content: S("Replace the whole body with this Markdown"), append: S("Markdown to append at the end"), properties: { type: "object", additionalProperties: true, description: "Properties to set" } }, ["page_id"]),
    run: (args) => { const entry = notionFind(str(args, "page_id")); if (!entry || entry.object !== "page") throw new ToolError("Page not found.");
      const title = str(args, "title", false); const content = str(args, "content", false); const append = str(args, "append", false);
      if (title) entry.title = title; if (content !== undefined) entry.markdown = content; if (append) entry.markdown = `${entry.markdown}\n\n${append}`.trim();
      if (args.properties && typeof args.properties === "object") Object.assign(entry.properties, args.properties);
      entry.last_edited_by = ME.name; entry.last_edited_time = new Date().toISOString(); return { ok: true, page: notionSummary(entry), content: entry.markdown }; } },
  { name: "notion_add_comment", title: "Add comment", description: "Add a comment (as Alex Chen) to a page.", annotations: write,
    inputSchema: schema({ page_id: S("Page ID (or exact title)"), text: S("Comment text") }, ["page_id", "text"]),
    run: (args) => { const entry = notionFind(str(args, "page_id")); if (!entry || entry.object !== "page") throw new ToolError("Page not found.");
      const comment = { id: randomUUID(), author: ME.name, text: str(args, "text"), created_time: new Date().toISOString() }; entry.comments.push(comment); return { ok: true, comment }; } },
];

// ── Linear ──────────────────────────────────────────────────────────────────────────────────────────────

const PRIORITY = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
function linearIssue(id) {
  const needle = String(id ?? "").trim().toUpperCase();
  const issue = state.linear.issues.find((entry) => entry.identifier === needle || entry.id.toUpperCase() === needle);
  if (!issue) throw new ToolError(`Issue ${id} not found.`);
  return issue;
}
function linearTeam(value) {
  const needle = String(value ?? "").trim().toLowerCase();
  const team = state.linear.teams.find((entry) => entry.key.toLowerCase() === needle || entry.name.toLowerCase() === needle || entry.id === needle);
  if (!team) throw new ToolError(`Team "${value}" not found. Teams: ${state.linear.teams.map((t) => t.key).join(", ")}.`);
  return team;
}
function linearState(value) {
  const found = state.linear.states.find((entry) => entry.toLowerCase() === String(value).trim().toLowerCase());
  if (!found) throw new ToolError(`Unknown state "${value}". States: ${state.linear.states.join(", ")}.`);
  return found;
}
function linearAssignee(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "" || String(value).toLowerCase() === "none") return null;
  if (String(value).toLowerCase() === "me") return ME.name;
  const found = findPerson(String(value)); if (!found) throw new ToolError(`No teammate matches "${value}".`); return found.name;
}
const linearView = (issue, full = false) => ({ id: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state, priority: PRIORITY[issue.priority] ?? issue.priority,
  assignee: issue.assignee, team: issue.team, project: issue.project, labels: issue.labels, due_date: issue.due_date, url: `https://linear.app/acme-robotics/issue/${issue.identifier.toLowerCase()}`,
  updated_at: issue.updated_at, ...(full ? { description: issue.description, creator: issue.creator, created_at: issue.created_at, comments: issue.comments } : {}) });
const priorityInput = (value) => {
  if (value === undefined || value === null) return undefined;
  const byName = Object.entries(PRIORITY).find(([, name]) => name.toLowerCase() === String(value).toLowerCase());
  const parsed = byName ? Number(byName[0]) : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) throw new ToolError("priority must be 0-4 or Urgent/High/Medium/Low."); return parsed;
};
const linearTools = [
  { name: "linear_list_teams", title: "List teams", description: "List Linear teams, workflow states and projects.", annotations: read, inputSchema: schema({}),
    run: () => ({ teams: state.linear.teams, states: state.linear.states, projects: state.linear.projects }) },
  { name: "linear_list_issues", title: "List issues", description: "List issues filtered by team, state, assignee (\"me\" for Alex), project, label, or text; newest updated first.", annotations: read,
    inputSchema: schema({ team: S("Team key or name (ENG, LAUNCH, SUP)"), state: S("Workflow state"), assignee: S("Person name/handle or \"me\""), project: S("Project name"), label: S("Label"), query: S("Text in title or description"), limit: N("Maximum results (default 25)") }),
    run: (args) => { const team = args.team ? linearTeam(args.team).name : null; const wanted = args.state ? linearState(args.state) : null; const assignee = linearAssignee(args.assignee);
      const project = str(args, "project", false); const label = str(args, "label", false);
      const issues = state.linear.issues.filter((i) => (!team || i.team === team) && (!wanted || i.state === wanted) && (assignee === undefined || i.assignee === assignee)
        && (!project || (i.project ?? "").toLowerCase() === project.toLowerCase()) && (!label || i.labels.includes(label)) && matches(`${i.identifier} ${i.title} ${i.description}`, str(args, "query", false)))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { total: issues.length, issues: issues.slice(0, num(args, "limit", 25)).map((i) => linearView(i)) }; } },
  { name: "linear_get_issue", title: "Get issue", description: "Get an issue with its description and comments.", annotations: read,
    inputSchema: schema({ id: S("Issue identifier, e.g. ENG-342") }, ["id"]), run: (args) => linearView(linearIssue(str(args, "id")), true) },
  { name: "linear_create_issue", title: "Create issue", description: "Create an issue in a team.", annotations: write,
    inputSchema: schema({ team: S("Team key or name"), title: S("Title"), description: S("Markdown description"), priority: S("Urgent, High, Medium, Low or 0-4"), assignee: S("Person or \"me\""), state: S("Workflow state (default Todo)"), labels: A("Labels"), project: S("Project name"), due_date: S("YYYY-MM-DD") }, ["team", "title"]),
    run: (args) => { const team = linearTeam(str(args, "team")); state.linear.counters[team.key] = (state.linear.counters[team.key] ?? 0) + 1;
      const now = new Date().toISOString();
      const issue = { id: randomUUID(), identifier: `${team.key}-${state.linear.counters[team.key]}`, team: team.name, title: str(args, "title"), description: str(args, "description", false) ?? "",
        state: args.state ? linearState(args.state) : "Todo", priority: priorityInput(args.priority) ?? 0, assignee: linearAssignee(args.assignee) ?? null, labels: list(args, "labels"),
        project: str(args, "project", false) ?? null, due_date: str(args, "due_date", false) ?? null, creator: ME.name, created_at: now, updated_at: now, comments: [] };
      state.linear.issues.push(issue); return { ok: true, issue: linearView(issue, true) }; } },
  { name: "linear_update_issue", title: "Update issue", description: "Change an issue's state, assignee, priority, title, description, labels or due date.", annotations: write,
    inputSchema: schema({ id: S("Issue identifier"), state: S("Workflow state"), assignee: S("Person, \"me\" or \"none\""), priority: S("Urgent, High, Medium, Low or 0-4"), title: S("Title"), description: S("Description"), labels: A("Replace labels"), due_date: S("YYYY-MM-DD") }, ["id"]),
    run: (args) => { const issue = linearIssue(str(args, "id"));
      if (args.state) issue.state = linearState(args.state); const assignee = linearAssignee(args.assignee); if (assignee !== undefined) issue.assignee = assignee;
      const priority = priorityInput(args.priority); if (priority !== undefined) issue.priority = priority;
      for (const key of ["title", "description", "due_date"]) { const value = str(args, key, false); if (value !== undefined) issue[key] = value; }
      if (args.labels !== undefined) issue.labels = list(args, "labels");
      issue.updated_at = new Date().toISOString(); return { ok: true, issue: linearView(issue, true) }; } },
  { name: "linear_add_comment", title: "Comment on issue", description: "Add a comment (as Alex Chen) to an issue.", annotations: write,
    inputSchema: schema({ id: S("Issue identifier"), body: S("Markdown comment") }, ["id", "body"]),
    run: (args) => { const issue = linearIssue(str(args, "id")); const comment = { id: randomUUID(), author: ME.name, body: str(args, "body"), created_at: new Date().toISOString() };
      issue.comments.push(comment); issue.updated_at = comment.created_at; return { ok: true, comment, issue: issue.identifier }; } },
];

// ── Google Calendar ─────────────────────────────────────────────────────────────────────────────────────

const parseTime = (value, key) => { const time = Date.parse(value); if (!Number.isFinite(time)) throw new ToolError(`"${key}" must be an ISO date-time.`); return time; };
const eventView = (event) => ({ ...event, html_link: `https://calendar.google.com/calendar/event?eid=${event.id}` });
function calendarEvent(id) { const event = state.calendar.events.find((entry) => entry.id === id); if (!event) throw new ToolError(`Event ${id} not found.`); return event; }
const attendeesInput = (values) => values.map((value) => { const found = findPerson(value);
  return found ? { email: found.email, name: found.name, response_status: "needsAction" } : { email: value, name: value, response_status: "needsAction" }; });
const calendarTools = [
  { name: "gcal_list_calendars", title: "List calendars", description: "List calendars Alex can see.", annotations: read, inputSchema: schema({}),
    run: () => ({ time_zone: TIME_ZONE, calendars: state.calendar.calendars }) },
  { name: "gcal_list_events", title: "List events", description: "List events between two times (default: today through the next 7 days), optionally filtered by text or attendee.", annotations: read,
    inputSchema: schema({ time_min: S("ISO start (default: start of today)"), time_max: S("ISO end (default: 7 days later)"), query: S("Text in title, description or location"), attendee: S("Person or email"), calendar_id: S("Calendar ID (default: all)") }),
    run: (args) => { const min = args.time_min ? parseTime(args.time_min, "time_min") : Date.parse(at(0, 0)); const max = args.time_max ? parseTime(args.time_max, "time_max") : min + 7 * 86400000;
      const attendee = args.attendee ? (findPerson(args.attendee)?.email ?? String(args.attendee)) : null; const calendarId = str(args, "calendar_id", false);
      const events = state.calendar.events.filter((e) => e.status !== "cancelled" && Date.parse(e.end) > min && Date.parse(e.start) < max && (!calendarId || e.calendar_id === calendarId)
        && (!attendee || e.attendees.some((a) => a.email === attendee)) && matches(`${e.summary} ${e.description} ${e.location}`, str(args, "query", false))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { time_zone: TIME_ZONE, now: isoWithOffset(new Date()), events: events.map(eventView) }; } },
  { name: "gcal_get_event", title: "Get event", description: "Get one event.", annotations: read, inputSchema: schema({ event_id: S("Event ID") }, ["event_id"]),
    run: (args) => eventView(calendarEvent(str(args, "event_id"))) },
  { name: "gcal_create_event", title: "Create event", description: "Create an event on Alex's calendar and invite attendees (invitations stay in this demo).", annotations: write,
    inputSchema: schema({ summary: S("Title"), start: S("ISO start"), end: S("ISO end"), attendees: A("People or emails"), description: S("Description"), location: S("Location or \"Google Meet\"") }, ["summary", "start", "end"]),
    run: (args) => { const start = parseTime(str(args, "start"), "start"); const end = parseTime(str(args, "end"), "end"); if (end <= start) throw new ToolError("end must be after start.");
      const event = { id: shortId() + shortId(), calendar_id: ME.email, summary: str(args, "summary"), start: isoWithOffset(new Date(start)), end: isoWithOffset(new Date(end)),
        attendees: [{ email: ME.email, name: ME.name, response_status: "accepted" }, ...attendeesInput(list(args, "attendees"))], organizer: ME.email,
        location: str(args, "location", false) ?? "Google Meet", description: str(args, "description", false) ?? "", recurrence: null, status: "confirmed", created: new Date().toISOString(), updated: new Date().toISOString() };
      state.calendar.events.push(event); return { ok: true, event: eventView(event) }; } },
  { name: "gcal_update_event", title: "Update event", description: "Move or edit an event; adds or replaces attendees.", annotations: write,
    inputSchema: schema({ event_id: S("Event ID"), summary: S("Title"), start: S("ISO start"), end: S("ISO end"), attendees: A("Replace attendees"), description: S("Description"), location: S("Location") }, ["event_id"]),
    run: (args) => { const event = calendarEvent(str(args, "event_id"));
      if (args.start) event.start = isoWithOffset(new Date(parseTime(args.start, "start"))); if (args.end) event.end = isoWithOffset(new Date(parseTime(args.end, "end")));
      if (Date.parse(event.end) <= Date.parse(event.start)) throw new ToolError("end must be after start.");
      for (const key of ["summary", "description", "location"]) { const value = str(args, key, false); if (value !== undefined) event[key] = value; }
      if (args.attendees !== undefined) event.attendees = [{ email: ME.email, name: ME.name, response_status: "accepted" }, ...attendeesInput(list(args, "attendees"))];
      event.updated = new Date().toISOString(); return { ok: true, event: eventView(event) }; } },
  { name: "gcal_delete_event", title: "Delete event", description: "Cancel an event.", annotations: destructive, inputSchema: schema({ event_id: S("Event ID") }, ["event_id"]),
    run: (args) => { const event = calendarEvent(str(args, "event_id")); event.status = "cancelled"; event.updated = new Date().toISOString(); return { ok: true, event_id: event.id, status: event.status }; } },
  { name: "gcal_find_free_time", title: "Find free time", description: "Find open slots when everyone is free (working hours 9:00-17:00 in the demo time zone).", annotations: read,
    inputSchema: schema({ attendees: A("People or emails (Alex is always included)"), duration_minutes: N("Meeting length (default 30)"), days: N("How many days ahead to search (default 5)") }),
    run: (args) => { const emails = new Set([ME.email, ...list(args, "attendees").map((value) => findPerson(value)?.email ?? value)]);
      const duration = num(args, "duration_minutes", 30) * 60000; const busy = state.calendar.events.filter((e) => e.status !== "cancelled" && e.attendees.some((a) => emails.has(a.email))).map((e) => [Date.parse(e.start), Date.parse(e.end)]);
      const slots = [];
      for (let day = 0; day < num(args, "days", 5) && slots.length < 8; day += 1) {
        const weekday = new Date(at(day, 12)).getUTCDay(); if (weekday === 0 || weekday === 6) continue;
        for (let cursor = Math.max(Date.parse(at(day, 9)), Date.now()); cursor + duration <= Date.parse(at(day, 17)) && slots.length < 8; cursor += 30 * 60000) {
          const aligned = Math.ceil(cursor / (30 * 60000)) * 30 * 60000;
          if (aligned + duration <= Date.parse(at(day, 17)) && !busy.some(([s, e]) => aligned < e && aligned + duration > s)) { slots.push({ start: isoWithOffset(new Date(aligned)), end: isoWithOffset(new Date(aligned + duration)) }); cursor = aligned + duration - 30 * 60000; }
        }
      }
      return { attendees: [...emails], time_zone: TIME_ZONE, slots }; } },
];

// ── Gmail ───────────────────────────────────────────────────────────────────────────────────────────────

function gmailThread(id) { const thread = state.gmail.threads.find((entry) => entry.id === id); if (!thread) throw new ToolError(`Thread ${id} not found.`); return thread; }
const threadSummary = (thread) => { const last = thread.messages.at(-1);
  return { id: thread.id, subject: thread.subject, from: last.from, date: last.date, snippet: last.snippet, labels: thread.labels, unread: thread.labels.includes("UNREAD"), message_count: thread.messages.length }; };
function gmailQuery(thread, query) {
  if (!query) return true;
  let rest = query;
  const take = (pattern) => { const found = []; rest = rest.replace(pattern, (_, value) => { found.push(value.replace(/^"|"$/g, "").toLowerCase()); return ""; }); return found; };
  const from = take(/\bfrom:("[^"]+"|\S+)/g), to = take(/\bto:("[^"]+"|\S+)/g), subject = take(/\bsubject:("[^"]+"|\S+)/g), label = take(/\b(?:label|in):(\S+)/g), is = take(/\bis:(\S+)/g);
  const all = thread.messages.map((m) => `${m.from} ${m.to.join(" ")} ${m.cc.join(" ")} ${m.subject} ${m.body}`).join(" ");
  return from.every((v) => thread.messages.some((m) => m.from.toLowerCase().includes(v))) && to.every((v) => thread.messages.some((m) => m.to.join(" ").toLowerCase().includes(v)))
    && subject.every((v) => thread.subject.toLowerCase().includes(v)) && label.every((v) => thread.labels.map((l) => l.toLowerCase()).includes(v))
    && is.every((v) => (v === "unread" ? thread.labels.includes("UNREAD") : v === "read" ? !thread.labels.includes("UNREAD") : v === "important" ? thread.labels.includes("IMPORTANT") : v === "starred" ? thread.labels.includes("STARRED") : true))
    && matches(all, rest.trim());
}
const recipients = (args, key) => list(args, key).map((value) => { const found = findPerson(value); return found ? `${found.name} <${found.email}>` : value; });
const gmailTools = [
  { name: "gmail_search_threads", title: "Search email", description: "Search Alex's mailbox with Gmail syntax: words, from:, to:, subject:, label:, is:unread, is:important. Newest first.", annotations: read,
    inputSchema: schema({ query: S("Gmail search query (default: in:inbox)"), limit: N("Maximum threads (default 20)") }),
    run: (args) => ({ threads: state.gmail.threads.filter((t) => gmailQuery(t, str(args, "query", false) ?? "in:inbox")).sort((a, b) => b.messages.at(-1).date.localeCompare(a.messages.at(-1).date)).slice(0, num(args, "limit", 20)).map(threadSummary) }) },
  { name: "gmail_read_thread", title: "Read thread", description: "Read every message in a thread and mark it read.", annotations: write,
    inputSchema: schema({ thread_id: S("Thread ID") }, ["thread_id"]),
    run: (args) => { const thread = gmailThread(str(args, "thread_id")); thread.labels = thread.labels.filter((l) => l !== "UNREAD"); return { ...threadSummary(thread), messages: thread.messages }; } },
  { name: "gmail_create_draft", title: "Create draft", description: "Create a draft (optionally as a reply in a thread). Drafts stay in Alex's Drafts until sent.", annotations: write,
    inputSchema: schema({ to: A("Recipients (people or emails)"), subject: S("Subject"), body: S("Plain-text body"), cc: A("Cc"), thread_id: S("Reply in this thread") }, ["to", "body"]),
    run: (args) => { const threadId = str(args, "thread_id", false); const thread = threadId ? gmailThread(threadId) : null;
      const draft = { id: `r${shortId()}`, thread_id: thread?.id ?? null, to: recipients(args, "to"), cc: recipients(args, "cc"), subject: str(args, "subject", false) ?? (thread ? `Re: ${thread.subject.replace(/^Re: /, "")}` : "(no subject)"), body: str(args, "body"), updated: new Date().toISOString() };
      state.gmail.drafts.push(draft); return { ok: true, draft }; } },
  { name: "gmail_list_drafts", title: "List drafts", description: "List Alex's drafts.", annotations: read, inputSchema: schema({}), run: () => ({ drafts: state.gmail.drafts }) },
  { name: "gmail_send", title: "Send email", description: "Send an email or a saved draft as Alex. This is a demo mailbox: mail is added to Sent and never leaves.", annotations: { ...write, openWorldHint: false },
    inputSchema: schema({ draft_id: S("Send this draft"), to: A("Recipients"), subject: S("Subject"), body: S("Body"), cc: A("Cc"), thread_id: S("Reply in this thread") }),
    run: (args) => { let draft = null; const draftId = str(args, "draft_id", false);
      if (draftId) { draft = state.gmail.drafts.find((d) => d.id === draftId); if (!draft) throw new ToolError(`Draft ${draftId} not found.`); state.gmail.drafts = state.gmail.drafts.filter((d) => d !== draft); }
      const to = draft?.to ?? recipients(args, "to"); if (!to.length) throw new ToolError("Give recipients in \"to\" or a draft_id.");
      const threadId = draft?.thread_id ?? str(args, "thread_id", false) ?? null; const existing = threadId ? gmailThread(threadId) : null;
      const subject = draft?.subject ?? str(args, "subject", false) ?? (existing ? `Re: ${existing.subject.replace(/^Re: /, "")}` : "(no subject)");
      const message = { id: shortId() + shortId().slice(0, 4), from: `${ME.name} <${ME.email}>`, to, cc: draft?.cc ?? recipients(args, "cc"), date: new Date().toISOString(), subject, body: draft?.body ?? str(args, "body"), snippet: "" };
      message.snippet = message.body.replace(/\s+/g, " ").slice(0, 120);
      let thread = existing;
      if (thread) { thread.messages.push(message); if (!thread.labels.includes("SENT")) thread.labels.push("SENT"); }
      else { thread = { id: shortId() + shortId().slice(0, 4), subject, labels: ["SENT"], messages: [message] }; state.gmail.threads.push(thread); }
      state.gmail.sent.push({ thread_id: thread.id, message_id: message.id });
      return { ok: true, thread_id: thread.id, message }; } },
  { name: "gmail_modify_labels", title: "Label or archive", description: "Add or remove labels on a thread (e.g. remove INBOX to archive, add STARRED, remove UNREAD).", annotations: write,
    inputSchema: schema({ thread_id: S("Thread ID"), add: A("Labels to add"), remove: A("Labels to remove") }, ["thread_id"]),
    run: (args) => { const thread = gmailThread(str(args, "thread_id")); const remove = new Set(list(args, "remove").map((l) => l.toUpperCase()));
      thread.labels = [...new Set([...thread.labels.filter((l) => !remove.has(l)), ...list(args, "add").map((l) => l.toUpperCase())])]; return { ok: true, thread: threadSummary(thread) }; } },
];

// ── MCP plumbing ────────────────────────────────────────────────────────────────────────────────────────

const SERVICES = {
  slack: { name: "slack", title: "Slack", version: "2.3.1", instructions: "Acme Robotics Slack workspace. You act as Alex Chen. Use slack_search_messages or slack_read_channel before replying in a thread.", tools: slackTools },
  notion: { name: "notion", title: "Notion", version: "1.9.0", instructions: "Acme Robotics Notion workspace. Search first, then fetch pages by ID.", tools: notionTools },
  linear: { name: "linear", title: "Linear", version: "1.4.2", instructions: "Acme Robotics Linear workspace (teams ENG, LAUNCH, SUP). \"me\" is Alex Chen.", tools: linearTools },
  "google-calendar": { name: "google-calendar", title: "Google Calendar", version: "1.2.0", instructions: `Alex Chen's Google Calendar. Times are in ${TIME_ZONE} unless an offset is given.`, tools: calendarTools },
  gmail: { name: "gmail", title: "Gmail", version: "1.6.0", instructions: "Alex Chen's Gmail (alex@acme.test). Sending only reaches this demo mailbox.", tools: gmailTools },
};
const toolList = (service) => service.tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function handleRpc(service, message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message?.id, -32600, "Invalid Request");
  const isNotification = message.id === undefined || message.id === null;
  if (isNotification) return null;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return rpcResult(message.id, { protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: service.name, title: service.title, version: service.version }, instructions: service.instructions });
    }
    case "ping": return rpcResult(message.id, {});
    case "tools/list": return rpcResult(message.id, { tools: toolList(service) });
    case "tools/call": {
      const tool = service.tools.find((entry) => entry.name === params.name);
      if (!tool) return rpcError(message.id, -32602, `Unknown tool: ${params.name}`);
      try {
        const value = tool.run(params.arguments && typeof params.arguments === "object" ? params.arguments : {});
        if (!tool.annotations.readOnlyHint) touched = true;
        log(`${service.name} ${tool.name} ok`);
        return rpcResult(message.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false });
      } catch (error) {
        if (!(error instanceof ToolError)) console.error(error);
        log(`${service.name} ${tool.name} error: ${error.message}`);
        return rpcResult(message.id, { content: [{ type: "text", text: error instanceof ToolError ? error.message : "Internal error" }], isError: true });
      }
    }
    case "resources/list": return rpcResult(message.id, { resources: [] });
    case "prompts/list": return rpcResult(message.id, { prompts: [] });
    default: return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function log(line) { console.log(`[demo-mcp] ${new Date().toISOString()} ${line}`); }
function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...headers });
  res.end(text);
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error("Body too large"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(res, 200, { ok: true, services: Object.keys(SERVICES) });
    refreshSeed();
    if (url.pathname === "/state" && req.method === "GET") return send(res, 200, state);
    if (url.pathname === "/reset" && req.method === "POST") { reset(); log("state reset"); return send(res, 200, { ok: true }); }
    const match = /^\/([a-z-]+)\/mcp\/?$/.exec(url.pathname);
    const service = match ? SERVICES[match[1]] : undefined;
    if (!service) return send(res, 404, { error: "not_found" });
    if (req.method === "GET") return send(res, 405, { error: "SSE stream not offered; use POST." }, { allow: "POST, DELETE" });
    if (req.method === "DELETE") return send(res, 200, { ok: true });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST, DELETE" });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, rpcError(null, -32700, "Parse error")); }
    const sessionHeader = { "mcp-session-id": req.headers["mcp-session-id"] || randomUUID() };
    if (Array.isArray(payload)) {
      const responses = payload.map((message) => handleRpc(service, message)).filter(Boolean);
      return responses.length ? send(res, 200, responses, sessionHeader) : send(res, 202, undefined, sessionHeader);
    }
    const response = handleRpc(service, payload);
    return response ? send(res, 200, response, sessionHeader) : send(res, 202, undefined, sessionHeader);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  }
});
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (${Object.keys(SERVICES).map((name) => `/${name}/mcp`).join(", ")})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
