import {
  openworkModelSelectorSchema,
  openworkModelsListArgsSchema,
  type OpenworkAffordanceArgument,
  type OpenworkAffordanceDescriptor,
  type OpenworkAffordanceEffects,
  type OpenworkProviderRef,
} from "@openwork/types/openwork-affordance";
import type {
  OpenworkFeatureContribution,
  OpenworkGuidanceDescriptor,
} from "@openwork/types/openwork-provider";
import { z } from "zod";

/**
 * An affordance's argument object. Keys it does not define are refused with
 * the valid names, so a wrong name (`limit` for `count`) fails loudly instead
 * of being dropped and silently falling back to a default.
 */
export function strictArgsSchema<Shape extends z.ZodRawShape>(shape: Shape) {
  const valid = Object.keys(shape).join(", ");
  return z.strictObject(shape, {
    error: (issue) => issue.code === "unrecognized_keys"
      ? `Unknown argument${issue.keys.length === 1 ? "" : "s"} ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}. Valid arguments: ${valid}.`
      : undefined,
  });
}

// Epoch milliseconds or an ISO-8601 string; resolve with sessionTimestampMs.
const sessionTimestampArgSchema = z.union([z.number().int().nonnegative(), z.string().trim().min(1)])
  .refine((value) => typeof value === "number" || Number.isFinite(Date.parse(value)), {
    message: "Expected epoch milliseconds or an ISO-8601 date string.",
  });

export function sessionTimestampMs(value: z.infer<typeof sessionTimestampArgSchema>): number {
  return typeof value === "number" ? value : Date.parse(value);
}

export const sessionSearchArgsSchema = strictArgsSchema({
  query: z.string().trim().min(1).describe("Text to search for across OpenWork session titles and message transcripts."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name to limit the search."),
  limit: z.number().int().positive().max(20).optional().describe("Maximum matching sessions to return. Defaults to 10, max 20."),
  scanLimit: z.number().int().positive().max(500).optional().describe("Maximum newest sessions whose transcripts are scanned across matching workspaces; every root session's title is matched regardless. Defaults to 100, max 500."),
  messageLimit: z.number().int().positive().max(1000).optional().describe("Maximum recent messages to load per scanned session. Defaults to 400, max 1000."),
  match: z.enum(["all", "any", "phrase"]).optional().describe("all (default): every whitespace-separated term must appear; any: one term suffices; phrase: the exact query text must appear."),
  createdAfter: sessionTimestampArgSchema.optional().describe("Only sessions created at or after this time (epoch milliseconds or ISO-8601 string)."),
  createdBefore: sessionTimestampArgSchema.optional().describe("Only sessions created at or before this time (epoch milliseconds or ISO-8601 string)."),
  archived: z.enum(["include", "exclude", "only"]).optional().describe("Archived sessions: include (default), exclude, or only."),
});

export const sessionReadArgsSchema = strictArgsSchema({
  sessionId: z.string().trim().min(1).describe("OpenWork/OpenCode session ID returned by session.search."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
  count: z.number().int().positive().max(100).optional().describe("Number of transcript messages to return. Defaults to 30, max 100."),
  from: z.enum(["start", "end"]).optional().describe("end (default): the last `count` messages; start: the first `count` messages."),
  summary: z.boolean().optional().describe("When true, return only the first user message and the last assistant message plus session metadata."),
});

export const sessionModelArgSchema = openworkModelSelectorSchema;

export const sessionCreateArgsSchema = strictArgsSchema({
  sessions: z.array(z.object({
    title: z.string().trim().min(1).transform((title) => title.length > 120 ? `${title.slice(0, 119)}…` : title).describe("Short title shown in the OpenWork session list."),
    prompt: z.string().trim().min(1).max(100_000).describe("Self-contained task to start in the new session."),
    model: sessionModelArgSchema.optional().describe("Model and reasoning effort for this session. Overrides the top-level model."),
  })).min(1).describe("One entry per new session to create and start."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Defaults to the workspace containing the current session."),
  model: sessionModelArgSchema.optional().describe("Model and reasoning effort for every created session unless an entry overrides it. Omit to use the engine default."),
});

export const sessionSendArgsSchema = strictArgsSchema({
  sessionId: z.string().trim().min(1).describe("Session ID of the existing session to message, from session.search, session.read, or session.list_sessions."),
  text: z.string().trim().min(1).max(100_000).describe("Prompt text appended to that session as a new user message."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
  reveal: z.boolean().optional().describe("true to also open that session in the person's focused pane after sending. Defaults to false: nothing on screen changes."),
});

/** The engine permission a person answers before the agent answers another session's question for them. */
export const SESSION_QUESTION_ANSWER_PERMISSION = "openwork_session_question_answer";

const sessionQuestionListArgsShape = {
  sessionId: z.string().trim().min(1).describe("Session ID from session.search or session.read."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
};

export const sessionQuestionListArgsSchema = strictArgsSchema(sessionQuestionListArgsShape);

// Built from the shape, not extended: an extended schema keeps the list of valid names it was made with.
export const sessionQuestionAnswerArgsSchema = strictArgsSchema({
  ...sessionQuestionListArgsShape,
  requestId: z.string().trim().min(1).describe("Pending question id from session.question.list."),
  answers: z.array(z.array(z.string().trim().min(1).max(10_000)).min(1).max(50)).min(1).max(20)
    .describe("One array per question, in order: the chosen option labels, or the person's own text where the question allows it."),
});

/** Argument schemas by affordance id; sessionContribution must advertise exactly these keys. */
export const sessionAffordanceArgsSchemas = {
  "models.list": openworkModelsListArgsSchema,
  "session.search": sessionSearchArgsSchema,
  "session.read": sessionReadArgsSchema,
  "session.create": sessionCreateArgsSchema,
  "session.send": sessionSendArgsSchema,
  "session.question.list": sessionQuestionListArgsSchema,
  "session.question.answer": sessionQuestionAnswerArgsSchema,
};

export type ConnectSkillDescriptor = {
  name: string;
  title?: string;
  description: string;
  capability: string;
};

export type EngineMcpDescriptor = {
  name: string;
  status?: string;
};

const noEffects: OpenworkAffordanceEffects = {
  data: "none",
  ui: "none",
  external: false,
};
const readEffects: OpenworkAffordanceEffects = {
  data: "read",
  ui: "none",
  external: false,
};
const writeEffects: OpenworkAffordanceEffects = {
  data: "write",
  ui: "none",
  external: false,
};

function argument(
  name: string,
  type: OpenworkAffordanceArgument["type"],
  required: boolean,
  description: string,
): OpenworkAffordanceArgument {
  return { name, type, required, description };
}

function affordance(input: {
  id: string;
  kind: "query" | "command";
  title: string;
  description: string;
  provider: OpenworkProviderRef;
  arguments?: OpenworkAffordanceArgument[];
  effects?: OpenworkAffordanceEffects;
  tool?: string;
}): OpenworkAffordanceDescriptor {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    description: input.description,
    provider: input.provider,
    arguments: input.arguments ?? [],
    effects: input.effects ?? noEffects,
    confirmation: "never",
    availability: { enabled: true },
    executor: input.tool
      ? { kind: "tool", tool: input.tool }
      : { kind: "openwork" },
  };
}

function sessionContribution(): OpenworkFeatureContribution {
  const provider: OpenworkProviderRef = { id: "openwork-server", kind: "builtin" };
  return {
    featureId: "sessions",
    provider,
    affordances: [
      affordance({
        id: "models.list",
        kind: "query",
        title: "List workspace models",
        description: "Return effective available connected picker models with providerId/modelId, displayName, providerName and available:true. Requires an existing renderer host via the UI query bridge, including headless callers; never focuses or navigates. Assigned models not yet engine-connected are omitted.",
        provider,
        arguments: [argument("workspaceId", "string", true, "Workspace id or name whose available models to list.")],
        effects: readEffects,
      }),
      affordance({
        id: "session.search",
        kind: "query",
        title: "Find sessions",
        description: "Search session titles and transcripts without changing the visible workbench. Every root session's title is matched; transcripts are scanned for the `scanLimit` newest sessions only, so when the result's `truncated` is true, retry with a larger `scanLimit` (max 500). Title and phrase matches rank first, then newest `updatedAt`. Each result carries `createdAt`, `archived`, `parentId` and `engine` (v1 or v2, the engine that holds the session).",
        provider,
        arguments: [
          argument("query", "string", true, "Text to find in session titles or messages."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
          argument("limit", "number", false, "Maximum matching sessions to return. Defaults to 10, max 20."),
          argument("scanLimit", "number", false, "Maximum newest sessions whose transcripts are scanned across matching workspaces; every root session's title is matched regardless. Defaults to 100, max 500."),
          argument("messageLimit", "number", false, "Maximum recent messages to load per scanned session. Defaults to 400, max 1000."),
          argument("match", "string", false, "all (default): every whitespace-separated term must appear; any: one term suffices; phrase: the exact query text must appear."),
          argument("createdAfter", "unknown", false, "Only sessions created at or after this time (epoch milliseconds or ISO-8601 string)."),
          argument("createdBefore", "unknown", false, "Only sessions created at or before this time (epoch milliseconds or ISO-8601 string)."),
          argument("archived", "string", false, "Archived sessions: include (default), exclude, or only."),
        ],
        effects: readEffects,
      }),
      affordance({
        id: "session.read",
        kind: "query",
        title: "Read a session transcript",
        description: "Read messages from a session without opening it. Finds the session on either engine. The result also carries `engine` (v1 or v2), `createdAt`, `archived`, `parentId`, `status` (idle, busy, retry, waiting), `working` (check it before session.archive), and `model` ({ providerId, modelId, variant, displayName?, providerName? } the session is bound to, variant being its reasoning effort; null before a model is bound). Pass `summary: true` to get only the first user message and the last assistant message (what was asked, what was concluded) in one call. Both modes include `lastError` ({ code, message } or null) from the latest assistant info.error before text filtering: end reads inspect only the fetched newest `count` messages; start/summary inspect the whole transcript, even outside displayed text. Null means no assistant error observed in that window; a later assistant without an error clears it. Codes are allowlisted error names (otherwise UnknownError); messages are fixed labels under 160 characters, never arbitrary provider details. Snapshot errors only: event-only failures, including pre-assistant model-not-found, are not observable here.",
        provider,
        arguments: [
          argument("sessionId", "string", true, "Session id returned by session.search."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
          argument("count", "number", false, "Number of messages to return. Defaults to 30, max 100."),
          argument("from", "string", false, "end (default): the last `count` messages; start: the first `count` messages."),
          argument("summary", "boolean", false, "When true, return only the first user and last assistant messages plus metadata."),
        ],
        effects: readEffects,
      }),
      affordance({
        id: "session.create",
        kind: "command",
        title: "Create sessions",
        description: "Create and start one or more sessions without navigating away. Pass `model` with providerId/modelId or alias/displayName (exact case-insensitive picker name, optional providerId qualifier), plus variant for reasoning effort. models.list discovers available models through an existing renderer host, required for model selection even from headless callers; no focus or navigation. All models resolve before creation; missing host, unavailable or ambiguous models are rejected. Returned bindings round-trip by ids; displayName/providerName are decorations when ids are present, but alias plus modelId is invalid. Results include model ids and optional displayName/providerName, also returned by session.read and session.list_sessions.",
        provider,
        arguments: [
          argument("sessions", "array", true, "Array of { title (≤120 chars, longer is clipped), prompt (≤100000 chars), model? }. Each prompt is self-contained; model is { providerId, modelId, variant? (≤60 chars) } or { alias/displayName, providerId?, variant? (≤60 chars) }."),
          argument("workspaceId", "string", false, "Optional workspace id or name. Defaults to the requesting session's workspace."),
          argument("model", "object", false, "Optional providerId/modelId or alias/displayName (exact case-insensitive name, optional providerId qualifier) and variant (reasoning effort, ≤60 chars) for every created session. Omit to use the engine default."),
        ],
        effects: writeEffects,
      }),
      affordance({
        id: "session.send",
        kind: "command",
        title: "Send a prompt to a session",
        description: "Append a prompt to an existing session by id without opening it. The message is written immediately; a session that is mid-turn handles it at its next step. Nothing on screen changes unless reveal is true. This is the way to talk to another session: composer.set_text and composer.send only reach the composer the person has focused.",
        provider,
        arguments: [
          argument("sessionId", "string", true, "Session id from session.search, session.read, or session.list_sessions."),
          argument("text", "string", true, "Prompt text appended as a new user message (≤100000 chars)."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
          argument("reveal", "boolean", false, "true to also open that session in the person's focused pane after sending. Defaults to false."),
        ],
        effects: writeEffects,
      }),
      affordance({
        id: "session.question.list",
        kind: "query",
        title: "List a session's pending questions",
        description: "List the questions another session is waiting on the person to answer (session.read status waiting), with each question's options and whether it takes several choices or the person's own text.",
        provider,
        arguments: [
          argument("sessionId", "string", true, "Session id from session.search or session.read."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
        ],
        effects: readEffects,
      }),
      affordance({
        id: "session.question.answer",
        kind: "command",
        title: "Answer a session's pending question",
        description: "Answer a pending question from session.question.list on the person's behalf, only with answers the person gave or asked you to choose. The waiting session continues with them.",
        provider,
        arguments: [
          argument("sessionId", "string", true, "Session id that asked the question."),
          argument("requestId", "string", true, "Pending question id from session.question.list."),
          argument("answers", "array", true, "One array per question, in order: chosen option labels, or the person's own text where allowed."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
        ],
        effects: writeEffects,
      }),
    ],
    guidance: [],
  };
}

function sessionGroupContribution(): OpenworkFeatureContribution {
  const provider: OpenworkProviderRef = { id: "openwork-server", kind: "builtin" };
  const workspaceId = argument("workspaceId", "string", false, "Optional workspace id or name. Defaults to the workspace of the session involved.");
  return {
    featureId: "session-groups",
    provider,
    affordances: [
      affordance({
        id: "session.group.list",
        kind: "query",
        title: "List sidebar groups",
        description: "List the sidebar groups (for example Done, In progress) of a workspace with the sessions in each. Sessions not listed are ungrouped. Works without the desktop window open.",
        provider,
        arguments: [workspaceId],
        effects: readEffects,
      }),
      affordance({
        id: "session.group.create",
        kind: "command",
        title: "Create a sidebar group",
        description: "Add a group to a workspace sidebar. An existing group with the same name is reused and returned with created:false.",
        provider,
        arguments: [argument("label", "string", true, "Group name, at most 120 characters."), workspaceId],
        effects: writeEffects,
      }),
      affordance({
        id: "session.group.move",
        kind: "command",
        title: "Move a session to a group",
        description: "Put a session in a sidebar group, or ungroup it when groupId is omitted. The result confirms the saved group.",
        provider,
        arguments: [
          argument("sessionId", "string", true, "Session id from session.search, session.read or session.group.list."),
          argument("groupId", "string", false, "Group id or exact name from session.group.list. Omit to ungroup."),
          workspaceId,
        ],
        effects: writeEffects,
      }),
      affordance({
        id: "session.group.remove",
        kind: "command",
        title: "Remove a sidebar group",
        description: "Remove a group the person asked to remove. Its sessions are kept: ungrouped, or moved to destinationGroupId.",
        provider,
        arguments: [
          argument("groupId", "string", true, "Group id or exact name to remove."),
          argument("destinationGroupId", "string", false, "Optional group id or name that receives its sessions."),
          argument("confirmed", "boolean", true, "Must be true."),
          workspaceId,
        ],
        effects: writeEffects,
      }),
    ],
    guidance: [],
  };
}

function automationContribution(): OpenworkFeatureContribution {
  const provider: OpenworkProviderRef = { id: "openwork-automations", kind: "builtin" };
  return {
    featureId: "automations",
    provider,
    affordances: [
      affordance({
        id: "automation.propose",
        kind: "command",
        title: "Propose an Automation",
        description: "Offer a scheduled Automation for the person to review and create. This only renders a proposal in the chat; it cannot create, activate, or run anything.",
        provider,
        arguments: [
          argument("name", "string", true, "Short Automation name, at most 120 characters."),
          argument("instructions", "string", true, "Self-contained instructions the Automation runs on its schedule."),
          argument("schedule", "object", true, "Schedule with an IANA timezone: once {at}, daily {hour, minute}, weekly {daysOfWeek, hour, minute}, or interval {everyHours 1-24, optional daysOfWeek (0=Sunday), startHour, endHour} for every few hours on the hour, e.g. every 3 hours from 9 to 18, or calendar {edge start|end, offsetMinutes -120..120, rule {withExternalAttendees, titleIncludes}} to run around each meeting on the person's Google Calendar (Cloud only). Interval and calendar need their organization features."),
          argument("model", "object", false, "Optional providerId and modelId. Omit to use the person's default."),
        ],
        effects: noEffects,
      }),
    ],
    guidance: [],
  };
}

function extensionContribution(): OpenworkFeatureContribution {
  const provider: OpenworkProviderRef = { id: "openwork-extensions", kind: "extension" };
  return {
    featureId: "extensions",
    provider,
    affordances: [
      affordance({
        id: "extension.actions",
        kind: "query",
        title: "List extension actions",
        description: "List actions exposed by enabled local OpenWork extensions.",
        provider,
        arguments: [argument("extensionId", "string", false, "Optional extension id.")],
        effects: readEffects,
      }),
      affordance({
        id: "extension.call",
        kind: "command",
        title: "Call an extension action",
        description: "Execute one action exposed by a local OpenWork extension.",
        provider,
        arguments: [
          argument("extensionId", "string", true, "Extension id."),
          argument("action", "string", true, "Action id returned by extension.actions."),
          argument("args", "object", false, "Extension action arguments."),
        ],
        effects: { data: "write", ui: "none", external: true },
      }),
    ],
    guidance: [],
  };
}

function connectContribution(
  skills: ConnectSkillDescriptor[],
  cloudMcp: EngineMcpDescriptor | undefined,
): OpenworkFeatureContribution | null {
  if (skills.length === 0 && !cloudMcp) return null;
  const provider: OpenworkProviderRef = { id: "openwork-cloud", kind: "connect" };
  const guidance: OpenworkGuidanceDescriptor[] = skills.map((skill) => ({
    ref: skill.capability,
    title: skill.title?.trim() || skill.name,
    description: skill.description,
    provider,
    loading: "catalog",
  }));
  return {
    featureId: "connect",
    provider,
    affordances: [
      affordance({
        id: "connect.capabilities.search",
        kind: "query",
        title: "Search Connect capabilities",
        description: "Discover a remote capability when no exact capability ref is already known.",
        provider,
        arguments: [
          argument("query", "string", true, "Capability keywords."),
          argument("limit", "number", false, "Maximum capabilities to return."),
          argument("type", "string", false, "Optional capability type filter."),
        ],
        effects: { data: "read", ui: "none", external: true },
        tool: "openwork-cloud_search_capabilities",
      }),
      affordance({
        id: "connect.capability.execute",
        kind: "command",
        title: "Execute a Connect capability",
        description: "Execute an exact remote capability ref or load a known remote skill.",
        provider,
        arguments: [
          argument("name", "string", false, "Exact capability ref returned by Connect search or remote skill guidance."),
          argument("arguments", "object", false, "Arguments matching the search match's inputSchema."),
          argument("schemaDigest", "string", false, "Optional schema digest from the search match."),
          // Den keeps accepting these older inputs for a while, for callers
          // and older Den builds from before `arguments`.
          argument("path", "object", false, "Older form of arguments.path."),
          argument("query", "object", false, "Older form of arguments.query."),
          argument("body", "object", false, "Older form of arguments."),
        ],
        effects: { data: "write", ui: "none", external: true },
        tool: "openwork-cloud_execute_capability",
      }),
    ],
    guidance,
  };
}

function mcpContribution(mcp: EngineMcpDescriptor): OpenworkFeatureContribution {
  return {
    featureId: `mcp:${mcp.name}`,
    provider: { id: mcp.name, kind: "mcp" },
    affordances: [],
    guidance: [],
  };
}

export function buildOpenworkProviderContributions(
  skills: ConnectSkillDescriptor[],
  mcps: EngineMcpDescriptor[] = [],
): OpenworkFeatureContribution[] {
  const cloudMcp = mcps.find((mcp) => mcp.name === "openwork-cloud");
  const connect = connectContribution(skills, cloudMcp);
  return [
    sessionContribution(),
    sessionGroupContribution(),
    automationContribution(),
    extensionContribution(),
    ...mcps
      .filter((mcp) => mcp.name !== "openwork-cloud")
      .map(mcpContribution),
    ...(connect ? [connect] : []),
  ];
}
