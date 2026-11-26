import type { DenBadgeTone } from "../../(den)/_components/ui/badge";
import type { DenOrgMember, DenOrgTeam } from "../../(den)/_lib/den-org";
import { type AccessDraft, accessNames, accessPeopleIds, joinNames, ownedAccessStatus, peopleLabel } from "../../(den)/dashboard/_components/access-summary";
import { everyHoursLabel, hourLabel } from "../../(den)/dashboard/_components/my-agent-view";
import { formatWorkbotCost } from "../../(den)/dashboard/_features/workbot-usage/workbot-usage-data";

// ---------------------------------------------------------------------------
// Sample model. Everything in this prototype is in memory; nothing is saved.
// ---------------------------------------------------------------------------

export type PersonId = "dana" | "sam" | "mina" | "leo" | "priya";
export type Scenario = "sample" | "empty";
export type ConnectorId = "slack" | "linear" | "github" | "notion" | "gmail" | "calendar";
export type Level = "none" | "read" | "write";
// A level is a shortcut for a set of tools. Any other set is "custom".
export type Preset = Level | "custom";
export type PaidBy = "me" | "org";
export type BlockReason = "Not allowed" | "Blocked by admin" | "Not connected";
export type Outcome = "sent" | "quiet" | "failed" | "over_budget";
export type RhythmId = "1h" | "2h" | "3h" | "4h" | "daily" | "weekly";
export type Days = "weekdays" | "everyday";
export type ModelId = "auto" | "haiku" | "sonnet" | "opus";

export type Connector = {
  id: ConnectorId;
  name: string;
  url: string;
  aliases: string[];
  readLine: string;
  writeLine: string;
  readTools: string[];
  writeTools: string[];
  neverTools: string[];
};

export type Schedule = {
  rhythm: RhythmId;
  days: Days;
  startHour: number;
  endHour: number;
  hour: number;
  weekday: string;
};

// One agent, several routines: each is a time it wakes up and what it does then.
export type Routine = {
  id: string;
  name: string;
  // What to do this time, on top of the agent's job. Empty means "do your job".
  instruction: string;
  schedule: Schedule;
  on: boolean;
};

export type ScriptStep = {
  connector: ConnectorId | "openwork";
  label: string;
  blockedLabel: string;
  tool: string;
  // How it asks for this the first time, in plain words: "File the missing bug in Linear".
  ask?: string;
  // What it says while it does this: "Checking Linear".
  doing?: string;
  // Only attempted once the instructions mention this word; skipped quietly when the tool is blocked.
  ifInstructed?: string;
};

export type ScriptedRun = {
  outcome: "sent" | "quiet";
  summary: string;
  blockedSummary?: string;
  steps: ScriptStep[];
};

export type RunStep = {
  key: string;
  connector: ConnectorId | "workbot" | "openwork";
  label: string;
  tool: string;
  blocked?: BlockReason;
  // Set on a step it may not take yet: how it asks for it.
  ask?: string;
  // What it says while it does this. Without it, the label is shown.
  doing?: string;
};

// One thing a run wants to do with a tool it isn't allowed yet, in plain words.
export type AskItem = { connector: ConnectorId | "openwork"; tool: string; action: string };

// What a run asked to do the first time it needed to, and how that ended.
export type RunAsk = {
  items: AskItem[];
  state: "allowed" | "always" | "denied" | "expired";
};

export type AgentRun = {
  id: string;
  when: string;
  today: boolean;
  outcome: Outcome;
  summary: string;
  costMicro: number;
  steps: RunStep[];
  // Set when someone asked the agent a question. The run is its answer, shown only to them.
  asked?: string;
  // The routine this run was for. Unset when it was run by hand or asked a question.
  routine?: string;
  // Set when the person stopped it before it finished.
  stopped?: boolean;
  // A message the person sent while it worked. It read that first and went by it.
  heard?: string;
  // A tool it asked to use partway through, and the answer.
  wanted?: RunAsk;
};

// The colour of an agent's round avatar. Each agent is a named character with one job.
export type AgentColor = "red" | "orange" | "green" | "teal" | "blue" | "violet" | "pink" | "slate";
export const AGENT_COLORS: { id: AgentColor; fill: string }[] = [
  { id: "red", fill: "#e5484d" },
  { id: "orange", fill: "#f76b15" },
  { id: "green", fill: "#30a46c" },
  { id: "teal", fill: "#12a594" },
  { id: "blue", fill: "#0090ff" },
  { id: "violet", fill: "#6e56cf" },
  { id: "pink", fill: "#d6409f" },
  { id: "slate", fill: "#60646c" },
];

// OpenWork's own tools, which an agent can be allowed like any app.
export type OpenWorkArea = "sessions" | "skills" | "automations" | "artifacts";

// Where an agent's sessions may run: OpenWork Cloud, and any of the member's own computers.
export type RunsOn = { cloud: boolean; computers: string[] };
export const MY_COMPUTERS: { id: string; name: string; online: boolean }[] = [
  { id: "laptop", name: "This MacBook", online: true },
  { id: "studio", name: "Mac Studio", online: true },
];

// A reply in a thread: a follow-up about one result. It never changes the agent.
// When a reply in a thread asks for a lasting change, the agent offers to take it to the conversation instead.
export type ThreadReply = { id: string; runId: string; from: PersonId | "agent"; text: string; move?: { text: string; done: boolean } };

export type Agent = {
  id: string;
  name: string;
  color: AgentColor;
  // Its OpenWork tools, by area. Anything not listed is blocked.
  openwork: Record<OpenWorkArea, string[]>;
  runsOn: RunsOn;
  // Also send results to the person's Slack, besides its conversation here.
  alsoSlack: boolean;
  replies: ThreadReply[];
  // Where in the conversation someone asked "What do you remember?", by how many runs came before.
  memoryChecks: number[];
  instructions: string;
  on: boolean;
  routines: Routine[];
  // The tools it may call, by app. Anything not listed is blocked.
  tools: Record<ConnectorId, string[]>;
  model: ModelId;
  budgetMicro: number | null;
  paidBy: PaidBy;
  spentMicro: number;
  runsThisMonth: number;
  runCount: number;
  quietWhenNothing: boolean;
  runs: AgentRun[];
  script: ScriptedRun[];
  madeIn: "page" | "chat";
  owner: PersonId;
  share: AccessDraft;
  // People and teams it is shared with who may also change it. Everyone else it is shared with can only use it.
  managers: string[];
  // A shared agent shows in your list once you add it. Your own are always there.
  added: boolean;
  // An admin's mark that the organization stands behind this shared agent.
  approved: boolean;
  // Set while it is new: made from +, seen only by its owner, not started yet.
  setup: AgentSetup | null;
  // The member's own words that made it, kept at the top of its conversation. Empty for agents made another way.
  said: string;
  notes: AgentNote[];
};

// A new agent is a chat. It hears its job, says what it will do and how often, and waits for one answer.
export type AgentSetup = {
  // The schedule it proposes, read from the job. Every hour unless the job says otherwise.
  schedule: Schedule;
  // "start" asks whether to begin. "often" asks how often instead.
  asking: "start" | "often";
};

// Something an agent was told to keep in mind. On a shared agent that changes it for
// other people, so it waits as "ask" until whoever said it agrees.
export type AgentNote = {
  id: string;
  text: string;
  afterRuns: number;
  by: PersonId;
  forEveryone: boolean;
  state: "kept" | "ask" | "dropped";
};

export type Access = {
  // Tools an admin blocks for every agent in the organization, by app.
  blocked: Record<ConnectorId, string[]>;
  agentCapMicro: number | null;
  maxAgents: number;
  // A shared pot agents can be paid from, instead of their owner's own limit.
  orgBudget: { offered: boolean; monthlyMicro: number };
  // Whether members may share their agents with other people.
  sharing: boolean;
  // How many sessions one agent may work on at once. One more waits for a free slot.
  atOnce: number;
  // Agents may only run in OpenWork Cloud, never on members' own computers.
  cloudOnly: boolean;
};

// One piece of work an agent is doing now. Every run is a fresh session.
export type SessionState = "working" | "waiting" | "needs_you";
export type AgentSession = {
  id: string;
  agentId: string;
  // "ask" is a message in its conversation. The others are background work that reports back there.
  kind: "ask" | "routine" | "run";
  label: string;
  routineId?: string;
  asked?: string;
  state: SessionState;
  // Steps shown so far, out of the run worked out when it started.
  shown: number;
  run: AgentRun;
  // What it will ask before it goes past step `at`. Raised in the background, the question expires after 30 minutes.
  ask: { items: AskItem[]; at: number; raisedMs: number; background: boolean } | null;
  heard: string[];
};

export const ASK_EXPIRES_MS = 30 * 60 * 1000;

export type ToolSet = Pick<Connector, "name" | "url" | "readLine" | "writeLine" | "readTools" | "writeTools" | "neverTools"> & { id: string };

export const OPENWORK_AREAS: (ToolSet & { id: OpenWorkArea })[] = [
  {
    id: "sessions", name: "Sessions", url: "",
    readLine: "Reads your sessions.",
    writeLine: "Reads your sessions, starts new ones and sends to them.",
    readTools: ["list_sessions", "read_session"],
    writeTools: ["start_session", "send_to_session"],
    neverTools: ["answer_remote_session", "attach_remote_session"],
  },
  {
    id: "skills", name: "Skills", url: "",
    readLine: "Reads your skills.",
    writeLine: "Reads, creates and changes your skills.",
    readTools: ["list_skills", "read_skill"],
    writeTools: ["create_skill", "update_skill"],
    neverTools: ["delete_skill"],
  },
  {
    id: "automations", name: "Automations", url: "",
    readLine: "Reads your automations and their runs.",
    writeLine: "Reads your automations, proposes new ones and changes them.",
    readTools: ["list_automations", "read_automation"],
    writeTools: ["propose_automation", "update_automation"],
    neverTools: ["archive_automation"],
  },
  {
    id: "artifacts", name: "Artifacts", url: "",
    readLine: "Reads your artifacts.",
    writeLine: "Reads, creates and changes your artifacts.",
    readTools: ["list_artifacts", "read_artifact"],
    writeTools: ["create_artifact", "update_artifact"],
    neverTools: ["delete_artifact"],
  },
];

export function noOpenWork(): Record<OpenWorkArea, string[]> {
  return { sessions: [], skills: [], automations: [], artifacts: [] };
}

export const PRESET_LABEL: Record<Preset, string> = { none: "Off", read: "Read only", write: "Read and write", custom: "Custom" };
export const TIMEZONE = "America/Los_Angeles";

export const CONNECTORS: Connector[] = [
  {
    id: "slack", name: "Slack", url: "https://slack.com", aliases: ["slack"],
    readLine: "Reads channels and threads you're in.",
    writeLine: "Reads channels and threads, and posts messages as you. Never deletes.",
    readTools: ["search_messages", "read_channel", "read_thread", "list_channels"],
    writeTools: ["send_message", "add_reaction"],
    neverTools: ["delete_message", "archive_channel"],
  },
  {
    id: "linear", name: "Linear", url: "https://linear.app", aliases: ["linear"],
    readLine: "Reads issues, comments and projects.",
    writeLine: "Reads, creates and updates issues and comments. Never deletes.",
    readTools: ["list_issues", "get_issue", "list_comments", "list_projects"],
    writeTools: ["create_issue", "update_issue", "create_comment"],
    neverTools: ["delete_issue", "archive_project"],
  },
  {
    id: "github", name: "GitHub", url: "https://github.com", aliases: ["github", "pull request", "prs"],
    readLine: "Reads pull requests, issues and commits.",
    writeLine: "Reads, comments on and opens pull requests and issues. Never deletes.",
    readTools: ["list_pull_requests", "get_pull_request", "list_commits", "search_issues"],
    writeTools: ["create_issue", "add_comment", "create_pull_request"],
    neverTools: ["delete_branch", "delete_repository"],
  },
  {
    id: "notion", name: "Notion", url: "https://notion.so", aliases: ["notion"],
    readLine: "Reads pages and databases.",
    writeLine: "Reads, creates and edits pages. Never deletes.",
    readTools: ["search", "get_page", "query_database"],
    writeTools: ["create_page", "update_page", "append_blocks"],
    neverTools: ["trash_page", "delete_database"],
  },
  {
    id: "gmail", name: "Gmail", url: "https://mail.google.com", aliases: ["gmail", "email", "inbox"],
    readLine: "Reads your inbox and threads.",
    writeLine: "Reads your inbox, drafts and sends email as you. Never deletes.",
    readTools: ["search_threads", "get_thread", "list_labels"],
    writeTools: ["create_draft", "send_message", "modify_labels"],
    neverTools: ["delete_thread", "empty_trash"],
  },
  {
    id: "calendar", name: "Google Calendar", url: "https://calendar.google.com", aliases: ["calendar", "meetings"],
    readLine: "Reads your events.",
    writeLine: "Reads, creates and updates events. Never deletes.",
    readTools: ["list_events", "get_event"],
    writeTools: ["create_event", "update_event"],
    neverTools: ["delete_event"],
  },
];

export const MODELS: { id: ModelId; label: string; runMicro: number }[] = [
  { id: "auto", label: "Auto", runMicro: 190_000 },
  { id: "haiku", label: "Claude Haiku 5.5", runMicro: 60_000 },
  { id: "sonnet", label: "Claude Sonnet 5.5", runMicro: 420_000 },
  { id: "opus", label: "Claude Opus 5.5", runMicro: 1_350_000 },
];

export const RHYTHMS: { id: RhythmId; label: string; everyHours: number | null }[] = [
  { id: "1h", label: everyHoursLabel(1), everyHours: 1 },
  { id: "2h", label: everyHoursLabel(2), everyHours: 2 },
  { id: "3h", label: everyHoursLabel(3), everyHours: 3 },
  { id: "4h", label: everyHoursLabel(4), everyHours: 4 },
  { id: "daily", label: "Once a day", everyHours: null },
  { id: "weekly", label: "Once a week", everyHours: null },
];

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const DEFAULT_SCHEDULE: Schedule = { rhythm: "daily", days: "weekdays", startHour: 9, endHour: 18, hour: 9, weekday: "Monday" };
export const BUDGET_DOLLARS = [5, 10, 25, 50];
export const MAX_AGENT_CHOICES = [3, 5, 10];
export const DOLLAR = 1_000_000;

export const ME: PersonId = "dana";
export const MEMBER = { name: "Dana Reyes", initials: "DR", ownSpendMicro: 18_200_000, ownRequests: 268, limitMicro: 60 * DOLLAR };

export const PEOPLE: { id: PersonId; name: string; email: string }[] = [
  { id: "dana", name: "Dana Reyes", email: "dana@example.com" },
  { id: "sam", name: "Sam Patel", email: "sam@example.com" },
  { id: "mina", name: "Mina Cho", email: "mina@example.com" },
  { id: "leo", name: "Leo Marsh", email: "leo@example.com" },
  { id: "priya", name: "Priya Nair", email: "priya@example.com" },
];

export const TEAMS: { id: string; name: string; memberIds: PersonId[] }[] = [
  { id: "team-eng", name: "Engineering", memberIds: ["dana", "sam", "leo"] },
  { id: "team-support", name: "Support", memberIds: ["mina", "priya"] },
];

export const ORG_MEMBERS: DenOrgMember[] = PEOPLE.map((person) => ({
  id: person.id,
  userId: `user-${person.id}`,
  inviteId: null,
  role: "member",
  effectiveRole: "member",
  adminTeams: [],
  createdAt: null,
  joinedAt: null,
  isOwner: false,
  openworkWeb: true,
  user: { id: `user-${person.id}`, email: person.email, name: person.name, image: null },
}));

export const ORG_TEAMS: DenOrgTeam[] = TEAMS.map((team) => ({
  id: team.id,
  name: team.name,
  createdAt: null,
  updatedAt: null,
  memberIds: [...team.memberIds],
  managedByScim: false,
  grantsOrganizationAdmin: false,
}));

export const DIRECTORY = { members: ORG_MEMBERS, teams: ORG_TEAMS };
export const NOT_SHARED: AccessDraft = { orgWide: false, memberIds: [], teamIds: [] };

// What the people an agent is shared with have used it for this month (sample data).
export const SHARED_USE: Record<string, Record<string, { spentMicro: number; runs: number }>> = {
  "agent-triage": { sam: { spentMicro: 1_860_000, runs: 14 } },
};

export const OTHER_PEOPLE: {
  id: PersonId;
  name: string;
  ownSpendMicro: number;
  requests: number;
  limitMicro: number;
  agents: { id: string; name: string; model: string; spentMicro: number; budgetMicro: number; runs: number; paidBy: PaidBy }[];
}[] = [
  {
    id: "sam", name: "Sam Patel", ownSpendMicro: 31_750_000, requests: 412, limitMicro: 60 * DOLLAR,
    agents: [{ id: "standup", name: "Standup digest", model: "Auto", spentMicro: 2_100_000, budgetMicro: 10 * DOLLAR, runs: 21, paidBy: "me" }],
  },
  {
    id: "mina", name: "Mina Cho", ownSpendMicro: 9_400_000, requests: 156, limitMicro: 60 * DOLLAR,
    agents: [
      { id: "agent-churn", name: "Churn watch", model: "Claude Sonnet 5.5", spentMicro: 10_240_000, budgetMicro: 10 * DOLLAR, runs: 88, paidBy: "org" },
      { id: "docs", name: "Docs gardener", model: "Claude Haiku 5.5", spentMicro: 1_120_000, budgetMicro: 5 * DOLLAR, runs: 12, paidBy: "me" },
    ],
  },
  { id: "leo", name: "Leo Marsh", ownSpendMicro: 12_900_000, requests: 201, limitMicro: 60 * DOLLAR, agents: [] },
  { id: "priya", name: "Priya Nair", ownSpendMicro: 4_300_000, requests: 77, limitMicro: 60 * DOLLAR, agents: [] },
];

export const DEFAULT_ACCESS: Access = {
  blocked: { slack: [], linear: [], github: [], notion: [], gmail: ["send_message", "modify_labels"], calendar: ["create_event", "update_event"] },
  agentCapMicro: 25 * DOLLAR,
  maxAgents: 5,
  orgBudget: { offered: true, monthlyMicro: 200 * DOLLAR },
  sharing: true,
  atOnce: 3,
  cloudOnly: false,
};

export const DEFAULT_CONNECTED: Record<ConnectorId, boolean> = { slack: true, linear: true, github: true, notion: true, gmail: true, calendar: false };

export const OUTCOME_PILL: Record<Outcome, { label: string; tone: DenBadgeTone }> = {
  sent: { label: "Sent", tone: "info" },
  quiet: { label: "Quiet", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  over_budget: { label: "Over budget", tone: "warning" },
};

function eachConnector(tools: (id: ConnectorId) => string[]): Record<ConnectorId, string[]> {
  return { slack: tools("slack"), linear: tools("linear"), github: tools("github"), notion: tools("notion"), gmail: tools("gmail"), calendar: tools("calendar") };
}

export function noTools(): Record<ConnectorId, string[]> {
  return eachConnector(() => []);
}

export function copyTools(tools: Record<ConnectorId, string[]>): Record<ConnectorId, string[]> {
  return eachConnector((id) => [...tools[id]]);
}

export function delivered(key: string): RunStep {
  return { key, connector: "workbot", label: "Sent you a direct message in Slack", tool: "deliver" };
}

// What every agent has that the samples below don't spell out.
type AgentBase = Omit<Agent, "color" | "openwork" | "runsOn" | "alsoSlack" | "replies" | "memoryChecks" | "said">;
const SAMPLE_EXTRAS: Record<string, Partial<Agent>> = {
  "agent-triage": {
    color: "blue",
    alsoSlack: true,
    openwork: { ...noOpenWork(), sessions: ["list_sessions", "read_session"] },
    replies: [
      { id: "reply-1", runId: "triage-1", from: "dana", text: "Which release issue is blocked?" },
      { id: "reply-2", runId: "triage-1", from: "agent", text: "The export timeout in Linear. It has waited on a review since Friday, and two people are assigned." },
    ],
  },
  "agent-notes": { color: "violet" },
  "agent-inbox": { color: "orange" },
  "agent-churn": { color: "red" },
};
const SAMPLE_COLORS: AgentColor[] = ["teal", "green", "pink", "slate"];

function finishAgent(base: AgentBase, index: number): Agent {
  return {
    color: SAMPLE_COLORS[index % SAMPLE_COLORS.length] ?? "slate",
    openwork: noOpenWork(),
    runsOn: { cloud: true, computers: [] },
    alsoSlack: false,
    replies: [],
    memoryChecks: [],
    said: "",
    ...base,
    ...SAMPLE_EXTRAS[base.id],
  };
}

export function sampleAgents(): Agent[] {
  return sampleBases().map(finishAgent);
}

function sampleBases(): AgentBase[] {
  return [
    {
      id: "agent-triage",
      name: "Morning triage",
      instructions: "Read my open Linear issues and new GitHub review requests. Tell me what needs me today, most urgent first. Skip anything I already replied to.",
      on: true,
      routines: [
        { id: "triage-morning", name: "Morning check", instruction: "", on: true, schedule: { rhythm: "daily", days: "weekdays", startHour: 9, endHour: 18, hour: 9, weekday: "Monday" } },
        { id: "triage-friday", name: "Friday wrap-up", instruction: "Sum up what I closed this week and what carries over to Monday.", on: true, schedule: { rhythm: "weekly", days: "weekdays", startHour: 9, endHour: 18, hour: 16, weekday: "Friday" } },
      ],
      tools: { ...noTools(), slack: ["search_messages", "read_thread"], linear: readOnly("linear"), github: readOnly("github") },
      paidBy: "me",
      model: "auto",
      budgetMicro: 10 * DOLLAR,
      spentMicro: 3_420_000,
      runsThisMonth: 16,
      runCount: 0,
      quietWhenNothing: true,
      madeIn: "page",
      owner: "dana",
      share: { orgWide: false, memberIds: ["sam"], teamIds: ["team-eng"] },
      managers: ["sam"],
      added: true,
      approved: true,
      setup: null,
      notes: [{ id: "note-sam", text: "Skip threads that are only emoji reactions.", afterRuns: 0, by: "sam", forEveryone: true, state: "kept" }],
      runs: [
        {
          id: "triage-1", routine: "Morning check", when: "9:00 AM", today: true, outcome: "sent", costMicro: 212_000,
          summary: "3 things need you today: a blocked release issue and 2 reviews waiting since Friday.",
          steps: [
            { key: "a", connector: "linear", label: "Read 14 open issues assigned to you", tool: "list_issues" },
            { key: "b", connector: "github", label: "Read 5 review requests", tool: "list_pull_requests" },
            { key: "c", connector: "slack", label: "Read 2 threads that mention you", tool: "search_messages" },
            delivered("d"),
          ],
        },
        {
          id: "triage-2", routine: "Morning check", when: "Fri 9:00 AM", today: false, outcome: "quiet", costMicro: 164_000,
          summary: "Nothing new since Thursday.",
          steps: [
            { key: "a", connector: "linear", label: "Read 13 open issues assigned to you", tool: "list_issues" },
            { key: "b", connector: "github", label: "Read 3 review requests", tool: "list_pull_requests" },
          ],
        },
        {
          id: "triage-3", routine: "Morning check", when: "Thu 9:00 AM", today: false, outcome: "sent", costMicro: 198_000,
          summary: "1 review is waiting on you: the billing export pull request.",
          steps: [
            { key: "a", connector: "linear", label: "Read 13 open issues assigned to you", tool: "list_issues" },
            { key: "b", connector: "github", label: "Read 4 review requests", tool: "list_pull_requests" },
            delivered("c"),
          ],
        },
      ],
      script: [
        {
          outcome: "sent",
          summary: "2 things need you: a customer-reported bug moved to urgent, and 1 review is waiting.",
          steps: [
            { connector: "linear", label: "Read 15 open issues assigned to you", blockedLabel: "Couldn't read Linear", tool: "list_issues" },
            { connector: "github", label: "Read 4 review requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
            { connector: "slack", label: "Read 1 thread that mentions you", blockedLabel: "Couldn't read Slack", tool: "search_messages" },
          ],
        },
        {
          outcome: "quiet",
          summary: "Nothing new since the last run.",
          steps: [
            { connector: "linear", label: "Read 15 open issues assigned to you", blockedLabel: "Couldn't read Linear", tool: "list_issues" },
            { connector: "github", label: "Read 4 review requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
          ],
        },
      ],
    },
    {
      id: "agent-notes",
      name: "Release notes",
      instructions: "Draft release notes from the pull requests merged this week and save them to the Release notes page in Notion. Group them by area and keep each line to one sentence.",
      on: true,
      routines: [
        { id: "notes-weekly", name: "Weekly draft", instruction: "", on: true, schedule: { rhythm: "weekly", days: "weekdays", startHour: 9, endHour: 18, hour: 16, weekday: "Friday" } },
      ],
      tools: { ...noTools(), github: readOnly("github"), notion: readOnly("notion") },
      paidBy: "org",
      model: "sonnet",
      budgetMicro: 25 * DOLLAR,
      spentMicro: 6_100_000,
      runsThisMonth: 3,
      runCount: 0,
      quietWhenNothing: true,
      madeIn: "page",
      owner: "dana",
      share: NOT_SHARED,
      managers: [],
      added: true,
      approved: false,
      setup: null,
      notes: [],
      runs: [
        {
          id: "notes-1", routine: "Weekly draft", when: "Fri 4:00 PM", today: false, outcome: "sent", costMicro: 2_040_000,
          summary: "Drafted notes for 12 merged pull requests and sent them to you. Couldn't save to Notion: it isn't allowed to create pages there.",
          steps: [
            { key: "a", connector: "github", label: "Read 12 merged pull requests", tool: "list_pull_requests" },
            { key: "b", connector: "notion", label: "Couldn't create a page in Notion", tool: "create_page", blocked: "Not allowed" },
            delivered("c"),
          ],
        },
      ],
      script: [
        {
          outcome: "sent",
          summary: "Saved release notes for 9 merged pull requests to Notion.",
          blockedSummary: "Drafted notes for 9 merged pull requests and sent them to you. Couldn't save to Notion: it isn't allowed to create pages there.",
          steps: [
            { connector: "github", label: "Read 9 merged pull requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
            { connector: "notion", label: "Created the page “Release notes, week 47” in Notion", blockedLabel: "Couldn't create a page in Notion", tool: "create_page", ask: "Save the release notes as a page in Notion" },
          ],
        },
      ],
    },
    {
      id: "agent-inbox",
      name: "Inbox watch",
      instructions: "Check my inbox for customer replies that have waited more than a day. Tell me who is waiting and what they asked.",
      on: true,
      routines: [
        { id: "inbox-sweep", name: "Inbox sweep", instruction: "", on: true, schedule: { rhythm: "2h", days: "weekdays", startHour: 9, endHour: 18, hour: 9, weekday: "Monday" } },
      ],
      tools: { ...noTools(), gmail: readOnly("gmail") },
      paidBy: "me",
      model: "auto",
      budgetMicro: 5 * DOLLAR,
      spentMicro: 5_030_000,
      runsThisMonth: 61,
      runCount: 0,
      quietWhenNothing: true,
      madeIn: "page",
      owner: "dana",
      share: NOT_SHARED,
      managers: [],
      added: true,
      approved: false,
      setup: null,
      notes: [],
      runs: [
        { id: "inbox-1", routine: "Inbox sweep", when: "9:00 AM", today: true, outcome: "over_budget", costMicro: 0, summary: "Skipped. This month's budget is used up.", steps: [] },
        {
          id: "inbox-2", routine: "Inbox sweep", when: "Fri 5:00 PM", today: false, outcome: "sent", costMicro: 88_000,
          summary: "2 customer replies have waited more than a day.",
          steps: [{ key: "a", connector: "gmail", label: "Read 31 threads in your inbox", tool: "search_threads" }, delivered("b")],
        },
        {
          id: "inbox-x", routine: "Inbox sweep", when: "Fri 3:00 PM", today: false, outcome: "sent", costMicro: 96_000,
          summary: "1 customer reply has waited more than a day: a question about renewing their plan.",
          wanted: { items: [{ connector: "gmail", tool: "create_draft", action: "Draft a reply in Gmail" }], state: "expired" },
          steps: [
            { key: "a", connector: "gmail", label: "Read 26 threads in your inbox", tool: "search_threads" },
            { key: "b", connector: "gmail", label: "Didn't draft a reply", tool: "create_draft", blocked: "Not allowed" },
          ],
        },
        {
          id: "inbox-3", routine: "Inbox sweep", when: "Fri 1:00 PM", today: false, outcome: "quiet", costMicro: 74_000,
          summary: "No one has waited more than a day.",
          steps: [{ key: "a", connector: "gmail", label: "Read 28 threads in your inbox", tool: "search_threads" }],
        },
      ],
      script: [
        {
          outcome: "sent",
          summary: "1 customer reply has waited more than a day. I drafted an answer for you to review.",
          blockedSummary: "1 customer reply has waited more than a day.",
          steps: [
            { connector: "gmail", label: "Read 23 threads in your inbox", blockedLabel: "Couldn't read Gmail", tool: "search_threads" },
            { connector: "gmail", ifInstructed: "draft", label: "Drafted 1 reply for you to review", blockedLabel: "Couldn't draft a reply", tool: "create_draft", ask: "Draft a reply in Gmail" },
          ],
        },
        {
          outcome: "quiet",
          summary: "No one has waited more than a day.",
          steps: [{ connector: "gmail", label: "Read 24 threads in your inbox", blockedLabel: "Couldn't read Gmail", tool: "search_threads" }],
        },
      ],
    },
    {
      id: "agent-churn",
      name: "Churn watch",
      instructions: "Watch customer email and the support channels for anyone who mentions cancelling or switching. Tell me who it was and what they said.",
      on: false,
      routines: [
        { id: "churn-sweep", name: "Churn sweep", instruction: "", on: true, schedule: { rhythm: "4h", days: "weekdays", startHour: 9, endHour: 17, hour: 9, weekday: "Monday" } },
      ],
      tools: { ...noTools(), gmail: readOnly("gmail"), slack: readOnly("slack") },
      paidBy: "org",
      model: "sonnet",
      budgetMicro: 10 * DOLLAR,
      spentMicro: 0,
      runsThisMonth: 0,
      runCount: 0,
      quietWhenNothing: true,
      madeIn: "page",
      owner: "mina",
      share: { orgWide: false, memberIds: ["dana"], teamIds: ["team-support"] },
      managers: [],
      added: true,
      approved: false,
      setup: null,
      notes: [{ id: "note-mina", text: "Leave out accounts that are still in a free trial.", afterRuns: 0, by: "mina", forEveryone: true, state: "kept" }],
      runs: [],
      script: [
        {
          outcome: "sent",
          summary: "1 customer mentioned switching: they asked how to export their data before the renewal date.",
          steps: [
            { connector: "gmail", label: "Read 18 customer threads", blockedLabel: "Couldn't read Gmail", tool: "search_threads" },
            { connector: "slack", label: "Read 2 support channels", blockedLabel: "Couldn't read Slack", tool: "read_channel" },
          ],
        },
        {
          outcome: "quiet",
          summary: "Nobody mentioned cancelling since the last run.",
          steps: [
            { connector: "gmail", label: "Read 6 customer threads", blockedLabel: "Couldn't read Gmail", tool: "search_threads" },
            { connector: "slack", label: "Read 2 support channels", blockedLabel: "Couldn't read Slack", tool: "read_channel" },
          ],
        },
      ],
    },
    {
      id: "standup",
      name: "Standup digest",
      instructions: "Read what the team merged and closed since yesterday. Tell me what shipped, what is blocked and who is waiting on a review.",
      on: false,
      routines: [
        { id: "standup-daily", name: "Before standup", instruction: "", on: true, schedule: { rhythm: "daily", days: "weekdays", startHour: 9, endHour: 18, hour: 9, weekday: "Monday" } },
      ],
      tools: { ...noTools(), github: readOnly("github"), linear: readOnly("linear") },
      paidBy: "me",
      model: "auto",
      budgetMicro: 10 * DOLLAR,
      spentMicro: 0,
      runsThisMonth: 0,
      runCount: 0,
      quietWhenNothing: true,
      madeIn: "page",
      owner: "sam",
      share: { orgWide: false, memberIds: ["dana"], teamIds: ["team-eng"] },
      managers: ["dana"],
      added: false,
      approved: true,
      setup: null,
      notes: [],
      runs: [],
      script: [
        {
          outcome: "sent",
          summary: "4 pull requests merged since yesterday. The billing export is blocked on a review, and Leo is waiting on you for #490.",
          steps: [
            { connector: "github", label: "Read 4 merged pull requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
            { connector: "linear", label: "Read 9 issues closed or blocked", blockedLabel: "Couldn't read Linear", tool: "list_issues" },
          ],
        },
        {
          outcome: "quiet",
          summary: "Nothing merged or closed since yesterday.",
          steps: [
            { connector: "github", label: "Read the merged pull requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
            { connector: "linear", label: "Read the closed issues", blockedLabel: "Couldn't read Linear", tool: "list_issues" },
          ],
        },
      ],
    },
    {
      id: "docs",
      name: "Docs gardener",
      instructions: "Look for Notion pages that changed this week and have a broken link or no owner. Tell me which ones need care.",
      on: false,
      routines: [
        { id: "docs-weekly", name: "Monday sweep", instruction: "", on: true, schedule: { rhythm: "weekly", days: "weekdays", startHour: 9, endHour: 18, hour: 10, weekday: "Monday" } },
      ],
      tools: { ...noTools(), notion: readOnly("notion") },
      paidBy: "me",
      model: "haiku",
      budgetMicro: 5 * DOLLAR,
      spentMicro: 0,
      runsThisMonth: 0,
      runCount: 0,
      quietWhenNothing: true,
      madeIn: "page",
      owner: "mina",
      share: { orgWide: true, memberIds: [], teamIds: [] },
      managers: [],
      added: false,
      approved: false,
      setup: null,
      notes: [],
      runs: [],
      script: [
        {
          outcome: "sent",
          summary: "3 pages need care: 2 have a broken link and the onboarding guide has no owner.",
          steps: [{ connector: "notion", label: "Read 11 pages changed this week", blockedLabel: "Couldn't read Notion", tool: "search" }],
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Rules the prototype acts out
// ---------------------------------------------------------------------------

export function connectorById(id: ConnectorId): Connector {
  return CONNECTORS.find((connector) => connector.id === id) ?? CONNECTORS[0];
}

export function modelById(id: ModelId) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function toolsForLevel(connector: ToolSet, level: Level): string[] {
  if (level === "none") return [];
  return level === "read" ? [...connector.readTools] : [...connector.readTools, ...connector.writeTools];
}

export function readOnly(id: ConnectorId): string[] {
  return toolsForLevel(connectorById(id), "read");
}

export function presetOf(connector: ToolSet, tools: string[]): Preset {
  if (tools.length === 0) return "none";
  const same = (level: Level) => {
    const wanted = toolsForLevel(connector, level);
    return wanted.length === tools.length && wanted.every((tool) => tools.includes(tool));
  };
  return same("read") ? "read" : same("write") ? "write" : "custom";
}

export function isWriteTool(connector: ToolSet, tool: string): boolean {
  return connector.writeTools.includes(tool);
}

// "create_issue" reads as "Create issue".
export function toolLabel(tool: string): string {
  const words = tool.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

// What the agent can really call: its own list, minus what the admin blocks, and nothing until the app is connected.
export function effectiveTools(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, id: ConnectorId): string[] {
  if (!connected[id]) return [];
  return agent.tools[id].filter((tool) => !access.blocked[id].includes(tool));
}

export function effectiveLevel(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, id: ConnectorId): Preset {
  return presetOf(connectorById(id), effectiveTools(agent, access, connected, id));
}

// Starting a session is OpenWork's own tool. It runs on one of the member's computers, so an admin's "Cloud only" rule blocks it.
const SESSION_TOOLS = OPENWORK_AREAS.find((area) => area.id === "sessions");

export function stepWrites(connector: ConnectorId | "openwork" | "workbot", tool: string): boolean {
  if (connector === "workbot") return false;
  if (connector === "openwork") return SESSION_TOOLS?.writeTools.includes(tool) ?? false;
  return isWriteTool(connectorById(connector), tool);
}

export function stepAppName(connector: ConnectorId | "openwork" | "workbot"): string {
  return connector === "openwork" ? "OpenWork" : connector === "workbot" ? "Slack" : connectorById(connector).name;
}

export function blockReason(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, id: ConnectorId | "openwork", tool: string): BlockReason | null {
  if (id === "openwork") {
    if (access.cloudOnly) return "Blocked by admin";
    return agent.openwork.sessions.includes(tool) ? null : "Not allowed";
  }
  if (!connected[id]) return "Not connected";
  if (access.blocked[id].includes(tool)) return "Blocked by admin";
  return agent.tools[id].includes(tool) ? null : "Not allowed";
}

// What an admin's blocks leave open in one app, as a level.
export function adminPreset(connector: Connector, blocked: string[]): Preset {
  return presetOf(connector, toolsForLevel(connector, "write").filter((tool) => !blocked.includes(tool)));
}

export function blocksForLevel(connector: Connector, level: Level): string[] {
  if (level === "write") return [];
  return level === "read" ? [...connector.writeTools] : toolsForLevel(connector, "write");
}

export function toolsLine(connector: ToolSet, tools: string[]): string {
  const preset = presetOf(connector, tools);
  if (preset === "none") return "Not used.";
  if (preset === "read") return connector.readLine;
  if (preset === "write") return connector.writeLine;
  return `${tools.length} of ${toolsForLevel(connector, "write").length} tools: ${listWords(tools.map((tool) => lowerFirst(toolLabel(tool))))}.`;
}

export function toolCount(connector: ToolSet, tools: string[]): string {
  return `${tools.length} of ${toolsForLevel(connector, "write").length} tools`;
}

export function orgBudgetSpent(agents: Agent[]): number {
  const others = OTHER_PEOPLE.flatMap((person) => person.agents).filter((agent) => agent.paidBy === "org").reduce((sum, agent) => sum + agent.spentMicro, 0);
  return others + agents.filter((agent) => agent.paidBy === "org").reduce((sum, agent) => sum + agent.spentMicro, 0);
}

export function paidByLine(agent: Agent): string {
  return agent.paidBy === "org" ? "The org's agent budget" : "Your own limit";
}

export function effectiveBudget(agent: Agent, access: Access): number | null {
  if (agent.budgetMicro === null) return access.agentCapMicro;
  if (access.agentCapMicro === null) return agent.budgetMicro;
  return Math.min(agent.budgetMicro, access.agentCapMicro);
}

export function overBudget(agent: Agent, access: Access): boolean {
  const budget = effectiveBudget(agent, access);
  return budget !== null && agent.spentMicro >= budget;
}

export function scheduleLine(schedule: Schedule): string {
  const rhythm = RHYTHMS.find((entry) => entry.id === schedule.rhythm);
  if (schedule.rhythm === "weekly") return `${schedule.weekday}s at ${hourLabel(schedule.hour)}`;
  const days = schedule.days === "weekdays" ? "Weekdays" : "Every day";
  if (schedule.rhythm === "daily") return `${days} at ${hourLabel(schedule.hour)}`;
  return `${rhythm?.label ?? "Every hour"}, ${hourLabel(schedule.startHour)} to ${hourLabel(schedule.endHour)}, ${days.toLowerCase()}`;
}

export function nextRunLine(schedule: Schedule): string {
  const rhythm = RHYTHMS.find((entry) => entry.id === schedule.rhythm);
  if (schedule.rhythm === "weekly") return `Next run ${schedule.weekday} at ${hourLabel(schedule.hour)}`;
  if (schedule.rhythm === "daily") return `Next run tomorrow at ${hourLabel(schedule.hour)}`;
  return rhythm?.everyHours === 1 ? "Next run within the hour" : `Next run within ${rhythm?.everyHours ?? 2} hours`;
}

export function budgetLine(agent: Agent, access: Access): string {
  const budget = effectiveBudget(agent, access);
  return budget === null ? `${formatWorkbotCost(agent.spentMicro)} this month` : `${formatWorkbotCost(agent.spentMicro)} of ${formatWorkbotCost(budget)}`;
}

// How soon a schedule comes round, in hours, for picking the routine that runs next.
function comesRound(schedule: Schedule): number {
  if (schedule.rhythm === "weekly") return 168;
  if (schedule.rhythm === "daily") return 24;
  return RHYTHMS.find((entry) => entry.id === schedule.rhythm)?.everyHours ?? 1;
}

export function makeRoutine(id: string, name: string, instruction: string, schedule: Schedule): Routine {
  return { id, name, instruction, schedule, on: true };
}

export function routineName(schedule: Schedule): string {
  if (schedule.rhythm === "weekly") return `${schedule.weekday} check`;
  if (schedule.rhythm !== "daily") return "Regular check";
  return schedule.hour < 12 ? "Morning check" : schedule.hour < 17 ? "Afternoon check" : "Evening check";
}

export function uniqueRoutineName(name: string, routines: Routine[]): string {
  const taken = (candidate: string) => routines.some((routine) => routine.name.toLowerCase() === candidate.toLowerCase());
  if (!taken(name)) return name;
  let count = 2;
  while (taken(`${name} ${count}`)) count += 1;
  return `${name} ${count}`;
}

export function routineWhen(routine: Routine): string {
  return routine.on ? scheduleLine(routine.schedule) : "Paused";
}

export function nextRoutine(agent: Agent): Routine | null {
  return agent.routines.filter((routine) => routine.on).sort((a, b) => comesRound(a.schedule) - comesRound(b.schedule))[0] ?? null;
}

// Reads as a sentence without its full stop, the way nextRunLine does.
export function nextRunText(agent: Agent): string {
  if (agent.routines.length === 0) return "It has no routines, so it works only when asked";
  const next = nextRoutine(agent);
  return next ? nextRunLine(next.schedule) : "Its routines are paused";
}

export function routinesLine(agent: Agent): string {
  const only = agent.routines[0];
  if (!only) return "Only when asked";
  if (agent.routines.length === 1) return routineWhen(only);
  const on = agent.routines.filter((routine) => routine.on).length;
  return on === agent.routines.length ? `${agent.routines.length} routines` : `${agent.routines.length} routines, ${on} on`;
}

// Whether a routine is on stays outside the file, so one the file keeps (same name) stays as it was.
export function keepRoutineState(next: Routine[], current: Routine[]): Routine[] {
  return next.map((routine) => {
    const before = current.find((entry) => entry.name === routine.name);
    return before ? { ...routine, id: before.id, on: before.on } : routine;
  });
}

export function agentStateLine(agent: Agent, access: Access): string {
  if (agent.setup) return agent.instructions.trim().length === 0 ? "New. Tell it what to do." : "New. Answer its question to start it.";
  if (agent.instructions.trim().length === 0) return "Not set up yet.";
  if (!agent.on) return "Paused.";
  if (overBudget(agent, access)) return "Over budget. It runs again next month, or when you raise its budget.";
  const last = agent.runs[0];
  if (!last) return `No runs yet. ${nextRunText(agent)}.`;
  return `Last run ${last.today ? `at ${last.when}` : last.when}. ${last.summary}`;
}

const GENERIC_READ: Record<ConnectorId, string> = {
  slack: "Read 3 threads that mention you",
  linear: "Read 12 open issues assigned to you",
  github: "Read 6 open pull requests",
  notion: "Read 4 pages changed this week",
  gmail: "Read 20 threads in your inbox",
  calendar: "Read today's 5 events",
};

export function genericScript(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>): ScriptedRun[] {
  const steps = CONNECTORS.flatMap((connector): ScriptStep[] => {
    const tool = effectiveTools(agent, access, connected, connector.id).find((entry) => connector.readTools.includes(entry));
    return tool ? [{ connector: connector.id, label: GENERIC_READ[connector.id], blockedLabel: `Couldn't read ${connector.name}`, tool }] : [];
  });
  if (steps.length === 0) return [];
  return [
    { outcome: "sent", summary: "2 things need you. I listed them with links, most urgent first.", steps },
    { outcome: "quiet", summary: "Nothing new since the last run.", steps },
  ];
}

function whyBlocked(step: RunStep): string {
  const tool = toolLabel(step.tool);
  if (step.blocked === "Not connected") return `${stepAppName(step.connector)} isn't connected for you.`;
  if (step.blocked === "Blocked by admin") return `Your admin blocks “${tool}” for agents.`;
  return `“${tool}” is off for this agent.`;
}

// Every step is one tool call. A blocked read stops the run; a blocked write is skipped and reported.
function actOut(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, scripted: ScriptedRun, base: { id: string; when: string; today: boolean; asked?: string; routine?: string }): AgentRun {
  const instructed = agent.instructions.toLowerCase();
  const steps: RunStep[] = [];
  let skippedWrite = false;
  let failedRead: RunStep | null = null;
  for (let index = 0; index < scripted.steps.length; index += 1) {
    const step = scripted.steps[index];
    if (!step) continue;
    const reason = blockReason(agent, access, connected, step.connector, step.tool);
    if (step.ifInstructed && (reason !== null || !instructed.includes(step.ifInstructed))) {
      skippedWrite = true;
      continue;
    }
    const key = `${base.id}-${index}`;
    if (reason === null) {
      steps.push({ key, connector: step.connector, label: step.label, tool: step.tool, doing: step.doing });
      continue;
    }
    const blocked: RunStep = { key, connector: step.connector, label: step.blockedLabel, tool: step.tool, blocked: reason, ask: step.ask, doing: step.doing };
    steps.push(blocked);
    if (stepWrites(step.connector, step.tool)) skippedWrite = true;
    else failedRead = failedRead ?? blocked;
  }
  const cost = Math.round(modelById(agent.model).runMicro * (0.8 + 0.1 * (agent.runCount % 5)));
  if (failedRead) {
    return { ...base, outcome: "failed", summary: `${failedRead.label}. ${whyBlocked(failedRead)}`, costMicro: Math.round(cost * 0.3), steps };
  }
  const summary = skippedWrite ? scripted.blockedSummary ?? "Sent you what it found. It couldn't save its work with the tools it's allowed." : scripted.summary;
  const tellsYou = scripted.outcome === "sent" || !agent.quietWhenNothing;
  return {
    ...base,
    outcome: tellsYou ? "sent" : "quiet",
    summary,
    costMicro: cost,
    steps: tellsYou && agent.alsoSlack ? [...steps, delivered(`${base.id}-dm`)] : steps,
  };
}

// Run by hand it does its job once. Run from a routine (its own time, or Test) the run carries the routine's name.
export function simulateRun(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, when: string, id: string, routine?: Routine): AgentRun {
  const base = routine ? { id, when, today: true, routine: routine.name } : { id, when, today: true };
  if (overBudget(agent, access)) {
    return { ...base, outcome: "over_budget", summary: "Skipped. This month's budget is used up.", costMicro: 0, steps: [] };
  }
  const script = agent.script.length > 0 ? agent.script : genericScript(agent, access, connected);
  const scripted = script[agent.runCount % Math.max(1, script.length)];
  if (!scripted) {
    return { ...base, outcome: "quiet", summary: "Nothing to read. Allow it at least one tool.", costMicro: 0, steps: [] };
  }
  return actOut(agent, access, connected, scripted, base);
}

// Anyone who can use the agent can ask it something. It answers only them, with their own accounts.
export function askAgent(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, question: string, when: string, id: string): AgentRun {
  const base = { id, when, today: true, asked: question };
  if (overBudget(agent, access)) {
    return { ...base, outcome: "over_budget", summary: "It can't answer. This month's budget is used up.", costMicro: 0, steps: [] };
  }
  const script = agent.script.length > 0 ? agent.script : genericScript(agent, access, connected);
  const scripted = script.find((entry) => entry.outcome === "sent") ?? script[0];
  if (!scripted) {
    return { ...base, outcome: "failed", summary: "It has no tools to look anything up with.", costMicro: 0, steps: [] };
  }
  const run = actOut(agent, access, connected, scripted, base);
  return { ...run, outcome: run.outcome === "quiet" ? "sent" : run.outcome, steps: run.steps.filter((step) => step.connector !== "workbot") };
}

// A fresh session for one piece of work. The run is worked out up front and shown step by step.
// If a step needs a tool the agent isn't allowed (and the admin doesn't block), it stops there and asks.
export function startSession(agent: Agent, access: Access, connected: Record<ConnectorId, boolean>, input: {
  id: string;
  when: string;
  kind: AgentSession["kind"];
  routine?: Routine;
  asked?: string;
  nowMs: number;
  working: boolean;
}): AgentSession {
  const run = input.kind === "ask" && input.asked
    ? askAgent(agent, access, connected, input.asked, input.when, input.id)
    : simulateRun(agent, access, connected, input.when, input.id, input.routine);
  // Everything this run would change with a tool it isn't allowed yet. It asks for all of it once, when it gets to the first.
  const items = run.steps.flatMap((step): AskItem[] => (
    step.blocked === "Not allowed" && step.connector !== "workbot" && stepWrites(step.connector, step.tool)
      ? [{ connector: step.connector, tool: step.tool, action: step.ask ?? `Use “${toolLabel(step.tool)}” in ${stepAppName(step.connector)}` }]
      : []
  ));
  const at = run.steps.findIndex((step) => items.some((item) => item.tool === step.tool && item.connector === step.connector));
  return {
    id: input.id,
    agentId: agent.id,
    kind: input.kind,
    label: input.kind === "ask" ? "Your message" : input.routine?.name ?? "Run now",
    routineId: input.routine?.id,
    asked: input.asked,
    state: input.working ? "working" : "waiting",
    shown: 0,
    run,
    ask: items.length > 0 ? { items, at: Math.max(0, at), raisedMs: input.nowMs, background: input.kind !== "ask" } : null,
    heard: [],
  };
}

// The step it would have taken, had it been allowed.
function doneLabel(agent: Agent, tool: string): string | null {
  for (const scripted of agent.script) {
    const step = scripted.steps.find((entry) => entry.tool === tool);
    if (step) return step.label;
  }
  return null;
}

// How a session's run ends: as worked out, or changed by the answer to what it asked.
export function settleRun(agent: Agent, session: AgentSession, answer: RunAsk["state"] | null): AgentRun {
  const { run, ask } = session;
  const heard = session.heard[session.heard.length - 1];
  const base = heard ? { ...run, heard } : run;
  if (!ask || answer === null) return base;
  const wanted: RunAsk = { items: ask.items, state: answer };
  if (answer === "allowed" || answer === "always") {
    const asked = (step: RunStep) => ask.items.find((item) => item.tool === step.tool && item.connector === step.connector);
    const scripted = agent.script.find((entry) => entry.steps.some((step) => ask.items.some((item) => item.tool === step.tool)));
    return {
      ...base,
      wanted,
      summary: scripted?.summary ?? run.summary,
      steps: run.steps.map((step) => {
        const item = asked(step);
        return item ? { key: step.key, connector: step.connector, label: doneLabel(agent, step.tool) ?? item.action, tool: step.tool, doing: step.doing } : step;
      }),
    };
  }
  return { ...base, wanted };
}

// A stopped session keeps what it already did, and nothing after.
export function stoppedRun(session: AgentSession): AgentRun {
  return {
    ...session.run,
    stopped: true,
    outcome: "quiet",
    summary: "Stopped. What it already did stays done; nothing after that ran.",
    costMicro: Math.round(session.run.costMicro * Math.min(1, session.shown / Math.max(1, session.run.steps.length))),
    steps: session.run.steps.slice(0, session.shown),
  };
}

// The answer to "What do you remember?" is what it keeps in mind on every run.
export function isMemoryQuestion(text: string): boolean {
  return /what (do|did) you remember|what do you know about me/i.test(text);
}

// A thread is about one result. Changing the agent itself happens in its conversation.
export function changesTheAgent(text: string): boolean {
  return /\b(remember|from now on|always|never|stop doing|don't|do not|every time|change (your|the) routine|new routine|new skill)\b/i.test(text);
}

export function applyRun(agent: Agent, run: AgentRun): Agent {
  const ran = run.outcome === "over_budget" ? 0 : 1;
  return { ...agent, runs: [run, ...agent.runs], spentMicro: agent.spentMicro + run.costMicro, runCount: agent.runCount + ran, runsThisMonth: agent.runsThisMonth + ran };
}

export function clockNow(): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date());
}

export function runsLabel(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

export function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export function personName(id: string): string {
  return PEOPLE.find((person) => person.id === id)?.name ?? id;
}

export function firstNameOf(id: string): string {
  return personName(id).split(" ")[0] ?? id;
}

export function initialsOf(name: string): string {
  return name.split(" ").slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("");
}

export function isMine(agent: Agent): boolean {
  return agent.owner === ME;
}

export function sharedPeople(share: AccessDraft, owner: string): string[] {
  return accessPeopleIds(share, DIRECTORY, owner);
}

export function shareStatus(agent: Agent): string {
  return ownedAccessStatus(agent.share, DIRECTORY, agent.owner);
}

export function shareTargets(share: AccessDraft, owner: string): string {
  if (share.orgWide) return "Everyone";
  return joinNames(accessNames(share, DIRECTORY, owner), 3);
}

export function isShared(share: AccessDraft, owner: string): boolean {
  return share.orgWide || sharedPeople(share, owner).length > 0;
}

// One agent, used by several people. Whoever it works for, it uses that person's own accounts.
export function shareEffect(share: AccessDraft, owner: string): string {
  if (!isShared(share, owner)) return "Only you can use it.";
  const who = share.orgWide ? "Everyone in the organization" : shareTargets(share, owner);
  return `${who} can ask it things and turn on its routines for themselves. It uses each person's own accounts, never yours.`;
}

export function shareCaution(agent: Agent): string {
  const pays = agent.paidBy === "org" ? "The org's agent budget pays for everyone's use." : "Each person's use counts toward their own limit.";
  return `They see its instructions, routines and tools. They never see your runs or your messages. Only you and the managers you pick can change it. ${pays}`;
}

export function mergeShare(current: AccessDraft, added: AccessDraft): AccessDraft {
  return {
    orgWide: current.orgWide || added.orgWide,
    memberIds: [...new Set([...current.memberIds, ...added.memberIds])],
    teamIds: [...new Set([...current.teamIds, ...added.teamIds])],
  };
}

export type Role = "owner" | "manager" | "collaborator";

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", manager: "Manager", collaborator: "Collaborator" };
export const ROLE_LINE: Record<Role, string> = {
  owner: "Can change it, share it and remove it.",
  manager: "Can use it and change what it does.",
  collaborator: "Can use it. Can't change it.",
};
export const TEAM_ROLE_LINE: Record<Exclude<Role, "owner">, string> = { manager: "Can use and change it", collaborator: "Can use it" };

function teamsOf(person: string): string[] {
  return TEAMS.filter((team) => team.memberIds.some((id) => id === person)).map((team) => team.id);
}

// What one person may do with an agent. Null when it isn't shared with them.
export function roleOf(agent: Agent, person: string = ME): Role | null {
  if (agent.owner === person) return "owner";
  if (!sharedPeople(agent.share, agent.owner).includes(person)) return null;
  return agent.managers.includes(person) || teamsOf(person).some((team) => agent.managers.includes(team)) ? "manager" : "collaborator";
}

export function canChange(agent: Agent): boolean {
  const role = roleOf(agent);
  return role === "owner" || role === "manager";
}

// Only someone it is still shared with can manage it.
export function keepManagers(managers: string[], share: AccessDraft): string[] {
  return managers.filter((id) => share.memberIds.includes(id) || share.teamIds.includes(id));
}

// A member sees their own agents, and shared ones while their admin allows sharing.
export function canSee(agent: Agent, access: Access): boolean {
  return isMine(agent) || (access.sharing && roleOf(agent) !== null);
}

// What sits in your sidebar: your own, and shared agents you added.
export function inMyList(agent: Agent, access: Access): boolean {
  return isMine(agent) || (agent.added && canSee(agent, access));
}

export function sharedWithMe(agents: Agent[], access: Access): Agent[] {
  return agents.filter((agent) => !isMine(agent) && canSee(agent, access));
}

export function newAgent(id: string, access: Access): Agent {
  return {
    id,
    name: "New agent",
    instructions: "",
    on: false,
    routines: [],
    tools: noTools(),
    model: "auto",
    paidBy: "me",
    budgetMicro: Math.min(10 * DOLLAR, access.agentCapMicro ?? 10 * DOLLAR),
    spentMicro: 0,
    runsThisMonth: 0,
    runCount: 0,
    quietWhenNothing: true,
    runs: [],
    script: [],
    madeIn: "page",
    color: "blue",
    openwork: noOpenWork(),
    runsOn: { cloud: true, computers: [] },
    alsoSlack: false,
    replies: [],
    memoryChecks: [],
    owner: ME,
    share: NOT_SHARED,
    managers: [],
    added: true,
    approved: false,
    setup: null,
    said: "",
    notes: [],
  };
}

export function copyAgent(agent: Agent, id: string, access: Access): Agent {
  return {
    ...newAgent(id, access),
    name: `${agent.name} copy`,
    instructions: agent.instructions,
    routines: agent.routines.map((routine) => ({ ...routine, schedule: { ...routine.schedule } })),
    tools: copyTools(agent.tools),
    model: agent.model,
    script: agent.script,
  };
}

// ---------------------------------------------------------------------------
// An agent's own thread: every run is a turn, and what you reply is remembered.
// ---------------------------------------------------------------------------

export type ThreadItem = { kind: "run"; key: string; run: AgentRun } | { kind: "note"; key: string; note: AgentNote } | { kind: "memory"; key: string };

// What the agent keeps in mind on every run.
export function keptNotes(agent: Agent): AgentNote[] {
  return agent.notes.filter((note) => note.state === "kept");
}

// Telling a shared agent something changes it for other people, so it asks first.
export function noteAsksFirst(agent: Agent): boolean {
  return isShared(agent.share, agent.owner);
}

// Everyone a shared agent works for, as the person reading sees them.
export function usedByLine(agent: Agent): string {
  if (agent.share.orgWide) return "Everyone in the organization";
  const people = [agent.owner, ...sharedPeople(agent.share, agent.owner)];
  const others = people.filter((id) => id !== ME).map(firstNameOf);
  const names = people.includes(ME) ? ["You", ...others] : others;
  return names.length > 4 ? `${peopleLabel(names.length)}, you included` : `${listWords(names)} (${peopleLabel(names.length)})`;
}

// A thread is one person's own: it shows what they told the agent, never what a teammate told it.
export function agentThread(agent: Agent): ThreadItem[] {
  const oldestFirst = [...agent.runs].reverse();
  const items: ThreadItem[] = [];
  const notesAt = (count: number) => agent.notes.filter((note) => note.by === ME && Math.min(note.afterRuns, oldestFirst.length) === count);
  const said = (count: number) => {
    for (const note of notesAt(count)) items.push({ kind: "note", key: note.id, note });
    agent.memoryChecks.forEach((at, index) => {
      if (Math.min(at, oldestFirst.length) === count) items.push({ kind: "memory", key: `memory-${index}` });
    });
  };
  oldestFirst.forEach((run, index) => {
    said(index);
    items.push({ kind: "run", key: run.id, run });
  });
  said(oldestFirst.length);
  return items;
}

// ---------------------------------------------------------------------------
// Chat through Connect (simulated). Asking in words makes the same changes as
// the page. Anything that gives an agent more reach comes back as a card to
// approve; anything that gives it less is applied at once.
// ---------------------------------------------------------------------------

export type ChatStep = { key: string; label: string; detail?: string; tool: string; input: string; result: string };

export type AgentDraft = {
  name: string;
  instructions: string;
  schedule: Schedule;
  tools: Record<ConnectorId, string[]>;
  budgetMicro: number;
  capped: string[];
  script: ScriptedRun[];
};

export type SpendRow = { id: string; name: string; note: string; spentMicro: number; budgetMicro: number | null; over: boolean; paidBy: PaidBy };

export type ChatCard =
  | { kind: "proposal"; draft: AgentDraft; state: "draft" | "on" | "dismissed"; agentId: string | null }
  | { kind: "permission"; agentId: string; connector: ConnectorId; tools: string[]; addInstructions: string | null; state: "ask" | "allowed" | "kept" }
  | { kind: "share"; agentId: string; share: AccessDraft; managers: string[]; promote: string[]; state: "ask" | "shared" | "kept" }
  | { kind: "run"; agentId: string; agentName: string; run: AgentRun }
  | { kind: "spend"; rows: SpendRow[]; totalMicro: number; orgMicro: number };

export type ChatTurn = { id: string; prompt: string; steps: ChatStep[]; reply: string; card: ChatCard | null };

export type ChatResult = {
  agents: Agent[];
  steps: Omit<ChatStep, "key">[];
  reply: string;
  card: ChatCard | null;
  // The agent this turn was about, so "it" works in the next message.
  agentId: string | null;
};

export const STORY: string[] = [
  "Create an agent called PR review that checks my open pull requests on GitHub every weekday at 9 and tells me which ones need my review",
  "Run it now",
  "Let it comment on those pull requests",
  "Run it again",
  "Add a routine to PR review that lists what I merged every Friday at 4",
  "Share it with the Engineering team",
  "How much have my agents spent this month?",
  "Pause Inbox watch",
];

export const CHAT_EXTRAS: string[] = [
  "Let Release notes write to Notion",
  "Let Inbox watch send email with Gmail",
  "Set Inbox watch's budget to $10 a month",
  "Charge Morning triage to the org budget",
  "Make Leo a manager of Morning triage",
  "Stop sharing Morning triage",
];

const PR_REVIEW_SCRIPT: ScriptedRun[] = [
  {
    outcome: "sent",
    summary: "3 pull requests need your review. #482 Billing export has waited 3 days. #490 Retry webhooks and #497 Fix time zone in schedules came in yesterday.",
    steps: [
      { connector: "github", label: "Read 6 open pull requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
      { connector: "github", label: "Read the review requests on 3 of them", blockedLabel: "Couldn't read GitHub", tool: "get_pull_request" },
    ],
  },
  {
    outcome: "sent",
    summary: "I commented on #482 and #490 to tell the authors they are next in your queue. #497 still needs your review.",
    blockedSummary: "3 pull requests still need your review: #482, #490 and #497.",
    steps: [
      { connector: "github", label: "Read 6 open pull requests", blockedLabel: "Couldn't read GitHub", tool: "list_pull_requests" },
      { connector: "github", ifInstructed: "comment", label: "Commented on 2 pull requests that have waited more than a day", blockedLabel: "Couldn't comment on 2 pull requests", tool: "add_comment" },
    ],
  },
];

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function findAgent(text: string, agents: Agent[]): Agent | null {
  const matches = agents.filter((agent) => text.includes(agent.name.toLowerCase()));
  return matches.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

function mentionedConnectors(text: string): Connector[] {
  return CONNECTORS.filter((connector) => connector.aliases.some((alias) => text.includes(alias)));
}

const WRITE_WORDS: [RegExp, string][] = [[/\bcomment/, "comment"], [/\b(send|post|reply|message)/, "send"], [/\bdraft/, "draft"], [/\breact/, "reaction"], [/\blabel/, "label"]];

// A named action asks for single tools ("comment" is add_comment). Plain "write" asks for all of them.
function askedWriteTools(text: string, connector: Connector): string[] {
  const named = connector.writeTools.filter((tool) => WRITE_WORDS.some(([said, part]) => said.test(text) && tool.includes(part)));
  return named.length > 0 ? named : [...connector.writeTools];
}

function toolsInUse(tools: Record<ConnectorId, string[]>): Record<string, string[]> {
  return Object.fromEntries(CONNECTORS.filter((connector) => tools[connector.id].length > 0).map((connector) => [connector.id, tools[connector.id]]));
}

function parseSchedule(text: string): Schedule {
  const schedule: Schedule = { ...DEFAULT_SCHEDULE };
  const hours = /every (\d) hours?/.exec(text);
  const at = /\bat (\d{1,2})\s*(am|pm)?/.exec(text);
  const weekday = WEEKDAYS.find((day) => text.includes(day.toLowerCase()));
  if (at) {
    const raw = Number(at[1]);
    // "at 4" with no am or pm means the afternoon.
    schedule.hour = (at[2] === "pm" && raw < 12) || (at[2] === undefined && raw >= 1 && raw <= 6) ? raw + 12 : raw;
  } else if (/evening|end of (the )?day/.test(text)) {
    schedule.hour = 17;
  }
  if (hours) {
    const match = RHYTHMS.find((entry) => entry.everyHours === Number(hours[1]));
    if (match) schedule.rhythm = match.id;
  } else if (/every hour|hourly/.test(text)) {
    schedule.rhythm = "1h";
  } else if (weekday || /weekly|every week\b/.test(text)) {
    schedule.rhythm = "weekly";
    schedule.weekday = weekday ?? "Friday";
  }
  if (/every day|daily/.test(text) && /weekend/.test(text)) schedule.days = "everyday";
  return schedule;
}

const THIRD_PERSON: Record<string, string> = {
  checks: "check", tells: "tell", reads: "read", watches: "watch", drafts: "draft", saves: "save", sends: "send", posts: "post",
  finds: "find", lists: "list", summarizes: "summarize", writes: "write", comments: "comment", reviews: "review",
  keeps: "keep", tracks: "track", flags: "flag", reminds: "remind", sums: "sum", collects: "collect", looks: "look",
};

// The schedule is its own setting, so the instructions keep only the job.
function instructionsFrom(body: string): string {
  const withoutSchedule = body
    .replace(/\s+(?:every|each)\s+(?:weekday|(?:mon|tues|wednes|thurs|fri)day|morning|evening|day|week|hour|\d\s+hours?)(?:\s+at\s+\d{1,2}(?:\s*(?:am|pm)\b)?)?/gi, "")
    .replace(/\s+at\s+\d{1,2}(?:\s*(?:am|pm))?\b/gi, "");
  const direct = withoutSchedule.replace(/\b[a-z]+s\b/g, (word) => THIRD_PERSON[word] ?? word).trim();
  return `${direct.charAt(0).toUpperCase()}${direct.slice(1)}${/[.!?]$/.test(direct) ? "" : "."}`;
}

function parseShareTarget(text: string): AccessDraft | null {
  const orgWide = /\b(everyone|everybody|whole (org|organization|company)|entire (org|organization|company)|the organization)\b/.test(text);
  const teamIds = TEAMS.filter((team) => text.includes(team.name.toLowerCase())).map((team) => team.id);
  const memberIds = PEOPLE.filter((person) => person.id !== ME && new RegExp(`\\b${person.name.split(" ")[0]?.toLowerCase()}\\b`).test(text)).map((person) => person.id);
  if (!orgWide && teamIds.length === 0 && memberIds.length === 0) return null;
  return { orgWide, teamIds, memberIds };
}

// The apps a job names, read only unless it says to write somewhere. Tools an admin blocks are left out.
function toolsForJob(job: string, access: Access): { mentioned: Connector[]; tools: Record<ConnectorId, string[]>; capped: string[] } {
  const mentioned = mentionedConnectors(job);
  const tools = noTools();
  const capped: string[] = [];
  for (const connector of mentioned) {
    const wantsWrite = new RegExp(`\\b(save|write|post|create|update|draft|comment|send)s?\\b[^.]*\\b(to|in|into|on|with)\\s+(the\\s+|my\\s+)?(${connector.aliases.join("|")})`).test(job);
    const wanted = wantsWrite ? [...connector.readTools, ...askedWriteTools(job, connector)] : [...connector.readTools];
    tools[connector.id] = wanted.filter((tool) => !access.blocked[connector.id].includes(tool));
    if (tools[connector.id].length < wanted.length) capped.push(connector.name);
  }
  return { mentioned, tools, capped };
}

// ---------------------------------------------------------------------------
// Starting from +: a new agent is a chat. Its first message from you is its
// job. It names itself, says what it will do and how often, and asks one thing.
// ---------------------------------------------------------------------------

// What a new agent offers when you don't know what to say. The short line is the option; the long one is the job it sends.
export const JOB_EXAMPLES: { label: string; job: string }[] = [
  {
    label: "Watch #bugs in Slack and get each bug fixed",
    job: "Watch #bugs in Slack. For each new bug, check Linear and file it if it's missing. Then start a coding session on my Mac Studio to fix it, and reply in the Slack thread.",
  },
  {
    label: "Tell me which pull requests need my review",
    job: "Check my open pull requests on GitHub every weekday at 9 and tell me which ones need my review.",
  },
  {
    label: "Tell me which customers are waiting on me",
    job: "Read my inbox every 2 hours and tell me which customers are waiting on me.",
  },
];

// How often, as the options a new agent offers. Anything else can be typed.
export const OFTEN_CHOICES: { label: string; schedule: Schedule }[] = [
  { label: "Every hour", schedule: { ...DEFAULT_SCHEDULE, rhythm: "1h" } },
  { label: "Every 2 hours", schedule: { ...DEFAULT_SCHEDULE, rhythm: "2h" } },
  { label: "Once a day, at 9", schedule: { ...DEFAULT_SCHEDULE } },
  { label: "Once a week, on Monday", schedule: { ...DEFAULT_SCHEDULE, rhythm: "weekly" } },
];

// The sample job: a bug reported in Slack ends as an issue, a draft pull request and a reply.
// Reading is free. Anything that changes something is asked for the first time it comes up.
const BUGS_SCRIPT: ScriptedRun[] = [
  {
    outcome: "sent",
    summary: "1 new bug: exports time out for large workspaces. I filed it as ENG-482, and a coding session on your Mac Studio opened draft PR #513. I replied in the Slack thread with both.",
    blockedSummary: "1 new bug isn't in Linear yet: exports time out for large workspaces. I left it as it is.",
    steps: [
      { connector: "slack", label: "Read 4 new messages in #bugs", blockedLabel: "Couldn't read #bugs", tool: "read_channel", doing: "Reading #bugs" },
      { connector: "linear", label: "Looked for each bug in Linear. 1 is missing", blockedLabel: "Couldn't read Linear", tool: "list_issues", doing: "Checking Linear" },
      { connector: "linear", label: "Filed ENG-482, “Export times out for large workspaces”", blockedLabel: "Didn't file the missing bug", tool: "create_issue", ask: "File the missing bug in Linear", doing: "Filing the bug in Linear" },
      { connector: "openwork", label: "Started a coding session on your Mac Studio. It opened draft PR #513", blockedLabel: "Didn't start a coding session", tool: "start_session", ask: "Start a coding session on your Mac Studio", doing: "Fixing it in a coding session on your Mac Studio" },
      { connector: "slack", label: "Replied in the Slack thread with the issue and the PR", blockedLabel: "Didn't reply in Slack", tool: "send_message", ask: "Reply in the Slack thread", doing: "Replying in the Slack thread" },
    ],
  },
  {
    outcome: "quiet",
    summary: "No new bugs in #bugs since the last check.",
    steps: [
      { connector: "slack", label: "Read 2 new messages in #bugs", blockedLabel: "Couldn't read #bugs", tool: "read_channel", doing: "Reading #bugs" },
      { connector: "linear", label: "Looked for each bug in Linear. All are there", blockedLabel: "Couldn't read Linear", tool: "list_issues", doing: "Checking Linear" },
    ],
  },
];

function isBugsJob(job: string): boolean {
  return /#bugs|\bbugs?\b/.test(job) && /slack/.test(job);
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// An agent is named from its job, so nobody has to think of a name first. It can be renamed at any time.
export function nameFromJob(text: string, taken: string[]): string {
  const job = text.toLowerCase();
  const channel = /#([a-z][a-z0-9-]*)/.exec(job)?.[1];
  const app = mentionedConnectors(job)[0];
  const base = channel
    ? `${capitalize(channel.replace(/s$/, ""))} watcher`
    : /pull request|\bprs?\b/.test(job) ? "PR review"
      : /inbox|email/.test(job) ? "Inbox check"
        : app ? `${app.name} check` : "My agent";
  const used = (candidate: string) => taken.some((entry) => entry.toLowerCase() === candidate.toLowerCase());
  if (!used(base)) return base;
  let count = 2;
  while (used(`${base} ${count}`)) count += 1;
  return `${base} ${count}`;
}

// A routine is named for what it does, the way a person would say it.
function routineNameFor(job: string, schedule: Schedule): string {
  const channel = /#([a-z][a-z0-9-]*)/.exec(job.toLowerCase())?.[1];
  return channel ? `Check #${channel}` : routineName(schedule);
}

// "Every hour on weekdays", for a sentence.
export function oftenWords(schedule: Schedule): string {
  if (schedule.rhythm === "weekly") return `every ${schedule.weekday} at ${hourLabel(schedule.hour)}`;
  const days = schedule.days === "weekdays" ? "weekday" : "day";
  if (schedule.rhythm === "daily") return `every ${days} at ${hourLabel(schedule.hour)}`;
  const every = RHYTHMS.find((entry) => entry.id === schedule.rhythm)?.everyHours ?? 1;
  return `every ${every === 1 ? "hour" : `${every} hours`} on ${schedule.days === "weekdays" ? "weekdays" : "every day"}`;
}

// What a new agent says back once it has its job: the plan in one or two sentences, with how often in it.
export function planLine(agent: Agent, schedule: Schedule): string {
  const often = oftenWords(schedule);
  if (isBugsJob(agent.said.toLowerCase())) {
    return `Got it. I'll check #bugs ${often}. For each new bug I look for it in Linear, file it if it's missing, start a coding session on your Mac Studio that opens a draft pull request, and reply in the Slack thread.`;
  }
  // The member said "my inbox" and "tell me". Said back, that is "your inbox" and "tell you".
  const [first = "", ...rest] = agent.instructions.split(/(?<=[.!?])\s+/);
  const promise = lowerFirst(first.replace(/[.!?]$/, "")).replace(/\bmy\b/g, "your").replace(/\bme\b/g, "you").replace(/\bmine\b/g, "yours");
  const after = rest.join(" ").replace(/\bmy\b/g, "your").replace(/\bme\b/g, "you");
  return `Got it. I'll ${promise}, ${often}.${after ? ` ${after}` : ""}`;
}

const COLOR_ORDER: AgentColor[] = ["red", "teal", "green", "pink", "slate", "blue", "violet", "orange"];

// A new agent has no name and no job yet. Its colour is picked for it.
export function draftAgent(id: string, access: Access, taken: AgentColor[]): Agent {
  const color = COLOR_ORDER.find((entry) => !taken.includes(entry)) ?? "slate";
  // No budget of its own: it is paid from the member's own limit, up to what the admin allows an agent. Nobody is asked.
  return { ...newAgent(id, access), name: "New agent", color, budgetMicro: null, setup: { schedule: { ...DEFAULT_SCHEDULE, rhythm: "1h" }, asking: "start" } };
}

const SAYS_WHEN = /every (?:\d|hour|day|weekday|morning|evening|week|monday|tuesday|wednesday|thursday|friday)|each (?:hour|day|morning|evening|week)|daily|hourly|weekly|once a (?:day|week)|\bat \d{1,2}\b/;

// A job that says no time is checked every hour. One that does keeps what it says.
function scheduleFromJob(said: string): Schedule {
  return SAYS_WHEN.test(said) ? parseSchedule(said) : { ...DEFAULT_SCHEDULE, rhythm: "1h" };
}

// A short message that only says when ("every 2 hours", "once a day at 9") changes the schedule, not the job.
export function onlySaysWhen(text: string): boolean {
  const said = text.trim().toLowerCase();
  return said.length <= 48 && SAYS_WHEN.test(said) && mentionedConnectors(said).length === 0 && !said.includes("#");
}

// The first message in a new agent's chat is its job. It takes its name from it.
export function giveJob(agent: Agent, text: string, taken: string[]): Agent {
  if (!agent.setup) return agent;
  const said = text.trim();
  if (agent.said.length > 0 && onlySaysWhen(said)) {
    return { ...agent, setup: { schedule: parseSchedule(said.toLowerCase()), asking: "start" } };
  }
  return {
    ...agent,
    name: nameFromJob(said, taken),
    said,
    instructions: instructionsFrom(said),
    setup: { schedule: scheduleFromJob(said.toLowerCase()), asking: "start" },
  };
}

// Starting it makes its first routine and lets it read the apps its job names. Reading is all it gets:
// the first time it wants to change something, it asks. Its budget is the member's own limit until they say otherwise.
export function startAgent(agent: Agent, access: Access, schedule?: Schedule): Agent {
  if (!agent.setup) return agent;
  const job = agent.said.toLowerCase();
  const when = schedule ?? agent.setup.schedule;
  const tools = noTools();
  for (const connector of mentionedConnectors(job)) {
    tools[connector.id] = connector.readTools.filter((tool) => !access.blocked[connector.id].includes(tool));
  }
  return {
    ...agent,
    on: true,
    setup: null,
    tools,
    openwork: isBugsJob(job) ? { ...noOpenWork(), sessions: ["list_sessions", "read_session"] } : agent.openwork,
    routines: [makeRoutine(`${agent.id}-routine`, routineNameFor(agent.said, when), "", when)],
    script: isBugsJob(job) ? BUGS_SCRIPT : /pull request|\bprs?\b/.test(job) ? PR_REVIEW_SCRIPT : [],
  };
}

export function agentFromDraft(draft: AgentDraft, id: string, access: Access): Agent {
  return {
    ...newAgent(id, access),
    name: draft.name,
    instructions: draft.instructions,
    on: true,
    routines: [makeRoutine(`${id}-routine`, routineName(draft.schedule), "", draft.schedule)],
    tools: draft.tools,
    budgetMicro: draft.budgetMicro,
    script: draft.script,
    madeIn: "chat",
  };
}

export function draftUses(draft: AgentDraft): { connector: Connector; tools: string[] }[] {
  return CONNECTORS.filter((connector) => draft.tools[connector.id].length > 0).map((connector) => ({ connector, tools: draft.tools[connector.id] }));
}

export function interpretChat({ prompt, agents, access, connected, id, when, contextId, pendingName }: {
  prompt: string;
  agents: Agent[];
  access: Access;
  connected: Record<ConnectorId, boolean>;
  id: string;
  when: string;
  contextId: string | null;
  pendingName: string | null;
}): ChatResult {
  const text = prompt.toLowerCase();
  const mine = agents.filter(isMine);
  const same = { agents, card: null, agentId: contextId };
  const found = { label: "Searched your connections", detail: "for “agents”", tool: "search_capabilities", input: json({ query: "personal agents" }), result: json({ matches: ["getMeAgents", "postMeAgents", "putMeAgentsAgent", "postMeAgentsAgentRoutines", "postMeAgentsAgentRun", "getMeAgentsUsage"] }) };

  if (/how much|spen[dt]|\bcost/.test(text) && !/\$\s?\d/.test(text)) {
    const rows = agents.filter(usedByMe).map((agent): SpendRow => ({
      id: agent.id,
      name: agent.name,
      note: [isMine(agent) ? "" : `Shared by ${firstNameOf(agent.owner)}`, runsLabel(agent.runsThisMonth), agent.paidBy === "org" ? "paid by the org" : ""].filter((part) => part.length > 0).join(", "),
      spentMicro: agent.spentMicro,
      budgetMicro: effectiveBudget(agent, access),
      over: overBudget(agent, access),
      paidBy: agent.paidBy,
    }));
    const total = rows.filter((row) => row.paidBy === "me").reduce((sum, row) => sum + row.spentMicro, 0);
    const orgTotal = rows.filter((row) => row.paidBy === "org").reduce((sum, row) => sum + row.spentMicro, 0);
    const over = rows.filter((row) => row.over).map((row) => row.name);
    return {
      ...same,
      steps: [{
        label: "Read your agents' spend",
        detail: "this month",
        tool: "getMeAgentsUsage",
        input: json({ period: "month" }),
        result: json(rows.map((row) => ({ agent: row.name, costMicroUsd: row.spentMicro, budgetMicroUsd: row.budgetMicro, paidBy: row.paidBy }))),
      }],
      reply: rows.length === 0
        ? "You have no agents yet."
        : `Your agents have used ${formatWorkbotCost(total)} of your own limit this month.${orgTotal > 0 ? ` The org's agent budget paid another ${formatWorkbotCost(orgTotal)}.` : ""}${over.length > 0 ? ` ${listWords(over)} ${over.length === 1 ? "is" : "are"} over budget and will not run again until next month.` : ""}`,
      card: rows.length === 0 ? null : { kind: "spend", rows, totalMicro: total, orgMicro: orgTotal },
    };
  }

  if (/\b(create|make|add|set up|new)\b.*\bagent\b/.test(text)) {
    if (mine.length >= access.maxAgents) {
      return { ...same, steps: [], reply: `You have ${mine.length} of ${access.maxAgents} agents. Remove one first, or ask your admin to allow more.` };
    }
    const named = /(?:called|named)\s+["“']?([A-Za-z0-9][A-Za-z0-9 ]{1,30}?)["”']?(?=\s+(?:that|to|which|and|every|each|on)\b|[,.]|$)/i.exec(prompt);
    const rest = /\bagent\b(?:\s+(?:called|named)\s+["“']?[A-Za-z0-9 ]+?["”']?)?\s+(?:that|to|which)\s+(.*)$/i.exec(prompt);
    const body = (rest?.[1] ?? prompt).trim();
    const job = body.toLowerCase();
    const { mentioned, tools, capped } = toolsForJob(job, access);
    const schedule = parseSchedule(text);
    const name = named?.[1]?.trim() ?? (mentioned[0] ? `${mentioned[0].name} check` : "New agent");
    const draft: AgentDraft = {
      name,
      instructions: instructionsFrom(body),
      schedule,
      tools,
      budgetMicro: Math.min(10 * DOLLAR, access.agentCapMicro ?? 10 * DOLLAR),
      capped,
      script: /pull request|\bprs?\b/.test(job) ? PR_REVIEW_SCRIPT : [],
    };
    const notConnected = mentioned.filter((connector) => !connected[connector.id]).map((connector) => connector.name);
    return {
      agents,
      steps: [
        found,
        { label: "Read your agents", detail: "and what your admin allows them", tool: "getMeAgents", input: "{}", result: json({ agents: mine.length, maxAgents: access.maxAgents, monthlyBudgetCapMicroUsd: access.agentCapMicro, blockedTools: toolsInUse(access.blocked) }) },
        { label: "Drafted the agent", detail: name, tool: "agent.propose", input: json({ file: `agents/${agentSlug(name)}.md`, name, instructions: draft.instructions, routines: [{ name: routineName(schedule), cron: scheduleCron(schedule) }], timezone: TIMEZONE, tools: toolsInUse(tools), budget: { monthlyUsd: draft.budgetMicro / DOLLAR, paidBy: "me" } }), result: json({ status: "waiting_for_you" }) },
      ],
      reply: `Here is ${name}. Nothing runs until you turn it on.${capped.length > 0 ? ` Your admin blocks some ${listWords(capped)} tools for agents, so I left those out.` : ""}${notConnected.length > 0 ? ` ${listWords(notConnected)} isn't connected yet, so it can't use it.` : ""}`,
      card: { kind: "proposal", draft, state: "draft", agentId: null },
      agentId: contextId,
    };
  }

  const named = findAgent(text, agents);
  const pronoun = /\b(it|its|it's|that agent|this agent|that one)\b/.test(text);
  const agent = named ?? (pronoun ? agents.find((entry) => entry.id === contextId) ?? null : null);
  const change = /\b(run|pause|resume|start|stop|turn|let|allow|give|set|cap|budget|limit|change|share|unshare|charge|bill|pay|add|make)\b/.test(text);
  if (!agent) {
    if (pronoun && pendingName) return { ...same, steps: [], reply: `${pendingName} isn't on yet. Choose “Create and turn on” on its card first.` };
    if (!change) return { ...same, steps: [], reply: "I can create, change, run, share or pause your agents, and tell you what they spent. Try one of the suggestions below." };
    return { ...same, steps: [], reply: mine.length === 0 ? "You have no agents yet. Ask me to create one." : `Which agent? You have ${listWords(mine.map((entry) => entry.name))}.` };
  }
  const about = { agentId: agent.id, card: null };
  const replace = (next: Agent) => agents.map((entry) => (entry.id === next.id ? next : entry));
  const withoutName = text.replace(agent.name.toLowerCase(), "");
  const connectors = mentionedConnectors(withoutName);
  const dollars = /\$\s?(\d+)/.exec(text);
  const mayChange = canChange(agent);
  const ownerOnly = `Only ${firstNameOf(agent.owner)} can share ${agent.name}. You can make your own copy and share that.`;
  const managerOnly = `Only ${firstNameOf(agent.owner)} and the managers ${firstNameOf(agent.owner)} picked can change ${agent.name}. You can turn it on or off for yourself, or make your own copy.`;
  const sharingOff = "Your admin turned off sharing agents, so it stays only yours.";
  const read = { label: "Read the agent", detail: agent.name, tool: "getMeAgentsAgent", input: json({ agent: agent.name }), result: json({ id: agent.id, file: agentFilePath(agent), tools: toolsInUse(agent.tools), paidBy: agent.paidBy, sharedWith: shareTargets(agent.share, agent.owner) || "nobody" }) };

  if (/\b(add|new|another)\b.*\broutine\b/.test(text)) {
    if (!mayChange) return { agents, ...about, steps: [], reply: managerOnly };
    const body = /\b(?:that|which)\s+(.*)$/i.exec(prompt)?.[1]?.trim() ?? "";
    if (body.length === 0) {
      return { agents, ...about, steps: [], reply: `What should the routine do, and when? For example: “Add a routine to ${agent.name} that sums up my week every Friday at 4”.` };
    }
    const schedule = parseSchedule(text);
    const routine = makeRoutine(`${id}-routine`, uniqueRoutineName(routineName(schedule), agent.routines), instructionsFrom(body), schedule);
    return {
      agents: replace({ ...agent, routines: [...agent.routines, routine] }),
      ...about,
      steps: [read, { label: "Added a routine", detail: `${agent.name}, ${routine.name}`, tool: "postMeAgentsAgentRoutines", input: json({ agent: agent.name, name: routine.name, cron: scheduleCron(schedule), timezone: TIMEZONE, instruction: routine.instruction }), result: json({ status: "on", routines: agent.routines.length + 1 }) }],
      reply: `${agent.name} has a new routine, “${routine.name}”. ${scheduleLine(schedule)}. It waits for its next time. Open the agent to test it sooner.`,
    };
  }

  if (/\bmanagers?\b|\bcollaborators?\b/.test(text)) {
    if (!isMine(agent)) return { agents, ...about, steps: [], reply: ownerOnly };
    if (!access.sharing) return { agents, ...about, steps: [], reply: sharingOff };
    const target = parseShareTarget(withoutName);
    if (!target || target.orgWide) return { agents, ...about, steps: [], reply: `Who? Name a person or a team, such as Sam or Engineering.` };
    const ids = [...target.memberIds, ...target.teamIds];
    const who = shareTargets(target, agent.owner);
    const roles = (role: Role) => Object.fromEntries(ids.map((entry) => [entry, role]));
    if (/\bcollaborators?\b|\b(not|no longer|remove|stop)\b/.test(withoutName)) {
      const managers = agent.managers.filter((entry) => !ids.includes(entry));
      if (managers.length === agent.managers.length) return { agents, ...about, steps: [read], reply: `${who} can already only use ${agent.name}.` };
      return {
        agents: replace({ ...agent, managers }),
        ...about,
        steps: [{ label: "Changed a role", detail: `${who}, collaborator`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, roles: roles("collaborator") }), result: json({ managers }) }],
        reply: `${who} can still use ${agent.name}, but can no longer change it.`,
      };
    }
    const managers = [...new Set([...agent.managers, ...ids])];
    if (managers.length === agent.managers.length) return { agents, ...about, steps: [read], reply: `${who} can already change ${agent.name}.` };
    return {
      agents,
      agentId: agent.id,
      steps: [read, { label: "Asked to change a role", detail: `${who}, manager`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, roles: roles("manager") }), result: json({ status: "needs_your_approval" }) }],
      reply: `A manager can change what ${agent.name} does and which tools it uses, so this needs your go-ahead.`,
      card: { kind: "share", agentId: agent.id, share: mergeShare(agent.share, target), managers, promote: ids.filter((entry) => !agent.managers.includes(entry)), state: "ask" },
    };
  }

  if (/\b(stop sharing|unshare|make (it|.*) private)\b/.test(text)) {
    if (!isMine(agent)) return { agents, ...about, steps: [], reply: ownerOnly };
    return {
      agents: replace({ ...agent, share: NOT_SHARED, managers: [] }),
      ...about,
      steps: [{ label: "Stopped sharing", detail: agent.name, tool: "putMeAgentsAgent", input: json({ agent: agent.name, share: null }), result: json({ sharedWith: [] }) }],
      reply: `${agent.name} is only yours again. It stops working for everyone else.`,
    };
  }

  if (/\bshare\b/.test(text)) {
    if (!isMine(agent)) return { agents, ...about, steps: [], reply: ownerOnly };
    if (!access.sharing) return { agents, ...about, steps: [], reply: sharingOff };
    const target = parseShareTarget(withoutName);
    if (!target) return { agents, ...about, steps: [], reply: `Who should get ${agent.name}? Name people, a team such as Engineering, or everyone.` };
    const share = mergeShare(agent.share, target);
    return {
      agents,
      agentId: agent.id,
      steps: [
        read,
        { label: "Asked to share it", detail: `with ${shareTargets(target, agent.owner).toLowerCase() === "everyone" ? "everyone" : shareTargets(target, agent.owner)}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, share: target }), result: json({ status: "needs_your_approval" }) },
      ],
      reply: "Sharing reaches other people, so it needs your go-ahead.",
      card: { kind: "share", agentId: agent.id, share, managers: agent.managers, promote: [], state: "ask" },
    };
  }

  const toOrg = /\b(charge|bill|move|switch)\b.*\b(org|organization|company)\b|\b(org|organization|company)\b.*\b(pay|pays|paid)\b/.test(withoutName);
  const toMe = /\b(charge|bill)\b.*\b(me|my)\b|\bi(?:'ll| will) pay\b/.test(withoutName);
  if (toOrg || toMe) {
    if (!mayChange) return { agents, ...about, steps: [], reply: managerOnly };
    const paidBy: PaidBy = toOrg ? "org" : "me";
    if (paidBy === "org" && !access.orgBudget.offered) {
      return { agents, ...about, steps: [read], reply: `Your admin hasn't set up an org budget for agents, so ${agent.name} stays on your own limit.` };
    }
    if (agent.paidBy === paidBy) {
      return { agents, ...about, steps: [read], reply: paidBy === "org" ? `${agent.name} is already paid from the org's agent budget.` : `${agent.name} already counts toward your own limit.` };
    }
    return {
      agents: replace({ ...agent, paidBy }),
      ...about,
      steps: [{ label: "Changed who pays", detail: `${agent.name}, ${paidBy === "org" ? "the org" : "you"}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, budget: { paidBy } }), result: json({ budget: { paidBy } }) }],
      reply: paidBy === "org"
        ? `${agent.name} is now paid from the org's agent budget. Its runs no longer count toward your limit.`
        : `${agent.name} now counts toward your own limit.`,
    };
  }

  if (dollars && /budget|cap|limit|spend|\bset\b/.test(text)) {
    if (!mayChange) return { agents, ...about, steps: [], reply: managerOnly };
    const wanted = Number(dollars[1]) * DOLLAR;
    const applied = access.agentCapMicro === null ? wanted : Math.min(wanted, access.agentCapMicro);
    return {
      agents: replace({ ...agent, budgetMicro: applied }),
      ...about,
      steps: [{ label: "Set the monthly budget", detail: `${agent.name}, ${formatWorkbotCost(applied)}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, monthlyBudgetMicroUsd: wanted }), result: json({ monthlyBudgetMicroUsd: applied }) }],
      reply: applied < wanted
        ? `Your admin allows up to ${formatWorkbotCost(applied)} a month for each agent, so I set ${agent.name} to that.`
        : `${agent.name} can now spend up to ${formatWorkbotCost(applied)} a month. It has used ${formatWorkbotCost(agent.spentMicro)}.`,
    };
  }

  const connector = connectors[0];

  // Taking single tools away ("stop it from commenting") only makes the agent able to do less, so it applies at once.
  const saidActions = WRITE_WORDS.filter(([said]) => said.test(withoutName)).map(([, part]) => part);
  if (saidActions.length > 0 && /\b(stop|no longer)\b|\b(don't|do not) let\b/.test(withoutName)) {
    if (!mayChange) return { agents, ...about, steps: [], reply: managerOnly };
    const taken = CONNECTORS
      .filter((entry) => connector === undefined || entry.id === connector.id)
      .flatMap((entry) => agent.tools[entry.id].filter((tool) => isWriteTool(entry, tool) && saidActions.some((part) => tool.includes(part))).map((tool) => ({ entry, tool })));
    if (taken.length === 0) return { agents, ...about, steps: [read], reply: `${agent.name} can't do that today, so there is nothing to take away.` };
    const tools = { ...agent.tools };
    for (const { entry, tool } of taken) tools[entry.id] = tools[entry.id].filter((name) => name !== tool);
    const apps = listWords([...new Set(taken.map(({ entry }) => entry.name))]);
    const labels = listWords(taken.map(({ tool }) => `“${toolLabel(tool)}”`));
    const changed = Object.fromEntries(taken.map(({ entry }) => [entry.id, tools[entry.id]]));
    return {
      agents: replace({ ...agent, tools }),
      ...about,
      steps: [read, { label: "Blocked a tool", detail: `${apps}, ${labels}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, tools: changed }), result: json({ tools: changed }) }],
      reply: `${agent.name} can no longer use ${labels} in ${apps}. It applies from the next run.`,
    };
  }

  if (connector && /\b(let|allow|give|write|read|send|post|save|create|update|edit|draft|comment|stop using|remove|access)\b/.test(text)) {
    if (!mayChange) return { agents, ...about, steps: [], reply: managerOnly };
    const current = agent.tools[connector.id];
    const adminBlocks = access.blocked[connector.id];
    if (!connected[connector.id]) {
      return { agents, ...about, steps: [read], reply: `${connector.name} isn't connected yet. Connect it first, then I can let ${agent.name} use it.` };
    }
    const lowered = /stop using|no access|remove/.test(text) ? [] : /read.only|only read|just read/.test(text) ? current.filter((tool) => !isWriteTool(connector, tool)) : null;
    if (lowered) {
      if (lowered.length === current.length) {
        return { agents, ...about, steps: [read], reply: lowered.length === 0 ? `${agent.name} doesn't use ${connector.name}.` : `${agent.name} can already only read ${connector.name}.` };
      }
      return {
        agents: replace({ ...agent, tools: { ...agent.tools, [connector.id]: lowered } }),
        ...about,
        steps: [{ label: "Lowered its access", detail: `${connector.name}, ${lowered.length === 0 ? "off" : "read only"}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, tools: { [connector.id]: lowered } }), result: json({ tools: { [connector.id]: lowered } }) }],
        reply: lowered.length === 0 ? `${agent.name} no longer uses ${connector.name}.` : `${agent.name} can now only read ${connector.name}.`,
      };
    }
    const wantsWrite = /write|send|post|save|create|update|edit|draft|comment/.test(withoutName);
    const wanted = wantsWrite ? [...(current.length === 0 ? connector.readTools : []), ...askedWriteTools(withoutName, connector)] : [...connector.readTools];
    const missing = wanted.filter((tool) => !current.includes(tool));
    const refused = missing.filter((tool) => adminBlocks.includes(tool));
    const adding = missing.filter((tool) => !adminBlocks.includes(tool));
    const names = (tools: string[]) => listWords(tools.map((tool) => `“${toolLabel(tool)}”`));
    if (missing.length === 0) return { agents, ...about, steps: [read], reply: `${agent.name} can already do that in ${connector.name}.` };
    if (adding.length === 0) {
      const instead = connector.writeTools.find((tool) => tool.includes("draft") && !adminBlocks.includes(tool) && !current.includes(tool));
      return {
        agents,
        agentId: agent.id,
        steps: [read, { label: "Asked for more access", detail: `${connector.name}, ${names(refused)}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, tools: { [connector.id]: { allow: refused } } }), result: json({ error: "tool_blocked_by_admin", tools: refused }) }],
        reply: `Your admin blocks ${names(refused)} in ${connector.name} for every agent, so ${agent.name} can't use ${refused.length === 1 ? "it" : "them"}.${instead ? " It can write drafts for you to send instead. That needs your go-ahead." : ""}`,
        card: instead ? { kind: "permission", agentId: agent.id, connector: connector.id, tools: [instead], addInstructions: "Draft a reply to each one for me to review. Never send it.", state: "ask" } : null,
      };
    }
    const comment = adding.includes("add_comment") && !agent.instructions.toLowerCase().includes("comment");
    const writes = adding.some((tool) => isWriteTool(connector, tool));
    return {
      agents,
      agentId: agent.id,
      steps: [read, { label: "Asked for more access", detail: `${connector.name}, ${names(adding)}`, tool: "putMeAgentsAgent", input: json({ agent: agent.name, tools: { [connector.id]: { allow: adding } } }), result: json({ status: "needs_your_approval" }) }],
      reply: `${writes ? `Today ${agent.name} can't do that in ${connector.name}.` : `${agent.name} doesn't read ${connector.name} yet.`} Allowing ${adding.length === 1 ? "one more tool" : `${adding.length} more tools`} needs your go-ahead.${refused.length > 0 ? ` Your admin blocks ${names(refused)}, so I left ${refused.length === 1 ? "it" : "them"} out.` : ""}`,
      card: {
        kind: "permission",
        agentId: agent.id,
        connector: connector.id,
        tools: adding,
        addInstructions: comment ? "Comment on the ones that have waited more than a day to tell the author they are next in my queue." : null,
        state: "ask",
      },
    };
  }

  if (/\brun\b|\bcheck now\b/.test(text)) {
    const run = simulateRun(agent, access, connected, when, id);
    return {
      agents: replace(applyRun(agent, run)),
      agentId: agent.id,
      steps: [{ label: "Ran the agent", detail: agent.name, tool: "postMeAgentsAgentRun", input: json({ agent: agent.name }), result: json({ outcome: run.outcome, costMicroUsd: run.costMicro, steps: run.steps.map((step) => ({ tool: step.tool, allowed: !step.blocked })) }) }],
      reply: run.outcome === "sent"
        ? `${agent.name} ran and sent you this in Slack.`
        : run.outcome === "quiet" ? `${agent.name} ran and found nothing to tell you, so it stayed quiet.` : run.outcome === "over_budget" ? `${agent.name} didn't run. Its budget for this month is used up.` : `${agent.name} couldn't finish.`,
      card: { kind: "run", agentId: agent.id, agentName: agent.name, run },
    };
  }

  if (/\b(pause|turn off)\b|\bstop\b/.test(text)) {
    return {
      agents: replace({ ...agent, on: false }),
      ...about,
      steps: [{ label: "Paused the agent", detail: agent.name, tool: "putMeAgentsAgent", input: json({ agent: agent.name, on: false }), result: json({ status: "paused" }) }],
      reply: `${agent.name} is paused. It keeps its instructions and history.`,
    };
  }

  if (/\b(resume|turn on|start)\b/.test(text)) {
    return {
      agents: replace({ ...agent, on: true }),
      ...about,
      steps: [{ label: "Turned the agent on", detail: agent.name, tool: "putMeAgentsAgent", input: json({ agent: agent.name, on: true }), result: json({ status: "on" }) }],
      reply: overBudget(agent, access) ? `${agent.name} is on, but its budget for this month is used up. It runs again next month, or when you raise its budget.` : `${agent.name} is on. ${nextRunText(agent)}.`,
    };
  }

  return { agents, ...about, steps: [], reply: `I can run, pause or share ${agent.name}, add a routine, change which tools it can use, or set its budget and who pays.` };
}

// ---------------------------------------------------------------------------
// A shared agent, as the person it was shared with sees it
// ---------------------------------------------------------------------------

// Agents that did work for you: your own, and shared ones you turned on or asked.
export function usedByMe(agent: Agent): boolean {
  return isMine(agent) || agent.on || agent.spentMicro > 0;
}

export function sharedStateLine(agent: Agent, access: Access): string {
  const from = `From ${personName(agent.owner)}.`;
  if (agent.on) return `${from} ${agentStateLine(agent, access)}`;
  const last = agent.runs[0];
  return last ? `${from} Its routines are off for you. ${last.summary}` : `${from} Off for you. Ask it something, or turn on its routines.`;
}

export function recipientStatus(agent: Agent, person: string): string {
  const use = SHARED_USE[agent.id]?.[person];
  return use ? `On. ${formatWorkbotCost(use.spentMicro)} this month, ${runsLabel(use.runs)}` : "Hasn't used it yet";
}

export function shareLabel(agent: Agent): string {
  const status = shareStatus(agent);
  return status === "Everyone" ? "Shared with everyone" : status;
}

// ---------------------------------------------------------------------------
// The agent as a file. One Markdown file holds everything the page edits, so
// an agent can live in a repo and be reviewed like code. Whether it is on for
// you, and who it is shared with, stay outside the file.
// ---------------------------------------------------------------------------

export function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function agentFilePath(agent: Agent, kind: "md" | "ts" = "md"): string {
  return `agents/${agentSlug(agent.name)}.${kind}`;
}

export function scheduleCron(schedule: Schedule): string {
  if (schedule.rhythm === "weekly") return `0 ${schedule.hour} * * ${WEEKDAYS.indexOf(schedule.weekday) + 1}`;
  const days = schedule.days === "weekdays" ? "1-5" : "*";
  if (schedule.rhythm === "daily") return `0 ${schedule.hour} * * ${days}`;
  const every = RHYTHMS.find((entry) => entry.id === schedule.rhythm)?.everyHours ?? 1;
  const hours = `${schedule.startHour}-${schedule.endHour - 1}`;
  return `0 ${every === 1 ? hours : `${hours}/${every}`} * * ${days}`;
}

// Only the schedules the page can show: once a day, once a week, or every 1 to 4 hours.
export function scheduleFromCron(cron: string): Schedule | null {
  const match = /^0 (\d{1,2})(?:-(\d{1,2}))?(?:\/(\d))? \* \* (\*|1-5|[1-5])$/.exec(cron.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] === undefined ? null : Number(match[2]);
  const step = match[3] === undefined ? null : Number(match[3]);
  const days = match[4] ?? "*";
  if (first > 23) return null;
  const daily: Schedule = { rhythm: "daily", days: days === "*" ? "everyday" : "weekdays", startHour: 9, endHour: 18, hour: first, weekday: "Monday" };
  if (last === null) {
    if (step !== null) return null;
    if (days === "*" || days === "1-5") return daily;
    const weekday = WEEKDAYS[Number(days) - 1];
    return weekday ? { ...daily, rhythm: "weekly", weekday } : null;
  }
  const rhythm = RHYTHMS.find((entry) => entry.everyHours === (step ?? 1));
  if (!rhythm || (days !== "*" && days !== "1-5") || last < first || last > 23) return null;
  return { ...daily, rhythm: rhythm.id, startHour: first, endHour: last + 1 };
}

function describe(agent: Agent): string {
  return (/^[^.!?]*[.!?]?/.exec(agent.instructions.trim())?.[0] ?? "").trim();
}

function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, " ");
}

export function agentFile(agent: Agent): string {
  const used = CONNECTORS.filter((connector) => agent.tools[connector.id].length > 0);
  const tools = (connector: Connector) => {
    const preset = presetOf(connector, agent.tools[connector.id]);
    return preset === "read" ? "read" : preset === "write" ? "read_write" : `[${agent.tools[connector.id].join(", ")}]`;
  };
  return [
    "---",
    `name: ${agent.name}`,
    `description: ${describe(agent)}`,
    `model: ${agent.model}`,
    ...(agent.routines.length === 0 ? [] : [
      "routines:",
      ...agent.routines.flatMap((routine) => [
        `  - name: ${routine.name}`,
        `    cron: "${scheduleCron(routine.schedule)}"`,
        ...(oneLine(routine.instruction).length === 0 ? [] : [`    instruction: ${oneLine(routine.instruction)}`]),
      ]),
      `timezone: ${TIMEZONE}`,
    ]),
    "tools:",
    ...used.map((connector) => `  ${connector.id}: ${tools(connector)}`),
    "budget:",
    ...(agent.budgetMicro === null ? [] : [`  monthly_usd: ${agent.budgetMicro / DOLLAR}`]),
    `  paid_by: ${agent.paidBy}`,
    `quiet_when_nothing: ${agent.quietWhenNothing}`,
    "---",
    "",
    agent.instructions.trim(),
    "",
  ].join("\n");
}

// The same agent defined in code. OpenWork reads the values out of the file and never runs it.
export function agentCode(agent: Agent): string {
  const used = CONNECTORS.filter((connector) => agent.tools[connector.id].length > 0);
  const tools = (connector: Connector) => {
    const preset = presetOf(connector, agent.tools[connector.id]);
    if (preset !== "custom") return preset === "read" ? '"read"' : '"read_write"';
    const names = agent.tools[connector.id].map((tool) => `"${tool}"`);
    // A long list goes one tool to a line, the way a formatter would leave it.
    return names.join(", ").length > 60 ? `[\n${names.map((name) => `      ${name},`).join("\n")}\n    ]` : `[${names.join(", ")}]`;
  };
  const monthly = agent.budgetMicro === null ? "" : `monthlyUsd: ${agent.budgetMicro / DOLLAR}, `;
  return [
    'import { defineAgent } from "@openwork/agents";',
    "",
    "export default defineAgent({",
    `  name: ${JSON.stringify(agent.name)},`,
    `  description: ${JSON.stringify(describe(agent))},`,
    `  model: ${JSON.stringify(agent.model)},`,
    ...(agent.routines.length === 0 ? [] : [
      "  routines: [",
      ...agent.routines.map((routine) => `    { name: ${JSON.stringify(routine.name)}, cron: "${scheduleCron(routine.schedule)}"${oneLine(routine.instruction).length === 0 ? "" : `, instruction: ${JSON.stringify(oneLine(routine.instruction))}`} },`),
      "  ],",
      `  timezone: "${TIMEZONE}",`,
    ]),
    "  tools: {",
    ...used.map((connector) => `    ${connector.id}: ${tools(connector)},`),
    "  },",
    `  budget: { ${monthly}paidBy: "${agent.paidBy}" },`,
    `  quietWhenNothing: ${agent.quietWhenNothing},`,
    `  instructions: ${JSON.stringify(agent.instructions.trim())},`,
    "});",
    "",
  ].join("\n");
}

export type FileCheck = {
  // What applying the file would change. Null while a problem is left.
  patch: Partial<Agent> | null;
  problems: string[];
  // Things that are accepted, but won't do what the file says.
  warnings: string[];
};

const FILE_KEYS: Record<string, string[]> = {
  name: [],
  description: [],
  model: [],
  routines: [],
  timezone: [],
  tools: CONNECTORS.map((connector) => connector.id),
  budget: ["monthly_usd", "paid_by"],
  quiet_when_nothing: [],
};

const ROUTINE_KEYS = ["name", "cron", "instruction"];

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

type FileFormat = "md" | "ts";

// What a file says before it is checked. Both formats end up here, under the Markdown spelling of each setting.
type FileSettings = {
  top: Map<string, string>;
  nested: Map<string, Map<string, string>>;
  routines: Map<string, string>[];
  instructions: string;
};

// How each format spells the things a check talks about.
const FILE_WORDS: Record<FileFormat, { monthly: string; paidByMe: string; paidByChoice: string; quiet: string; toolChoice: (tool: string) => string; instructions: string }> = {
  md: {
    monthly: "monthly_usd",
    paidByMe: "paid_by: me",
    paidByChoice: "paid_by is me or org.",
    quiet: "quiet_when_nothing",
    toolChoice: (tool) => `write read, read_write, or a list such as [${tool}].`,
    instructions: "Write what it should do under the settings.",
  },
  ts: {
    monthly: "monthlyUsd",
    paidByMe: 'paidBy: "me"',
    paidByChoice: 'paidBy is "me" or "org".',
    quiet: "quietWhenNothing",
    toolChoice: (tool) => `write "read", "read_write", or a list such as ["${tool}"].`,
    instructions: "Write what it should do in instructions.",
  },
};

export function readAgentFile(text: string, access: Access): FileCheck {
  const problems: string[] = [];
  const parts = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(text.replace(/\r\n/g, "\n").trim());
  if (!parts) return { patch: null, problems: ["Start the file with its settings between two lines of ---."], warnings: [] };

  const settings: FileSettings = { top: new Map(), nested: new Map(), routines: [], instructions: parts[2] ?? "" };
  let parent: string | null = null;
  let routine: Map<string, string> | null = null;
  for (const line of (parts[1] ?? "").split("\n")) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (top) {
      const name = top[1] ?? "";
      settings.top.set(name, unquote(top[2] ?? ""));
      parent = name;
      routine = null;
      if (!(name in FILE_KEYS)) problems.push(`“${name}” isn't a setting an agent has.`);
      continue;
    }
    if (parent === "routines") {
      // Each routine starts with "- name:" and keeps its other settings indented under it.
      const starts = /^\s+-\s*(.*)$/.exec(line);
      if (starts) {
        routine = new Map<string, string>();
        settings.routines.push(routine);
      }
      const pair = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(starts ? starts[1] ?? "" : line);
      if (!pair || !routine) problems.push(`“${line.trim()}” isn't a routine. Start each one with - name: and put its cron and instruction under it.`);
      else if (!ROUTINE_KEYS.includes(pair[1] ?? "")) problems.push(`“${pair[1]}” isn't a setting a routine has.`);
      else routine.set(pair[1] ?? "", unquote(pair[2] ?? ""));
      continue;
    }
    const entry = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!entry) {
      problems.push(`“${line.trim()}” isn't a setting. Write it as name: value.`);
      continue;
    }
    const key = entry[1] ?? "";
    const value = unquote(entry[2] ?? "");
    const allowed: string[] | undefined = parent ? FILE_KEYS[parent] : undefined;
    if (!parent || !allowed) continue;
    if (parent !== "tools" && !allowed.includes(key)) {
      problems.push(`“${key}” isn't a setting under ${parent}.`);
      continue;
    }
    const group = settings.nested.get(parent) ?? new Map<string, string>();
    group.set(key, value);
    settings.nested.set(parent, group);
  }
  return checkSettings(settings, access, "md", problems);
}

type CodeValue = string | number | boolean | CodeValue[] | { [key: string]: CodeValue };

class CodeProblem extends Error {}

const CODE_GAP = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y;
const CODE_NAME = /[A-Za-z_$][\w$]*/y;
const CODE_NUMBER = /-?\d+(?:\.\d+)?/y;
const CODE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

// The file is read as data and never run, so a value has to be written out where it is used.
function notRun(where: string): string {
  return `${where.length > 0 ? `“${where}” has` : "Each setting has"} to be written out in place: text, a number, true or false, or a list. OpenWork reads this file and never runs it.`;
}

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'" || char === "`";
}

function isGroup(value: CodeValue): value is { [key: string]: CodeValue } {
  return typeof value === "object" && !Array.isArray(value);
}

function isText(value: CodeValue): value is string {
  return typeof value === "string";
}

// Reads one written-out value: text, a number, true or false, a list, or a group of settings. Anything that would
// have to be run to know its value (a variable, a call, a sum) is a problem.
function parseCode(source: string, start: number): CodeValue {
  let at = start;
  const match = (pattern: RegExp): string | null => {
    pattern.lastIndex = at;
    return pattern.exec(source)?.[0] ?? null;
  };
  const skip = () => {
    at += match(CODE_GAP)?.length ?? 0;
  };
  const quoted = (where: string): string => {
    const quote = source[at] ?? "";
    let out = "";
    at += 1;
    while (at < source.length && source[at] !== quote) {
      const char = source[at] ?? "";
      if (quote === "`" && char === "$" && source[at + 1] === "{") throw new CodeProblem(notRun(where));
      if (char === "\\") {
        const next = source[at + 1] ?? "";
        out += CODE_ESCAPES[next] ?? next;
        at += 2;
      } else {
        out += char;
        at += 1;
      }
    }
    if (at >= source.length) throw new CodeProblem("A piece of text is missing its closing quote.");
    at += 1;
    return out;
  };
  const value = (where: string): CodeValue => {
    skip();
    const char = source[at];
    if (isQuote(char)) return quoted(where);
    if (char === "{") {
      at += 1;
      const out: { [key: string]: CodeValue } = {};
      for (;;) {
        skip();
        if (source[at] === "}") {
          at += 1;
          return out;
        }
        const bare = isQuote(source[at]) ? null : match(CODE_NAME);
        if (bare === null && !isQuote(source[at])) throw new CodeProblem(notRun(where));
        const name = bare ?? quoted(where);
        if (bare !== null) at += bare.length;
        const path = where.length > 0 ? `${where}.${name}` : name;
        skip();
        if (source[at] !== ":") throw new CodeProblem(notRun(path));
        at += 1;
        out[name] = value(path);
        skip();
        if (source[at] === ",") at += 1;
        else if (source[at] !== "}") throw new CodeProblem(notRun(path));
      }
    }
    if (char === "[") {
      at += 1;
      const out: CodeValue[] = [];
      for (;;) {
        skip();
        if (source[at] === "]") {
          at += 1;
          return out;
        }
        out.push(value(where));
        skip();
        if (source[at] === ",") at += 1;
        else if (source[at] !== "]") throw new CodeProblem(notRun(where));
      }
    }
    const number = match(CODE_NUMBER);
    if (number !== null) {
      at += number.length;
      return Number(number);
    }
    const word = match(CODE_NAME);
    if (word === "true" || word === "false") {
      at += word.length;
      return word === "true";
    }
    throw new CodeProblem(notRun(where));
  };
  return value("");
}

const CODE_KEYS: Record<string, string> = {
  name: "name",
  description: "description",
  model: "model",
  routines: "routines",
  timezone: "timezone",
  tools: "tools",
  budget: "budget",
  quietWhenNothing: "quiet_when_nothing",
  instructions: "instructions",
};

const CODE_NESTED: Record<string, Record<string, string>> = {
  budget: { monthlyUsd: "monthly_usd", paidBy: "paid_by" },
};

// The TypeScript form of the same file. Only the values inside defineAgent({ … }) are read.
export function readAgentCode(text: string, access: Access): FileCheck {
  const source = text.replace(/\r\n/g, "\n");
  const call = /export\s+default\s+defineAgent\s*\(/.exec(source);
  if (!call) return { patch: null, problems: ["Export the agent with export default defineAgent({ … })."], warnings: [] };
  let parsed: CodeValue;
  try {
    parsed = parseCode(source, call.index + call[0].length);
  } catch (error) {
    if (error instanceof CodeProblem) return { patch: null, problems: [error.message], warnings: [] };
    throw error;
  }
  if (!isGroup(parsed)) return { patch: null, problems: ["Put the settings inside defineAgent({ … })."], warnings: [] };

  const problems: string[] = [];
  const settings: FileSettings = { top: new Map(), nested: new Map(), routines: [], instructions: "" };
  for (const [key, value] of Object.entries(parsed)) {
    const setting = CODE_KEYS[key];
    if (setting === undefined) {
      problems.push(`“${key}” isn't a setting an agent has.`);
      continue;
    }
    if (setting === "routines") {
      if (!Array.isArray(value)) {
        problems.push("routines needs a list inside [ ].");
        continue;
      }
      for (const entry of value) {
        if (!isGroup(entry)) {
          problems.push("Each routine needs its settings inside { }.");
          continue;
        }
        const routine = new Map<string, string>();
        for (const [inner, innerValue] of Object.entries(entry)) {
          if (!ROUTINE_KEYS.includes(inner)) problems.push(`“${inner}” isn't a setting a routine has.`);
          else if (!isText(innerValue)) problems.push(`${inner} needs text in quotes.`);
          else routine.set(inner, innerValue);
        }
        settings.routines.push(routine);
      }
      continue;
    }
    if (setting === "tools" || setting === "budget") {
      if (!isGroup(value)) {
        problems.push(`${key} needs its settings inside { }.`);
        continue;
      }
      const group = new Map<string, string>();
      for (const [inner, innerValue] of Object.entries(value)) {
        if (setting === "tools") {
          // Anything else is left empty, so the check below says what a connector accepts.
          group.set(inner, isText(innerValue) ? innerValue : Array.isArray(innerValue) && innerValue.every(isText) ? `[${innerValue.join(", ")}]` : "");
          continue;
        }
        const name = CODE_NESTED[setting]?.[inner];
        if (name === undefined) problems.push(`“${inner}” isn't a setting under ${key}.`);
        else if (name === "monthly_usd" && typeof innerValue !== "number") problems.push("monthlyUsd needs a number above 0.");
        else if (name !== "monthly_usd" && !isText(innerValue)) problems.push(`${inner} needs text in quotes.`);
        else group.set(name, String(innerValue));
      }
      settings.nested.set(setting, group);
      continue;
    }
    if (setting === "quiet_when_nothing") {
      if (typeof value === "boolean") settings.top.set(setting, String(value));
      else problems.push("quietWhenNothing is true or false.");
      continue;
    }
    if (!isText(value)) problems.push(`${key} needs text in quotes.`);
    else if (setting === "instructions") settings.instructions = value;
    else settings.top.set(setting, value);
  }
  return checkSettings(settings, access, "ts", problems);
}

function checkSettings(settings: FileSettings, access: Access, format: FileFormat, problems: string[]): FileCheck {
  const warnings: string[] = [];
  const words = FILE_WORDS[format];
  const patch: Partial<Agent> = {};
  const name = (settings.top.get("name") ?? "").trim();
  if (name.length === 0) problems.push("Give it a name.");
  else patch.name = name;

  const model = settings.top.get("model") ?? "auto";
  const known = MODELS.find((entry) => entry.id === model);
  if (known) patch.model = known.id;
  else problems.push(`“${model}” isn't a model. Use ${MODELS.map((entry) => entry.id).join(", ")}.`);

  // No routines is fine: the agent then works only when someone asks it.
  const routines: Routine[] = [];
  settings.routines.forEach((entry, index) => {
    const label = (entry.get("name") ?? "").trim();
    const cron = entry.get("cron") ?? "";
    const schedule = scheduleFromCron(cron);
    const called = label.length > 0 ? `“${label}”` : `Routine ${index + 1}`;
    if (label.length === 0) problems.push(`Routine ${index + 1} needs a name.`);
    else if (routines.some((routine) => routine.name === label)) problems.push(`Two routines are called “${label}”. Give each its own name.`);
    if (cron.length === 0) problems.push(`${called} needs a cron line that says when it runs.`);
    else if (!schedule) problems.push(`${called}: “${cron}” isn't a time agents can keep yet. Use once a day, once a week, or every 1 to 4 hours on the hour.`);
    if (label.length > 0 && schedule) routines.push(makeRoutine(`file-${index}`, label, (entry.get("instruction") ?? "").trim(), schedule));
  });
  patch.routines = routines;

  const tools = noTools();
  for (const [id, value] of settings.nested.get("tools") ?? []) {
    const connector = CONNECTORS.find((entry) => entry.id === id);
    if (!connector) {
      problems.push(`“${id}” isn't an app an agent can use.`);
      continue;
    }
    const every = toolsForLevel(connector, "write");
    const list = /^\[(.*)\]$/.exec(value);
    if (value === "read") tools[connector.id] = toolsForLevel(connector, "read");
    else if (value === "read_write") tools[connector.id] = every;
    else if (list) {
      const names = (list[1] ?? "").split(",").map(unquote).filter((entry) => entry.length > 0);
      for (const tool of names) {
        if (connector.neverTools.includes(tool)) problems.push(`${connector.name}: ${tool} removes things for good, so no agent can use it.`);
        else if (!every.includes(tool)) problems.push(`${connector.name} has no tool called ${tool}.`);
      }
      tools[connector.id] = every.filter((tool) => names.includes(tool));
    } else {
      problems.push(`${connector.name}: ${words.toolChoice(connector.readTools[0] ?? "tool")}`);
      continue;
    }
    const blocked = tools[connector.id].filter((tool) => access.blocked[connector.id].includes(tool));
    if (blocked.length > 0) {
      warnings.push(`Your admin blocks ${listWords(blocked)} in ${connector.name}. ${blocked.length === 1 ? "It stays" : "They stay"} in the file, but the agent can't use ${blocked.length === 1 ? "it" : "them"}.`);
    }
  }
  patch.tools = tools;

  const monthly = settings.nested.get("budget")?.get("monthly_usd");
  if (monthly === undefined) patch.budgetMicro = null;
  else {
    const dollars = Number(monthly);
    if (!Number.isFinite(dollars) || dollars <= 0) problems.push(`${words.monthly} needs a number above 0.`);
    else {
      patch.budgetMicro = Math.round(dollars * DOLLAR);
      if (access.agentCapMicro !== null && patch.budgetMicro > access.agentCapMicro) {
        warnings.push(`Your admin allows up to ${formatWorkbotCost(access.agentCapMicro)} a month for each agent, so it stops there.`);
      }
    }
  }
  const paidBy = settings.nested.get("budget")?.get("paid_by") ?? "me";
  if (paidBy === "org" && !access.orgBudget.offered) problems.push(`Your admin hasn't set up an org budget for agents. Use ${words.paidByMe}.`);
  else if (paidBy === "me" || paidBy === "org") patch.paidBy = paidBy;
  else problems.push(words.paidByChoice);

  const quiet = settings.top.get("quiet_when_nothing") ?? "true";
  if (quiet === "true" || quiet === "false") patch.quietWhenNothing = quiet === "true";
  else problems.push(`${words.quiet} is true or false.`);

  const instructions = settings.instructions.trim();
  if (instructions.length === 0) problems.push(words.instructions);
  else patch.instructions = instructions;

  return { patch: problems.length > 0 ? null : patch, problems, warnings };
}
