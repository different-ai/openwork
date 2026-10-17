#!/usr/bin/env node
// Demo Atlassian for preview worlds: an in-memory Jira Data Center (with Jira Service Management) and Confluence
// Data Center for the fictional Acme Robotics team, plus an MCP server that mirrors the community
// `mcp-atlassian` server (sooperset/mcp-atlassian, the one enterprises self-host next to Jira and Confluence).
//
// Fidelity is the point: the REST endpoints answer in the shapes Jira/Confluence Data Center return, so the real
// `mcp-atlassian` works against them unchanged (JIRA_URL=<base>/jira, CONFLUENCE_URL=<base>/confluence, any
// personal access token). The built-in MCP endpoint offers the same tool names and argument schemas, backed by the
// same in-memory data, so a world does not need Python. Everything stays in memory; restarting restores the seed.
//
// Self-contained on purpose (no imports outside Node): worlds upload it verbatim into a Daytona sandbox.
//
//   HOST=127.0.0.1 PORT=3991 node demo-atlassian.mjs
//   GET  /health                 liveness
//   GET  /state                  current data (debugging a demo)
//   POST /reset                  restore the seed
//   POST /mcp                    MCP JSON-RPC (Streamable HTTP, JSON responses): jira_* and confluence_* tools
//   /jira/rest/api/2/...         Jira Data Center REST API v2 (+ /jira/rest/servicedeskapi/... for JSM)
//   /confluence/rest/api/...     Confluence Data Center REST API
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3991);
const TIME_ZONE = process.env.DEMO_TIME_ZONE || "America/Los_Angeles";
/** Links shown to people (browse URLs, page links); the REST API itself is served by this process. */
const JIRA_SITE = (process.env.DEMO_JIRA_URL || "https://jira.acme.test").replace(/\/$/, "");
const CONFLUENCE_SITE = (process.env.DEMO_CONFLUENCE_URL || "https://confluence.acme.test").replace(/\/$/, "");
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const JIRA_VERSION = "9.12.15";
const CONFLUENCE_VERSION = "8.5.16";

// ── Time ────────────────────────────────────────────────────────────────────────────────────────────────

const fixedNow = process.env.DEMO_NOW ? Date.parse(process.env.DEMO_NOW) : null;
if (fixedNow !== null && !Number.isFinite(fixedNow)) throw new Error("DEMO_NOW must be an ISO timestamp.");
const clockNow = () => fixedNow ?? Date.now();

function zoneOffsetMinutes(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - date.getTime()) / 60000);
}
/** Jira's timestamp format: 2026-10-16T09:12:33.000-0700. */
function jiraTime(ms) {
  const date = new Date(ms); const offset = zoneOffsetMinutes(date); const local = new Date(ms + offset * 60000);
  const abs = Math.abs(offset);
  return `${local.toISOString().slice(0, 23)}${offset >= 0 ? "+" : "-"}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}
/** Confluence's timestamp format: 2026-10-16T09:12:33.000-07:00. */
const confluenceTime = (ms) => jiraTime(ms).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
const localDate = (ms) => new Date(ms + zoneOffsetMinutes(new Date(ms)) * 60000).toISOString().slice(0, 10);
const MINUTE = 60000; const HOUR = 60 * MINUTE; const DAY = 24 * HOUR;
const ago = (ms) => clockNow() - ms;

// ── People: the same Acme Robotics team as the other demo apps. The signed-in person is Alex Chen. ─────────

const DOMAIN = "acme.test";
const PEOPLE = [
  ["alex", "Alex Chen", "CEO"], ["priya", "Priya Shah", "VP Engineering"], ["mateo", "Mateo Rivera", "VP Sales"],
  ["morgan", "Morgan Lee", "Product Designer"], ["nora", "Nora Patel", "Product Manager"], ["jamal", "Jamal Brooks", "Staff Engineer"],
  ["sofia", "Sofia Garcia", "Engineering Manager, Fleet"], ["ivy", "Ivy Nguyen", "Design Lead"], ["liam", "Liam O'Connor", "Account Executive"],
  ["olivia", "Olivia Martin", "Head of Marketing"], ["harper", "Harper Wilson", "Support Lead"], ["kenji", "Kenji Tanaka", "Field Operations"],
  ["zoe", "Zoe Kim", "Content Marketing"], ["sam", "Sam Okafor", "Finance Manager"], ["maya", "Maya Singh", "Legal Counsel"],
  ["ezra", "Ezra Cohen", "Data Engineer"], ["camila", "Camila Torres", "People Operations"], ["dev", "Devon Park", "IT Support"],
].map(([handle, displayName, title], index) => {
  const [first, ...rest] = displayName.toLowerCase().replace(/[^a-z ]/g, "").split(" ");
  const name = `${first}.${rest.join("")}`;
  return { handle, name, key: `JIRAUSER${10100 + index}`, displayName, title, emailAddress: `${handle}@${DOMAIN}`, userKey: `8a7f80c${(0x1a2b3c + index).toString(16)}0185c3d4e5f60001` };
});
const ME = PEOPLE.find((person) => person.handle === "alex");

/** Resolves an email, username, user key, display name, first name or "currentUser()" to a person. */
function findPerson(value) {
  if (value && typeof value === "object") value = value.name ?? value.accountId ?? value.key ?? value.emailAddress ?? value.displayName;
  if (typeof value !== "string" || !value.trim()) return null;
  const needle = value.trim().toLowerCase().replace(/^@/, "").replace(/^accountid:/, "").replace(/^~/, "");
  if (needle === "currentuser()" || needle === "me") return ME;
  return PEOPLE.find((p) => [p.name, p.key.toLowerCase(), p.emailAddress, p.displayName.toLowerCase(), p.handle, p.userKey].includes(needle))
    ?? PEOPLE.find((p) => p.displayName.toLowerCase().split(" ")[0] === needle) ?? null;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────────

/** An error answered the way Jira/Confluence do, so REST clients (and mcp-atlassian) see real status codes. */
class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const notFound = (message) => new ApiError(404, message);
const badRequest = (message, errors = {}) => new ApiError(400, message, { errors });

// ── Seed: Jira ──────────────────────────────────────────────────────────────────────────────────────────

const STATUS_CATEGORIES = {
  new: { self: "", id: 2, key: "new", colorName: "blue-gray", name: "To Do" },
  indeterminate: { self: "", id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
  done: { self: "", id: 3, key: "done", colorName: "green", name: "Done" },
};
const STATUSES = [
  ["10000", "To Do", "new"], ["3", "In Progress", "indeterminate"], ["10001", "In Review", "indeterminate"], ["10002", "Done", "done"],
  ["10100", "Waiting for support", "new"], ["10101", "Waiting for customer", "indeterminate"], ["10102", "Resolved", "done"],
].map(([id, name, category]) => ({ id, name, description: "", iconUrl: `${JIRA_SITE}/images/icons/statuses/generic.png`, statusCategory: STATUS_CATEGORIES[category] }));
const status = (name) => STATUSES.find((entry) => entry.name.toLowerCase() === String(name).toLowerCase());
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"].map((name, index) => ({ id: String(index + 1), name, iconUrl: `${JIRA_SITE}/images/icons/priorities/${name.toLowerCase()}.svg` }));
const priority = (value) => PRIORITIES.find((entry) => entry.id === String(value) || entry.name.toLowerCase() === String(value).toLowerCase());
const RESOLUTIONS = [{ id: "10000", name: "Done", description: "Work has been completed on this issue." }, { id: "10001", name: "Won't Do", description: "This issue won't be actioned." }];
const ISSUE_TYPES = [
  ["10000", "Epic", false, "Created by Jira Software - do not edit or delete. Issue type for a big user story that needs to be broken down."],
  ["10001", "Story", false, "Created by Jira Software - do not edit or delete. Issue type for a user story."],
  ["10002", "Task", false, "A task that needs to be done."],
  ["10003", "Sub-task", true, "The sub-task of the issue"],
  ["10004", "Bug", false, "A problem which impairs or prevents the functions of the product."],
  ["10100", "IT Help", false, "For general IT problems and questions. Created by Jira Service Management."],
  ["10101", "Service Request", false, "Created by Jira Service Management for service requests."],
  ["10102", "Incident", false, "For system outages or incidents. Created by Jira Service Management."],
].map(([id, name, subtask, description]) => ({ id, name, description, subtask, iconUrl: `${JIRA_SITE}/secure/viewavatar?size=xsmall&avatarId=${10300 + Number(id) % 100}&avatarType=issuetype`, avatarId: 10300 + Number(id) % 100 }));
const issueType = (value) => {
  const needle = String(value ?? "").trim().toLowerCase().replace(/^subtask$/, "sub-task");
  return ISSUE_TYPES.find((entry) => entry.id === needle || entry.name.toLowerCase() === needle);
};
/** Workflows: the transitions available from any status. */
const WORKFLOWS = {
  software: [["11", "To Do"], ["21", "In Progress"], ["31", "In Review"], ["41", "Done"]],
  business: [["11", "To Do"], ["21", "In Progress"], ["41", "Done"]],
  service_desk: [["761", "Waiting for support"], ["771", "Waiting for customer"], ["781", "In Progress"], ["791", "Resolved"]],
};

function seedJira() {
  const now = clockNow();
  const lead = (handle) => PEOPLE.find((p) => p.handle === handle);
  const projects = [
    { id: "10000", key: "FLEET", name: "Fleet Software", projectTypeKey: "software", lead: lead("sofia"), description: "Robot firmware, navigation and the fleet manager.",
      issueTypes: ["Epic", "Story", "Task", "Bug", "Sub-task"], components: ["Firmware", "Navigation", "Fleet Manager", "Dashboard"], versions: [["10100", "2.0-rc4", false, 2], ["10101", "2.0", false, 15], ["10102", "1.9.3", true, -30]] },
    { id: "10001", key: "DOC", name: "Documentation", projectTypeKey: "business", lead: lead("nora"), description: "User manuals, datasheets, safety guides and release notes.",
      issueTypes: ["Task", "Sub-task"], components: ["User manuals", "Datasheets", "Safety", "Release notes"], versions: [] },
    { id: "10002", key: "ITSD", name: "IT Service Desk", projectTypeKey: "service_desk", lead: lead("dev"), description: "Get help from the Acme IT team.",
      issueTypes: ["IT Help", "Service Request", "Incident", "Task"], components: ["Accounts", "Hardware", "Network", "Software"], versions: [] },
  ].map((project) => ({ ...project, components: project.components.map((name, index) => ({ id: String(10200 + Number(project.id.slice(-1)) * 10 + index), name })),
    versions: project.versions.map(([id, name, released, days]) => ({ id, name, archived: false, released, releaseDate: localDate(now + days * DAY), projectId: Number(project.id) })) }));
  const counters = { FLEET: 0, DOC: 0, ITSD: 0 };
  const issues = [];
  let nextId = 10400;
  const issue = (projectKey, type, summary, fields = {}) => {
    const project = projects.find((p) => p.key === projectKey);
    counters[projectKey] = fields.number ?? counters[projectKey] + 1;
    const created = fields.created ?? ago((3 + nextId % 17) * DAY + (nextId % 9) * HOUR);
    const entry = {
      id: String(nextId++), key: `${projectKey}-${counters[projectKey]}`, project: project.key, issuetype: type, summary,
      description: fields.description ?? null, status: fields.status ?? (project.projectTypeKey === "service_desk" ? "Waiting for support" : "To Do"),
      priority: fields.priority ?? "Medium", assignee: fields.assignee ?? null, reporter: fields.reporter ?? "alex", creator: fields.reporter ?? "alex",
      labels: fields.labels ?? [], components: fields.components ?? [], fixVersions: fields.fixVersions ?? [], versions: [], duedate: fields.duedate ?? null,
      parent: fields.parent ?? null, epicLink: fields.epicLink ?? null, created, updated: fields.updated ?? Math.max(created, ago((2 + nextId % 48) * HOUR)),
      resolution: null, resolutiondate: null, comments: [], watchers: [fields.reporter ?? "alex"], changelog: [], requestType: fields.requestType ?? null, remoteLinks: [],
    };
    if (status(entry.status).statusCategory.key === "done") { entry.resolution = "Done"; entry.resolutiondate = entry.updated; }
    for (const [handle, body, minutesAgo] of fields.comments ?? []) entry.comments.push(newComment(handle, body, ago(minutesAgo * MINUTE)));
    issues.push(entry);
    return entry;
  };
  // FLEET: the Fleet 2.0 release, its launch blockers and the multi-site dashboard.
  const epic = issue("FLEET", "Epic", "Fleet 2.0 release", { status: "In Progress", priority: "High", assignee: "sofia", reporter: "priya", number: 300, created: ago(60 * DAY), fixVersions: ["2.0"],
    description: "Everything that has to ship for Fleet 2.0: rc4 firmware, navigation fixes and the multi-site dashboard.\n\nh3. Launch criteria\n* No open launch blockers\n* 72h soak test on 3 customer sites\n* Release notes reviewed by Docs" });
  issue("FLEET", "Bug", "BMS handshake fails after deep sleep on 1.9.x firmware", { status: "Done", priority: "Highest", assignee: "jamal", reporter: "harper", number: 318, created: ago(30 * DAY), labels: ["firmware"], components: ["Firmware"], fixVersions: ["2.0-rc4"] });
  issue("FLEET", "Bug", "Localization drift near reflective tape (Northwind, dock 4)", { status: "In Progress", priority: "Highest", assignee: "jamal", reporter: "jamal", number: 342, created: ago(20 * HOUR), epicLink: epic.key,
    labels: ["launch-blocker", "navigation"], components: ["Navigation"], fixVersions: ["2.0-rc4"],
    description: "Pose error jumps ~30cm after robots cross the reflective tape section at Northwind dock 4.\n\n*Steps to reproduce*\n# Load the dock-4 map on the bench unit\n# Drive across the tape strip at 1.2 m/s\n# Compare pose against ground truth\n\nSuspect the new lidar intensity filter in rc3.",
    comments: [["ezra", "Pose logs for the last 7 days are in the telemetry notebook; drift only happens when intensity > 0.85.", 17 * 60], ["priya", "This is a launch blocker until we know the cause.", 3 * 60]] });
  issue("FLEET", "Story", "Make the lidar intensity threshold configurable per site", { status: "To Do", priority: "High", assignee: "sofia", reporter: "jamal", epicLink: epic.key, labels: ["navigation"], components: ["Navigation"], fixVersions: ["2.0"] });
  issue("FLEET", "Bug", "Battery telemetry gaps in the fleet manager", { status: "In Review", priority: "Highest", assignee: "ezra", reporter: "sofia", number: 351, epicLink: epic.key, labels: ["launch-blocker", "telemetry"], components: ["Fleet Manager"], fixVersions: ["2.0-rc4"] });
  issue("FLEET", "Task", "Cut rc4 firmware build", { status: "To Do", priority: "High", assignee: "sofia", reporter: "priya", epicLink: epic.key, components: ["Firmware"], fixVersions: ["2.0-rc4"], duedate: localDate(now + 2 * DAY) });
  issue("FLEET", "Story", "Dashboard: map view clustering for more than 50 robots", { status: "In Progress", priority: "Medium", assignee: "jamal", reporter: "nora", epicLink: epic.key, components: ["Dashboard"], fixVersions: ["2.0"] });
  issue("FLEET", "Story", "Dashboard: SSO sign-in for customer admins", { status: "To Do", priority: "Medium", assignee: null, reporter: "harper", labels: ["customer-request"], components: ["Dashboard"] });
  // DOC: documentation work, owned by Nora Patel.
  issue("DOC", "Task", "Update the Atlas 2 user manual for firmware 2.0", { status: "In Progress", priority: "High", assignee: "nora", reporter: "nora", number: 41, components: ["User manuals"], duedate: localDate(now + 10 * DAY),
    description: "Chapters 4 (Mapping) and 7 (Charging) change with 2.0. Screenshots of the new dashboard are needed." });
  issue("DOC", "Task", "Translate the Atlas safety guide to German and French", { status: "To Do", priority: "Medium", assignee: "zoe", reporter: "nora", components: ["Safety"], labels: ["translation"] });
  issue("DOC", "Task", "Fleet 2.0 release notes", { status: "To Do", priority: "High", assignee: "nora", reporter: "sofia", components: ["Release notes"], duedate: localDate(now + 14 * DAY) });
  issue("DOC", "Task", "Refresh the Atlas Lift datasheet (new payload rating)", { status: "Done", priority: "Medium", assignee: "zoe", reporter: "mateo", components: ["Datasheets"], created: ago(20 * DAY), updated: ago(6 * DAY) });
  // ITSD: requests to the IT team.
  issue("ITSD", "Service Request", "New laptop for Riley Hart (starts in 3 weeks)", { status: "In Progress", priority: "Medium", assignee: "dev", reporter: "camila", number: 214, requestType: "12", created: ago(2 * DAY) });
  issue("ITSD", "IT Help", "VPN disconnects every 10 minutes from the Reno site", { status: "Waiting for customer", priority: "High", assignee: "dev", reporter: "kenji", requestType: "10", created: ago(DAY),
    comments: [["dev", "Can you send the output of the VPN client diagnostics (Help → Export logs)?", 20 * 60]] });
  issue("ITSD", "Service Request", "Access to the Salesforce sandbox", { status: "Resolved", priority: "Low", assignee: "dev", reporter: "liam", requestType: "13", created: ago(5 * DAY), updated: ago(4 * DAY) });
  return { projects, issues, counters, nextId, nextCommentId: 30000 };
}
let commentSeq = 30000;
function newComment(handle, body, at = clockNow()) {
  return { id: String(commentSeq++), author: handle, body, created: at, updated: at };
}

/** Service desks and request types (Jira Service Management). */
const SERVICE_DESKS = [{ id: "1", projectId: "10002", projectKey: "ITSD", projectName: "IT Service Desk" }];
const REQUEST_TYPES = [
  { id: "10", name: "Get IT help", description: "Ask a question or get help with an IT problem.", issueTypeId: "10100", helpText: "",
    fields: ["summary", "description"] },
  { id: "11", name: "Reset a password", description: "Locked out or forgot a password? We'll reset it.", issueTypeId: "10101", helpText: "Never send your current password.",
    fields: ["summary", "customfield_10500", "description"] },
  { id: "12", name: "Request new hardware", description: "Laptops, monitors, headsets and phones.", issueTypeId: "10101", helpText: "",
    fields: ["summary", "customfield_10501", "description"] },
  { id: "13", name: "Request access to an application", description: "Get access to Salesforce, SAP, Jira, Confluence and more.", issueTypeId: "10101", helpText: "",
    fields: ["summary", "customfield_10500", "description"] },
  { id: "14", name: "Report a system problem", description: "Something is broken or down for several people.", issueTypeId: "10102", helpText: "",
    fields: ["summary", "description"] },
].map((entry) => ({ ...entry, serviceDeskId: "1", groupIds: ["1"] }));
const REQUEST_FIELDS = {
  summary: { fieldId: "summary", name: "Summary", description: "", required: true, jiraSchema: { type: "string", system: "summary" }, validValues: [] },
  description: { fieldId: "description", name: "Description", description: "Tell us what happened and what you've already tried.", required: false, jiraSchema: { type: "string", system: "description" }, validValues: [] },
  customfield_10500: { fieldId: "customfield_10500", name: "Application", description: "Which system is this about?", required: true,
    jiraSchema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10500 },
    validValues: ["Windows login", "Email (Outlook)", "VPN", "SAP", "Salesforce", "Jira", "Confluence", "Other"].map((label, index) => ({ value: String(10600 + index), label, children: [] })) },
  customfield_10501: { fieldId: "customfield_10501", name: "Hardware", description: "", required: true,
    jiraSchema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10501 },
    validValues: ["Laptop", "Monitor", "Headset", "Docking station", "Mobile phone"].map((label, index) => ({ value: String(10700 + index), label, children: [] })) },
};

// ── Seed: Confluence ────────────────────────────────────────────────────────────────────────────────────

function seedConfluence() {
  const spaces = [
    { id: 98305, key: "HB", name: "Employee Handbook", description: "How we work at Acme Robotics: policies, benefits, offices and IT." },
    { id: 98306, key: "SALES", name: "Sales & Accounts", description: "Account plans, customer health and the sales playbook." },
    { id: 98307, key: "PROD", name: "Products", description: "Datasheets, positioning and pricing for every Acme product." },
    { id: 98308, key: "ENG", name: "Engineering", description: "Architecture, runbooks and release process." },
  ];
  const pages = [];
  let nextId = 163840001;
  const page = (spaceKey, title, parent, markdown, extra = {}) => {
    const created = extra.created ?? ago(120 * DAY);
    const entry = { id: String(nextId++), type: "page", status: "current", spaceKey, title, parentId: parent?.id ?? null,
      body: markdownToStorage(markdown), version: 1, versions: [], creator: extra.creator ?? "alex", created, lastModifier: extra.lastModifier ?? extra.creator ?? "alex",
      lastModified: extra.lastModified ?? Math.max(created, ago((extra.editedDaysAgo ?? 9) * DAY)), labels: extra.labels ?? [], comments: [], views: extra.views ?? 40 };
    entry.version = extra.version ?? 1 + Math.floor(Math.abs(Math.sin(nextId)) * 6);
    pages.push(entry);
    return entry;
  };
  const home = (spaceKey, title, markdown, creator) => page(spaceKey, title, null, markdown, { creator });

  const hb = home("HB", "Employee Handbook", "Welcome to Acme Robotics. This space is the source of truth for company policies.\n\n- Working at the office\n- Remote and hybrid work\n- Expenses and travel\n- IT and security\n- Time off and holidays", "camila");
  spaces[0].homepageId = hb.id;
  page("HB", "Working at the office", hb, [
    "# Working at the office",
    "Our Reno HQ is open 7:00–20:00 on weekdays. Badge in at the main entrance; visitors sign in at reception and wear a visitor badge at all times.",
    "## Desks",
    "- Desks are unassigned; book one in the desk booking tool by 9:00 the day before.",
    "- Clear your desk at the end of the day (clean desk policy).",
    "## Kitchen",
    "Coffee, tea and fruit are free. Label food in the fridge with your name and date; the fridge is emptied every Friday at 15:00.",
    "## Parking and bikes",
    "Employee parking is in lot B. Covered bike racks and showers are next to the loading dock.",
    "## Quiet zones",
    "The second floor east wing is a quiet zone: no calls, no meetings.",
  ].join("\n"), { creator: "camila", labels: ["policy", "office"] });
  page("HB", "Remote and hybrid work", hb, "# Remote and hybrid work\nEveryone can work remotely up to 3 days a week. Team anchor days are Tuesday and Thursday.\n\n- Use a company laptop with disk encryption and VPN.\n- Home office allowance: $500 once, $150 per year after that.\n- Working from another country for more than 10 days needs approval from People Ops.", { creator: "camila", labels: ["policy", "remote"] });
  page("HB", "Expenses and travel", hb, "# Expenses and travel\n- Submit expenses within 30 days in the finance tool.\n- Book flights and hotels through the travel portal; economy for flights under 6 hours.\n- Customer meals: up to $120 per person, list attendees.\n- Mileage is reimbursed at the IRS rate.", { creator: "sam", labels: ["policy", "finance"] });
  const it = page("HB", "IT and security", hb, "# IT and security\nNeed help? Raise a request in the **IT Service Desk** (Jira project ITSD) or call the IT hotline at ext. 4357 (HELP).\n\n## Passwords\n- Passwords are at least 14 characters and change every 180 days.\n- Locked out? Use **Reset a password** in the IT Service Desk, or ask a colleague to raise it on your behalf.\n- Never share your password, including with IT.\n\n## Devices\n- Company laptops only for customer data.\n- Report lost devices to IT within 1 hour.", { creator: "dev", labels: ["policy", "it", "security"] });
  page("HB", "Time off and holidays", hb, "# Time off and holidays\n- 25 days of paid time off per year, plus company holidays.\n- Request time off in the HR tool at least 2 weeks ahead for anything longer than 3 days.\n- Sick days do not count against PTO; tell your manager the same morning.", { creator: "camila", labels: ["policy", "hr"] });

  const sales = home("SALES", "Sales & Accounts", "Account plans for our key customers, plus the sales playbook. Numbers are refreshed monthly by Finance from the CRM.", "mateo");
  spaces[1].homepageId = sales.id;
  const accounts = page("SALES", "Key accounts", sales, "# Key accounts\nOne page per strategic customer. Owner: the account executive.\n\n| Customer | Industry | Robots | ARR | Health |\n|---|---|---|---|---|\n| Northwind Logistics | 3PL warehousing | 12 | $1.10M | Green |\n| Blue Harbor Foods | Food distribution | 18 | $1.46M | Amber |\n| Cedar Grove Pharma | Pharma distribution | 6 | $0.52M | Green |\n| Pinecrest Retail | Retail e-commerce | 25 | $2.05M | Red |", { creator: "mateo", labels: ["accounts"] });
  const account = (name, owner, markdown) => page("SALES", `Account plan: ${name}`, accounts, markdown, { creator: owner, labels: ["account-plan", name.toLowerCase().replace(/[^a-z]+/g, "-")], editedDaysAgo: 4 });
  account("Northwind Logistics", "liam", [
    "# Account plan: Northwind Logistics",
    "**Owner:** Liam O'Connor · **Exec sponsor:** Alex Chen · **Customer since:** 2025",
    "## Snapshot",
    "| Metric | Value |", "|---|---|",
    "| Annual recurring revenue | $1.10M |", "| Robots deployed | 12 Atlas 2 across 2 sites (Reno, Sparks) |",
    "| Orders last 12 months | 4 orders, $1.38M |", "| Open pipeline | Expansion to 40 robots / 3 sites, ~$1.4M ARR |",
    "| Support tickets (90 days) | 7, 1 high severity |", "| NPS | 62 |",
    "## Relationship",
    "Strong. Weekly ops call with Dana Whitfield (VP Operations). Their board approved budget for expansion if the multi-site dashboard and SSO ship by end of Q1.",
    "## Growth potential",
    "High. Third site in Stockton planned; they also evaluate Atlas Lift for pallet moves.",
    "## Risks",
    "- Localization drift at dock 4 (FLEET-342) is visible to their ops team.",
    "- Depends on SSO for the dashboard (FLEET roadmap, not committed).",
    "## Churn risk",
    "Low.",
  ].join("\n"));
  account("Blue Harbor Foods", "harper", [
    "# Account plan: Blue Harbor Foods",
    "**Owner:** Liam O'Connor · **Support lead:** Harper Wilson · **Customer since:** 2023",
    "## Snapshot",
    "| Metric | Value |", "|---|---|",
    "| Annual recurring revenue | $1.46M |", "| Robots deployed | 18 Atlas 2 + 2 Atlas Lift at 1 site |",
    "| Orders last 12 months | 2 orders, $0.41M |", "| Open pipeline | Renewal in 5 months; no expansion yet |",
    "| Support tickets (90 days) | 19, 4 high severity |", "| NPS | 18 |",
    "## Relationship",
    "Mixed. Operations team relies on us daily, but the charging escalations (FLEET-318, fixed in 2.0-rc4) hurt trust. New COO since August.",
    "## Growth potential",
    "Medium. A second cold-storage site is planned for next year if reliability improves.",
    "## Risks",
    "- Renewal in 5 months, procurement asked for a competitor quote.",
    "- High ticket volume; they are still on 1.9.x firmware.",
    "## Churn risk",
    "Medium-high.",
  ].join("\n"));
  account("Cedar Grove Pharma", "liam", "# Account plan: Cedar Grove Pharma\n**Owner:** Liam O'Connor\n\n| Metric | Value |\n|---|---|\n| Annual recurring revenue | $0.52M |\n| Robots deployed | 6 Atlas 2 |\n| Orders last 12 months | 1 order, $0.52M |\n| NPS | 55 |\n\n## Relationship\nGood, but slow: every change needs GxP validation.\n## Growth potential\nHigh: 4 more distribution centers in the US.\n## Churn risk\nLow.");
  account("Pinecrest Retail", "mateo", "# Account plan: Pinecrest Retail\n**Owner:** Mateo Rivera\n\n| Metric | Value |\n|---|---|\n| Annual recurring revenue | $2.05M |\n| Robots deployed | 25 Atlas 2 across 3 sites |\n| Orders last 12 months | 3 orders, $0.90M |\n| NPS | 9 |\n\n## Relationship\nStrained. Executive sponsor left in July; the new VP is reviewing all automation vendors.\n## Growth potential\nLow until the vendor review ends.\n## Churn risk\nHigh.");
  page("SALES", "Sales playbook", sales, "# Sales playbook\n1. Discovery: pick rate, peak season, WMS, number of sites.\n2. Pilot: 4–6 robots for 8 weeks with success criteria agreed up front.\n3. Expansion: multi-site pricing applies from 20 robots.\n\nAlways attach the latest datasheets from the **Products** space.", { creator: "mateo", labels: ["playbook"] });

  const prod = home("PROD", "Products", "Datasheets, positioning and pricing. Marketing owns these pages; ask Olivia Martin before sharing anything marked *internal*.", "olivia");
  spaces[2].homepageId = prod.id;
  page("PROD", "Atlas 2 autonomous mobile robot – datasheet", prod, [
    "# Atlas 2 autonomous mobile robot",
    "The workhorse for goods-to-person picking in warehouses.",
    "## Key specs",
    "| Spec | Value |", "|---|---|",
    "| Payload | 300 kg |", "| Top speed | 2.0 m/s |", "| Runtime | 10 h, 1 h opportunity charge to 80% |",
    "| Navigation | Lidar + vision SLAM, no floor markers |", "| Safety | ISO 3691-4, PL d |", "| Footprint | 980 × 680 mm |",
    "## Typical use cases",
    "- Goods-to-person picking (30% more picks per hour than manual carts in customer pilots)",
    "- Line-side replenishment in manufacturing",
    "## Why Acme",
    "Learns a new warehouse in under 2 hours with Fleet 2.0 self-serve mapping; one dashboard for every site.",
  ].join("\n"), { creator: "olivia", labels: ["datasheet", "atlas-2"] });
  page("PROD", "Atlas Lift pallet robot – datasheet", prod, [
    "# Atlas Lift pallet robot",
    "Autonomous pallet moves between dock, storage and staging.",
    "## Key specs",
    "| Spec | Value |", "|---|---|",
    "| Payload | 1,200 kg (Euro and US pallets) |", "| Lift height | 1.6 m |", "| Top speed | 1.5 m/s |",
    "| Runtime | 8 h, swappable battery |", "| Safety | ISO 3691-4, 360° safety lidar |",
    "## Typical use cases",
    "- Dock to storage transport",
    "- Cold storage down to -25 °C (optional kit)",
  ].join("\n"), { creator: "olivia", labels: ["datasheet", "atlas-lift"] });
  page("PROD", "Fleet Manager and dashboard", prod, "# Fleet Manager\nCloud or on-premise software that plans missions, charges robots and shows KPIs.\n\n- Multi-site dashboard (Fleet 2.0)\n- Integrations: SAP EWM, Manhattan, Blue Yonder WMS via REST\n- Role-based access; SSO on the roadmap", { creator: "nora", labels: ["software"] });
  page("PROD", "Pricing overview (internal)", prod, "# Pricing overview (internal)\n| Item | List price |\n|---|---|\n| Atlas 2 | $48,000 or $1,650 per month (RaaS) |\n| Atlas Lift | $95,000 or $3,100 per month (RaaS) |\n| Fleet Manager | $9,000 per site per year |\n\nMulti-site discount from 20 robots: 8%. Never share this page with customers.", { creator: "mateo", labels: ["pricing", "internal"] });
  page("PROD", "Project XYZ: documentation plan", prod, "# Project XYZ: documentation plan\nProject XYZ is the internal code name for the Atlas 2 cold-storage kit.\n\n## Deliverables\n- Updated user manual chapter (owner: Nora Patel)\n- Cold-storage safety addendum\n- Datasheet update\n\nTrack the work in the Jira project **DOC**.", { creator: "nora", labels: ["project-xyz", "documentation"] });

  const eng = home("ENG", "Engineering", "Architecture, on-call and the release process.", "priya");
  spaces[3].homepageId = eng.id;
  page("ENG", "Release process", eng, "# Release process\n1. Cut a release candidate (rc) build.\n2. 72h soak test on 3 customer sites.\n3. Go/no-go review with Product, Support and Docs.\n4. Staged rollout: 10% → 50% → 100% over a week.", { creator: "sofia", labels: ["process"] });
  page("ENG", "On-call runbook: robots stuck charging", eng, "# Robots stuck in 'charging'\n1. Check the firmware version (1.9.x has the BMS handshake bug FLEET-318).\n2. Power-cycle the robot from the fleet manager.\n3. If still stuck, collect `/var/log/bms` and escalate.\n4. Fix: upgrade to 2.0-rc4 or later.", { creator: "jamal", labels: ["runbook"] });

  const comment = (target, handle, markdown, minutesAgo) => target.comments.push({ id: String(nextId++), author: handle, body: markdownToStorage(markdown), created: ago(minutesAgo * MINUTE) });
  comment(pages.find((p) => p.title === "Account plan: Blue Harbor Foods"), "mateo", "Let's review this before the renewal kickoff. Harper, can you add the ticket trend?", 26 * 60);
  comment(it, "kenji", "Is the IT hotline also staffed on weekends?", 3 * 24 * 60);
  comment(it, "dev", "Yes, Saturdays 9–13. Outside those hours raise a request in ITSD.", 3 * 24 * 60 - 45);
  return { spaces, pages, nextId };
}

// ── Markup helpers: Markdown ⇄ Confluence storage format, Markdown ⇄ Jira wiki markup ───────────────────

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function inlineMarkdownToHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
}
/** A small Markdown → Confluence storage (XHTML) converter: headings, paragraphs, lists, tables, code. */
function markdownToStorage(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { out.push(`<h${heading[1].length}>${inlineMarkdownToHtml(heading[2])}</h${heading[1].length}>`); i += 1; continue; }
    if (/^```/.test(line)) {
      const code = []; i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${code.join("\n")}]]></ac:plain-text-body></ac:structured-macro>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const header = cells(rows[0]); const body = rows.slice(1).filter((row) => !/^\|[\s:|-]+\|?$/.test(row)).map(cells);
      out.push(`<table><tbody><tr>${header.map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`).join("")}</tr>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdownToHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]); const items = [];
      while (i < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) {
        const item = lines[i].replace(/^(\s*)([-*+]|\d+\.)\s+/, "");
        const task = /^\[( |x)\]\s+(.*)$/i.exec(item);
        items.push(task ? `<li>${task[1].toLowerCase() === "x" ? "☑" : "☐"} ${inlineMarkdownToHtml(task[2])}</li>` : `<li>${inlineMarkdownToHtml(item)}</li>`);
        i += 1;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i += 1; }
      out.push(`<blockquote><p>${inlineMarkdownToHtml(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\||>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) { paragraph.push(lines[i]); i += 1; }
    out.push(`<p>${paragraph.map(inlineMarkdownToHtml).join("<br />")}</p>`);
  }
  return out.join("");
}
const decodeHtml = (text) => text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
function inlineHtmlToMarkdown(html) {
  return decodeHtml(html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<(strong|b)>(.*?)<\/\1>/g, "**$2**")
    .replace(/<(em|i)>(.*?)<\/\1>/g, "*$2*")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, "[$2]($1)")
    .replace(/<ac:link>.*?<ri:page ri:content-title="([^"]*)"[^>]*\/>.*?<\/ac:link>/g, "[$1]")
    .replace(/<ri:user [^>]*ri:(?:userkey|username)="([^"]*)"[^>]*\/>/g, (_, id) => `@${findPerson(id)?.displayName ?? id}`)
    .replace(/<[^>]+>/g, ""));
}
/**
 * Confluence storage (XHTML) → Markdown. The "markdownify" flavor matches mcp-atlassian's output (setext headings
 * for levels 1-2, "*" bullets); the default flavor is plain GitHub-style Markdown.
 */
function storageToMarkdown(storage, flavor = "github") {
  const markdownify = flavor === "markdownify";
  let html = String(storage ?? "");
  html = html.replace(/<ac:structured-macro ac:name="code"[^>]*>.*?<!\[CDATA\[([\s\S]*?)\]\]>.*?<\/ac:structured-macro>/g, (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`);
  html = html.replace(/<ac:structured-macro[^>]*>[\s\S]*?<\/ac:structured-macro>/g, "");
  html = html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, level, text) => {
    const heading = inlineHtmlToMarkdown(text).trim();
    if (markdownify && Number(level) <= 2) return `\n${heading}\n${(Number(level) === 1 ? "=" : "-").repeat(heading.length)}\n`;
    return `\n${"#".repeat(Number(level))} ${heading}\n`;
  });
  html = html.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, table) => {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => inlineHtmlToMarkdown(cell[1]).trim()));
    if (!rows.length) return "";
    return `\n| ${rows[0].join(" | ")} |\n| ${rows[0].map(() => "---").join(" | ")} |\n${rows.slice(1).map((row) => `| ${row.join(" | ")} |`).join("\n")}\n`;
  });
  html = html.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/g, (_, kind, items) => `\n${[...items.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((item, index) => `${kind === "ol" ? `${index + 1}.` : markdownify ? "*" : "-"} ${inlineHtmlToMarkdown(item[1]).trim()}`).join("\n")}\n`);
  html = html.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, (_, text) => `\n> ${inlineHtmlToMarkdown(text).trim()}\n`);
  html = html.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_, text) => `\n${inlineHtmlToMarkdown(text)}\n`);
  return inlineHtmlToMarkdown(html).replace(/\n{3,}/g, "\n\n").trim();
}
/** Plain text of a storage body, for search and excerpts. */
const storageText = (storage) => decodeHtml(String(storage ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Markdown → Jira wiki markup (what mcp-atlassian sends to Jira Server/DC). */
function markdownToWiki(markdown) {
  if (markdown === null || markdown === undefined) return markdown;
  // Like mcp-atlassian's converter, a list directly follows the paragraph before it (no blank line).
  return String(markdown).replace(/\n\n(?=\s*([-*+]|\d+\.)\s)/g, "\n").split("\n").map((line) => line
    .replace(/^(#{1,6})\s+/, (_, hashes) => `h${hashes.length}. `)
    .replace(/^(\s*)[-*+]\s+/, (_, indent) => `${"*".repeat(Math.floor(indent.length / 2) + 1)} `)
    .replace(/^(\s*)\d+\.\s+/, (_, indent) => `${"#".repeat(Math.floor(indent.length / 2) + 1)} `)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/`([^`]+)`/g, "{{$1}}")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$1|$2]")).join("\n");
}
/** Jira wiki markup → Markdown (what mcp-atlassian shows for Server/DC descriptions and comments). */
function wikiToMarkdown(wiki) {
  if (wiki === null || wiki === undefined) return "";
  return String(wiki).split("\n").map((line) => line
    .replace(/^h([1-6])\.\s+/, (_, level) => `${"#".repeat(Number(level))} `)
    .replace(/^(\*+)\s+/, (_, stars) => `${"  ".repeat(stars.length - 1)}- `)
    .replace(/^(#+)\s+/, (_, hashes) => `${"  ".repeat(hashes.length - 1)}1. `)
    .replace(/\*([^*\n]+)\*/g, "**$1**")
    .replace(/\{\{([^}]+)\}\}/g, "`$1`")
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, "[$1]($2)")).join("\n");
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────

function seed() { commentSeq = 30000; return { jira: seedJira(), confluence: seedConfluence() }; }
let state = seed();
let touched = false;
let audit = [], auditSequence = 0;
function reset() { state = seed(); touched = false; audit = []; auditSequence = 0; }

// ── Jira: views in the shape of the REST API v2 ─────────────────────────────────────────────────────────

const jiraBase = (ctx) => ctx.restBase ?? `${JIRA_SITE}`;
function userView(handle, ctx = {}) {
  const person = typeof handle === "string" ? PEOPLE.find((p) => p.handle === handle) : handle;
  if (!person) return null;
  const avatar = (size) => `${JIRA_SITE}/secure/useravatar?size=${size}&ownerId=${person.key}&avatarId=10122`;
  return { self: `${jiraBase(ctx)}/rest/api/2/user?username=${person.name}`, key: person.key, name: person.name, emailAddress: person.emailAddress,
    avatarUrls: { "48x48": avatar("large"), "24x24": avatar("small"), "16x16": avatar("xsmall"), "32x32": avatar("medium") },
    displayName: person.displayName, active: true, deleted: false, timeZone: TIME_ZONE, locale: "en_US" };
}
const statusView = (name, ctx = {}) => { const entry = status(name); return { self: `${jiraBase(ctx)}/rest/api/2/status/${entry.id}`, ...entry, statusCategory: { ...entry.statusCategory, self: `${jiraBase(ctx)}/rest/api/2/statuscategory/${entry.statusCategory.id}` } }; };
const priorityView = (name, ctx = {}) => { const entry = priority(name); return { self: `${jiraBase(ctx)}/rest/api/2/priority/${entry.id}`, ...entry }; };
const issueTypeView = (name, ctx = {}) => { const entry = issueType(name); return { self: `${jiraBase(ctx)}/rest/api/2/issuetype/${entry.id}`, ...entry }; };
function projectRef(key, ctx = {}) {
  const project = state.jira.projects.find((p) => p.key === key);
  return { self: `${jiraBase(ctx)}/rest/api/2/project/${project.id}`, id: project.id, key: project.key, name: project.name, projectTypeKey: project.projectTypeKey,
    avatarUrls: { "48x48": `${JIRA_SITE}/secure/projectavatar?avatarId=10324`, "24x24": `${JIRA_SITE}/secure/projectavatar?size=small&avatarId=10324`, "16x16": `${JIRA_SITE}/secure/projectavatar?size=xsmall&avatarId=10324`, "32x32": `${JIRA_SITE}/secure/projectavatar?size=medium&avatarId=10324` },
    projectCategory: undefined };
}
function projectView(project, ctx = {}) {
  return { expand: "description,lead,url,projectKeys", ...projectRef(project.key, ctx), description: project.description, lead: userView(project.lead, ctx),
    components: project.components.map((c) => ({ self: `${jiraBase(ctx)}/rest/api/2/component/${c.id}`, id: c.id, name: c.name, isAssigneeTypeValid: false })),
    issueTypes: project.issueTypes.map((name) => issueTypeView(name, ctx)), assigneeType: "UNASSIGNED",
    versions: project.versions.map((v) => ({ self: `${jiraBase(ctx)}/rest/api/2/version/${v.id}`, ...v })), roles: {}, archived: false, projectKeys: [project.key] };
}
const commentView = (comment, issue, ctx = {}) => ({ self: `${jiraBase(ctx)}/rest/api/2/issue/${issue.id}/comment/${comment.id}`, id: comment.id, author: userView(comment.author, ctx), body: comment.body,
  updateAuthor: userView(comment.author, ctx), created: jiraTime(comment.created), updated: jiraTime(comment.updated) });
const EPIC_LINK_FIELD = "customfield_10100"; const EPIC_NAME_FIELD = "customfield_10102"; const STORY_POINTS_FIELD = "customfield_10106";
const REQUEST_TYPE_FIELD = "customfield_10010";
/** All fields of an issue, keyed as Jira does. */
function issueFields(issue, ctx = {}) {
  const project = state.jira.projects.find((p) => p.key === issue.project);
  const parent = issue.parent ? state.jira.issues.find((entry) => entry.key === issue.parent) : null;
  const requestType = issue.requestType ? REQUEST_TYPES.find((entry) => entry.id === issue.requestType) : null;
  return {
    summary: issue.summary, issuetype: issueTypeView(issue.issuetype, ctx), project: projectRef(issue.project, ctx), status: statusView(issue.status, ctx),
    priority: priorityView(issue.priority, ctx), assignee: issue.assignee ? userView(issue.assignee, ctx) : null, reporter: userView(issue.reporter, ctx), creator: userView(issue.creator, ctx),
    created: jiraTime(issue.created), updated: jiraTime(issue.updated), description: issue.description, labels: issue.labels,
    components: issue.components.map((name) => { const c = project.components.find((entry) => entry.name === name); return { self: `${jiraBase(ctx)}/rest/api/2/component/${c?.id}`, id: c?.id, name }; }),
    fixVersions: issue.fixVersions.map((name) => { const v = project.versions.find((entry) => entry.name === name); return v ? { self: `${jiraBase(ctx)}/rest/api/2/version/${v.id}`, ...v } : { name }; }),
    versions: [], duedate: issue.duedate, resolution: issue.resolution ? { self: `${jiraBase(ctx)}/rest/api/2/resolution/10000`, ...RESOLUTIONS.find((r) => r.name === issue.resolution) } : null,
    resolutiondate: issue.resolutiondate ? jiraTime(issue.resolutiondate) : null, lastViewed: null, environment: null, timetracking: {},
    watches: { self: `${jiraBase(ctx)}/rest/api/2/issue/${issue.key}/watchers`, watchCount: issue.watchers.length, isWatching: issue.watchers.includes(ME.handle) },
    votes: { self: `${jiraBase(ctx)}/rest/api/2/issue/${issue.key}/votes`, votes: 0, hasVoted: false },
    comment: { comments: issue.comments.map((c) => commentView(c, issue, ctx)), maxResults: issue.comments.length, total: issue.comments.length, startAt: 0 },
    issuelinks: [], subtasks: state.jira.issues.filter((entry) => entry.parent === issue.key).map((entry) => ({ id: entry.id, key: entry.key, self: `${jiraBase(ctx)}/rest/api/2/issue/${entry.id}`,
      fields: { summary: entry.summary, status: statusView(entry.status, ctx), priority: priorityView(entry.priority, ctx), issuetype: issueTypeView(entry.issuetype, ctx) } })),
    ...(parent ? { parent: { id: parent.id, key: parent.key, self: `${jiraBase(ctx)}/rest/api/2/issue/${parent.id}`, fields: { summary: parent.summary, status: statusView(parent.status, ctx), priority: priorityView(parent.priority, ctx), issuetype: issueTypeView(parent.issuetype, ctx) } } } : {}),
    [EPIC_LINK_FIELD]: issue.epicLink, [EPIC_NAME_FIELD]: issue.issuetype === "Epic" ? issue.summary : null, [STORY_POINTS_FIELD]: null,
    ...(issue.application ? { customfield_10500: { value: issue.application } } : {}),
    ...(issue.hardware ? { customfield_10501: { value: issue.hardware } } : {}),
    [REQUEST_TYPE_FIELD]: requestType ? { _links: { jiraRest: `${jiraBase(ctx)}/rest/api/2/issue/${issue.id}` }, requestType: requestTypeView(requestType, ctx), currentStatus: { status: issue.status, statusCategory: status(issue.status).statusCategory.key.toUpperCase(), statusDate: { iso8601: jiraTime(issue.updated) } } } : null,
  };
}
const NAVIGABLE_DEFAULT = ["summary", "issuetype", "project", "status", "priority", "assignee", "reporter", "creator", "created", "updated", "description", "labels", "components", "fixVersions", "versions", "duedate", "resolution", "resolutiondate", "watches", "votes", "issuelinks", "subtasks", "parent", "comment", EPIC_LINK_FIELD, EPIC_NAME_FIELD, STORY_POINTS_FIELD, REQUEST_TYPE_FIELD];
function selectFields(all, fieldsParam) {
  const wanted = String(fieldsParam ?? "*all").split(",").map((f) => f.trim()).filter(Boolean);
  if (!wanted.length || wanted.includes("*all") || wanted.includes("*navigable")) return all;
  const out = {};
  for (const key of wanted) { if (key.startsWith("-")) continue; if (key in all) out[key] = all[key]; }
  return out;
}
const FIELD_DEFS = [
  ["summary", "Summary", "string"], ["issuetype", "Issue Type", "issuetype"], ["project", "Project", "project"], ["status", "Status", "status"], ["priority", "Priority", "priority"],
  ["assignee", "Assignee", "user"], ["reporter", "Reporter", "user"], ["creator", "Creator", "user"], ["created", "Created", "datetime"], ["updated", "Updated", "datetime"],
  ["description", "Description", "string"], ["labels", "Labels", "array"], ["components", "Component/s", "array"], ["fixVersions", "Fix Version/s", "array"], ["versions", "Affects Version/s", "array"],
  ["duedate", "Due Date", "date"], ["resolution", "Resolution", "resolution"], ["resolutiondate", "Resolved", "datetime"], ["comment", "Comment", "comments-page"], ["parent", "Parent", "issuelink"],
  ["issuelinks", "Linked Issues", "array"], ["subtasks", "Sub-Tasks", "array"], ["watches", "Watchers", "watches"], ["votes", "Votes", "votes"],
  [EPIC_LINK_FIELD, "Epic Link", "any", "com.pyxis.greenhopper.jira:gh-epic-link"], [EPIC_NAME_FIELD, "Epic Name", "string", "com.pyxis.greenhopper.jira:gh-epic-label"],
  [STORY_POINTS_FIELD, "Story Points", "number", "com.atlassian.jira.plugin.system.customfieldtypes:float"], ["customfield_10101", "Epic Status", "option", "com.pyxis.greenhopper.jira:gh-epic-status"],
  ["customfield_10104", "Sprint", "array", "com.pyxis.greenhopper.jira:gh-sprint"], [REQUEST_TYPE_FIELD, "Customer Request Type", "sd-customerrequesttype", "com.atlassian.servicedesk:vp-origin"],
  ["customfield_10500", "Application", "option", "com.atlassian.jira.plugin.system.customfieldtypes:select"], ["customfield_10501", "Hardware", "option", "com.atlassian.jira.plugin.system.customfieldtypes:select"],
].map(([id, name, type, custom]) => ({ id, key: id, name, custom: Boolean(custom), orderable: true, navigable: true, searchable: true,
  clauseNames: custom ? [`cf[${id.replace("customfield_", "")}]`, name] : [id], schema: custom ? { type, custom, customId: Number(id.replace("customfield_", "")) } : { type, system: id } }));
function issueView(issue, ctx = {}, options = {}) {
  const all = issueFields(issue, ctx);
  const view = { expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations", id: issue.id, self: `${jiraBase(ctx)}/rest/api/2/issue/${issue.id}`, key: issue.key, fields: selectFields(all, options.fields) };
  const expand = String(options.expand ?? "");
  if (expand.includes("renderedFields")) view.renderedFields = { description: issue.description ? markdownToStorage(wikiToMarkdown(issue.description)) : null };
  if (expand.includes("names")) view.names = Object.fromEntries(FIELD_DEFS.map((f) => [f.id, f.name]));
  if (expand.includes("transitions")) view.transitions = transitionsFor(issue, ctx);
  if (expand.includes("changelog")) view.changelog = { startAt: 0, maxResults: issue.changelog.length, total: issue.changelog.length, histories: issue.changelog.map((entry) => ({ ...entry, author: userView(entry.author, ctx), created: jiraTime(entry.created) })) };
  return view;
}
function transitionsFor(issue, ctx = {}) {
  const project = state.jira.projects.find((p) => p.key === issue.project);
  return WORKFLOWS[project.projectTypeKey].filter(([, to]) => to !== issue.status).map(([id, to]) => ({ id, name: to === "Done" || to === "Resolved" ? (to === "Done" ? "Done" : "Resolve this issue") : to, to: statusView(to, ctx), hasScreen: false, isGlobal: true, isInitial: false, isConditional: false }));
}

function findIssue(idOrKey) {
  const needle = String(idOrKey ?? "").trim().toUpperCase();
  const issue = state.jira.issues.find((entry) => entry.key === needle || entry.id === needle);
  if (!issue) throw new ApiError(404, "Issue Does Not Exist", { errorMessages: ["Issue Does Not Exist"] });
  return issue;
}
function findProject(idOrKey) {
  const needle = String(idOrKey ?? "").trim().toUpperCase();
  const project = state.jira.projects.find((p) => p.key === needle || p.id === needle || p.name.toUpperCase() === needle);
  if (!project) throw new ApiError(404, `No project could be found with key '${idOrKey}'.`, { errorMessages: [`No project could be found with key '${idOrKey}'.`] });
  return project;
}
function recordChange(issue, field, from, to) {
  if (from === to) return;
  issue.changelog.push({ id: String(40000 + issue.changelog.length + Number(issue.id)), author: ME.handle, created: clockNow(), items: [{ field, fieldtype: "jira", from: null, fromString: from ?? null, to: null, toString: to ?? null }] });
}
const userHandle = (value) => {
  if (value === null || value === undefined || value === "" || value === "-1") return null;
  const person = findPerson(value);
  if (!person) throw badRequest("", { assignee: `User '${typeof value === "object" ? JSON.stringify(value) : value}' does not exist.` });
  return person.handle;
};
const nameOf = (value) => (value && typeof value === "object" ? value.name ?? value.value ?? value.id : value);

/** Applies a Jira "fields" object (create or edit) to an issue. */
function applyFields(issue, fields, creating = false) {
  const project = state.jira.projects.find((p) => p.key === issue.project);
  for (const [key, raw] of Object.entries(fields ?? {})) {
    switch (key) {
      case "project": case "issuetype": break;
      case "summary": if (!String(raw ?? "").trim()) throw badRequest("", { summary: "You must specify a summary of the issue." }); recordChange(issue, "summary", issue.summary, raw); issue.summary = String(raw); break;
      case "description": recordChange(issue, "description", issue.description, raw); issue.description = raw === null ? null : String(raw); break;
      case "assignee": { const handle = userHandle(raw); recordChange(issue, "assignee", issue.assignee && userView(issue.assignee).displayName, handle && userView(handle).displayName); issue.assignee = handle; break; }
      case "reporter": issue.reporter = userHandle(raw) ?? issue.reporter; break;
      case "priority": { const found = priority(nameOf(raw)); if (!found) throw badRequest("", { priority: `Priority name '${nameOf(raw)}' is not valid` }); recordChange(issue, "priority", issue.priority, found.name); issue.priority = found.name; break; }
      case "labels": issue.labels = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((label) => String(label).replace(/\s+/g, "_")); break;
      case "components": issue.components = (Array.isArray(raw) ? raw : [raw]).map((c) => { const name = nameOf(c); const found = project.components.find((entry) => entry.name.toLowerCase() === String(name).toLowerCase() || entry.id === String(name)); if (!found) throw badRequest("", { components: `Component name '${name}' is not valid` }); return found.name; }); break;
      case "fixVersions": issue.fixVersions = (Array.isArray(raw) ? raw : [raw]).map((v) => { const name = nameOf(v); const found = project.versions.find((entry) => entry.name === String(name) || entry.id === String(name)); if (!found) throw badRequest("", { fixVersions: `Version name '${name}' is not valid` }); return found.name; }); break;
      case "duedate": issue.duedate = raw ? String(raw).slice(0, 10) : null; break;
      case "parent": { const key2 = nameOf(raw) ?? raw?.key; if (key2) issue.parent = findIssue(key2).key; break; }
      case EPIC_LINK_FIELD: issue.epicLink = raw ? findIssue(raw).key : null; break;
      case EPIC_NAME_FIELD: case STORY_POINTS_FIELD: case "customfield_10500": case "customfield_10501": case "environment": case "timetracking": break;
      default:
        if (!creating) throw badRequest("", { [key]: `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.` });
        throw badRequest("", { [key]: `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.` });
    }
  }
}
function createIssue(fields, ctx = {}) {
  const projectValue = fields?.project?.key ?? fields?.project?.id ?? fields?.project;
  if (!projectValue) throw badRequest("", { project: "project is required" });
  const project = findProject(projectValue);
  const typeName = fields?.issuetype?.name ?? fields?.issuetype?.id ?? fields?.issuetype;
  const type = issueType(typeName);
  if (!type || !project.issueTypes.includes(type.name)) throw badRequest("", { issuetype: "The issue type selected is invalid." });
  if (type.subtask && !fields.parent) throw badRequest("", { parent: "Could not find parent issue. Sub-tasks need a parent." });
  if (!String(fields.summary ?? "").trim()) throw badRequest("", { summary: "You must specify a summary of the issue." });
  state.jira.counters[project.key] += 1;
  const now = clockNow();
  const issue = { id: String(state.jira.nextId++), key: `${project.key}-${state.jira.counters[project.key]}`, project: project.key, issuetype: type.name, summary: "", description: null,
    status: project.projectTypeKey === "service_desk" ? "Waiting for support" : "To Do", priority: "Medium", assignee: null, reporter: ctx.actor ?? ME.handle, creator: ctx.actor ?? ME.handle,
    labels: [], components: [], fixVersions: [], versions: [], duedate: null, parent: null, epicLink: null, created: now, updated: now, resolution: null, resolutiondate: null,
    comments: [], watchers: [ctx.actor ?? ME.handle], changelog: [], requestType: ctx.requestType ?? null, remoteLinks: [] };
  const rest = { ...fields }; delete rest.project; delete rest.issuetype;
  applyFields(issue, rest, true);
  issue.changelog = [];
  state.jira.issues.push(issue);
  touched = true;
  return issue;
}
function transitionIssue(issue, transitionId, fields = {}, comment) {
  const project = state.jira.projects.find((p) => p.key === issue.project);
  const transition = WORKFLOWS[project.projectTypeKey].find(([id, to]) => id === String(transitionId) || to.toLowerCase() === String(transitionId).toLowerCase());
  if (!transition) throw badRequest(`It seems that you have tried to perform a workflow operation (${transitionId}) that is not valid for the current state of this issue (${issue.key}).`, { transition: `Transition id '${transitionId}' is not valid for this issue.` });
  const before = issue.status; issue.status = transition[1];
  recordChange(issue, "status", before, issue.status);
  if (status(issue.status).statusCategory.key === "done") { issue.resolution = nameOf(fields?.resolution) ?? "Done"; issue.resolutiondate = clockNow(); }
  else { issue.resolution = null; issue.resolutiondate = null; }
  const rest = { ...(fields ?? {}) }; delete rest.resolution;
  applyFields(issue, rest);
  if (comment) issue.comments.push(newComment(ME.handle, comment));
  issue.updated = clockNow();
  touched = true;
}

// ── JQL and CQL: one small parser for both ──────────────────────────────────────────────────────────────

function tokenize(query) {
  const tokens = []; let i = 0;
  const text = String(query ?? "");
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "(" || ch === ")" || ch === ",") { tokens.push({ type: ch }); i += 1; continue; }
    if (ch === "\"" || ch === "'") {
      let j = i + 1; let value = "";
      while (j < text.length && text[j] !== ch) { if (text[j] === "\\" && j + 1 < text.length) j += 1; value += text[j]; j += 1; }
      tokens.push({ type: "str", value }); i = j + 1; continue;
    }
    const op = /^(!~|~|!=|>=|<=|=|>|<)/.exec(text.slice(i));
    if (op) { tokens.push({ type: "op", value: op[1] }); i += op[1].length; continue; }
    let j = i; while (j < text.length && !/[\s(),=!~<>"']/.test(text[j])) j += 1;
    const word = text.slice(i, j);
    if (text[j] === "(" && /^[A-Za-z]+$/.test(word)) {
      let depth = 0; let k = j; for (; k < text.length; k += 1) { if (text[k] === "(") depth += 1; if (text[k] === ")") { depth -= 1; if (depth === 0) break; } }
      tokens.push({ type: "fn", name: word, args: text.slice(j + 1, k).split(",").map((arg) => arg.trim().replace(/^["']|["']$/g, "")).filter(Boolean) }); i = k + 1; continue;
    }
    tokens.push({ type: "word", value: word }); i = j;
  }
  return tokens;
}
/** Parses `a = b AND (c ~ "d" OR e in (f, g)) ORDER BY x DESC` into a predicate tree and an order. */
function parseQuery(query) {
  const tokens = tokenize(query); let pos = 0;
  const peekWord = (...words) => tokens[pos]?.type === "word" && words.includes(tokens[pos].value.toUpperCase());
  const value = () => {
    const token = tokens[pos++];
    if (!token) throw badRequest("Error in the JQL Query: Expecting either a value, list or function but got the end of the query.");
    if (token.type === "(") { const values = []; while (tokens[pos] && tokens[pos].type !== ")") { if (tokens[pos].type === ",") { pos += 1; continue; } values.push(value()); } pos += 1; return { list: values }; }
    if (token.type === "fn") return { fn: token.name, args: token.args };
    return token.value;
  };
  const clause = () => {
    if (tokens[pos]?.type === "(") { pos += 1; const inner = or(); pos += 1; return inner; }
    if (peekWord("NOT")) { pos += 1; return { not: clause() }; }
    const fieldToken = tokens[pos++];
    if (!fieldToken) throw badRequest("Error in the JQL Query: The query is incomplete.");
    const field = (fieldToken.value ?? fieldToken.name ?? "").toLowerCase();
    let op;
    if (tokens[pos]?.type === "op") op = tokens[pos++].value;
    else if (peekWord("IN")) { pos += 1; op = "in"; }
    else if (peekWord("NOT") && tokens[pos + 1]?.value?.toUpperCase() === "IN") { pos += 2; op = "not in"; }
    else if (peekWord("IS")) { pos += 1; if (peekWord("NOT")) { pos += 1; op = "is not"; } else op = "is"; }
    else if (peekWord("WAS")) { pos += 1; op = "="; }
    else throw badRequest(`Error in the JQL Query: Expecting operator but got '${tokens[pos]?.value ?? "end of query"}'. The valid operators are '=', '!=', '<', '>', '<=', '>=', '~', '!~', 'IN', 'NOT IN', 'IS' and 'IS NOT'.`);
    return { field, op, value: value() };
  };
  const and = () => { let left = clause(); while (peekWord("AND")) { pos += 1; left = { and: [left, clause()] }; } return left; };
  const or = () => { let left = and(); while (peekWord("OR")) { pos += 1; left = { or: [left, and()] }; } return left; };
  let tree = null; const order = [];
  if (tokens.length && !peekWord("ORDER")) tree = or();
  if (peekWord("ORDER")) {
    pos += 1; if (peekWord("BY")) pos += 1;
    while (pos < tokens.length) {
      const field = tokens[pos++]; if (field.type === ",") continue;
      const dir = peekWord("ASC", "DESC") ? tokens[pos++].value.toUpperCase() : "ASC";
      order.push({ field: String(field.value ?? field.name).toLowerCase(), dir });
    }
  }
  return { tree, order };
}
/** Resolves relative dates: -7d, -2w, startOfDay(-1d), now(), "2026-10-01". */
function dateValue(value) {
  if (value && typeof value === "object" && value.fn) {
    const fn = value.fn.toLowerCase(); const arg = value.args[0];
    const base = fn === "now" ? clockNow() : (() => { const d = new Date(clockNow() + zoneOffsetMinutes(new Date(clockNow())) * 60000); d.setUTCHours(0, 0, 0, 0);
      if (fn === "startofweek") d.setUTCDate(d.getUTCDate() - d.getUTCDay()); if (fn === "startofmonth") d.setUTCDate(1); if (fn === "startofyear") d.setUTCMonth(0, 1);
      return d.getTime() - zoneOffsetMinutes(new Date(clockNow())) * 60000; })();
    return arg ? base + relative(arg) : base;
  }
  const text = String(value);
  if (/^[+-]?\d+[mhdwMy]$/.test(text)) return clockNow() + relative(text);
  const parsed = Date.parse(text.length === 10 ? `${text}T00:00:00` : text.replace(" ", "T"));
  if (!Number.isFinite(parsed)) throw badRequest(`Date value '${text}' for field is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`);
  return parsed;
}
function relative(text) {
  const match = /^([+-]?\d+)([mhdwMy])$/.exec(String(text).trim()); if (!match) return 0;
  const unit = { m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY, M: 30 * DAY, y: 365 * DAY }[match[2]];
  return Number(match[1]) * unit;
}
const words = (text) => String(text ?? "").toLowerCase().replace(/[*?]/g, "").split(/[^a-z0-9äöüß.-]+/i).filter(Boolean);
/** Jira/Confluence-style text match: every search word appears in the text (prefix match, case-insensitive). */
function textMatches(haystack, needle) {
  const terms = words(needle); if (!terms.length) return true;
  const tokens = words(haystack);
  return terms.every((term) => tokens.some((token) => token.startsWith(term) || (term.length > 4 && token.startsWith(term.replace(/(ing|ed|es|s)$/, "")))));
}
function compare(actual, op, expected, kind) {
  const list = expected && typeof expected === "object" && expected.list ? expected.list : null;
  const norm = (v) => (v === null || v === undefined ? null : String(v).toLowerCase());
  if (op === "is" || op === "is not") {
    const empty = actual === null || actual === undefined || (Array.isArray(actual) && !actual.length) || actual === "";
    const wantsEmpty = ["empty", "null"].includes(norm(expected));
    return op === "is" ? empty === wantsEmpty : empty !== wantsEmpty;
  }
  if (kind === "date") {
    if (actual === null || actual === undefined) return false;
    const target = dateValue(expected);
    return op === ">" ? actual > target : op === ">=" ? actual >= target : op === "<" ? actual < target : op === "<=" ? actual <= target : op === "=" ? localDate(actual) === localDate(target) : op === "!=" ? localDate(actual) !== localDate(target) : false;
  }
  if (kind === "text") return op === "~" ? textMatches(actual, expected) : op === "!~" ? !textMatches(actual, expected) : op === "=" ? norm(actual) === norm(expected) : op === "!=" ? norm(actual) !== norm(expected) : false;
  const values = Array.isArray(actual) ? actual.map(norm) : [norm(actual)];
  const candidates = (list ?? [expected]).flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => (v && typeof v === "object" && v.fn ? (v.fn.toLowerCase() === "currentuser" ? ME.handle : norm(v.fn)) : norm(v)));
  const hit = values.some((v) => candidates.includes(v));
  if (op === "=" || op === "in") return hit;
  if (op === "!=" || op === "not in") return !hit && values.some((v) => v !== null);
  if (op === "~") return values.some((v) => candidates.some((c) => v?.includes(c)));
  if (op === "!~") return !values.some((v) => candidates.some((c) => v?.includes(c)));
  if ([">", ">=", "<", "<="].includes(op)) {
    const a = Number(values[0]); const b = Number(candidates[0]);
    return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b;
  }
  return false;
}
function evaluate(tree, resolve) {
  if (!tree) return true;
  if (tree.and) return tree.and.every((part) => evaluate(part, resolve));
  if (tree.or) return tree.or.some((part) => evaluate(part, resolve));
  if (tree.not) return !evaluate(tree.not, resolve);
  const resolved = resolve(tree.field, tree.value);
  if (!resolved) return false;
  return compare(resolved.value, tree.op, "expected" in resolved ? resolved.expected : tree.value, resolved.kind);
}

/** JQL field resolution: values are compared case-insensitively against names, keys and handles. */
function jqlField(issue) {
  const personKeys = (handle) => { if (!handle) return null; const p = PEOPLE.find((entry) => entry.handle === handle); return [p.handle, p.name, p.key.toLowerCase(), p.emailAddress, p.displayName.toLowerCase()]; };
  const userExpected = (expected) => {
    const map = (v) => (v && typeof v === "object" && v.fn ? (v.fn.toLowerCase() === "currentuser" ? ME.handle : v) : (findPerson(v)?.handle ?? v));
    return expected && typeof expected === "object" && expected.list ? { list: expected.list.map(map) } : map(expected);
  };
  return (field, expected) => {
    switch (field) {
      case "project": { const p = state.jira.projects.find((entry) => entry.key === issue.project); return { value: [p.key, p.name, p.id] }; }
      case "key": case "issuekey": case "id": return { value: [issue.key, issue.id] };
      case "status": return { value: [issue.status, status(issue.status).id] };
      case "statuscategory": { const c = status(issue.status).statusCategory; return { value: [c.name, c.key, String(c.id)] }; }
      case "assignee": case "reporter": case "creator": { const handle = issue[field]; return { value: handle ? personKeys(handle) : null, expected: userExpected(expected) }; }
      case "watcher": return { value: issue.watchers, expected: userExpected(expected) };
      case "type": case "issuetype": return { value: [issue.issuetype, issueType(issue.issuetype).id] };
      case "priority": return { value: [issue.priority, priority(issue.priority).id] };
      case "labels": case "label": return { value: issue.labels.length ? issue.labels : null };
      case "component": return { value: issue.components.length ? issue.components : null };
      case "fixversion": return { value: issue.fixVersions.length ? issue.fixVersions : null };
      case "resolution": return { value: issue.resolution ? [issue.resolution] : null, expected: ["unresolved"].includes(String(expected).toLowerCase()) ? null : expected };
      case "parent": return { value: issue.parent ? [issue.parent] : null };
      case "\"epic link\"": case "epic link": case "cf[10100]": case "epiclink": return { value: issue.epicLink ? [issue.epicLink] : null };
      case "summary": return { value: issue.summary, kind: "text" };
      case "description": return { value: issue.description ?? "", kind: "text" };
      case "comment": return { value: issue.comments.map((c) => c.body).join(" "), kind: "text" };
      case "text": return { value: `${issue.key} ${issue.summary} ${issue.description ?? ""} ${issue.comments.map((c) => c.body).join(" ")} ${issue.labels.join(" ")}`, kind: "text" };
      case "created": case "createddate": return { value: issue.created, kind: "date" };
      case "updated": case "updateddate": return { value: issue.updated, kind: "date" };
      case "resolved": case "resolutiondate": return { value: issue.resolutiondate, kind: "date" };
      case "due": case "duedate": return { value: issue.duedate ? Date.parse(`${issue.duedate}T12:00:00`) : null, kind: "date" };
      case "request-type": case "\"customer request type\"": case "customer request type": { const r = REQUEST_TYPES.find((entry) => entry.id === issue.requestType); return { value: r ? [r.name, r.id] : null }; }
      default: throw badRequest(`Field '${field}' does not exist or you do not have permission to view it.`);
    }
  };
}
function jqlSort(order) {
  return (a, b) => {
    for (const { field, dir } of order.length ? order : [{ field: "created", dir: "DESC" }]) {
      const value = (issue) => {
        if (["created", "updated", "resolved", "duedate", "due"].includes(field)) return field === "duedate" || field === "due" ? issue.duedate ?? "" : issue[field === "resolved" ? "resolutiondate" : field] ?? 0;
        if (field === "priority") return Number(priority(issue.priority).id);
        if (field === "key" || field === "issuekey") return Number(issue.id);
        if (field === "rank") return Number(issue.id);
        return String(issue[field] ?? "").toLowerCase();
      };
      const x = value(a); const y = value(b);
      if (x < y) return dir === "DESC" ? 1 : -1; if (x > y) return dir === "DESC" ? -1 : 1;
    }
    return 0;
  };
}
function searchIssues(jql) {
  const { tree, order } = parseQuery(jql);
  return state.jira.issues.filter((issue) => evaluate(tree, jqlField(issue))).sort(jqlSort(order));
}

// ── Confluence: views in the shape of the REST API ──────────────────────────────────────────────────────

const confluenceBase = (ctx) => ctx.restBase ?? `${CONFLUENCE_SITE}`;
function confluenceUser(handle, ctx = {}) {
  const person = typeof handle === "string" ? PEOPLE.find((p) => p.handle === handle) : handle;
  if (!person) return null;
  return { type: "known", username: person.name, userKey: person.userKey, profilePicture: { path: "/images/icons/profilepics/default.svg", width: 48, height: 48, isDefault: true },
    displayName: person.displayName, _links: { self: `${confluenceBase(ctx)}/rest/api/user?key=${person.userKey}` }, _expandable: { status: "" } };
}
function spaceView(space, ctx = {}) {
  return { id: space.id, key: space.key, name: space.name, description: { plain: { value: space.description, representation: "plain" } },
    homepage: space.homepageId ? { id: space.homepageId, type: "page", title: state.confluence.pages.find((p) => p.id === space.homepageId)?.title } : undefined,
    type: "global", status: "current", _links: { webui: `/display/${space.key}`, self: `${confluenceBase(ctx)}/rest/api/space/${space.key}` }, _expandable: { metadata: "", icon: "", permissions: "" } };
}
const pageUrl = (page) => `${CONFLUENCE_SITE}/pages/viewpage.action?pageId=${page.id}`;
function ancestorsOf(page) {
  const chain = []; let current = page;
  while (current?.parentId) { current = state.confluence.pages.find((p) => p.id === current.parentId); if (current) chain.unshift(current); }
  return chain;
}
function contentView(page, ctx = {}, expand = "") {
  const space = state.confluence.spaces.find((s) => s.key === page.spaceKey);
  const want = (key) => expand.split(",").some((part) => part.trim() === key || part.trim().startsWith(`${key}.`));
  const view = { id: page.id, type: page.type, status: page.status, title: page.title };
  if (want("space")) view.space = spaceView(space, ctx);
  if (want("history")) view.history = { latest: true, createdBy: confluenceUser(page.creator, ctx), createdDate: confluenceTime(page.created),
    lastUpdated: { by: confluenceUser(page.lastModifier, ctx), when: confluenceTime(page.lastModified), number: page.version } };
  if (want("version")) view.version = { by: confluenceUser(page.lastModifier, ctx), when: confluenceTime(page.lastModified), message: "", number: page.version, minorEdit: false, hidden: false };
  if (want("ancestors")) view.ancestors = ancestorsOf(page).map((a) => ({ id: a.id, type: "page", status: "current", title: a.title, _links: { webui: `/pages/viewpage.action?pageId=${a.id}` } }));
  if (want("body")) {
    view.body = { storage: { value: page.body, representation: "storage", _expandable: { content: `/rest/api/content/${page.id}` } } };
    if (expand.includes("body.view")) view.body.view = { value: page.body, representation: "view" };
    if (expand.includes("body.export_view")) view.body.export_view = { value: page.body, representation: "export_view" };
  }
  if (want("metadata")) view.metadata = { labels: { results: page.labels.map((name, index) => ({ prefix: "global", name, id: String(1000 + index) })), start: 0, limit: 200, size: page.labels.length }, _expandable: { currentuser: "", properties: "" } };
  if (want("container") && page.containerId) view.container = { id: page.containerId, type: "page", title: state.confluence.pages.find((p) => p.id === page.containerId)?.title };
  view.extensions = page.type === "comment" ? { location: "footer" } : { position: "none" };
  view._links = { webui: page.type === "comment" ? `/pages/viewpage.action?pageId=${page.containerId}&focusedCommentId=${page.id}#comment-${page.id}` : `/pages/viewpage.action?pageId=${page.id}`,
    edit: `/pages/resumedraft.action?draftId=${page.id}`, tinyui: `/x/${Buffer.from(page.id).toString("base64url").slice(0, 6)}`, self: `${confluenceBase(ctx)}/rest/api/content/${page.id}`,
    base: confluenceBase(ctx), context: ctx.restBase ? "/confluence" : "" };
  view._expandable = { children: `/rest/api/content/${page.id}/child`, descendants: `/rest/api/content/${page.id}/descendant`,
    ...(view.space ? {} : { space: `/rest/api/space/${page.spaceKey}` }), ...(view.version ? {} : { version: "" }), ...(view.history ? {} : { history: `/rest/api/content/${page.id}/history` }) };
  return view;
}
function commentAsContent(comment, page) {
  return { id: comment.id, type: "comment", status: "current", title: `Re: ${page.title}`, spaceKey: page.spaceKey, parentId: null, containerId: page.id, body: comment.body,
    version: 1, creator: comment.author, created: comment.created, lastModifier: comment.author, lastModified: comment.created, labels: [], comments: [] };
}
function findPage(id) {
  const needle = String(id ?? "").trim();
  const page = state.confluence.pages.find((p) => p.id === needle && p.status === "current");
  if (!page) throw new ApiError(404, `No content found with id: ContentId{id=${needle}}`, { statusCode: 404, data: { authorized: true, valid: true, errors: [], successful: true }, message: `No content found with id: ContentId{id=${needle}}`, reason: "Not Found" });
  return page;
}
/** CQL field resolution. */
function cqlField(page) {
  return (field, expected) => {
    const body = storageText(page.body);
    switch (field) {
      case "space": case "space.key": return { value: [page.spaceKey] };
      case "type": return { value: [page.type] };
      case "title": return { value: page.title, kind: "text" };
      case "text": case "sitesearch": return { value: `${page.title} ${body} ${page.labels.join(" ")}`, kind: "text" };
      case "label": case "labels": return { value: page.labels.length ? page.labels : null };
      case "id": case "content": return { value: [page.id] };
      case "parent": return { value: page.parentId ? [page.parentId] : null };
      case "ancestor": return { value: ancestorsOf(page).map((a) => a.id) };
      case "creator": case "contributor": { const p = PEOPLE.find((entry) => entry.handle === (field === "creator" ? page.creator : page.lastModifier));
        const exp = expected && typeof expected === "object" && expected.fn?.toLowerCase() === "currentuser" ? ME.handle : (findPerson(expected)?.handle ?? expected);
        return { value: [p.handle, p.name, p.userKey], expected: exp }; }
      case "created": return { value: page.created, kind: "date" };
      case "lastmodified": return { value: page.lastModified, kind: "date" };
      default: throw new ApiError(400, `Could not parse cql : ${field}`, { statusCode: 400, message: `com.atlassian.confluence.api.service.exceptions.BadRequestException: Could not parse cql : ${field}` });
    }
  };
}
function cqlSearch(cql) {
  const { tree, order } = parseQuery(cql);
  const results = state.confluence.pages.filter((page) => page.status === "current" && evaluate(tree, cqlField(page)));
  const key = order[0]?.field ?? "lastmodified"; const dir = order[0]?.dir ?? "DESC";
  const value = (page) => (key === "title" ? page.title.toLowerCase() : key === "created" ? page.created : page.lastModified);
  return results.sort((a, b) => (value(a) < value(b) ? (dir === "DESC" ? 1 : -1) : value(a) > value(b) ? (dir === "DESC" ? -1 : 1) : 0));
}
function excerptOf(page, cql) {
  const text = storageText(page.body); const term = words(/~\s*["']([^"']+)["']/.exec(cql ?? "")?.[1] ?? "")[0];
  const index = term ? text.toLowerCase().indexOf(term) : -1; const start = Math.max(0, index - 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 220)}${text.length > start + 220 ? "…" : ""}`;
}
function savePage(page, { title, body, parentId, versionNumber, message }) {
  if (versionNumber !== undefined && Number(versionNumber) !== page.version + 1) {
    throw new ApiError(409, `Version must be incremented on update. Current version is: ${page.version}`, { statusCode: 409, message: `com.atlassian.confluence.api.service.exceptions.ConflictException: Version must be incremented on update. Current version is: ${page.version}` });
  }
  page.versions.push({ number: page.version, title: page.title, body: page.body, by: page.lastModifier, when: page.lastModified, message: "" });
  if (title !== undefined) {
    const clash = state.confluence.pages.find((p) => p !== page && p.spaceKey === page.spaceKey && p.title.toLowerCase() === String(title).toLowerCase() && p.status === "current" && p.type === "page");
    if (clash) throw new ApiError(400, `A page with this title already exists: A page already exists with the title ${title} in the space with key ${page.spaceKey}`, { statusCode: 400 });
    page.title = String(title);
  }
  if (body !== undefined) page.body = body;
  if (parentId !== undefined && parentId !== null) page.parentId = findPage(parentId).id;
  page.version += 1; page.lastModifier = ME.handle; page.lastModified = clockNow(); page.versionMessage = message ?? "";
  touched = true;
}
function createPage({ spaceKey, title, body, parentId, type = "page" }) {
  const space = state.confluence.spaces.find((s) => s.key === String(spaceKey ?? "").toUpperCase());
  if (!space) throw new ApiError(404, `No space with key : ${spaceKey}`, { statusCode: 404, message: `com.atlassian.confluence.api.service.exceptions.NotFoundException: No space with key : ${spaceKey}` });
  if (!String(title ?? "").trim()) throw new ApiError(400, "Title is required", { statusCode: 400 });
  if (state.confluence.pages.some((p) => p.spaceKey === space.key && p.title.toLowerCase() === String(title).toLowerCase() && p.status === "current" && p.type === "page")) {
    throw new ApiError(400, `A page with this title already exists: A page already exists with the title ${title} in the space with key ${space.key}`, { statusCode: 400 });
  }
  const now = clockNow();
  const page = { id: String(state.confluence.nextId++), type, status: "current", spaceKey: space.key, title: String(title), parentId: parentId ? findPage(parentId).id : space.homepageId,
    body: body ?? "", version: 1, versions: [], creator: ME.handle, created: now, lastModifier: ME.handle, lastModified: now, labels: [], comments: [], views: 0 };
  state.confluence.pages.push(page);
  touched = true;
  return page;
}

// ── REST routing ────────────────────────────────────────────────────────────────────────────────────────

const paged = (items, start, limit) => items.slice(Number(start) || 0, (Number(start) || 0) + (Number(limit) || 50));
function requestTypeView(type, ctx = {}) {
  return { _expands: ["field"], id: type.id, _links: { self: `${jiraBase(ctx)}/rest/servicedeskapi/servicedesk/${type.serviceDeskId}/requesttype/${type.id}` }, name: type.name, description: type.description,
    helpText: type.helpText, issueTypeId: type.issueTypeId, serviceDeskId: type.serviceDeskId, groupIds: type.groupIds, icon: { id: "10508", _links: { iconUrls: {} } } };
}
function customerRequestView(issue, ctx = {}) {
  const desk = SERVICE_DESKS.find((d) => d.projectKey === issue.project);
  const type = REQUEST_TYPES.find((entry) => entry.id === issue.requestType);
  return { _expands: ["participant", "status", "sla", "requestType", "serviceDesk", "attachment", "comment", "action"], issueId: issue.id, issueKey: issue.key, requestTypeId: issue.requestType, serviceDeskId: desk?.id,
    createdDate: { iso8601: jiraTime(issue.created), jira: jiraTime(issue.created), friendly: "Today", epochMillis: issue.created },
    reporter: { key: PEOPLE.find((p) => p.handle === issue.reporter).key, name: PEOPLE.find((p) => p.handle === issue.reporter).name, emailAddress: PEOPLE.find((p) => p.handle === issue.reporter).emailAddress, displayName: PEOPLE.find((p) => p.handle === issue.reporter).displayName, active: true, timeZone: TIME_ZONE },
    requestFieldValues: [{ fieldId: "summary", label: "Summary", value: issue.summary }, { fieldId: "description", label: "Description", value: issue.description ?? "" }],
    currentStatus: { status: issue.status, statusCategory: status(issue.status).statusCategory.key.toUpperCase(), statusDate: { iso8601: jiraTime(issue.updated), epochMillis: issue.updated } },
    requestType: type ? requestTypeView(type, ctx) : undefined,
    _links: { jiraRest: `${jiraBase(ctx)}/rest/api/2/issue/${issue.id}`, web: `${JIRA_SITE}/servicedesk/customer/portal/${desk?.id}/${issue.key}`, self: `${jiraBase(ctx)}/rest/servicedeskapi/request/${issue.id}` } };
}

async function jiraRest(method, path, query, body, ctx) {
  let m;
  if (path === "/rest/api/2/serverInfo") return { baseUrl: JIRA_SITE, version: JIRA_VERSION, versionNumbers: JIRA_VERSION.split(".").map(Number), deploymentType: "Server", buildNumber: 912015, buildDate: "2026-08-20T00:00:00.000+0000", serverTime: jiraTime(clockNow()), scmInfo: "demo", serverTitle: "Acme Robotics Jira" };
  if (path === "/rest/api/2/myself") return { ...userView(ME, ctx), groups: { size: 2, items: [] }, applicationRoles: { size: 1, items: [] }, expand: "groups,applicationRoles" };
  if (path === "/rest/api/2/user") { const person = findPerson(query.get("username") ?? query.get("key") ?? query.get("accountId")); if (!person) throw new ApiError(404, `The user named '${query.get("username") ?? query.get("key")}' does not exist`, { errorMessages: [`The user named '${query.get("username") ?? query.get("key")}' does not exist`] }); return userView(person, ctx); }
  if (path === "/rest/api/2/user/search" || path === "/rest/api/2/user/picker" || path === "/rest/api/2/user/assignable/search" || path === "/rest/api/2/user/assignable/multiProjectSearch") {
    const needle = String(query.get("username") ?? query.get("query") ?? "").toLowerCase();
    const users = PEOPLE.filter((p) => !needle || needle === "." || [p.name, p.displayName.toLowerCase(), p.emailAddress, p.key.toLowerCase()].some((v) => v.includes(needle)));
    const limited = paged(users, query.get("startAt"), query.get("maxResults") ?? 50).map((p) => userView(p, ctx));
    return path.endsWith("picker") ? { users: limited.map((u) => ({ name: u.name, key: u.key, html: u.displayName, displayName: u.displayName })), total: limited.length, header: `Showing ${limited.length} of ${users.length} matching users` } : limited;
  }
  if (path === "/rest/api/2/project" && method === "GET") return state.jira.projects.map((p) => { const v = projectView(p, ctx); delete v.components; delete v.issueTypes; delete v.versions; delete v.roles; return v; });
  if ((m = /^\/rest\/api\/2\/project\/([^/]+)$/.exec(path))) return projectView(findProject(m[1]), ctx);
  if ((m = /^\/rest\/api\/2\/project\/([^/]+)\/statuses$/.exec(path))) {
    const project = findProject(m[1]); const names = WORKFLOWS[project.projectTypeKey].map(([, to]) => to);
    return project.issueTypes.map((name) => ({ ...issueTypeView(name, ctx), statuses: names.map((n) => statusView(n, ctx)) }));
  }
  if ((m = /^\/rest\/api\/2\/project\/([^/]+)\/(components|versions)$/.exec(path))) { const project = findProject(m[1]); return m[2] === "components" ? projectView(project, ctx).components : projectView(project, ctx).versions; }
  if ((m = /^\/rest\/api\/2\/issue\/createmeta\/([^/]+)\/issuetypes$/.exec(path))) { const project = findProject(m[1]); const values = project.issueTypes.map((name) => issueTypeView(name, ctx)); return { maxResults: 50, startAt: 0, total: values.length, isLast: true, values }; }
  if ((m = /^\/rest\/api\/2\/issue\/createmeta\/([^/]+)\/issuetypes\/([^/]+)$/.exec(path))) {
    findProject(m[1]); const type = issueType(m[2]);
    const fields = ["summary", "issuetype", "project", "reporter", "assignee", "priority", "description", "labels", "components", "fixVersions", "duedate", ...(type?.subtask ? ["parent"] : []), ...(type?.name === "Epic" ? [EPIC_NAME_FIELD] : [EPIC_LINK_FIELD])];
    const values = fields.map((id) => { const def = FIELD_DEFS.find((f) => f.id === id); return { required: ["summary", "issuetype", "project", "reporter", ...(type?.subtask ? ["parent"] : []), ...(type?.name === "Epic" ? [EPIC_NAME_FIELD] : [])].includes(id), schema: def.schema, name: def.name, fieldId: id, hasDefaultValue: id === "priority", operations: ["set"],
      ...(id === "priority" ? { allowedValues: PRIORITIES.map((p) => priorityView(p.name, ctx)), defaultValue: priorityView("Medium", ctx) } : {}) }; });
    return { maxResults: 50, startAt: 0, total: values.length, isLast: true, values };
  }
  if (path === "/rest/api/2/issue/createmeta") {
    const keys = (query.get("projectKeys") ?? "").split(",").filter(Boolean);
    return { expand: "projects", projects: state.jira.projects.filter((p) => !keys.length || keys.includes(p.key)).map((p) => ({ ...projectRef(p.key, ctx), issuetypes: p.issueTypes.map((name) => ({ ...issueTypeView(name, ctx), expand: "fields" })) })) };
  }
  if (path === "/rest/api/2/field") return FIELD_DEFS;
  if (path === "/rest/api/2/priority") return PRIORITIES.map((p) => priorityView(p.name, ctx));
  if (path === "/rest/api/2/status") return STATUSES.map((s) => statusView(s.name, ctx));
  if (path === "/rest/api/2/issuetype") return ISSUE_TYPES.map((t) => issueTypeView(t.name, ctx));
  if (path === "/rest/api/2/resolution") return RESOLUTIONS.map((r) => ({ self: `${jiraBase(ctx)}/rest/api/2/resolution/${r.id}`, ...r }));
  if (path === "/rest/api/2/issueLinkType") return { issueLinkTypes: [{ id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" }, { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" }, { id: "10002", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" }] };
  if (path === "/rest/api/2/search" || path === "/rest/api/2/search/") {
    const params = method === "POST" ? body ?? {} : { jql: query.get("jql"), startAt: query.get("startAt"), maxResults: query.get("maxResults"), fields: query.get("fields"), expand: query.get("expand") };
    const fields = Array.isArray(params.fields) ? params.fields.join(",") : params.fields ?? NAVIGABLE_DEFAULT.join(",");
    const issues = searchIssues(params.jql ?? "");
    const startAt = Number(params.startAt ?? 0); const maxResults = Math.min(Number(params.maxResults ?? 50), 1000);
    const expand = Array.isArray(params.expand) ? params.expand.join(",") : params.expand;
    return { expand: "schema,names", startAt, maxResults, total: issues.length, issues: issues.slice(startAt, startAt + maxResults).map((issue) => issueView(issue, ctx, { fields, expand })),
      ...(String(expand ?? "").includes("names") ? { names: Object.fromEntries(FIELD_DEFS.map((f) => [f.id, f.name])) } : {}) };
  }
  if (path === "/rest/api/2/issue" && method === "POST") { const issue = createIssue(body?.fields ?? {}, ctx); return { status: 201, body: { id: issue.id, key: issue.key, self: `${jiraBase(ctx)}/rest/api/2/issue/${issue.id}` } }; }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (method === "GET") return issueView(issue, ctx, { fields: query.get("fields") ?? "*all", expand: query.get("expand") });
    if (method === "PUT") {
      applyFields(issue, body?.fields ?? {});
      for (const [field, operations] of Object.entries(body?.update ?? {})) for (const operation of operations) {
        if (field === "labels") { if (operation.add) issue.labels.push(operation.add); if (operation.remove) issue.labels = issue.labels.filter((l) => l !== operation.remove); if (operation.set) issue.labels = operation.set; }
        else if (field === "comment" && operation.add) issue.comments.push(newComment(ME.handle, operation.add.body));
        else applyFields(issue, { [field]: operation.set ?? operation.add });
      }
      issue.updated = clockNow(); touched = true; return { status: 204 };
    }
    if (method === "DELETE") { if (state.jira.issues.some((entry) => entry.parent === issue.key) && query.get("deleteSubtasks") !== "true") throw badRequest("The issue has subtasks; set deleteSubtasks=true to delete them."); state.jira.issues = state.jira.issues.filter((entry) => entry !== issue && entry.parent !== issue.key); touched = true; return { status: 204 }; }
  }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/assignee$/.exec(path)) && method === "PUT") { const issue = findIssue(m[1]); applyFields(issue, { assignee: body?.name ?? body?.accountId ?? body?.key ?? null }); issue.updated = clockNow(); touched = true; return { status: 204 }; }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (method === "POST") { if (!String(body?.body ?? "").trim()) throw badRequest("", { comment: "Comment body can not be empty!" }); const comment = newComment(ME.handle, String(body.body)); issue.comments.push(comment); issue.updated = clockNow(); touched = true; return { status: 201, body: commentView(comment, issue, ctx) }; }
    const comments = issue.comments.map((c) => commentView(c, issue, ctx)); const startAt = Number(query.get("startAt") ?? 0); const maxResults = Number(query.get("maxResults") ?? 50);
    return { startAt, maxResults, total: comments.length, comments: comments.slice(startAt, startAt + maxResults) };
  }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/comment\/([^/]+)$/.exec(path))) {
    const issue = findIssue(m[1]); const comment = issue.comments.find((c) => c.id === m[2]); if (!comment) throw notFound("Can not find a comment for the id: " + m[2] + ".");
    if (method === "PUT") { comment.body = String(body?.body ?? comment.body); comment.updated = clockNow(); touched = true; }
    if (method === "DELETE") { issue.comments = issue.comments.filter((c) => c !== comment); touched = true; return { status: 204 }; }
    return commentView(comment, issue, ctx);
  }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/transitions$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (method === "POST") { transitionIssue(issue, body?.transition?.id ?? body?.transition?.name, body?.fields, body?.update?.comment?.[0]?.add?.body); return { status: 204 }; }
    return { expand: "transitions", transitions: transitionsFor(issue, ctx) };
  }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/watchers$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (method === "POST") { const handle = userHandle(typeof body === "string" ? body : ME.handle); if (!issue.watchers.includes(handle)) issue.watchers.push(handle); touched = true; return { status: 204 }; }
    if (method === "DELETE") { const handle = userHandle(query.get("username") ?? query.get("accountId")); issue.watchers = issue.watchers.filter((w) => w !== handle); touched = true; return { status: 204 }; }
    return { self: `${jiraBase(ctx)}/rest/api/2/issue/${issue.key}/watchers`, isWatching: issue.watchers.includes(ME.handle), watchCount: issue.watchers.length, watchers: issue.watchers.map((h) => userView(h, ctx)) };
  }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/remotelink$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (method === "POST") { const link = { id: 10000 + issue.remoteLinks.length, self: "", object: body?.object ?? {}, globalId: body?.globalId ?? null }; issue.remoteLinks.push(link); touched = true; return { status: 201, body: { id: link.id, self: link.self } }; }
    return issue.remoteLinks;
  }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/(worklog|votes|properties)$/.exec(path))) { findIssue(m[1]); return m[2] === "worklog" ? { startAt: 0, maxResults: 0, total: 0, worklogs: [] } : m[2] === "votes" ? { votes: 0, hasVoted: false, voters: [] } : { keys: [] }; }
  if ((m = /^\/rest\/api\/2\/issue\/([^/]+)\/changelog$/.exec(path))) { const issue = findIssue(m[1]); return { startAt: 0, maxResults: 100, total: issue.changelog.length, values: issue.changelog.map((entry) => ({ ...entry, author: userView(entry.author, ctx), created: jiraTime(entry.created) })) }; }
  // Jira Service Management.
  if (path === "/rest/servicedeskapi/info") return { version: "5.12.15", platformVersion: JIRA_VERSION, buildDate: { iso8601: "2026-08-20T00:00:00+0000" }, buildChangeSet: "demo", isLicensedForUse: true, _links: { self: `${jiraBase(ctx)}/rest/servicedeskapi/info` } };
  if (path === "/rest/servicedeskapi/servicedesk" || path === "/rest/servicedeskapi/servicedesk/") return { size: SERVICE_DESKS.length, start: 0, limit: 50, isLastPage: true, values: SERVICE_DESKS.map((d) => ({ ...d, _links: { self: `${jiraBase(ctx)}/rest/servicedeskapi/servicedesk/${d.id}` } })) };
  if ((m = /^\/rest\/servicedeskapi\/servicedesk\/(?:projectKey:)?([^/]+)$/.exec(path))) { const desk = SERVICE_DESKS.find((d) => d.id === m[1] || d.projectKey === m[1].toUpperCase()); if (!desk) throw notFound("The service desk does not exist."); return { ...desk, _links: { self: `${jiraBase(ctx)}/rest/servicedeskapi/servicedesk/${desk.id}` } }; }
  if ((m = /^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/requesttype$/.exec(path))) {
    if (!SERVICE_DESKS.some((d) => d.id === m[1])) throw notFound("The service desk does not exist.");
    const values = paged(REQUEST_TYPES.filter((t) => t.serviceDeskId === m[1] && (!query.get("searchQuery") || textMatches(`${t.name} ${t.description}`, query.get("searchQuery")))), query.get("start"), query.get("limit"));
    return { _expands: [], size: values.length, start: Number(query.get("start") ?? 0), limit: Number(query.get("limit") ?? 50), isLastPage: true, values: values.map((t) => requestTypeView(t, ctx)) };
  }
  if ((m = /^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/requesttype\/([^/]+)\/field$/.exec(path))) {
    const type = REQUEST_TYPES.find((t) => t.serviceDeskId === m[1] && t.id === m[2]); if (!type) throw notFound("The request type does not exist.");
    return { requestTypeFields: type.fields.map((id) => REQUEST_FIELDS[id]), canRaiseOnBehalfOf: true, canAddRequestParticipants: true };
  }
  if ((m = /^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/queue$/.exec(path))) {
    const queues = [["1", "All open", "resolution = Unresolved"], ["2", "Assigned to me", "assignee = currentUser() AND resolution = Unresolved"], ["3", "Waiting for support", "status = \"Waiting for support\""], ["4", "Recently resolved", "resolution != Unresolved"]];
    return { size: queues.length, start: 0, limit: 50, isLastPage: true, values: queues.map(([id, name, jql]) => ({ id, name, jql: `project = ITSD AND ${jql}`, fields: ["issuetype", "issuekey", "summary", "reporter", "assignee", "status", "created"], issueCount: searchIssues(`project = ITSD AND ${jql}`).length })) };
  }
  if ((m = /^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/queue\/([^/]+)\/issue$/.exec(path))) {
    const jql = { 1: "resolution = Unresolved", 2: "assignee = currentUser() AND resolution = Unresolved", 3: "status = \"Waiting for support\"", 4: "resolution != Unresolved" }[m[2]];
    if (!jql) throw notFound("The queue does not exist."); const issues = searchIssues(`project = ITSD AND ${jql}`);
    return { size: issues.length, start: 0, limit: 50, isLastPage: true, values: issues.map((issue) => ({ id: issue.id, key: issue.key, fields: issueFields(issue, ctx) })) };
  }
  if (path === "/rest/servicedeskapi/request" && method === "POST") {
    const desk = SERVICE_DESKS.find((d) => d.id === String(body?.serviceDeskId)); if (!desk) throw notFound("The service desk does not exist.");
    const type = REQUEST_TYPES.find((t) => t.serviceDeskId === desk.id && t.id === String(body?.requestTypeId)); if (!type) throw badRequest("The request type does not exist.");
    const values = body?.requestFieldValues ?? {};
    for (const id of type.fields) if (REQUEST_FIELDS[id].required && (values[id] === undefined || values[id] === "")) throw badRequest(`Field '${REQUEST_FIELDS[id].name}' is required.`, { [id]: `${REQUEST_FIELDS[id].name} is required.` });
    for (const id of Object.keys(values)) if (!type.fields.includes(id)) throw badRequest(`The field '${id}' is not valid for request type '${type.name}'.`);
    const onBehalf = body?.raiseOnBehalfOf ? userHandle(body.raiseOnBehalfOf) : null;
    const select = (id) => { const raw = values[id]; if (raw === undefined) return null; const label = nameOf(raw); const found = REQUEST_FIELDS[id].validValues.find((v) => v.value === String(label) || v.label.toLowerCase() === String(label).toLowerCase()); if (!found) throw badRequest(`'${label}' is not a valid option for ${REQUEST_FIELDS[id].name}.`); return found.label; };
    const application = type.fields.includes("customfield_10500") ? select("customfield_10500") : null; const hardware = type.fields.includes("customfield_10501") ? select("customfield_10501") : null;
    const issue = createIssue({ project: { key: desk.projectKey }, issuetype: { id: type.issueTypeId }, summary: values.summary, description: values.description ?? null,
      ...(type.id === "11" ? { priority: { name: "High" } } : {}) }, { ...ctx, actor: onBehalf ?? ME.handle, requestType: type.id });
    issue.application = application; issue.hardware = hardware;
    for (const participant of body?.requestParticipants ?? []) { const handle = userHandle(participant); if (!issue.watchers.includes(handle)) issue.watchers.push(handle); }
    const view = customerRequestView(issue, ctx);
    if (application) view.requestFieldValues.push({ fieldId: "customfield_10500", label: "Application", value: { value: application } });
    if (hardware) view.requestFieldValues.push({ fieldId: "customfield_10501", label: "Hardware", value: { value: hardware } });
    return { status: 201, body: view };
  }
  if ((m = /^\/rest\/servicedeskapi\/request\/([^/]+)$/.exec(path))) return customerRequestView(findIssue(m[1]), ctx);
  if ((m = /^\/rest\/servicedeskapi\/request\/([^/]+)\/comment$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (method === "POST") { const comment = newComment(ME.handle, String(body?.body ?? "")); comment.public = body?.public !== false; issue.comments.push(comment); issue.updated = clockNow(); touched = true; return { status: 201, body: { id: comment.id, body: comment.body, public: comment.public, author: userView(ME, ctx), created: { iso8601: jiraTime(comment.created), epochMillis: comment.created } } }; }
    return { size: issue.comments.length, start: 0, limit: 50, isLastPage: true, values: issue.comments.map((c) => ({ id: c.id, body: c.body, public: c.public !== false, author: userView(c.author, ctx), created: { iso8601: jiraTime(c.created), epochMillis: c.created } })) };
  }
  if ((m = /^\/rest\/servicedeskapi\/request\/([^/]+)\/(status|sla|participant|approval|attachment)$/.exec(path))) {
    const issue = findIssue(m[1]);
    if (m[2] === "status") return { size: 1, start: 0, limit: 50, isLastPage: true, values: [customerRequestView(issue, ctx).currentStatus] };
    if (m[2] === "sla") return { size: 1, start: 0, limit: 50, isLastPage: true, values: [{ id: "1", name: "Time to first response", completedCycles: [], ongoingCycle: { startTime: { iso8601: jiraTime(issue.created), epochMillis: issue.created }, breachTime: { iso8601: jiraTime(issue.created + 8 * HOUR), epochMillis: issue.created + 8 * HOUR }, breached: clockNow() > issue.created + 8 * HOUR, paused: false, withinCalendarHours: true, goalDuration: { millis: 8 * HOUR, friendly: "8h" }, elapsedTime: { millis: clockNow() - issue.created }, remainingTime: { millis: issue.created + 8 * HOUR - clockNow() } } }] };
    if (m[2] === "participant") return { size: issue.watchers.length, start: 0, limit: 50, isLastPage: true, values: issue.watchers.map((h) => userView(h, ctx)) };
    return { size: 0, start: 0, limit: 50, isLastPage: true, values: [] };
  }
  throw new ApiError(404, "null for uri: " + path, { errorMessages: [`null for uri: ${path}`] });
}

async function confluenceRest(method, path, query, body, ctx) {
  let m;
  const expand = query.get("expand") ?? "";
  if (path === "/rest/api/user/current") return { ...confluenceUser(ME, ctx), _expandable: { status: "", operations: "", details: "" } };
  if (path === "/rest/api/user" || path === "/rest/api/user/") { const person = findPerson(query.get("username") ?? query.get("key") ?? query.get("accountId")); if (!person) throw notFound(`No user found with username: ${query.get("username") ?? query.get("key")}`); return confluenceUser(person, ctx); }
  if ((m = /^\/rest\/api\/group\/([^/]+)\/member$/.exec(path))) {
    const values = paged(PEOPLE, query.get("start"), query.get("limit") ?? 200).map((p) => confluenceUser(p, ctx));
    return { results: values, start: Number(query.get("start") ?? 0), limit: Number(query.get("limit") ?? 200), size: values.length, _links: { self: `${confluenceBase(ctx)}/rest/api/group/${m[1]}/member` } };
  }
  if (path === "/rest/api/space" || path === "/rest/api/space/") {
    const keys = query.getAll("spaceKey"); const spaces = state.confluence.spaces.filter((s) => !keys.length || keys.includes(s.key));
    return { results: paged(spaces, query.get("start"), query.get("limit") ?? 25).map((s) => spaceView(s, ctx)), start: Number(query.get("start") ?? 0), limit: Number(query.get("limit") ?? 25), size: spaces.length, _links: { self: `${confluenceBase(ctx)}/rest/api/space` } };
  }
  if ((m = /^\/rest\/api\/space\/([^/]+)$/.exec(path))) { const space = state.confluence.spaces.find((s) => s.key === m[1].toUpperCase()); if (!space) throw notFound(`No space with key : ${m[1]}`); return spaceView(space, ctx); }
  if ((m = /^\/rest\/api\/space\/([^/]+)\/content(?:\/(page|blogpost))?$/.exec(path))) {
    const pages = state.confluence.pages.filter((p) => p.spaceKey === m[1].toUpperCase() && p.type === "page" && p.status === "current" && (query.get("depth") !== "root" || !p.parentId));
    const results = paged(pages, query.get("start"), query.get("limit") ?? 25).map((p) => contentView(p, ctx, expand));
    const pageResult = { results, start: Number(query.get("start") ?? 0), limit: Number(query.get("limit") ?? 25), size: results.length, _links: {} };
    return m[2] ? pageResult : { page: pageResult, blogpost: { results: [], start: 0, limit: 25, size: 0, _links: {} }, _links: {} };
  }
  if ((path === "/rest/api/content" || path === "/rest/api/content/") && method === "GET") {
    const spaceKey = query.get("spaceKey"); const title = query.get("title"); const type = query.get("type") ?? "page";
    const pages = state.confluence.pages.filter((p) => p.status === "current" && p.type === type && (!spaceKey || p.spaceKey === spaceKey.toUpperCase()) && (!title || p.title === title));
    const results = paged(pages, query.get("start"), query.get("limit") ?? 25).map((p) => contentView(p, ctx, expand));
    return { results, start: Number(query.get("start") ?? 0), limit: Number(query.get("limit") ?? 25), size: results.length, _links: { self: `${confluenceBase(ctx)}/rest/api/content` } };
  }
  if ((path === "/rest/api/content" || path === "/rest/api/content/") && method === "POST") {
    const storage = body?.body?.storage?.value ?? body?.body?.editor?.value ?? body?.body?.wiki?.value ?? "";
    if (body?.type === "comment") {
      const page = findPage(body?.container?.id); const comment = { id: String(state.confluence.nextId++), author: ME.handle, body: storage, created: clockNow(), parentCommentId: body?.ancestors?.[0]?.id ?? null };
      page.comments.push(comment); touched = true; return contentView(commentAsContent(comment, page), ctx, "body.storage,version,container");
    }
    const page = createPage({ spaceKey: body?.space?.key, title: body?.title, body: storage, parentId: body?.ancestors?.[0]?.id, type: body?.type ?? "page" });
    return contentView(page, ctx, "body.storage,version,space,ancestors,history");
  }
  if ((path === "/rest/api/content/search" || path === "/rest/api/search") && method === "GET") {
    const cql = query.get("cql") ?? ""; const start = Number(query.get("start") ?? 0); const limit = Math.min(Number(query.get("limit") ?? 25), 100);
    const pages = cqlSearch(cql);
    if (path === "/rest/api/content/search") return { results: pages.slice(start, start + limit).map((p) => contentView(p, ctx, expand)), start, limit, size: Math.min(limit, Math.max(0, pages.length - start)), totalSize: pages.length, cqlQuery: cql, searchDuration: 7, _links: { self: `${confluenceBase(ctx)}/rest/api/content/search` } };
    const contentExpand = expand.split(",").map((part) => part.trim().replace(/^content\./, "")).join(",");
    return { results: pages.slice(start, start + limit).map((p) => ({ content: contentView(p, ctx, contentExpand), title: p.title, excerpt: excerptOf(p, cql), url: `/pages/viewpage.action?pageId=${p.id}`,
      resultGlobalContainer: { title: state.confluence.spaces.find((s) => s.key === p.spaceKey).name, displayUrl: `/display/${p.spaceKey}` }, entityType: "content", iconCssClass: "aui-icon content-type-page",
      lastModified: confluenceTime(p.lastModified), friendlyLastModified: "recently", score: 1 })), start, limit, size: Math.min(limit, Math.max(0, pages.length - start)), totalSize: pages.length, cqlQuery: cql, searchDuration: 9, _links: { base: confluenceBase(ctx), context: "/confluence" } };
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)$/.exec(path))) {
    const page = findPage(m[1]);
    if (method === "GET") {
      const wantedVersion = query.get("version");
      if (wantedVersion && Number(wantedVersion) !== page.version) { const old = page.versions.find((v) => v.number === Number(wantedVersion)); if (!old) throw notFound(`No content found with id ${page.id} and version ${wantedVersion}`); return contentView({ ...page, title: old.title, body: old.body, version: old.number, lastModifier: old.by, lastModified: old.when }, ctx, expand); }
      return contentView(page, ctx, expand);
    }
    if (method === "PUT") {
      const storage = body?.body?.storage?.value ?? body?.body?.editor?.value;
      savePage(page, { title: body?.title, body: storage, parentId: body?.ancestors?.[0]?.id, versionNumber: body?.version?.number, message: body?.version?.message });
      return contentView(page, ctx, "body.storage,version,space,ancestors");
    }
    if (method === "DELETE") { page.status = "trashed"; touched = true; return { status: 204 }; }
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/child$/.exec(path))) { const page = findPage(m[1]); const children = state.confluence.pages.filter((p) => p.parentId === page.id && p.status === "current"); return { page: { results: children.map((p) => contentView(p, ctx, expand)), start: 0, limit: 25, size: children.length } }; }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/child\/page$/.exec(path))) {
    const page = findPage(m[1]); const children = state.confluence.pages.filter((p) => p.parentId === page.id && p.status === "current" && p.type === "page");
    const results = paged(children, query.get("start"), query.get("limit") ?? 25).map((p) => contentView(p, ctx, expand));
    return { results, start: Number(query.get("start") ?? 0), limit: Number(query.get("limit") ?? 25), size: results.length, _links: { self: `${confluenceBase(ctx)}/rest/api/content/${page.id}/child/page` } };
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/(?:child|descendant)\/comment$/.exec(path))) {
    const page = findPage(m[1]); const results = page.comments.map((c) => contentView(commentAsContent(c, page), ctx, `${expand},body.storage`));
    return { results, start: 0, limit: 25, size: results.length, _links: { self: `${confluenceBase(ctx)}/rest/api/content/${page.id}/child/comment` } };
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/(?:child|descendant)\/attachment$/.exec(path))) { findPage(m[1]); return { results: [], start: 0, limit: 50, size: 0, _links: {} }; }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/descendant\/page$/.exec(path))) {
    const page = findPage(m[1]); const results = state.confluence.pages.filter((p) => p.status === "current" && p.type === "page" && ancestorsOf(p).some((a) => a.id === page.id));
    return { results: results.map((p) => contentView(p, ctx, expand)), start: 0, limit: results.length, size: results.length, _links: {} };
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/label$/.exec(path))) {
    const page = findPage(m[1]);
    if (method === "POST") {
      for (const label of Array.isArray(body) ? body : [body]) { const name = String(label?.name ?? "").toLowerCase().trim(); if (!name || /\s/.test(name)) throw badRequest("Label names cannot contain spaces."); if (!page.labels.includes(name)) page.labels.push(name); }
      touched = true;
    }
    if (method === "DELETE") { page.labels = page.labels.filter((l) => l !== query.get("name")); touched = true; return { status: 204 }; }
    return { results: page.labels.map((name, index) => ({ prefix: "global", name, id: String(1000 + index), label: name })), start: 0, limit: 200, size: page.labels.length, _links: { self: `${confluenceBase(ctx)}/rest/api/content/${page.id}/label` } };
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/history$/.exec(path))) { const page = findPage(m[1]); return contentView(page, ctx, "history").history; }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/version$/.exec(path))) {
    const page = findPage(m[1]);
    const all = [{ number: page.version, by: page.lastModifier, when: page.lastModified, message: page.versionMessage ?? "" }, ...[...page.versions].reverse().map((v) => ({ number: v.number, by: v.by, when: v.when, message: v.message }))];
    return { results: all.map((v) => ({ by: confluenceUser(v.by, ctx), when: confluenceTime(v.when), message: v.message, number: v.number, minorEdit: false, hidden: false })), start: 0, limit: 200, size: all.length };
  }
  if ((m = /^\/rest\/api\/content\/([^/]+)\/property$/.exec(path))) { findPage(m[1]); return { results: [], start: 0, limit: 10, size: 0 }; }
  if ((m = /^\/rest\/api\/analytics\/content\/([^/]+)\/views$/.exec(path))) { const page = findPage(m[1]); return { id: Number(page.id), count: page.views }; }
  if (path === "/rest/api/contentbody/convert/storage" && method === "POST") return { value: body?.representation === "wiki" ? markdownToStorage(wikiToMarkdown(body.value)) : String(body?.value ?? ""), representation: "storage" };
  if (path === "/rest/api/settings/systemInfo" || path === "/rest/applinks/1.0/manifest") return { version: CONFLUENCE_VERSION, buildNumber: "8804" };
  throw new ApiError(404, `null for uri: ${path}`, { statusCode: 404, message: `null for uri: ${path}` });
}

// ── MCP: the mcp-atlassian tool surface ─────────────────────────────────────────────────────────────────
//
// Tool definitions are mcp-atlassian 3.4.9's, verbatim. Results, error texts and argument validation match what it
// returns when pointed at this server's REST API, so prompts and skills written against the real server work here.

class ToolError extends Error {}
const strArg = (args, key, required = true) => {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") { if (required) throw new ToolError(`Missing required argument '${key}'.`); return undefined; }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};
const intArg = (args, key, fallback, min = 0, max = Infinity) => {
  const value = args?.[key]; if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value); if (!Number.isInteger(parsed)) throw new ToolError(`'${key}' must be an integer.`);
  return Math.min(max, Math.max(min, parsed));
};
const boolArg = (args, key, fallback) => { const value = args?.[key]; if (value === undefined || value === null) return fallback; return value === true || value === "true"; };
const jsonArg = (args, key) => {
  const value = args?.[key]; if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { throw new ToolError(`Invalid JSON in ${key}`); }
};
const csv = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : String(value).split(",").map((part) => part.trim()).filter(Boolean));
/** Runs a REST handler in-process. REST errors become tool errors worded like mcp-atlassian's. */
async function call(kind, method, path, { query = {}, body } = {}) {
  const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
  try {
    const result = await (kind === "jira" ? jiraRest : confluenceRest)(method, path, params, body, {});
    return result && typeof result === "object" && "status" in result && typeof result.status === "number" && Object.keys(result).length <= 2 ? result.body : result;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const issueKey = /^\/rest\/api\/2\/issue\/([^/]+)/.exec(path)?.[1];
    if (error.status === 404 && issueKey && error.message === "Issue Does Not Exist") throw new ToolError(`Issue ${issueKey} not found. Verify the issue key and project access.`);
    const fieldErrors = Object.values(error.extra?.errors ?? {}).filter(Boolean);
    throw new ToolError([error.message, ...fieldErrors].filter(Boolean).join("\n") || `HTTP ${error.status}`);
  }
}

// mcp-atlassian's simplified models, matched field for field against mcp-atlassian 3.4 talking to this server.
const ZONE_NAME = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "short" }).formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")?.value ?? "";
/** "2026-10-16 17:23:18 PDT", the way mcp-atlassian formats Jira and Confluence timestamps. */
function displayTime(value) {
  if (!value) return "";
  const ms = Date.parse(String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2")); if (!Number.isFinite(ms)) return String(value);
  const local = new Date(ms + zoneOffsetMinutes(new Date(ms)) * 60000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 19)} ${ZONE_NAME(ms)}`;
}
/** "2026-10-16 17:23:18.611000-07:00" (Python isoformat), used by jira_add_comment. */
function pythonIsoTime(value) {
  const ms = Date.parse(String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  const iso = confluenceTime(ms);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000${iso.slice(23)}`;
}
const simpleUser = (user) => (user ? { account_id: null, display_name: user.displayName, name: user.name, email: user.emailAddress, avatar_url: user.avatarUrls?.["48x48"], key: user.key } : null);
const simpleStatus = (s) => ({ name: s.name, category: s.statusCategory?.name, color: s.statusCategory?.colorName });
const CUSTOM_FIELD_IDS = [EPIC_LINK_FIELD, EPIC_NAME_FIELD, STORY_POINTS_FIELD, REQUEST_TYPE_FIELD];
/**
 * An issue as mcp-atlassian returns it. `requested` is the fields list; `rawDescription` keeps Jira wiki markup
 * (search and create results do), otherwise it is converted to Markdown (get, assign, transition do).
 */
function simpleIssue(raw, requested, { rawDescription = false, selfUrl = false, browseUrl = true, rawParent = false } = {}) {
  const f = raw.fields ?? {};
  const all = !requested || requested.includes("*all");
  const want = (key) => all || requested.includes(key);
  const out = { id: raw.id, key: raw.key };
  if (want("summary") && f.summary !== undefined) out.summary = f.summary;
  if (selfUrl || all) out.url = `${JIRA_SITE}/rest/api/2/issue/${raw.id}`;
  if (browseUrl) out.browse_url = `${JIRA_SITE}/browse/${raw.key}`;
  if (want("description") && f.description) out.description = rawDescription ? f.description : wikiToMarkdown(f.description);
  if (want("status") && f.status) out.status = simpleStatus(f.status);
  if (want("issuetype") && f.issuetype) out.issue_type = { name: f.issuetype.name };
  if (want("priority") && f.priority) out.priority = { name: f.priority.name };
  if ((all || selfUrl) && f.project) out.project = { key: f.project.key, name: f.project.name, avatar_url: f.project.avatarUrls?.["48x48"] };
  // mcp-atlassian echoes the raw REST parent object in create results.
  if (rawParent && f.parent) out.parent = f.parent;
  if (want("assignee") && "assignee" in f) out.assignee = f.assignee ? simpleUser(f.assignee) : { display_name: "Unassigned" };
  if (want("reporter") && f.reporter) out.reporter = simpleUser(f.reporter);
  if (want("labels") && f.labels?.length) out.labels = f.labels;
  if (want("components") && f.components?.length) out.components = f.components.map((c) => c.name);
  if (want("fixVersions") && f.fixVersions?.length) out.fix_versions = f.fixVersions.map((v) => v.name);
  if (want("duedate") && f.duedate) out.duedate = f.duedate;
  if (want("resolution") && f.resolution) out.resolution = { name: f.resolution.name };
  if (want("created") && f.created) out.created = displayTime(f.created);
  if (want("updated") && f.updated) out.updated = displayTime(f.updated);
  if (!rawParent && want("parent") && f.parent) out.parent = { id: f.parent.id, key: f.parent.key, summary: f.parent.fields?.summary };
  if (want("subtasks") && f.subtasks?.length) out.subtasks = f.subtasks.map((s) => ({ id: s.id, key: s.key, summary: s.fields.summary, status: simpleStatus(s.fields.status) }));
  for (const id of CUSTOM_FIELD_IDS) if (all || requested.includes(id)) out[id] = { value: f[id] ?? null };
  if (want("comment") && f.comment?.comments?.length) out.comments = f.comment.comments.map((c) => ({ id: c.id, body: wikiToMarkdown(c.body), author: simpleUser(c.author), created: c.created, updated: c.updated }));
  if (raw.changelog) out.changelogs = raw.changelog.histories.map((h) => ({ author: simpleUser(h.author), created: displayTime(h.created), items: h.items.map((i) => ({ field: i.field, from_string: i.fromString, to_string: i.toString })) }));
  if (raw.transitions) out.transitions = raw.transitions.map((t) => ({ id: Number(t.id), name: t.name }));
  return out;
}
const DEFAULT_FIELDS = "labels,assignee,created,reporter,description,summary,status,updated,issuetype,priority,versions";
const fieldsList = (value) => csv(value ?? DEFAULT_FIELDS);
function personIdentifier(value) {
  if (value === undefined || value === null || value === "") return null;
  let parsed = value;
  if (typeof value === "string" && value.trim().startsWith("{")) { try { parsed = JSON.parse(value); } catch { /* plain string */ } }
  const person = findPerson(parsed);
  if (!person) throw new ToolError(`No user found matching '${typeof parsed === "object" ? JSON.stringify(parsed) : parsed}'.`);
  return person.name;
}
/** A Confluence page as mcp-atlassian returns it. */
function simplePage(raw, { content = "markdown", excerpt } = {}) {
  const space = raw.space ?? (raw._expandable?.space ? { key: raw._expandable.space.split("/").pop() } : null);
  const out = { id: raw.id, title: raw.title, type: raw.type, created: displayTime(raw.history?.createdDate), updated: displayTime(raw.history?.lastUpdated?.when),
    url: `${CONFLUENCE_SITE}/pages/viewpage.action?pageId=${raw.id}` };
  if (space) out.space = { key: space.key, name: space.name ?? `Space ${space.key}` };
  const author = raw.history?.createdBy ?? raw.version?.by; if (author && raw.history) out.author = author.displayName;
  if (raw.version) out.version = raw.version.number;
  out.attachments = [];
  if (excerpt !== undefined) out.content = { value: excerpt, format: "view" };
  else if (content && raw.body?.storage) out.content = { value: content === "markdown" ? storageToMarkdown(raw.body.storage.value, "markdownify") : raw.body.storage.value, format: content === "markdown" ? "markdown" : "storage" };
  return out;
}
const pageIdArg = (args, key = "page_id") => {
  const value = strArg(args, key, false);
  if (!value) return undefined;
  const fromUrl = /pageId=(\d+)/.exec(value) ?? /\/pages\/(\d+)/.exec(value);
  return fromUrl ? fromUrl[1] : value;
};
function contentToStorage(content, format = "markdown") {
  const value = String(content ?? "");
  if (format === "storage" || format === "xhtml") return value;
  if (format === "wiki") return markdownToStorage(wikiToMarkdown(value));
  return markdownToStorage(value);
}
/** Plain words become a siteSearch query, like the Confluence search box; CQL is passed through. */
function simpleQueryToCql(query) {
  const trimmed = String(query ?? "").trim();
  if (/(\b(space|type|title|text|label|creator|ancestor|parent|lastmodified|created|siteSearch|contributor|id)\s*(=|~|!=|!~|>|<|\bin\b))/i.test(trimmed)) return trimmed;
  return `siteSearch ~ "${trimmed.replace(/"/g, "\\\"")}"`;
}

/**
 * Tool definitions copied verbatim from mcp-atlassian 3.4.9 (tools/list against Jira/Confluence Data Center):
 * names, titles, descriptions, argument schemas, output schemas and annotations.
 */
const TOOL_SPECS = [
  {"name": "jira_get_user_profile", "title": "Get User Profile", "description": "Retrieve profile information for a specific Jira user.", "inputSchema": {"additionalProperties": false, "properties": {"user_identifier": {"description": "Identifier for the user (e.g., email address 'user@example.com', username 'johndoe', account ID 'accountid:...', or key for Server/DC).", "type": "string"}}, "required": ["user_identifier"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get User Profile", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_users"]}}},
  {"name": "jira_search_assignable_users", "title": "Search Assignable Users", "description": "Search Jira users assignable in a given project or issue.\n\nUse this when you have a display name / partial name / email fragment\nand need a concrete identifier (``name`` / ``key`` for Server/DC,\n``accountId`` for Cloud) to feed into assignee, reporter, watcher, etc.\n\nReturns the full result set so the caller can disambiguate when several\nusers match — ``get_user_profile`` only resolves one identifier and is\nnot designed for human-name search.\n\nExactly one of ``project_key`` or ``issue_key`` must be provided — the\nunderlying API (``/user/assignable/search``) requires a project or issue\ncontext and works without the global \"Browse Users\" permission that bot\naccounts in locked-down DC instances often lack.", "inputSchema": {"additionalProperties": false, "properties": {"query": {"description": "Free-form text to search Jira users by: display name, username, or email substring (e.g. 'Smith', 'jane.doe', 'doe@example.com'). Server-side match is case-insensitive and partial.", "type": "string"}, "project_key": {"default": null, "description": "Project key to scope the search to (e.g. 'DT'). Required if issue_key is not given.", "type": "string"}, "issue_key": {"default": null, "description": "Issue key to scope the search to (e.g. 'DT-779'). Required if project_key is not given.", "type": "string"}, "limit": {"default": 20, "description": "Maximum number of users to return (default 20).", "maximum": 1000, "minimum": 1, "type": "integer"}}, "required": ["query"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Search Assignable Users", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_users"]}}},
  {"name": "jira_get_all_projects", "title": "Get All Projects", "description": "Get all Jira projects accessible to the current user.", "inputSchema": {"additionalProperties": false, "properties": {"include_archived": {"default": false, "description": "Whether to include archived projects in the results", "type": "boolean"}}, "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get All Projects", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_projects"]}}},
  {"name": "jira_get_project_issue_types", "title": "Get Project Issue Types", "description": "Get available issue types for a Jira project.\n\nReturns the list of issue types (Bug, Task, Story, Epic, etc.) that can\nbe created in the specified project. Use the returned issue type IDs with\nget_create_fields to discover what fields each type requires.", "inputSchema": {"additionalProperties": false, "properties": {"project_key": {"description": "Jira project key (e.g., 'PROJ', 'JTEST')", "pattern": "^[A-Z][A-Z0-9_]+$", "type": "string"}}, "required": ["project_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Project Issue Types", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_projects"]}}},
  {"name": "jira_get_issue", "title": "Get Issue", "description": "Get details of a specific Jira issue.\n\nIncludes Epic links and relationship information. Use the\n``include`` parameter to inline enrichments (remote_links,\ntransitions, watchers, changelog, comments, worklogs) so that\nseparate tool calls are not needed.", "inputSchema": {"additionalProperties": false, "properties": {"issue_key": {"description": "Jira issue key (e.g., 'PROJ-123', 'ACV2-642')", "pattern": "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$", "type": "string"}, "fields": {"default": "labels,assignee,created,reporter,description,summary,status,updated,issuetype,priority,versions", "description": "(Optional) Comma-separated list of fields to return (e.g., 'summary,status,customfield_10010'). You may also provide a single field as a string (e.g., 'duedate'). Use '*all' for all fields (including custom fields), or omit for essential fields only.", "type": "string"}, "expand": {"default": null, "description": "(Optional) Fields to expand. Examples: 'renderedFields' (for rendered content), 'transitions' (for available status transitions), 'changelog' (for history)", "type": "string"}, "comment_limit": {"default": 10, "description": "Maximum number of comments to include (0 or null for no comments)", "maximum": 100, "minimum": 0, "type": "integer"}, "properties": {"description": "(Optional) A comma-separated list of issue properties to return", "default": null, "type": "string"}, "update_history": {"default": true, "description": "Whether to update the issue view history for the requesting user", "type": "boolean"}, "include": {"default": null, "description": "(Optional) Comma-separated sections to inline in the response, avoiding extra tool calls. Supported: all, remote_links, transitions, watchers, changelog, comments, worklogs", "type": "string"}, "use_display_names": {"default": false, "description": "When true, custom field keys in the output use human-readable display names (e.g. 'Story Points') instead of opaque IDs (e.g. 'customfield_10243'). The 'names' expansion is added automatically. Standard fields are unaffected.", "type": "boolean"}}, "required": ["issue_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Issue", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_issues"]}}},
  {"name": "jira_search", "title": "Search Issues", "description": "Search Jira issues using JQL (Jira Query Language).", "inputSchema": {"additionalProperties": false, "properties": {"jql": {"description": "JQL query string (Jira Query Language). Examples:\n- Find Epics: \"issuetype = Epic AND project = PROJ\"\n- Find issues in Epic: \"parent = PROJ-123\"\n- Find by status: \"status = 'In Progress' AND project = PROJ\"\n- Find by assignee: \"assignee = currentUser()\"\n- Find recently updated: \"updated >= -7d AND project = PROJ\"\n- Find by label: \"labels = frontend AND project = PROJ\"\n- Find by priority: \"priority = High AND project = PROJ\"", "type": "string"}, "fields": {"default": "labels,assignee,created,reporter,description,summary,status,updated,issuetype,priority,versions", "description": "(Optional) Comma-separated fields to return in the results. Use '*all' for all fields, or specify individual fields like 'summary,status,assignee,priority'", "type": "string"}, "limit": {"default": 10, "description": "Maximum number of results (1-50)", "minimum": 1, "type": "integer"}, "start_at": {"default": 0, "description": "Starting index for pagination (0-based)", "minimum": 0, "type": "integer"}, "projects_filter": {"default": null, "description": "(Optional) Comma-separated list of project keys to filter results by. Overrides the environment variable JIRA_PROJECTS_FILTER if provided.", "type": "string"}, "expand": {"default": null, "description": "(Optional) fields to expand. Examples: 'renderedFields', 'transitions', 'changelog'", "type": "string"}, "page_token": {"default": null, "description": "(Optional) Pagination token from a previous search result. Cloud only — Server/DC uses start_at for pagination.", "type": "string"}, "use_display_names": {"default": false, "description": "When true, custom field keys in the output use human-readable display names (e.g. 'Story Points') instead of opaque IDs (e.g. 'customfield_10243'). The 'names' expansion is added automatically. Standard fields are unaffected.", "type": "boolean"}}, "required": ["jql"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Search Issues", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_issues"]}}},
  {"name": "jira_get_project_issues", "title": "Get Project Issues", "description": "Get all issues for a specific Jira project.", "inputSchema": {"additionalProperties": false, "properties": {"project_key": {"description": "Jira project key (e.g., 'PROJ', 'ACV2')", "pattern": "^[A-Z][A-Z0-9_]+$", "type": "string"}, "limit": {"default": 10, "description": "Maximum number of results (1-50)", "maximum": 50, "minimum": 1, "type": "integer"}, "start_at": {"default": 0, "description": "Starting index for pagination (0-based)", "minimum": 0, "type": "integer"}}, "required": ["project_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Project Issues", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_issues"]}}},
  {"name": "jira_get_transitions", "title": "Get Transitions", "description": "Get available status transitions for a Jira issue.", "inputSchema": {"additionalProperties": false, "properties": {"issue_key": {"description": "Jira issue key (e.g., 'PROJ-123', 'ACV2-642')", "pattern": "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$", "type": "string"}}, "required": ["issue_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Transitions", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_transitions"]}}},
  {"name": "jira_create_issue", "title": "Create Issue", "description": "Create a new Jira issue with optional Epic link or parent for subtasks.", "inputSchema": {"additionalProperties": false, "properties": {"project_key": {"description": "The JIRA project key (e.g. 'PROJ', 'DEV', 'ACV2'). This is the prefix of issue keys in your project. Never assume what it might be, always ask the user.", "pattern": "^[A-Z][A-Z0-9_]+$", "type": "string"}, "summary": {"description": "Summary/title of the issue", "type": "string"}, "issue_type": {"description": "Issue type (e.g. 'Task', 'Bug', 'Story', 'Epic', 'Subtask'). The available types depend on your project configuration. For subtasks, use 'Subtask' (not 'Sub-task') and include parent in additional_fields.", "type": "string"}, "assignee": {"default": null, "description": "(Optional) Assignee's user identifier (string): Email, display name, or account ID (e.g., 'user@example.com', 'John Doe', 'accountid:...')", "type": "string"}, "description": {"default": null, "description": "Issue description in Markdown format. On Jira Cloud, use '{expand:Title}...{expand}' for a collapsible section.", "type": "string"}, "components": {"default": null, "description": "(Optional) Comma-separated list of component names to assign (e.g., 'Frontend,API')", "type": "string"}, "additional_fields": {"default": null, "description": "(Optional) JSON string of additional fields to set. Examples:\n- Set priority: {\"priority\": {\"name\": \"High\"}}\n- Add labels: {\"labels\": [\"frontend\", \"urgent\"]}\n- Link to parent (for any issue type): {\"parent\": \"PROJ-123\"}\n- Link to epic: {\"epicKey\": \"EPIC-123\"} or {\"epic_link\": \"EPIC-123\"}\n- Set Fix Version/s: {\"fixVersions\": [{\"id\": \"10020\"}]}\n- Custom fields: {\"customfield_10010\": \"value\"}", "type": "string"}}, "required": ["project_key", "summary", "issue_type"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Create Issue", "destructiveHint": false}, "_meta": {"fastmcp": {"tags": ["jira", "toolset:jira_issues", "write"]}}},
  {"name": "jira_update_issue", "title": "Update Issue", "description": "Update an existing Jira issue including changing status, adding Epic links, updating fields, etc.", "inputSchema": {"additionalProperties": false, "properties": {"issue_key": {"description": "Jira issue key (e.g., 'PROJ-123', 'ACV2-642')", "pattern": "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$", "type": "string"}, "fields": {"description": "JSON string of fields to update. For 'assignee', provide a string identifier (email, name, or accountId). For 'description', provide text in Markdown format; on Jira Cloud, use '{expand:Title}...{expand}' for a collapsible section. Example: '{\"assignee\": \"user@example.com\", \"summary\": \"New Summary\", \"description\": \"## Updated\\nMarkdown text\"}'", "type": "string"}, "additional_fields": {"default": null, "description": "(Optional) JSON string of additional fields to update. Use this for custom fields or more complex updates. Link to epic: {\"epicKey\": \"EPIC-123\"} or {\"epic_link\": \"EPIC-123\"}.", "type": "string"}, "components": {"default": null, "description": "(Optional) Comma-separated list of component names (e.g., 'Frontend,API')", "type": "string"}, "attachments": {"default": null, "description": "(Optional) JSON string array or comma-separated list of file paths to attach to the issue. Example: '/path/to/file1.txt,/path/to/file2.txt' or ['/path/to/file1.txt','/path/to/file2.txt']", "type": "string"}, "return_fields": {"default": "*all", "description": "(Optional) Controls which fields of the updated issue are returned, to reduce response size and token usage. Defaults to '*all' (the complete issue, which can be very large). TOKEN-SAVING TIP: after an update you usually do NOT need the whole issue back. Pass a comma-separated list of just the field(s) you care about (e.g., 'summary,duedate'), or a single light field such as 'status' for a minimal confirmation - this can cut the response by thousands of tokens. The issue 'key' is always returned regardless. If you later need other fields, fetch them on demand with jira_get_issue (which also supports field filtering). Use '*all' only when you genuinely need the full updated issue.", "type": "string"}}, "required": ["issue_key", "fields"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Update Issue", "destructiveHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "toolset:jira_issues", "write"]}}},
  {"name": "jira_assign_issue", "title": "Assign Issue", "description": "Assign a Jira issue to a user using the dedicated assignment endpoint.\n\nThis is more reliable than setting assignee via update_issue, which is\nsilently ignored by some Jira configurations. Uses PUT /issue/{key}/assignee.", "inputSchema": {"additionalProperties": false, "properties": {"issue_key": {"description": "Jira issue key (e.g., 'PROJ-123', 'ACV2-642')", "pattern": "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$", "type": "string"}, "assignee": {"default": null, "description": "User identifier to assign (email, display name, or account ID), or a JSON object string from jira_search_assignable_users. Pass null or empty string to unassign the issue.", "type": "string"}}, "required": ["issue_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Assign Issue", "readOnlyHint": false}, "_meta": {"fastmcp": {"tags": ["jira", "toolset:jira_issues", "write"]}}},
  {"name": "jira_add_comment", "title": "Add Comment", "description": "Add a comment to a Jira issue.", "inputSchema": {"additionalProperties": false, "properties": {"issue_key": {"description": "Jira issue key (e.g., 'PROJ-123', 'ACV2-642')", "pattern": "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$", "type": "string"}, "body": {"description": "Comment text in Markdown format", "type": "string"}, "visibility": {"default": null, "description": "(Optional) Comment visibility as JSON string (e.g. '{\"type\":\"group\",\"value\":\"jira-users\"}')", "type": "string"}, "public": {"default": null, "description": "(Optional) For JSM/Service Desk issues only. Set to true for customer-visible comment, false for internal agent-only comment. Posted via the ServiceDesk API as a raw string; Jira Cloud renders it server-side and stores ADF (markdown observed to render on Cloud, without the client-side markdown-to-ADF guarantees of the regular comment path). Cannot be combined with visibility. If the issue's project is listed in JIRA_INTERNAL_ONLY_PROJECTS, only public=false is accepted — public=true or omitting this field is rejected.", "type": "boolean"}}, "required": ["issue_key", "body"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Add Comment", "destructiveHint": false}, "_meta": {"fastmcp": {"tags": ["jira", "toolset:jira_comments", "write"]}}},
  {"name": "jira_transition_issue", "title": "Transition Issue", "description": "Transition a Jira issue to a new status.", "inputSchema": {"additionalProperties": false, "properties": {"issue_key": {"description": "Jira issue key (e.g., 'PROJ-123', 'ACV2-642')", "pattern": "^[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*$", "type": "string"}, "transition_id": {"description": "ID of the transition to perform. Use the jira_get_transitions tool first to get the available transition IDs for the issue. Example values: '11', '21', '31'", "type": "string"}, "fields": {"default": null, "description": "(Optional) JSON string of fields to update during the transition. Some transitions require specific fields to be set (e.g., resolution). Example: '{\"resolution\": {\"name\": \"Fixed\"}}'", "type": "string"}, "comment": {"default": null, "description": "(Optional) Comment to add during the transition in Markdown format. This will be visible in the issue history. Rejected for projects listed in JIRA_INTERNAL_ONLY_PROJECTS (a transition comment may be customer-visible on JSM and cannot be forced internal): transition without a comment, then post an internal note with jira_add_comment(public=false).", "type": "string"}}, "required": ["issue_key", "transition_id"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Transition Issue", "destructiveHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "toolset:jira_transitions", "write"]}}},
  {"name": "jira_get_service_desk_for_project", "title": "Get Service Desk For Project", "description": "Get the Jira Service Desk associated with a project key.\n\nServer/Data Center only. Not available on Jira Cloud.", "inputSchema": {"additionalProperties": false, "properties": {"project_key": {"description": "Jira project key (e.g., 'SUP')", "pattern": "^[A-Z][A-Z0-9_]+$", "type": "string"}}, "required": ["project_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Service Desk For Project", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_service_desk"]}}},
  {"name": "jira_get_request_types", "title": "Get Request Types", "description": "Get request types for a Jira Service Management service desk.", "inputSchema": {"additionalProperties": false, "properties": {"service_desk_id": {"description": "Service desk ID (e.g., '4')", "type": "string"}, "start_at": {"default": 0, "description": "Starting index for pagination (0-based)", "minimum": 0, "type": "integer"}, "limit": {"default": 50, "description": "Maximum number of results (1-50)", "maximum": 50, "minimum": 1, "type": "integer"}}, "required": ["service_desk_id"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Request Types", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_service_desk"]}}},
  {"name": "jira_get_request_type_fields", "title": "Get Request Type Fields", "description": "Get field definitions for a Jira Service Management request type.", "inputSchema": {"additionalProperties": false, "properties": {"service_desk_id": {"description": "Service desk ID (e.g., '4')", "type": "string"}, "request_type_id": {"description": "Request type ID (e.g., '23')", "type": "string"}}, "required": ["service_desk_id", "request_type_id"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Request Type Fields", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "read", "toolset:jira_service_desk"]}}},
  {"name": "jira_create_customer_request", "title": "Create Customer Request", "description": "Create a Jira Service Management customer request.", "inputSchema": {"additionalProperties": false, "properties": {"service_desk_id": {"description": "Service desk ID (e.g., '4')", "type": "string"}, "request_type_id": {"description": "Request type ID (e.g., '23')", "type": "string"}, "request_field_values": {"description": "JSON string of request field values keyed by field ID. Examples:\n- Summary and description: {\"summary\": \"Access issue\", \"description\": \"Cannot log in\"}\n- Multi-value field: {\"customfield_10001\": [\"alice\", \"bob\"]}", "type": "string"}, "raise_on_behalf_of": {"default": null, "description": "(Optional) Jira user identifier for raiseOnBehalfOf. For Server/DC this is typically username or key; for Cloud use the identifier expected by your JSM instance.", "type": "string"}, "request_participants": {"default": null, "description": "(Optional) JSON array string or comma-separated list of request participants. Examples: [\"user1\",\"user2\"] or \"user1,user2\"", "type": "string"}, "attachments": {"default": null, "description": "(Optional) JSON array string of files to attach to the created request. Each object must contain 'filename', 'mime_type', and base64-encoded 'base64' content. Example: [{\"filename\": \"log.txt\", \"mime_type\": \"text/plain\", \"base64\": \"aGVsbG8=\"}]", "type": "string"}, "strict_on_behalf": {"default": false, "description": "If true, fail immediately when raiseOnBehalfOf cannot be applied. If false, retry without raiseOnBehalfOf and return a fallback warning.", "type": "boolean"}}, "required": ["service_desk_id", "request_type_id", "request_field_values"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Create Customer Request", "destructiveHint": true}, "_meta": {"fastmcp": {"tags": ["jira", "toolset:jira_service_desk", "write"]}}},
  {"name": "confluence_search", "title": "Search Content", "description": "Search Confluence content using simple terms or CQL.", "inputSchema": {"additionalProperties": false, "properties": {"query": {"description": "Search query - can be either a simple text (e.g. 'project documentation') or a CQL query string. Simple queries use 'siteSearch' by default, to mimic the WebUI search, with an automatic fallback to 'text' search if not supported. Examples of CQL:\n- Basic search: 'type=page AND space=DEV'\n- Personal space search: 'space=\"~username\"' (note: personal space keys starting with ~ must be quoted)\n- Search by title: 'title~\"Meeting Notes\"'\n- Use siteSearch: 'siteSearch ~ \"important concept\"'\n- Use text search: 'text ~ \"important concept\"'\n- Recent content: 'created >= \"2023-01-01\"'\n- Content with specific label: 'label=documentation'\n- Recently modified content: 'lastModified > startOfMonth(\"-1M\")'\n- Content modified this year: 'creator = currentUser() AND lastModified > startOfYear()'\n- Content you contributed to recently: 'contributor = currentUser() AND lastModified > startOfWeek()'\n- Content watched by user: 'watcher = \"user@domain.com\" AND type = page'\n- Exact phrase in content: 'text ~ \"\\\"Urgent Review Required\\\"\" AND label = \"pending-approval\"'\n- Title wildcards: 'title ~ \"Minutes*\" AND (space = \"HR\" OR space = \"Marketing\")'\nNote: Special identifiers need proper quoting in CQL: personal space keys (e.g., \"~username\"), reserved words, numeric IDs, and identifiers with special characters.", "type": "string"}, "limit": {"default": 10, "description": "Maximum number of results (1-50)", "maximum": 50, "minimum": 1, "type": "integer"}, "spaces_filter": {"default": null, "description": "(Optional) Comma-separated list of space keys to filter results by. Overrides the environment variable CONFLUENCE_SPACES_FILTER if provided. Use empty string to disable filtering.", "type": "string"}}, "required": ["query"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Search Content", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_pages"]}}},
  {"name": "confluence_get_page", "title": "Get Page", "description": "Get content of a specific Confluence page by its ID, or by its title and space key.", "inputSchema": {"additionalProperties": false, "properties": {"page_id": {"default": null, "description": "Confluence page ID, full page URL, or tiny link. For example: '123456789', 'https://example.atlassian.net/wiki/spaces/TEAM/pages/123456789/Page+Title', or 'https://example.atlassian.net/wiki/x/N4CIO'. Provide this OR both 'title' and 'space_key'. If page_id is provided, title and space_key will be ignored.", "type": "string"}, "title": {"default": null, "description": "The exact title of the Confluence page. Use this with 'space_key' if 'page_id' is not known.", "type": "string"}, "space_key": {"default": null, "description": "The key of the Confluence space where the page resides (e.g., 'DEV', 'TEAM'). Required if using 'title'.", "type": "string"}, "include_metadata": {"default": true, "description": "Whether to include page metadata such as creation date, last update, version, and labels.", "type": "boolean"}, "convert_to_markdown": {"default": true, "description": "Whether to convert page to markdown (true) or keep it in raw HTML format (false). Raw HTML can reveal macros (like dates) not visible in markdown, but CAUTION: using HTML significantly increases token usage in AI responses.", "type": "boolean"}}, "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Page", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_pages"]}}},
  {"name": "confluence_get_page_children", "title": "Get Page Children", "description": "Get child pages and folders of a specific Confluence page.", "inputSchema": {"additionalProperties": false, "properties": {"parent_id": {"description": "The ID of the parent page whose children you want to retrieve", "type": "string"}, "expand": {"default": "version", "description": "Fields to expand in the response (e.g., 'version', 'body.storage')", "type": "string"}, "limit": {"default": 25, "description": "Maximum number of child items to return (1-50)", "maximum": 50, "minimum": 1, "type": "integer"}, "include_content": {"default": false, "description": "Whether to include the page content in the response", "type": "boolean"}, "convert_to_markdown": {"default": true, "description": "Whether to convert page content to markdown (true) or keep it in raw HTML format (false). Only relevant if include_content is true.", "type": "boolean"}, "start": {"default": 0, "description": "Starting index for pagination (0-based)", "minimum": 0, "type": "integer"}, "include_folders": {"default": true, "description": "Whether to include child folders in addition to child pages", "type": "boolean"}}, "required": ["parent_id"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Page Children", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_pages"]}}},
  {"name": "confluence_get_space_page_tree", "title": "Get Space Page Tree", "description": "Get page hierarchy for a Confluence space as a flat list.\n\nReturns pages with parent_id and depth attributes for token-efficient\nprocessing. Filter by depth to focus on relevant sections, or find\npages by title. Much more efficient than rendering full ASCII trees.\n\nUse this to understand space organization before creating/moving pages.", "inputSchema": {"additionalProperties": false, "properties": {"space_key": {"description": "Space key", "type": "string"}, "limit": {"default": 100, "description": "Max pages to fetch", "maximum": 1000, "minimum": 1, "type": "integer"}}, "required": ["space_key"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Space Page Tree", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_pages"]}}},
  {"name": "confluence_get_comments", "title": "Get Comments", "description": "Get comments for a specific Confluence page.", "inputSchema": {"additionalProperties": false, "properties": {"page_id": {"description": "Confluence page ID (numeric ID, can be parsed from URL, e.g. from 'https://example.atlassian.net/wiki/spaces/TEAM/pages/123456789/Page+Title' -> '123456789')", "type": "string"}}, "required": ["page_id"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Comments", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_comments"]}}},
  {"name": "confluence_get_labels", "title": "Get Labels", "description": "Get labels for Confluence content (pages, blog posts, or attachments).", "inputSchema": {"additionalProperties": false, "properties": {"page_id": {"description": "Confluence content ID (page, blog post, or attachment). For pages: numeric ID from URL (e.g., '123456789'). For attachments: ID with 'att' prefix (e.g., 'att123456789'). Works with any Confluence content type that supports labels.", "type": "string"}}, "required": ["page_id"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Get Labels", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_labels"]}}},
  {"name": "confluence_add_label", "title": "Add Label", "description": "Add label to Confluence content (pages, blog posts, or attachments).\n\nUseful for:\n- Categorizing attachments (e.g., 'screenshot', 'diagram', 'legal-doc')\n- Tracking status (e.g., 'approved', 'needs-review', 'archived')\n- Filtering content by topic or version", "inputSchema": {"additionalProperties": false, "properties": {"page_id": {"description": "Confluence content ID to label. For pages/blogs: numeric ID (e.g., '123456789'). For attachments: ID with 'att' prefix (e.g., 'att123456789'). Use get_attachments to find attachment IDs.", "type": "string"}, "name": {"description": "Label name to add (lowercase, no spaces). Examples: 'draft', 'reviewed', 'confidential', 'v1.0'. Labels help organize and categorize content.", "type": "string"}}, "required": ["page_id", "name"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Add Label", "destructiveHint": false}, "_meta": {"fastmcp": {"tags": ["confluence", "toolset:confluence_labels", "write"]}}},
  {"name": "confluence_create_page", "title": "Create Page", "description": "Create a new Confluence page.", "inputSchema": {"additionalProperties": false, "properties": {"space_key": {"description": "The key of the space to create the page in (usually a short uppercase code like 'DEV', 'TEAM', or 'DOC')", "type": "string"}, "title": {"description": "The title of the page", "type": "string"}, "content": {"default": null, "description": "The content of the page. Format depends on content_format parameter. Can be Markdown (default), wiki markup, storage format, or XHTML storage format. Either 'content' or 'content_file' must be provided, but not both.", "type": "string"}, "parent_id": {"default": null, "description": "(Optional) parent page ID. If provided, this page will be created as a child of the specified page", "type": "string"}, "content_format": {"default": "markdown", "description": "(Optional) The format of the content parameter. Options: 'markdown' (default), 'wiki', 'storage', or 'xhtml'. Use 'xhtml' when providing Confluence XHTML storage format (same as 'storage'). Wiki format uses Confluence wiki markup syntax", "type": "string"}, "enable_heading_anchors": {"default": false, "description": "(Optional) Whether to enable automatic heading anchor generation. Only applies when content_format is 'markdown'", "type": "boolean"}, "include_content": {"default": false, "description": "(Optional) Whether to include page content in the response. Defaults to false since callers already have the content at create time", "type": "boolean"}, "emoji": {"default": null, "description": "(Optional) Page title emoji (icon shown in navigation). Can be any emoji character like '📝', '🚀', '📚'. Set to null/None to remove.", "type": "string"}, "content_file": {"default": null, "description": "(Optional) Absolute or relative filesystem path to read the page body from (UTF-8). Use this instead of 'content' when the body is too large to pass comfortably as a tool argument. Mutually exclusive with 'content'.", "type": "string"}, "page_width": {"default": null, "description": "(Optional) Page layout width. Options: 'full-width', 'default'. Defaults to null (Confluence default).", "type": "string"}, "table_layout": {"default": null, "description": "(Optional) Table width preset applied to all markdown tables. Options: 'full-width' (1800 px), 'wide' (960 px), 'default' (760 px). Only applies when content_format is 'markdown'.", "type": "string"}, "subtype": {"default": null, "description": "(Optional) Confluence page subtype. Use 'live' to create a Confluence Live Doc. Only supported for Confluence Cloud.", "type": "string"}}, "required": ["space_key", "title"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Create Page", "destructiveHint": false}, "_meta": {"fastmcp": {"tags": ["confluence", "toolset:confluence_pages", "write"]}}},
  {"name": "confluence_update_page", "title": "Update Page", "description": "Update an existing Confluence page.", "inputSchema": {"additionalProperties": false, "properties": {"page_id": {"description": "The ID of the page to update", "type": "string"}, "title": {"description": "The new title of the page", "type": "string"}, "content": {"default": null, "description": "The new content of the page. Format depends on content_format parameter and may be Markdown (default), wiki markup, storage format, or XHTML storage format. Either 'content' or 'content_file' must be provided, but not both.", "type": "string"}, "is_minor_edit": {"default": false, "description": "Whether this is a minor edit", "type": "boolean"}, "version_comment": {"default": null, "description": "Optional comment for this version", "type": "string"}, "parent_id": {"default": null, "description": "Optional the new parent page ID", "type": "string"}, "content_format": {"default": "markdown", "description": "(Optional) The format of the content parameter. Options: 'markdown' (default), 'wiki', 'storage', or 'xhtml'. Use 'xhtml' when providing Confluence XHTML storage format (same as 'storage'). Wiki format uses Confluence wiki markup syntax", "type": "string"}, "enable_heading_anchors": {"default": false, "description": "(Optional) Whether to enable automatic heading anchor generation. Only applies when content_format is 'markdown'", "type": "boolean"}, "include_content": {"default": false, "description": "(Optional) Whether to include page content in the response. Defaults to false since callers already have the content at update time", "type": "boolean"}, "emoji": {"default": null, "description": "(Optional) Page title emoji (icon shown in navigation). Can be any emoji character like '📝', '🚀', '📚'. Set to null/None to remove.", "type": "string"}, "content_file": {"default": null, "description": "(Optional) Absolute or relative filesystem path to read the new page body from (UTF-8). Use this instead of 'content' when the body is too large to pass comfortably as a tool argument. Mutually exclusive with 'content'.", "type": "string"}, "page_width": {"default": null, "description": "(Optional) Page layout width. Options: 'full-width', 'default'. Defaults to null (preserve existing).", "type": "string"}, "table_layout": {"default": null, "description": "(Optional) Table width preset applied to all markdown tables. Options: 'full-width' (1800 px), 'wide' (960 px), 'default' (760 px). Only applies when content_format is 'markdown'.", "type": "string"}}, "required": ["page_id", "title"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Update Page", "destructiveHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "toolset:confluence_pages", "write"]}}},
  {"name": "confluence_add_comment", "title": "Add Comment", "description": "Add a comment to a Confluence page.", "inputSchema": {"additionalProperties": false, "properties": {"page_id": {"description": "The ID of the page to add a comment to", "type": "string"}, "body": {"description": "The comment content in Markdown format", "type": "string"}}, "required": ["page_id", "body"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Add Comment", "destructiveHint": false}, "_meta": {"fastmcp": {"tags": ["confluence", "toolset:confluence_comments", "write"]}}},
  {"name": "confluence_search_user", "title": "Search User", "description": "Search Confluence users using CQL (Cloud) or group member API (Server/DC).", "inputSchema": {"additionalProperties": false, "properties": {"query": {"description": "Search query - a CQL query string for user search. Examples of CQL:\n- Basic user lookup by full name: 'user.fullname ~ \"First Last\"'\nNote: Special identifiers need proper quoting in CQL: personal space keys (e.g., \"~username\"), reserved words, numeric IDs, and identifiers with special characters.", "type": "string"}, "limit": {"default": 10, "description": "Maximum number of results (1-50)", "maximum": 50, "minimum": 1, "type": "integer"}, "group_name": {"default": "confluence-users", "description": "Group to search within on Server/DC instances (default: 'confluence-users'). Ignored on Cloud.", "type": "string"}}, "required": ["query"], "type": "object"}, "outputSchema": {"properties": {"result": {"type": "string"}}, "required": ["result"], "type": "object", "x-fastmcp-wrap-result": true}, "annotations": {"title": "Search User", "readOnlyHint": true}, "_meta": {"fastmcp": {"tags": ["confluence", "read", "toolset:confluence_users"]}}},
];

// Argument validation worded like the pydantic errors mcp-atlassian returns.
function schemaTypes(schema) {
  if (schema.anyOf) return schema.anyOf.flatMap(schemaTypes);
  return [schema.type ?? "any"];
}
function validateArgs(spec, args) {
  const errors = [];
  const python = (value) => (typeof value === "string" ? `'${value}'` : JSON.stringify(value));
  const pythonType = (value) => (value === null ? "NoneType" : typeof value === "string" ? "str" : typeof value === "boolean" ? "bool" : typeof value === "number" ? (Number.isInteger(value) ? "int" : "float") : Array.isArray(value) ? "list" : "dict");
  for (const key of spec.inputSchema.required ?? []) if (args[key] === undefined) errors.push(`${key}\n  Missing required argument [type=missing_argument, input_value=${JSON.stringify(args)}, input_type=dict]`);
  for (const [key, value] of Object.entries(args)) {
    const schema = spec.inputSchema.properties?.[key];
    if (!schema) { if (spec.inputSchema.additionalProperties === false) errors.push(`${key}\n  Unexpected keyword argument [type=unexpected_keyword_argument, input_value=${python(value)}, input_type=${pythonType(value)}]`); continue; }
    const types = schemaTypes(schema); const variant = schema.anyOf?.find((entry) => entry.type !== "null") ?? schema;
    if (value === null) { if (!types.includes("null")) errors.push(`${key}\n  Input should be a valid ${variant.type === "integer" ? "integer" : variant.type === "boolean" ? "boolean" : "string"} [type=${variant.type === "integer" ? "int" : variant.type === "boolean" ? "bool" : "string"}_type, input_value=None, input_type=NoneType]`); continue; }
    if (types.includes("string") && typeof value !== "string") errors.push(`${key}\n  Input should be a valid string [type=string_type, input_value=${python(value)}, input_type=${pythonType(value)}]`);
    else if (types.includes("integer") && !(Number.isInteger(value) || (typeof value === "string" && /^-?\d+$/.test(value)))) errors.push(`${key}\n  Input should be a valid integer [type=int_type, input_value=${python(value)}, input_type=${pythonType(value)}]`);
    else if (types.includes("boolean") && typeof value !== "boolean" && !["true", "false"].includes(String(value))) errors.push(`${key}\n  Input should be a valid boolean [type=bool_type, input_value=${python(value)}, input_type=${pythonType(value)}]`);
    else if (typeof value === "string" && variant.pattern && !new RegExp(variant.pattern).test(value)) errors.push(`${key}\n  String should match pattern '${variant.pattern}' [type=string_pattern_mismatch, input_value=${python(value)}, input_type=str]`);
    else if (variant.type === "integer" && variant.minimum !== undefined && Number(value) < variant.minimum) errors.push(`${key}\n  Input should be greater than or equal to ${variant.minimum} [type=greater_than_equal, input_value=${value}, input_type=int]`);
    else if (variant.type === "integer" && variant.maximum !== undefined && Number(value) > variant.maximum) errors.push(`${key}\n  Input should be less than or equal to ${variant.maximum} [type=less_than_equal, input_value=${value}, input_type=int]`);
  }
  if (!errors.length) return null;
  const withLinks = errors.map((error) => `${error}\n    For further information visit https://errors.pydantic.dev/2.14/v/${/\[type=([a-z_]+)/.exec(error)?.[1]}`);
  return `${errors.length} validation error${errors.length > 1 ? "s" : ""} for call[${spec.name.replace(/^(jira|confluence)_/, "")}]\n${withLinks.join("\n")}`;
}

const simpleComment = (raw, pageTitle) => ({ id: raw.id, body: storageToMarkdown(raw.body?.view?.value ?? raw.body?.storage?.value ?? "", "markdownify"), created: "", updated: "", title: `Re: ${pageTitle}`, author: raw.version?.by?.displayName, location: raw.extensions?.location ?? "footer" });
const simpleLabels = (result) => result.results.map((l) => ({ id: l.id, name: l.name, prefix: l.prefix, label: l.label ?? l.name }));
const PAGE_EXPAND = "body.storage,version,space,children.attachment,history";

const TOOL_HANDLERS = {
  // Jira: people and projects
  async jira_get_user_profile(args) {
    const person = findPerson(strArg(args, "user_identifier"));
    if (!person) throw new ToolError(`User '${args.user_identifier}' not found.`);
    return { success: true, user: simpleUser(await call("jira", "GET", "/rest/api/2/user", { query: { username: person.name } })) };
  },
  async jira_search_assignable_users(args) {
    const project = strArg(args, "project_key", false); const issue = strArg(args, "issue_key", false);
    if (Boolean(project) === Boolean(issue)) throw new ToolError("Exactly one of project_key or issue_key must be provided.");
    if (project) findProject(project); else findIssue(issue);
    const users = await call("jira", "GET", "/rest/api/2/user/assignable/search", { query: { username: strArg(args, "query"), maxResults: intArg(args, "limit", 20, 1, 100), ...(project ? { project } : { issueKey: issue }) } });
    return { success: true, count: users.length, users: users.map(simpleUser) };
  },
  async jira_get_all_projects() {
    return (await call("jira", "GET", "/rest/api/2/project")).map((p) => ({ key: p.key, name: p.name, description: p.description, avatar_url: p.avatarUrls["48x48"], lead: simpleUser(p.lead) }));
  },
  async jira_get_project_issue_types(args) {
    return (await call("jira", "GET", `/rest/api/2/issue/createmeta/${strArg(args, "project_key")}/issuetypes`)).values.map((t) => ({ id: t.id, name: t.name, description: t.description, subtask: t.subtask }));
  },
  // Jira: reading issues
  async jira_get_issue(args) {
    const include = csv(args.include); const all = include.includes("all");
    const expand = [strArg(args, "expand", false), (all || include.includes("transitions")) && "transitions", (all || include.includes("changelog")) && "changelog"].filter(Boolean).join(",");
    const commentLimit = intArg(args, "comment_limit", 10, 0, 100); const requested = fieldsList(args.fields);
    const raw = await call("jira", "GET", `/rest/api/2/issue/${strArg(args, "issue_key")}`, { query: { fields: [...requested, ...(commentLimit ? ["comment"] : [])].join(","), expand } });
    const { transitions, ...issue } = simpleIssue(raw, [...requested, ...(commentLimit ? ["comment"] : [])]);
    if (issue.comments) issue.comments = issue.comments.slice(-commentLimit);
    // Same section order as mcp-atlassian: changelogs, remote_links, transitions, watchers, worklogs.
    if (all || include.includes("remote_links")) issue.remote_links = await call("jira", "GET", `/rest/api/2/issue/${raw.key}/remotelink`);
    if (transitions) issue.transitions = transitions;
    if (all || include.includes("watchers")) {
      const w = await call("jira", "GET", `/rest/api/2/issue/${raw.key}/watchers`);
      issue.watchers = { issue_key: raw.key, watcher_count: w.watchCount, is_watching: w.isWatching, watchers: w.watchers.map(simpleUser) };
    }
    if (all || include.includes("worklogs")) issue.worklogs = (await call("jira", "GET", `/rest/api/2/issue/${raw.key}/worklog`)).worklogs;
    return issue;
  },
  async jira_search(args) {
    let jql = strArg(args, "jql"); const projects = csv(args.projects_filter);
    if (projects.length) { const order = /\s+ORDER\s+BY\s+.*$/i.exec(jql)?.[0] ?? ""; jql = `(${jql.slice(0, jql.length - order.length) || "project is not EMPTY"}) AND project IN (${projects.map((p) => `"${p}"`).join(", ")})${order}`; }
    const requested = fieldsList(args.fields); const startAt = intArg(args, "start_at", 0, 0); const limit = intArg(args, "limit", 10, 1, 50);
    const result = await call("jira", "POST", "/rest/api/2/search", { body: { jql, startAt, maxResults: limit, fields: requested, expand: strArg(args, "expand", false) } });
    return { total: result.total, start_at: result.startAt, max_results: result.maxResults, issues: result.issues.map((raw) => simpleIssue(raw, requested, { rawDescription: true })) };
  },
  async jira_get_project_issues(args) {
    const key = findProject(strArg(args, "project_key")).key; const requested = fieldsList();
    const result = await call("jira", "POST", "/rest/api/2/search", { body: { jql: `project = "${key}" ORDER BY created DESC`, startAt: intArg(args, "start_at", 0, 0), maxResults: intArg(args, "limit", 10, 1, 50), fields: requested } });
    return { total: result.total, start_at: result.startAt, max_results: result.maxResults, issues: result.issues.map((raw) => simpleIssue(raw, requested, { rawDescription: true })) };
  },
  async jira_get_transitions(args) {
    return (await call("jira", "GET", `/rest/api/2/issue/${strArg(args, "issue_key")}/transitions`)).transitions.map((t) => ({ id: Number(t.id), name: t.name }));
  },
  // Jira: changing issues
  async jira_create_issue(args) {
    const fields = { project: { key: strArg(args, "project_key") }, summary: strArg(args, "summary"), issuetype: { name: strArg(args, "issue_type").replace(/^subtask$/i, "Sub-task") } };
    const description = strArg(args, "description", false); if (description) fields.description = markdownToWiki(description);
    // mcp-atlassian looks the assignee up first and leaves the issue unassigned when nobody matches.
    const assignee = strArg(args, "assignee", false); if (assignee && findPerson(assignee)) fields.assignee = { name: personIdentifier(assignee) };
    const components = csv(args.components); if (components.length) fields.components = components.map((name) => ({ name }));
    for (const [key, value] of Object.entries(jsonArg(args, "additional_fields") ?? {})) {
      if (key === "epicKey" || key === "epic_link") fields[EPIC_LINK_FIELD] = value;
      else if (key === "parent") fields.parent = typeof value === "string" ? { key: value } : value;
      else if (key === "priority") fields.priority = typeof value === "string" ? { name: value } : value;
      else fields[key] = value;
    }
    const created = await call("jira", "POST", "/rest/api/2/issue", { body: { fields } });
    const raw = await call("jira", "GET", `/rest/api/2/issue/${created.key}`);
    return { message: "Issue created successfully", issue: simpleIssue(raw, fieldsList(), { rawDescription: true, selfUrl: true, browseUrl: false, rawParent: true }) };
  },
  async jira_update_issue(args) {
    const key = strArg(args, "issue_key"); const update = {};
    for (const [field, value] of Object.entries({ ...(jsonArg(args, "fields") ?? {}), ...(jsonArg(args, "additional_fields") ?? {}) })) {
      if (field === "assignee") update.assignee = value ? { name: personIdentifier(value) } : null;
      else if (field === "description") update.description = markdownToWiki(value);
      else if (field === "status") {
        const transition = (await call("jira", "GET", `/rest/api/2/issue/${key}/transitions`)).transitions.find((t) => [t.to.name, t.name].some((name) => name.toLowerCase() === String(value).toLowerCase()));
        if (!transition) throw new ToolError(`Cannot transition issue ${key} to status '${value}'. No matching transition found.`);
        await call("jira", "POST", `/rest/api/2/issue/${key}/transitions`, { body: { transition: { id: transition.id } } });
      }
      else if (field === "epicKey" || field === "epic_link") update[EPIC_LINK_FIELD] = value;
      else if (field === "priority") update.priority = typeof value === "string" ? { name: value } : value;
      else update[field] = value;
    }
    const components = csv(args.components); if (components.length) update.components = components.map((name) => ({ name }));
    if (Object.keys(update).length) await call("jira", "PUT", `/rest/api/2/issue/${key}`, { body: { fields: update } });
    const returnFields = args.return_fields === undefined || args.return_fields === null ? "*all" : String(args.return_fields);
    if (returnFields === "") return { message: "Issue updated successfully", issue: { key: findIssue(key).key } };
    const raw = await call("jira", "GET", `/rest/api/2/issue/${key}`, { query: { fields: returnFields } });
    const requested = returnFields === "*all" ? undefined : csv(returnFields);
    return { message: "Issue updated successfully", issue: simpleIssue(raw, requested, { browseUrl: !requested }) };
  },
  async jira_assign_issue(args) {
    const key = strArg(args, "issue_key"); const value = args.assignee;
    const name = value === undefined || value === null || value === "" ? null : personIdentifier(value);
    await call("jira", "PUT", `/rest/api/2/issue/${key}/assignee`, { body: { name } });
    const raw = await call("jira", "GET", `/rest/api/2/issue/${key}`);
    return { message: name ? `Issue ${raw.key} assigned successfully` : `Issue ${raw.key} unassigned successfully`, issue: simpleIssue(raw, [...fieldsList(), "comment"]) };
  },
  async jira_add_comment(args) {
    const key = strArg(args, "issue_key"); const body = strArg(args, "body");
    if (args.public !== undefined && args.public !== null && findIssue(key).requestType) {
      const c = await call("jira", "POST", `/rest/servicedeskapi/request/${key}/comment`, { body: { body, public: boolArg(args, "public", true) } });
      return { id: c.id, body, created: pythonIsoTime(c.created.iso8601), author: ME.displayName, public: c.public };
    }
    const c = await call("jira", "POST", `/rest/api/2/issue/${key}/comment`, { body: { body: markdownToWiki(body), ...(args.visibility ? { visibility: jsonArg(args, "visibility") } : {}) } });
    return { id: c.id, body: wikiToMarkdown(c.body), created: pythonIsoTime(c.created), author: c.author.displayName };
  },
  async jira_transition_issue(args) {
    const key = strArg(args, "issue_key"); const comment = strArg(args, "comment", false);
    await call("jira", "POST", `/rest/api/2/issue/${key}/transitions`, { body: { transition: { id: strArg(args, "transition_id") }, fields: jsonArg(args, "fields") ?? {}, ...(comment ? { update: { comment: [{ add: { body: markdownToWiki(comment) } }] } } : {}) } });
    const raw = await call("jira", "GET", `/rest/api/2/issue/${key}`);
    return { message: `Issue ${raw.key} transitioned successfully`, issue: simpleIssue(raw, [...fieldsList(), "comment"]) };
  },
  // Jira Service Management
  async jira_get_service_desk_for_project(args) {
    const key = strArg(args, "project_key").toUpperCase();
    const desk = (await call("jira", "GET", "/rest/servicedeskapi/servicedesk")).values.find((d) => d.projectKey === key);
    return { project_key: key, service_desk: desk ? { id: desk.id, project_key: desk.projectKey, project_name: desk.projectName, project_id: desk.projectId, links: { self: `${JIRA_SITE}/rest/servicedeskapi/servicedesk/${desk.id}` } } : null };
  },
  async jira_get_request_types(args) {
    const id = strArg(args, "service_desk_id");
    const result = await call("jira", "GET", `/rest/servicedeskapi/servicedesk/${id}/requesttype`, { query: { start: intArg(args, "start_at", 0, 0), limit: intArg(args, "limit", 50, 1, 50) } });
    return { service_desk_id: id, start: result.start, limit: result.limit, size: result.size, is_last_page: result.isLastPage,
      request_types: result.values.map((t) => ({ id: t.id, name: t.name, description: t.description, ...(t.helpText ? { help_text: t.helpText } : {}), issue_type_id: t.issueTypeId, group_ids: t.groupIds, icon: t.icon })) };
  },
  async jira_get_request_type_fields(args) {
    const desk = strArg(args, "service_desk_id"); const type = strArg(args, "request_type_id");
    const result = await call("jira", "GET", `/rest/servicedeskapi/servicedesk/${desk}/requesttype/${type}/field`);
    return { service_desk_id: desk, request_type_id: type,
      fields: result.requestTypeFields.map((f) => ({ field_id: f.fieldId, name: f.name, required: f.required, supports_multiple: false, ...(f.description ? { description: f.description } : {}), jira_schema: f.jiraSchema, ...(f.validValues.length ? { valid_values: f.validValues } : {}) })),
      can_raise_on_behalf_of: result.canRaiseOnBehalfOf, can_add_request_participants: result.canAddRequestParticipants };
  },
  async jira_create_customer_request(args) {
    const values = jsonArg(args, "request_field_values");
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new ToolError("request_field_values must be a JSON object keyed by field ID.");
    let participants = args.request_participants; if (typeof participants === "string" && participants.trim().startsWith("[")) participants = JSON.parse(participants);
    const desk = strArg(args, "service_desk_id"); const type = strArg(args, "request_type_id");
    const required = (await call("jira", "GET", `/rest/servicedeskapi/servicedesk/${desk}/requesttype/${type}/field`)).requestTypeFields.filter((f) => f.required && (values[f.fieldId] === undefined || values[f.fieldId] === ""));
    if (required.length) throw new ToolError(`JSM_CUSTOMER_REQUEST_MISSING_REQUIRED_FIELDS service_desk_id=${desk} request_type_id=${type}: ${required.map((f) => `${f.name} (${f.fieldId})`).join(", ")}`);
    let onBehalf = strArg(args, "raise_on_behalf_of", false); let mode = "created_direct";
    if (onBehalf && !findPerson(onBehalf)) {
      if (boolArg(args, "strict_on_behalf", false)) throw new ToolError(`raiseOnBehalfOf could not be applied for '${onBehalf}'.`);
      onBehalf = undefined; mode = "created_without_on_behalf";
    }
    const request = await call("jira", "POST", "/rest/servicedeskapi/request", { body: { serviceDeskId: strArg(args, "service_desk_id"), requestTypeId: strArg(args, "request_type_id"), requestFieldValues: values,
      ...(onBehalf ? { raiseOnBehalfOf: personIdentifier(onBehalf) } : {}), ...(participants ? { requestParticipants: csv(participants).map(personIdentifier) } : {}) } });
    const links = { jiraRest: `${JIRA_SITE}/rest/api/2/issue/${request.issueId}`, web: request._links.web, self: `${JIRA_SITE}/rest/servicedeskapi/request/${request.issueId}` };
    return { request_id: request.issueId, request_key: request.issueKey, portal_url: request._links.web, created_mode: mode, links };
  },
  // Confluence
  async confluence_search(args) {
    let cql = simpleQueryToCql(strArg(args, "query")); const spaces = csv(args.spaces_filter);
    if (spaces.length) cql = `(${cql}) AND (${spaces.map((s) => `space = "${s}"`).join(" OR ")})`;
    const result = await call("confluence", "GET", "/rest/api/search", { query: { cql, limit: intArg(args, "limit", 10, 1, 50), expand: "content.history,content.version" } });
    return result.results.map((r) => simplePage(r.content, { excerpt: r.excerpt }));
  },
  async confluence_get_page(args) {
    let raw; const id = pageIdArg(args);
    if (id) {
      try { raw = await call("confluence", "GET", `/rest/api/content/${id}`, { query: { expand: PAGE_EXPAND } }); }
      catch (error) {
        // mcp-atlassian reports a missing page as a result with an "error" field, not as a tool error.
        if (error instanceof ToolError && /No content found/.test(error.message)) return { error: `Failed to retrieve page by ID '${id}': Error retrieving page content: There is no content with the given id, or the calling user does not have permission to view the content` };
        throw error;
      }
    }
    else {
      const title = strArg(args, "title", false); const space = strArg(args, "space_key", false);
      if (!title || !space) throw new ToolError("Either 'page_id' or both 'title' and 'space_key' must be provided.");
      raw = (await call("confluence", "GET", "/rest/api/content", { query: { spaceKey: space, title, type: "page", expand: "body.storage,version" } })).results[0];
      if (!raw) throw new ToolError(`Page with title '${title}' not found in space '${space}'.`);
    }
    const page = simplePage(raw, { content: boolArg(args, "convert_to_markdown", true) ? "markdown" : "storage" });
    return boolArg(args, "include_metadata", true) ? { metadata: page } : { content: page.content };
  },
  async confluence_get_page_children(args) {
    const parent = strArg(args, "parent_id"); const includeContent = boolArg(args, "include_content", false); const limit = intArg(args, "limit", 25, 1, 50); const start = intArg(args, "start", 0, 0);
    const result = await call("confluence", "GET", `/rest/api/content/${parent}/child/page`, { query: { expand: `${strArg(args, "expand", false) ?? "version"}${includeContent ? ",body.storage" : ""}`, limit, start } });
    return { parent_id: parent, count: result.size, limit_requested: limit, start_requested: start,
      results: result.results.map((raw) => simplePage(raw, { content: includeContent ? (boolArg(args, "convert_to_markdown", true) ? "markdown" : "storage") : null })) };
  },
  async confluence_get_space_page_tree(args) {
    const key = strArg(args, "space_key");
    const result = await call("confluence", "GET", `/rest/api/space/${key}/content/page`, { query: { limit: intArg(args, "limit", 100, 1, 500), expand: "ancestors" } });
    const pages = result.results.map((p) => ({ id: p.id, title: p.title, parent_id: p.ancestors?.at(-1)?.id ?? null, position: null, depth: p.ancestors?.length ?? 0 }))
      .sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title));
    return { space_key: key, total_pages: pages.length, has_more: false, pages };
  },
  async confluence_get_comments(args) {
    const id = pageIdArg(args); const page = await call("confluence", "GET", `/rest/api/content/${id}`, { query: { expand: "space" } });
    return (await call("confluence", "GET", `/rest/api/content/${id}/child/comment`, { query: { expand: "body.view.value,version", depth: "all" } })).results.map((c) => simpleComment(c, page.title));
  },
  async confluence_get_labels(args) {
    return simpleLabels(await call("confluence", "GET", `/rest/api/content/${pageIdArg(args)}/label`));
  },
  async confluence_add_label(args) {
    return simpleLabels(await call("confluence", "POST", `/rest/api/content/${pageIdArg(args)}/label`, { body: [{ prefix: "global", name: strArg(args, "name") }] }));
  },
  async confluence_create_page(args) {
    if (args.content_file) throw new ToolError("Reading 'content_file' is not available on this server; pass the page body in 'content'.");
    const content = strArg(args, "content", false); if (content === undefined) throw new ToolError("Either 'content' or 'content_file' must be provided.");
    let created;
    try {
      created = await call("confluence", "POST", "/rest/api/content", { body: { type: "page", title: strArg(args, "title"), space: { key: strArg(args, "space_key") },
        body: { storage: { value: contentToStorage(content, strArg(args, "content_format", false) ?? "markdown"), representation: "storage" } }, ...(args.parent_id ? { ancestors: [{ id: strArg(args, "parent_id") }] } : {}) } });
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(`Failed to create page '${strArg(args, "title")}' in space ${strArg(args, "space_key")}: ${error.message}`);
      throw error;
    }
    const raw = await call("confluence", "GET", `/rest/api/content/${created.id}`, { query: { expand: PAGE_EXPAND } });
    return { message: "Page created successfully", page: simplePage(raw, { content: boolArg(args, "include_content", false) ? "markdown" : null }) };
  },
  async confluence_update_page(args) {
    if (args.content_file) throw new ToolError("Reading 'content_file' is not available on this server; pass the page body in 'content'.");
    const id = pageIdArg(args); const content = strArg(args, "content", false); if (content === undefined) throw new ToolError("Either 'content' or 'content_file' must be provided.");
    const current = await call("confluence", "GET", `/rest/api/content/${id}`, { query: { expand: "version" } });
    await call("confluence", "PUT", `/rest/api/content/${id}`, { body: { id, type: "page", title: strArg(args, "title"),
      version: { number: current.version.number + 1, minorEdit: boolArg(args, "is_minor_edit", false), message: strArg(args, "version_comment", false) ?? "" },
      body: { storage: { value: contentToStorage(content, strArg(args, "content_format", false) ?? "markdown"), representation: "storage" } }, ...(args.parent_id ? { ancestors: [{ id: strArg(args, "parent_id") }] } : {}) } });
    const raw = await call("confluence", "GET", `/rest/api/content/${id}`, { query: { expand: PAGE_EXPAND } });
    return { message: "Page updated successfully", page: simplePage(raw, { content: boolArg(args, "include_content", false) ? "markdown" : null }) };
  },
  async confluence_add_comment(args) {
    const id = pageIdArg(args); const page = await call("confluence", "GET", `/rest/api/content/${id}`, { query: { expand: "space" } });
    const c = await call("confluence", "POST", "/rest/api/content", { body: { type: "comment", container: { id, type: "page" }, body: { storage: { value: markdownToStorage(strArg(args, "body")), representation: "storage" } } } });
    return { success: true, message: "Comment added successfully", comment: simpleComment(c, page.title) };
  },
  async confluence_search_user(args) {
    const query = strArg(args, "query"); const needle = (/~\s*["']([^"']+)["']/.exec(query)?.[1] ?? query).toLowerCase();
    const members = (await call("confluence", "GET", `/rest/api/group/${strArg(args, "group_name", false) ?? "confluence-users"}/member`, { query: { limit: 200 } })).results;
    return members.filter((u) => u.displayName.toLowerCase().includes(needle) || u.username.includes(needle)).slice(0, intArg(args, "limit", 10, 1, 50))
      .map((u) => ({ entity_type: "user", title: u.displayName, score: 0.0, user: { account_id: null, display_name: u.displayName, email: null, profile_picture: u.profilePicture.path, is_active: true } }));
  },
};
const mcpTools = TOOL_SPECS.map((spec) => ({ ...spec, run: TOOL_HANDLERS[spec.name] }));
for (const tool of mcpTools) if (!tool.run) throw new Error(`No handler for ${tool.name}`);
const isReadOnly = (tool) => tool.annotations?.readOnlyHint === true;

function handleRpc(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  if (message.id === undefined || message.id === null) return null;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return result({ protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { experimental: {}, logging: {}, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false }, tools: { listChanged: true } },
        serverInfo: { name: "Atlassian MCP", version: "3.4.9" } });
    }
    case "ping": return result({});
    case "tools/list": return result({ tools: TOOL_SPECS });
    case "resources/list": return result({ resources: [] });
    case "resources/templates/list": return result({ resourceTemplates: [] });
    case "prompts/list": return result({ prompts: [] });
    case "logging/setLevel": return result({});
    case "tools/call": return { pending: true, message };
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
}
async function callTool(message) {
  const params = message.params ?? {};
  const tool = mcpTools.find((entry) => entry.name === params.name);
  if (!tool) return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true } };
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const invalid = validateArgs(tool, args);
  if (invalid) return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: invalid }], isError: true } };
  try {
    const value = await tool.run(args);
    if (!isReadOnly(tool)) touched = true;
    log(`mcp ${tool.name} ok`);
    // Python's json prints floats such as search scores as 0.0; keep the same text.
    const text = JSON.stringify(value, null, 2).replace(/^(\s*"score": )(-?\d+)(,?)$/gm, "$1$2.0$3");
    return { jsonrpc: "2.0", id: message.id, result: { _meta: { fastmcp: { wrap_result: true } }, content: [{ type: "text", text }], structuredContent: { result: text }, isError: false } };
  } catch (error) {
    if (!(error instanceof ToolError)) console.error(error);
    log(`mcp ${tool.name} error: ${error.message}`);
    return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `Error calling tool '${tool.name.replace(/^(jira|confluence)_/, "")}': ${error.message}` }], isError: true } };
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────

function log(line) { console.log(`[demo-atlassian] ${new Date().toISOString()} ${line}`); }
function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json;charset=UTF-8" }), "cache-control": "no-store", ...headers });
  res.end(text);
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("Body too large"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
/** Data Center accepts a personal access token (Bearer) or basic auth; anonymous REST calls get 401 like the real thing. */
const authorized = (req) => /^(Bearer|Basic)\s+\S+/i.test(String(req.headers.authorization ?? ""));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health") return send(res, 200, { ok: true, services: ["jira", "confluence"], mcp: "/mcp" });
    if (path === "/state" && req.method === "GET") return send(res, 200, { touched, ...state, audit });
    if (path === "/reset" && req.method === "POST") { reset(); log("state reset"); return send(res, 200, { ok: true }); }
    if (path === "/mcp") {
      if (req.method === "GET") return send(res, 405, { error: "SSE stream not offered; use POST." }, { allow: "POST, DELETE" });
      if (req.method === "DELETE") return send(res, 200, { ok: true });
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST, DELETE" });
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const sessionHeader = { "mcp-session-id": req.headers["mcp-session-id"] || randomUUID() };
      const respond = async (message) => {
        const handled = handleRpc(message);
        if (!handled?.pending) return handled;
        const at = Date.now(); // Real time binds the observed call to an assistant tool window, not the simulated business clock.
        const response = await callTool(handled.message);
        const input = structuredClone(message.params?.arguments ?? {});
        const output = response.result.content?.[0]?.text ?? "";
        audit.push({ sequence: ++auditSequence, at, name: String(message.params?.name ?? ""), input: JSON.stringify(input).length <= 65536 ? input : { truncated: true }, output: output.length <= 65536 ? output : { truncated: true }, status: response.result.isError ? "error" : "completed" });
        if (audit.length > 300) audit.shift();
        return response;
      };
      if (Array.isArray(payload)) { const responses = (await Promise.all(payload.map(respond))).filter(Boolean); return responses.length ? send(res, 200, responses, sessionHeader) : send(res, 202, undefined, sessionHeader); }
      const response = await respond(payload);
      return response ? send(res, 200, response, sessionHeader) : send(res, 202, undefined, sessionHeader);
    }
    const product = /^\/(jira|confluence)(\/.*)$/.exec(path);
    if (!product) return send(res, 404, { error: "not_found" });
    const [, kind, rest] = product;
    if (!rest.startsWith("/rest/")) return send(res, 404, { error: "not_found" });
    if (!authorized(req)) return send(res, 401, kind === "jira" ? { errorMessages: ["You are not authenticated. Authentication required to perform this operation."], errors: {} } : { statusCode: 401, data: { authorized: false, valid: true, errors: [], successful: false }, message: "This resource requires authentication", reason: "Unauthorized" });
    const raw = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readBody(req) : "";
    let body;
    if (raw) { try { body = JSON.parse(raw); } catch { return send(res, 400, { errorMessages: ["Unexpected character in JSON body."], errors: {} }); } }
    const ctx = { restBase: `http://${req.headers.host}/${kind}` };
    try {
      const result = await (kind === "jira" ? jiraRest : confluenceRest)(req.method ?? "GET", rest, url.searchParams, body, ctx);
      if (req.method !== "GET") touched = true;
      log(`${kind} ${req.method} ${rest} ok`);
      if (result && typeof result === "object" && "status" in result && typeof result.status === "number" && Object.keys(result).length <= 2) return send(res, result.status, result.body);
      return send(res, 200, result);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      log(`${kind} ${req.method} ${rest} ${error.status}: ${error.message}`);
      if (kind === "jira") return send(res, error.status, { errorMessages: error.extra.errorMessages ?? (error.message ? [error.message] : []), errors: error.extra.errors ?? {} });
      return send(res, error.status, { statusCode: error.status, data: { authorized: true, valid: true, errors: [], successful: false }, message: error.extra.message ?? error.message, reason: error.status === 404 ? "Not Found" : error.status === 409 ? "Conflict" : "Bad Request" });
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  }
});
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (/mcp, /jira/rest/..., /confluence/rest/...)`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
