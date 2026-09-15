/**
 * The team a coworker belongs to.
 *
 * Three things live here. The role catalog onboarding proposes a team from and
 * the Add screen suggests roles from. The short description of teammates every
 * coworker reads each turn (`team/roster.md`, written by the app whenever the
 * team changes; the coworker never edits it). And the two small append-only
 * logs a coworker keeps of the teammates it proposed (`team/suggestions.jsonl`)
 * and the work it offered to hand over (`team/referrals.jsonl`), with the
 * guards that keep a coworker from proposing what already exists, what the
 * person just declined, or more than one teammate a day.
 *
 * Nothing here creates a coworker: only the person's tap does, in the main
 * process, through the same path the Add screen uses.
 *
 * No Electron imports: exercised by `node --test electron/team.test.mjs`.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TEAM_DIR_NAME = "team";
/** Coworker-relative path of the description every coworker reads each turn. */
export const TEAM_ROSTER_FILE = "team/roster.md";
export const SUGGESTIONS_LOG_FILE = "team/suggestions.jsonl";
export const REFERRALS_LOG_FILE = "team/referrals.jsonl";
/** A role the person declined stays quiet for this long. */
export const DECLINE_QUIET_DAYS = 14;
/** A coworker proposes at most this many teammates in one day. */
export const SUGGESTIONS_PER_DAY = 1;
/** Teammates named in the description before "and n more". */
export const ROSTER_TEAMMATE_CAP = 12;
/** Declined roles listed in the description. */
export const ROSTER_DECLINED_CAP = 5;
const MISSION_CUT = 140;
const DAY_MS = 86_400_000;

const AVATAR_COLORS = ["blue", "violet", "mint", "orange", "rose", "slate"];

/**
 * The six roles from the plan: a default name, three alternates for when it is
 * taken, the short role label, a one-sentence mission in the coworker's voice,
 * a look, a voice, the words a request for this kind of work tends to use, and
 * the role recommended beside it when it is the only one asked for.
 */
export const TEAM_ROLES = [
  {
    id: "research",
    defaultName: "Scout",
    alternateNames: ["Atlas", "Nova", "Lark"],
    role: "Research and synthesis",
    pitch: "Digging into questions and comparing options",
    mission: "I dig into questions, compare options, and bring back what matters in a page or less.",
    avatarColor: "blue",
    avatarGlasses: "round",
    personality: "curious",
    complement: "operations",
    keywords: [
      "research", "investigate", "compare", "comparison", "competitor", "competitors", "landscape", "sources", "source",
      "find", "findings", "synthesize", "summary", "summarize", "study", "analysis", "analyze", "market", "options", "evidence",
    ],
  },
  {
    id: "writing",
    defaultName: "Editor",
    alternateNames: ["Quill", "Ink", "Sage"],
    role: "Writing and content",
    pitch: "Drafts, edits, and content in your voice",
    mission: "I turn rough ideas into clear drafts and keep every piece in your voice.",
    avatarColor: "violet",
    avatarGlasses: "square",
    personality: "thoughtful",
    complement: "operations",
    keywords: [
      "write", "writing", "draft", "drafting", "edit", "editing", "copy", "blog", "post", "announcement", "newsletter",
      "article", "tone", "proofread", "rewrite", "headline", "content", "story", "script", "memo", "documentation", "wording",
    ],
  },
  {
    id: "operations",
    defaultName: "Ops",
    alternateNames: ["Dot", "Pace", "Reed"],
    role: "Operations and scheduling",
    pitch: "Schedules, reminders, and follow-ups",
    mission: "I keep the routine work moving: schedules, reminders, checklists, and follow-ups.",
    avatarColor: "mint",
    avatarGlasses: "round",
    personality: "meticulous",
    complement: "research",
    keywords: [
      "schedule", "scheduling", "calendar", "remind", "reminder", "reminders", "every", "daily", "weekly", "routine",
      "checklist", "process", "operations", "ops", "logistics", "booking", "invoice", "invoices", "expenses", "organize",
      "organise", "track", "tracking", "admin", "coordinate", "recurring",
    ],
  },
  {
    id: "support",
    defaultName: "Care",
    alternateNames: ["Haven", "June", "Wren"],
    role: "Customer support",
    pitch: "Customer messages, answered with care",
    mission: "I watch what customers write in, answer with care, and flag what needs a person.",
    avatarColor: "rose",
    avatarGlasses: "none",
    personality: "warm",
    complement: "operations",
    keywords: [
      "support", "customer", "customers", "ticket", "tickets", "inbox", "helpdesk", "complaint", "complaints", "refund",
      "faq", "reply", "replies", "respond", "responses", "users", "triage", "churn", "feedback", "escalate",
    ],
  },
  {
    id: "sales",
    defaultName: "Pipeline",
    alternateNames: ["Ash", "Rowan", "Sol"],
    role: "Sales and relationships",
    pitch: "Leads, follow-ups, and deals that stay warm",
    mission: "I keep leads warm, follow up on time, and make sure no conversation goes cold.",
    avatarColor: "orange",
    avatarGlasses: "square",
    personality: "eager",
    complement: "operations",
    keywords: [
      "sales", "sell", "lead", "leads", "pipeline", "prospect", "prospects", "outreach", "deal", "deals", "crm", "demo",
      "pricing", "quote", "proposal", "client", "clients", "account", "accounts", "renewal", "upsell", "partnership", "partner",
    ],
  },
  {
    id: "product",
    defaultName: "Builder",
    alternateNames: ["Forge", "Kit", "Bolt"],
    role: "Product and engineering",
    pitch: "Specs, code, releases, and an honest backlog",
    mission: "I turn ideas into specs, working code, and releases, and keep the backlog honest.",
    avatarColor: "slate",
    avatarGlasses: "round",
    personality: "calm",
    complement: "operations",
    keywords: [
      "product", "engineering", "build", "code", "coding", "bug", "bugs", "feature", "features", "spec", "specs", "roadmap",
      "release", "ship", "api", "design", "prototype", "test", "tests", "deploy", "backlog", "sprint", "technical", "architecture",
    ],
  },
];

const ROLES_BY_ID = new Map(TEAM_ROLES.map((role) => [role.id, role]));

export function roleById(id) {
  return ROLES_BY_ID.get(String(id ?? "").trim().toLowerCase()) ?? null;
}

/** The catalog as the renderer shows it: everything a card needs, nothing about scoring. */
export function teamCatalog() {
  return TEAM_ROLES.map((role) => ({
    id: role.id,
    defaultName: role.defaultName,
    role: role.role,
    pitch: role.pitch,
    mission: role.mission,
    avatarColor: role.avatarColor,
    avatarGlasses: role.avatarGlasses,
    personality: role.personality,
  }));
}

/** Mirrors `slugifyCoworkerName` in coworkers.mjs so a proposed name is unique the way the store sees it. */
export function slugOf(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "coworker";
}

function draftFor(role, name) {
  return {
    roleId: role.id,
    name,
    role: role.role,
    mission: role.mission,
    avatarColor: role.avatarColor,
    avatarGlasses: role.avatarGlasses,
    personality: role.personality,
  };
}

/**
 * The team onboarding proposes from what the person picked. One intent → the
 * specialist plus its complement; two or three → one per intent in the order
 * picked; more → the first three. Unknown ids are ignored, duplicates dropped,
 * and nothing picked still proposes a starting pair.
 */
export function recommendTeam(intents) {
  const picked = [];
  for (const value of Array.isArray(intents) ? intents : []) {
    const role = roleById(value);
    if (role && !picked.includes(role)) picked.push(role);
  }
  let roles;
  if (picked.length === 0) roles = [roleById("research"), roleById("operations")];
  else if (picked.length === 1) roles = [picked[0], roleById(picked[0].complement)];
  else roles = picked.slice(0, 3);
  const taken = new Set();
  return roles.filter(Boolean).map((role) => {
    const name = uniqueName(role.id, taken);
    taken.add(slugOf(name));
    return draftFor(role, name);
  });
}

/**
 * A name for a new coworker of this role that no current coworker has: the
 * role's default, then its alternates, then the default with a number.
 */
export function uniqueName(roleId, takenSlugs) {
  const role = roleById(roleId);
  const taken = takenSlugs instanceof Set ? takenSlugs : new Set(takenSlugs ?? []);
  const candidates = role ? [role.defaultName, ...role.alternateNames] : [];
  for (const candidate of candidates) {
    if (!taken.has(slugOf(candidate))) return candidate;
  }
  const base = role ? role.defaultName : "Coworker";
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base} ${attempt}`;
    if (!taken.has(slugOf(candidate))) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** The least-used of the six colors; ties go to `preferred` when it is among them, else catalog order. */
export function pickAvatarColor(existingColors, preferred = "blue") {
  const counts = new Map(AVATAR_COLORS.map((color) => [color, 0]));
  for (const color of existingColors ?? []) {
    if (counts.has(color)) counts.set(color, counts.get(color) + 1);
  }
  const least = Math.min(...counts.values());
  const ties = AVATAR_COLORS.filter((color) => counts.get(color) === least);
  return ties.includes(preferred) ? preferred : ties[0];
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "we", "you", "i", "it",
  "this", "that", "can", "could", "would", "should", "please", "what", "how", "do", "does", "our", "your", "my",
  "me", "us", "at", "by", "from", "about", "as", "if", "so", "not", "let", "lets", "help", "need", "want", "coworker",
  "someone", "who", "keep", "eye",
]);

/** The same tokenizer the group chat's fallback scorer uses, kept here so the main process never imports renderer code. */
export function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/** The catalog role a request reads as, with how strongly; null when no role's words appear. */
export function scoreRole(text) {
  const words = new Set(tokens(text));
  let best = null;
  for (const role of TEAM_ROLES) {
    const profile = new Set([...role.keywords, ...tokens(role.role)]);
    let score = 0;
    for (const word of words) if (profile.has(word)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { roleId: role.id, score };
  }
  return best;
}

/**
 * The teammate who already covers a role, or null. `role` is a catalog id or
 * free text. A teammate created from the catalog matches its id exactly;
 * otherwise the words of the requested role are compared with the teammate's
 * role and mission — two shared words, or one when the request is one or two
 * words long ("writing").
 */
export function matchesExisting(role, team) {
  const requested = String(role ?? "").trim();
  if (!requested) return null;
  const catalog = roleById(requested);
  const members = Array.isArray(team) ? team : [];
  if (catalog) {
    const exact = members.find((member) => member.roleId === catalog.id);
    if (exact) return exact;
  }
  const wanted = catalog ? new Set([...tokens(catalog.role), ...catalog.keywords]) : new Set(tokens(requested));
  const short = !catalog && wanted.size <= 2;
  let best = null;
  let bestScore = 0;
  for (const member of members) {
    const memberRole = roleById(member.roleId);
    const profile = new Set([...tokens(`${member.role} ${member.mission}`), ...(memberRole ? memberRole.keywords : [])]);
    let score = 0;
    for (const word of wanted) if (profile.has(word)) score += 1;
    if (score > bestScore) {
      best = member;
      bestScore = score;
    }
  }
  if (!best) return null;
  if (catalog) return bestScore >= 3 ? best : null;
  return bestScore >= 2 || (short && bestScore >= 1) ? best : null;
}

function cut(text, limit) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function shortDate(at) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function describeRoleWord(entry) {
  const role = roleById(entry.roleId) ?? roleById(entry.role);
  return role ? role.role.toLowerCase() : String(entry.role ?? "").trim().toLowerCase() || "new";
}

/**
 * The description one coworker reads every turn: who it is, its teammates one
 * line each (alphabetical, capped), the roles the person recently declined,
 * and how to hand work over or propose a teammate. Never another coworker's
 * memory, documents, or conversation.
 */
export function rosterFor(self, teammates, declined = [], { now = Date.now() } = {}) {
  const others = (Array.isArray(teammates) ? teammates : [])
    .filter((member) => member.slug !== self.slug)
    .sort((a, b) => a.name.localeCompare(b.name));
  // Only the facts live here; when to refer or suggest is the contract's (`## My team`), said once.
  const lines = [
    "# My team",
    "",
    `I am ${self.name}${self.role ? ` (${cut(self.role, 60)})` : ""}.`,
    "",
    "My teammates, one line each:",
    "",
  ];
  if (others.length === 0) lines.push("(No teammates yet — I am the only coworker.)");
  else {
    for (const member of others.slice(0, ROSTER_TEAMMATE_CAP)) {
      const role = member.role ? cut(member.role, 60) : "no role yet";
      const mission = member.mission ? ` — ${cut(member.mission, MISSION_CUT)}` : "";
      lines.push(`- ${member.name} (\`${member.slug}\`) — ${role}${mission}`);
    }
    if (others.length > ROSTER_TEAMMATE_CAP) lines.push(`- and ${others.length - ROSTER_TEAMMATE_CAP} more`);
  }
  const recent = (Array.isArray(declined) ? declined : [])
    .filter((entry) => entry.state === "declined" && now - entry.at <= DECLINE_QUIET_DAYS * DAY_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, ROSTER_DECLINED_CAP);
  if (recent.length > 0) {
    lines.push("", "## Recently declined", "", "The person said not now to these:", "");
    for (const entry of recent) lines.push(`- a ${describeRoleWord(entry)} coworker — ${shortDate(entry.at)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function homeOf(coworkersDir, slug) {
  const cleaned = String(slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) throw new Error(`Invalid coworker slug: ${slug}`);
  return path.join(coworkersDir, cleaned);
}

async function writeAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function readLog(target) {
  let raw = "";
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed);
    } catch {
      // A torn line at the end of a log is skipped, never fatal.
    }
  }
  return entries;
}

/**
 * Fold an append-only log into its current entries: the first line with an id
 * is the entry; later lines with the same id carry a new state (and when) and
 * anything the answer added, such as the coworker created from a suggestion.
 */
export function foldLog(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id) continue;
    const current = byId.get(entry.id);
    if (!current) {
      byId.set(entry.id, { ...entry, stateAt: typeof entry.at === "number" ? entry.at : 0 });
      continue;
    }
    const { id: _id, at, ...patch } = entry;
    Object.assign(current, patch);
    if (typeof entry.state === "string") current.stateAt = typeof at === "number" ? at : current.stateAt;
  }
  return [...byId.values()];
}

async function appendLog(target, entry) {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readSuggestions(coworkersDir, slug) {
  return foldLog(await readLog(path.join(homeOf(coworkersDir, slug), SUGGESTIONS_LOG_FILE)));
}

export async function readReferrals(coworkersDir, slug) {
  return foldLog(await readLog(path.join(homeOf(coworkersDir, slug), REFERRALS_LOG_FILE)));
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Record a teammate this coworker proposed; the person's answer is appended later. */
export async function recordSuggestion(coworkersDir, slug, suggestion, { now = Date.now() } = {}) {
  const entry = { id: newId("sug"), at: now, by: slug, state: "offered", ...suggestion };
  await appendLog(path.join(homeOf(coworkersDir, slug), SUGGESTIONS_LOG_FILE), entry);
  return entry;
}

/** Record work this coworker offered to hand over; the person's choice is appended later. */
export async function recordReferral(coworkersDir, slug, referral, { now = Date.now() } = {}) {
  const entry = { id: newId("ref"), at: now, from: slug, state: "offered", ...referral };
  await appendLog(path.join(homeOf(coworkersDir, slug), REFERRALS_LOG_FILE), entry);
  return entry;
}

const SUGGESTION_STATES = new Set(["offered", "accepted", "declined"]);
const REFERRAL_STATES = new Set(["offered", "asked", "continued"]);

export async function setSuggestionState(coworkersDir, slug, id, state, { now = Date.now(), createdSlug = "" } = {}) {
  if (!SUGGESTION_STATES.has(state)) throw new Error(`Unknown suggestion state: ${state}`);
  const current = (await readSuggestions(coworkersDir, slug)).find((entry) => entry.id === id);
  if (!current) throw new Error("That suggestion is not on record.");
  await appendLog(path.join(homeOf(coworkersDir, slug), SUGGESTIONS_LOG_FILE), { id, at: now, state, ...(createdSlug ? { createdSlug } : {}) });
  return { ...current, state, stateAt: now, ...(createdSlug ? { createdSlug } : {}) };
}

export async function setReferralState(coworkersDir, slug, id, state, { now = Date.now() } = {}) {
  if (!REFERRAL_STATES.has(state)) throw new Error(`Unknown referral state: ${state}`);
  const current = (await readReferrals(coworkersDir, slug)).find((entry) => entry.id === id);
  if (!current) throw new Error("That hand-over is not on record.");
  await appendLog(path.join(homeOf(coworkersDir, slug), REFERRALS_LOG_FILE), { id, at: now, state });
  return { ...current, state, stateAt: now };
}

/** Both logs, folded, for the view to restore card states across a reload. */
export async function teamStates(coworkersDir, slug) {
  const [suggestions, referrals] = await Promise.all([readSuggestions(coworkersDir, slug), readReferrals(coworkersDir, slug)]);
  return {
    suggestions: suggestions.map((entry) => ({ id: entry.id, state: entry.state, at: entry.stateAt, createdSlug: typeof entry.createdSlug === "string" ? entry.createdSlug : "" })),
    referrals: referrals.map((entry) => ({ id: entry.id, state: entry.state, at: entry.stateAt })),
  };
}

function sameDay(a, b) {
  const first = new Date(a);
  const second = new Date(b);
  return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth() && first.getDate() === second.getDate();
}

/**
 * Whether a coworker may propose this role now. In order: a teammate already
 * covers it; the person declined it recently; this coworker already proposed
 * someone today; otherwise fine.
 */
export function suggestionGuard({ role, team, suggestions, now = Date.now() }) {
  const existing = matchesExisting(role, team);
  if (existing) return { kind: "existing", teammate: existing };
  const catalog = roleById(role);
  const wanted = catalog ? catalog.id : tokens(role).join(" ");
  const declined = (suggestions ?? [])
    .filter((entry) => entry.state === "declined" && now - entry.stateAt <= DECLINE_QUIET_DAYS * DAY_MS)
    .find((entry) => (catalog ? entry.roleId === catalog.id : tokens(entry.role).join(" ") === wanted));
  if (declined) return { kind: "declined", at: declined.stateAt };
  const today = (suggestions ?? []).filter((entry) => sameDay(entry.at, now)).length;
  if (today >= SUGGESTIONS_PER_DAY) return { kind: "daily" };
  return { kind: "ok" };
}

/** The person's request as compared between hand-overs: case, spacing, and trailing punctuation do not make it a new request. */
export function sameRequest(left, right) {
  const norm = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?…]+$/, "").trim();
  const a = norm(left);
  return a !== "" && a === norm(right);
}

/**
 * Whether a coworker may offer to hand this request over now. Once the person
 * has answered an offer for the same request with "continue" (keep the coworker
 * on it), the same request is never offered again — the contract says so, and
 * the handler holds the line for a model that forgets.
 */
export function referralGuard({ message, referrals }) {
  const kept = (referrals ?? [])
    .filter((entry) => entry.state === "continued" && sameRequest(entry.message, message))
    .sort((a, b) => b.stateAt - a.stateAt)[0];
  if (kept) return { kind: "kept", at: kept.stateAt };
  return { kind: "ok" };
}

/**
 * Write one coworker's description from the current team; returns whether the
 * file changed. Called by the store after every team change and on launch.
 */
export async function writeTeamRoster(coworkersDir, self, coworkers, { now = Date.now() } = {}) {
  const target = path.join(homeOf(coworkersDir, self.slug), TEAM_ROSTER_FILE);
  const declined = await readSuggestions(coworkersDir, self.slug).catch(() => []);
  const next = rosterFor(self, coworkers, declined, { now });
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch {
    current = "";
  }
  if (current === next) return false;
  await writeAtomic(target, next);
  return true;
}

/** Refresh every coworker's description after the team changed. Best effort per coworker. */
export async function refreshTeamRosters(coworkersDir, coworkers, options = {}) {
  const changed = [];
  for (const coworker of coworkers) {
    try {
      if (await writeTeamRoster(coworkersDir, coworker, coworkers, options)) changed.push(coworker.slug);
    } catch {
      // A coworker whose home is mid-move keeps its last description.
    }
  }
  return changed;
}
