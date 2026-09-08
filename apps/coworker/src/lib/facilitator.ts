/**
 * The silent facilitator of a group chat. Once per message from the person it
 * decides who answers, in what order, and how the replies relate, as one strict
 * JSON object; it never speaks in the group and nobody sees its words. It runs
 * in the hidden coordinator workspace with no tools, on the model the person's
 * coworkers already use. When it cannot decide — an unavailable model, an
 * answer that will not validate even after one repair, a timeout — the
 * deterministic scorer in `groups.ts` decides instead, silently.
 */
import { z } from "zod";
import type { CoworkerGroupTurn, CoworkerSummary, GroupTimelineEvent } from "./bridge.ts";
import { MAX_SPEAKERS_PER_TURN, RECENT_CONTEXT_EVENTS, type GroupParticipant, type Mentions, type RoutingPlan } from "./groups.ts";
import { parseModelPreference, recommendModel, type EngineModelCatalog, type EngineModelOption } from "./threads.ts";

/** The whole routing pass, repair and second model included, fits in this; then the scorer decides. */
export const ROUTING_TIMEOUT_MS = 45_000;
/** How many earlier turns' speaker orders the facilitator is reminded of. */
export const EARLIER_ORDERS = 5;
const MAX_LINE_CHARS = 400;

export type FacilitatorMember = GroupParticipant & { busy: boolean };

const routingResponse = z.object({
  speakers: z.array(z.object({ slug: z.string(), brief: z.string().max(400).default("") })).min(1),
  mode: z.enum(["sequential", "parallel"]).default("sequential"),
  dependsOn: z.array(z.tuple([z.string(), z.string()])).default([]),
  followUp: z.object({ slug: z.string(), brief: z.string().max(400).default("") }).nullable().default(null),
  synthesizer: z.string().nullable().default(null),
});

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat;
}

/** The speaking orders of the last few turns, as slugs, oldest first. */
export function earlierSpeakerOrders(turns: readonly CoworkerGroupTurn[], limit = EARLIER_ORDERS): string[][] {
  return turns
    .slice(-limit)
    .map((turn) => turn.speakers.filter((speaker) => speaker.part === "reply").map((speaker) => speaker.slug))
    .filter((order) => order.length > 0);
}

function constraintLine(mentions: Mentions, members: readonly FacilitatorMember[]): string {
  if (mentions.everyone) return `Constraint: the person asked everyone. Include every member (${members.map((member) => member.slug).join(", ")}) exactly once, in the best speaking order.`;
  if (mentions.slugs.length === 1) return `Constraint: the person named ${mentions.slugs[0]}. The speakers must be exactly that one coworker.`;
  if (mentions.slugs.length > 1) return `Constraint: the person named ${mentions.slugs.join(", ")}. The speakers must be exactly these coworkers, in the best speaking order.`;
  return `Constraint: nobody was named. Choose one coworker unless the message clearly needs two or three; never more than ${MAX_SPEAKERS_PER_TURN}.`;
}

/** Everything the facilitator is told for one routing pass. */
export function facilitatorPrompt(input: {
  group: { name: string };
  members: readonly FacilitatorMember[];
  recent: readonly GroupTimelineEvent[];
  earlierOrders: readonly string[][];
  message: string;
  mentions: Mentions;
  nameFor: (slug: string) => string;
}): string {
  const lines = [
    `You are the facilitator of the group chat "${input.group.name}". Decide who should answer the person's latest message and in what order. You never answer the person yourself and never add words of your own to the chat.`,
    "",
    "Members:",
  ];
  for (const member of input.members) {
    const role = member.role.trim() ? `, ${member.role.trim()}` : "";
    const mission = member.mission.trim() ? ` Mission: ${clip(member.mission)}` : "";
    lines.push(`- ${member.slug} — ${member.name}${role}.${mission} (${member.busy ? "busy replying in another group" : "available"})`);
  }
  const recent = input.recent.filter((event) => event.kind === "user" || event.kind === "coworker").slice(-RECENT_CONTEXT_EVENTS);
  if (recent.length > 0) {
    lines.push("", "Recent conversation, oldest first:");
    for (const event of recent) lines.push(`- ${event.kind === "user" ? "Person" : input.nameFor(event.slug ?? "")}: ${clip(event.text)}`);
  }
  if (input.earlierOrders.length > 0) {
    lines.push("", `Earlier messages were answered in this order: ${input.earlierOrders.map((order) => order.join(" → ")).join("; ")}.`);
  }
  lines.push(
    "",
    `The person's message: ${input.message.trim()}`,
    constraintLine(input.mentions, input.members),
    "",
    "Reply with one JSON object only, no other text, in exactly this shape:",
    '{"speakers":[{"slug":"<member slug>","brief":"<one sentence on what this coworker alone should cover>"}],"mode":"sequential","dependsOn":[],"followUp":null,"synthesizer":null}',
    "",
    "Rules:",
    `- speakers: in speaking order, slugs from the member list only, no duplicates, at most ${MAX_SPEAKERS_PER_TURN} unless everyone was asked. Prefer one; prefer available members.`,
    "- brief: one sentence on what that coworker should cover, not what the others cover.",
    '- mode: "parallel" only when the replies do not depend on one another; otherwise "sequential".',
    '- dependsOn: pairs ["later slug","earlier slug"] when a later speaker should build on an earlier reply; the earlier one must speak first.',
    "- followUp: at most one {\"slug\",\"brief\"} when one coworker should respond to another after the first round; otherwise null.",
    "- synthesizer: one slug only when a two-sentence wrap-up of several replies would help the person; otherwise null.",
  );
  return lines.join("\n");
}

export function repairPrompt(problem: string): string {
  return `Your last answer was not accepted: ${problem} Reply again with one JSON object only, in the required shape, and nothing else.`;
}

/** The first JSON object in a reply, fences and prose around it ignored. */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("The reply contained no JSON object.");
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    throw new Error("The reply was not valid JSON.");
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

/**
 * Turn a raw facilitator answer into a plan the group can run, or throw with
 * the plain reason so the facilitator gets one chance to repair it. Unknown or
 * duplicate coworkers, the wrong count, a set that ignores the person's
 * mentions, and dependencies pointing the wrong way are all rejected.
 */
export function validateRoutingPlan(raw: unknown, context: { participants: readonly GroupParticipant[]; mentions: Mentions }): RoutingPlan {
  const parsed = routingResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the JSON did not match the shape (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}).`);
  }
  const known = new Set(context.participants.map((participant) => participant.slug));
  const slugs = parsed.data.speakers.map((speaker) => speaker.slug.trim().toLowerCase());
  const unknown = slugs.filter((slug) => !known.has(slug));
  if (unknown.length > 0) throw new Error(`these are not members of the group: ${unknown.join(", ")}.`);
  if (new Set(slugs).size !== slugs.length) throw new Error("a coworker was listed twice among the speakers.");
  if (context.mentions.everyone) {
    if (!sameSet(slugs, [...known])) throw new Error("the person asked everyone, so every member must speak exactly once.");
  } else if (context.mentions.slugs.length > 0) {
    if (!sameSet(slugs, context.mentions.slugs)) throw new Error(`the person named ${context.mentions.slugs.join(", ")}, so the speakers must be exactly those.`);
  } else if (slugs.length > MAX_SPEAKERS_PER_TURN) {
    throw new Error(`at most ${MAX_SPEAKERS_PER_TURN} coworkers may answer one message.`);
  }
  const dependsOn: [string, string][] = [];
  for (const [later, earlier] of parsed.data.dependsOn) {
    const laterIndex = slugs.indexOf(later.trim().toLowerCase());
    const earlierIndex = slugs.indexOf(earlier.trim().toLowerCase());
    if (laterIndex === -1 || earlierIndex === -1) throw new Error("dependsOn names a coworker who is not among the speakers.");
    if (earlierIndex >= laterIndex) throw new Error("in dependsOn the earlier speaker must come before the later one.");
    dependsOn.push([slugs[laterIndex] ?? later, slugs[earlierIndex] ?? earlier]);
  }
  const followUpSlug = parsed.data.followUp?.slug.trim().toLowerCase() ?? "";
  if (followUpSlug && !known.has(followUpSlug)) throw new Error(`followUp names ${followUpSlug}, who is not a member of the group.`);
  const synthesizer = parsed.data.synthesizer?.trim().toLowerCase() ?? "";
  if (synthesizer && !known.has(synthesizer)) throw new Error(`synthesizer names ${synthesizer}, who is not a member of the group.`);
  return {
    speakers: parsed.data.speakers.map((speaker, index) => ({ slug: slugs[index] ?? speaker.slug, brief: speaker.brief.trim() })),
    mode: dependsOn.length > 0 ? "sequential" : parsed.data.mode,
    dependsOn,
    followUp: followUpSlug ? { slug: followUpSlug, brief: parsed.data.followUp?.brief.trim() ?? "" } : null,
    synthesizer: synthesizer || null,
    routedBy: "facilitator",
  };
}

/**
 * Which connected model the facilitator uses. "Automatic" is the model the
 * group's coworkers already use — an account model first — and the second
 * choice is the next such model, so one unavailable provider does not decide
 * the routing. A model the person chose for the group comes first.
 */
export function facilitatorModels(
  catalog: Pick<EngineModelCatalog, "models">,
  members: readonly Pick<CoworkerSummary, "model">[],
  preferred = "",
): { primary: EngineModelOption | null; secondary: EngineModelOption | null } {
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const ordered: EngineModelOption[] = [];
  const add = (model: EngineModelOption | null | undefined) => {
    if (model && !ordered.some((item) => item.id === model.id)) ordered.push(model);
  };
  add(parseModelPreference(preferred) ? byId.get(preferred.trim()) : null);
  const used = members.map((member) => byId.get(member.model.trim())).filter((model): model is EngineModelOption => Boolean(model));
  const counts = new Map<string, number>();
  for (const model of used) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  const distinct = [...new Map(used.map((model) => [model.id, model])).values()].sort(
    (left, right) => Number(right.source === "cloud") - Number(left.source === "cloud") || (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0),
  );
  for (const model of distinct) add(model);
  add(recommendModel(catalog, { exclude: ordered.map((model) => model.id) }));
  add(recommendModel(catalog, { exclude: ordered.map((model) => model.id) }));
  return { primary: ordered[0] ?? null, secondary: ordered[1] ?? null };
}

export type FacilitatorAsk = (prompt: string, model: EngineModelOption, signal: AbortSignal) => Promise<string>;

/**
 * One routing pass: ask, validate, feed one rejection back for repair, and if
 * that still fails try once more on the next model. Resolves null when nothing
 * usable came back, so the caller falls back to the deterministic scorer.
 */
export async function routeWithFacilitator(input: {
  prompt: string;
  participants: readonly GroupParticipant[];
  mentions: Mentions;
  models: { primary: EngineModelOption | null; secondary: EngineModelOption | null };
  ask: FacilitatorAsk;
  signal: AbortSignal;
  onAttempt?: (detail: { model: string; outcome: "accepted" | "repaired" | "rejected" | "failed"; reason: string }) => void;
}): Promise<RoutingPlan | null> {
  const context = { participants: input.participants, mentions: input.mentions };
  const attempt = async (model: EngineModelOption): Promise<RoutingPlan | null> => {
    let first: string;
    try {
      first = await input.ask(input.prompt, model, input.signal);
    } catch (cause) {
      input.onAttempt?.({ model: model.id, outcome: "failed", reason: cause instanceof Error ? cause.message : String(cause) });
      return null;
    }
    try {
      const plan = validateRoutingPlan(extractJson(first), context);
      input.onAttempt?.({ model: model.id, outcome: "accepted", reason: "" });
      return plan;
    } catch (problem) {
      const reason = problem instanceof Error ? problem.message : String(problem);
      try {
        const second = await input.ask(repairPrompt(reason), model, input.signal);
        const plan = validateRoutingPlan(extractJson(second), context);
        input.onAttempt?.({ model: model.id, outcome: "repaired", reason });
        return plan;
      } catch (again) {
        input.onAttempt?.({ model: model.id, outcome: "rejected", reason: again instanceof Error ? again.message : String(again) });
        return null;
      }
    }
  };
  for (const model of [input.models.primary, input.models.secondary]) {
    if (!model || input.signal.aborted) continue;
    const plan = await attempt(model);
    if (plan) return plan;
  }
  return null;
}
