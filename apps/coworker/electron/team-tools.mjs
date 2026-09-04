/**
 * The coworker's own tools for its team, served on the same loopback MCP server
 * as its documents, Workers, assignments, and memory (`coworker-tools.mjs`):
 * who else is on the team, offering to hand a request to a teammate, and
 * proposing a new teammate. Handlers take the slug the request's token resolved
 * to — never a coworker from the model — and answer in plain words plus the
 * fields the card in the conversation shows.
 *
 * Nothing here changes the team. A referral or a suggestion is an offer the
 * person answers with a tap; only that tap, in the main process, creates a
 * coworker or moves work. The guards a coworker's contract describes are
 * enforced here as well, so a model that ignores its instructions still cannot
 * propose a duplicate, nag after a decline, or propose twice in a day.
 *
 * No Electron imports: exercised by `node --test electron/team-tools.test.mjs`.
 */
import { TEAM_TOOL_NAMES } from "../src/lib/coworker-tools.ts";
import { listCoworkers } from "./coworkers.mjs";
import { MemoryError } from "./self-memory.mjs";
import {
  pickAvatarColor,
  readSuggestions,
  recordReferral,
  recordSuggestion,
  roleById,
  rosterFor,
  slugOf,
  suggestionGuard,
  uniqueName,
} from "./team.mjs";

const MESSAGE_LIMIT = 500;
const WHY_LIMIT = 160;
const ROLE_LIMIT = 40;
const NAME_LIMIT = 40;
const MISSION_LIMIT = 200;

/** The team tools as the engine lists them; names match `src/lib/coworker-tools.ts`. */
export function teamToolCatalog() {
  return [
    {
      name: "team_list",
      description: "Who is on the team besides you: name, role, and mission, one line each, plus the roles the person recently declined.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "team_refer",
      description: [
        "Offer to pass the person's request to the teammate whose job it is. Call it before doing the work, when the request is clearly theirs and more than a quick answer; then reply with one short sentence and stop — the person chooses whether to pass it or keep you on it.",
        "Never in a group chat, and never for a teammate who is not on the team.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "The teammate's name or id from your team description." },
          message: { type: "string", description: "The person's request, in their own words." },
          why: { type: "string", description: "One sentence on why this teammate is the better fit." },
        },
        required: ["to", "message", "why"],
        additionalProperties: false,
      },
    },
    {
      name: "team_suggest",
      description: [
        "Propose a new teammate when the person keeps asking for work nobody on the team covers, or asks who could do something. Give the role (a catalog id — research, writing, operations, support, sales, product — or a few words for another role), a one-sentence mission, and why.",
        "The answer tells you when a teammate already covers it, when the person declined it recently, or when you already proposed someone today; otherwise the person sees a card and decides. Reply with one short sentence and stop.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string", description: "A catalog id or a few words for the role." },
          mission: { type: "string", description: "One sentence, in the new coworker's voice: what it would own." },
          why: { type: "string", description: "One sentence on what made you propose it." },
          name: { type: "string", description: "Optional. A short first name; a unique one is chosen when left out." },
        },
        required: ["role", "mission", "why"],
        additionalProperties: false,
      },
    },
  ];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value, limit) {
  const single = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** What a card shows about a teammate: identity and look, never their memory or files. */
function teammateCard(coworker) {
  return {
    slug: coworker.slug,
    name: coworker.name,
    role: coworker.role,
    mission: coworker.mission,
    avatarColor: coworker.avatarColor,
    avatarGlasses: coworker.avatarGlasses,
    roleId: coworker.roleId ?? "",
  };
}

function roleWord(entry) {
  const catalog = roleById(entry.roleId) ?? roleById(entry.role);
  if (catalog) return catalog.role.toLowerCase();
  return String(entry.role ?? "").trim().toLowerCase() || "that";
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function shortDate(at) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A first name for a proposed coworker: the model's when valid and free, else the catalog's, else from the role's words. */
function nameFor({ proposed, catalog, roleText, takenSlugs }) {
  const wanted = text(proposed, NAME_LIMIT);
  if (wanted && !takenSlugs.has(slugOf(wanted))) return wanted;
  if (catalog) return uniqueName(catalog.id, takenSlugs);
  const first = titleCase(roleText.split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9-]/g, "") || "Coworker";
  if (!takenSlugs.has(slugOf(first))) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    if (!takenSlugs.has(slugOf(`${first} ${attempt}`))) return `${first} ${attempt}`;
  }
  return `${first} ${Date.now()}`;
}

const VERBS = {
  team_list: "check the team",
  team_refer: "offer to pass this on",
  team_suggest: "suggest a teammate",
};

function relayFailures(name, handler) {
  return async (slug, args) => {
    try {
      return await handler(slug, isRecord(args) ? args : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const plain = error instanceof MemoryError || /required|not found|not on the team/i.test(message);
      throw new Error(`Couldn't ${VERBS[name] ?? "do that"}: ${plain ? message : message || "something went wrong on this Mac"}`);
    }
  };
}

/** Team handlers bound to the main process: `coworkersDir` and, for tests, `now()`. */
export function createTeamToolHandlers({ coworkersDir, now = () => Date.now() }) {
  const teamOf = async (slug) => {
    const coworkers = await listCoworkers(coworkersDir);
    const self = coworkers.find((coworker) => coworker.slug === slug);
    if (!self) throw new MemoryError("Open Coworker does not know which coworker you are right now. Try again in a moment.");
    return { coworkers, self };
  };
  const findTeammate = (coworkers, wanted) => {
    const needle = wanted.toLowerCase();
    return coworkers.find((coworker) => coworker.slug === slugOf(wanted) || coworker.name.toLowerCase() === needle) ?? null;
  };

  const handlers = {
    team_list: async (slug) => {
      const { coworkers, self } = await teamOf(slug);
      const declined = await readSuggestions(coworkersDir, slug);
      return {
        text: rosterFor(self, coworkers, declined, { now: now() }),
        structured: { team: coworkers.filter((coworker) => coworker.slug !== slug).map(teammateCard) },
      };
    },
    team_refer: async (slug, args) => {
      const to = text(args.to, NAME_LIMIT);
      const message = text(args.message, MESSAGE_LIMIT);
      const why = text(args.why, WHY_LIMIT);
      if (!to) throw new MemoryError("Say which teammate, by name or id from your team description.");
      if (!message) throw new MemoryError("Include the person's request in their own words.");
      if (!why) throw new MemoryError("Say in one sentence why this teammate is the better fit.");
      const { coworkers } = await teamOf(slug);
      const teammate = findTeammate(coworkers, to);
      if (!teammate) throw new MemoryError(`Nobody on the team is called "${to}". team_list shows who is here; if the role is missing, propose a teammate instead.`);
      if (teammate.slug === slug) throw new MemoryError("That is you. Do the work yourself, or propose a teammate if nobody covers it.");
      const referral = await recordReferral(coworkersDir, slug, { to: teammate.slug, message, why }, { now: now() });
      return {
        text: `Offered to pass this to ${teammate.name}. Reply with one short sentence and stop — the person chooses.`,
        structured: { referral: { id: referral.id, to: teammateCard(teammate), message, why } },
      };
    },
    team_suggest: async (slug, args) => {
      const roleText = text(args.role, ROLE_LIMIT);
      const mission = text(args.mission, MISSION_LIMIT);
      const why = text(args.why, WHY_LIMIT);
      if (!roleText) throw new MemoryError("Say what role the new teammate would have.");
      if (!why) throw new MemoryError("Say in one sentence what made you propose it.");
      const { coworkers, self } = await teamOf(slug);
      const suggestions = await readSuggestions(coworkersDir, slug);
      const guard = suggestionGuard({ role: roleText, team: coworkers, suggestions, now: now() });
      const catalog = roleById(roleText);
      if (guard.kind === "existing") {
        const teammate = guard.teammate;
        const word = roleWord({ roleId: catalog?.id ?? teammate.roleId, role: catalog ? roleText : teammate.role });
        if (teammate.slug === slug) {
          return { text: `That is your own job — ${word} is what you cover. Do the work yourself.`, structured: { existing: teammateCard(self), self: true } };
        }
        return {
          text: `${teammate.name} already covers ${word}. Offer to pass it to them with coworker_team_refer instead.`,
          structured: { existing: teammateCard(teammate) },
        };
      }
      if (guard.kind === "declined") {
        return {
          text: `The person said not now to a ${roleWord({ roleId: catalog?.id ?? "", role: roleText })} coworker on ${shortDate(guard.at)}. Don't bring it up unless they ask.`,
          structured: { declined: { at: guard.at } },
        };
      }
      if (guard.kind === "daily") {
        return { text: "You already suggested a teammate today. Answer the request as best you can.", structured: { limit: "daily" } };
      }
      const takenSlugs = new Set(coworkers.map((coworker) => coworker.slug));
      const name = nameFor({ proposed: args.name, catalog, roleText, takenSlugs });
      const proposal = {
        roleId: catalog?.id ?? "",
        role: catalog ? catalog.role : titleCase(roleText),
        name,
        mission: mission || catalog?.mission || "",
        why,
        avatarColor: pickAvatarColor(coworkers.map((coworker) => coworker.avatarColor), catalog?.avatarColor ?? "blue"),
        avatarGlasses: catalog?.avatarGlasses ?? "round",
        personality: catalog?.personality ?? "neutral",
      };
      if (!proposal.mission) throw new MemoryError("Give the new teammate a one-sentence mission.");
      const recorded = await recordSuggestion(coworkersDir, slug, proposal, { now: now() });
      return {
        text: `Suggested ${name} for ${roleWord({ roleId: proposal.roleId, role: proposal.role })}. Reply with one short sentence and stop — the person decides whether to add them.`,
        structured: { suggestion: { id: recorded.id, by: slug, ...proposal } },
      };
    },
  };
  return Object.fromEntries(TEAM_TOOL_NAMES.map((name) => [name, relayFailures(name, handlers[name])]));
}
