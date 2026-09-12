import {
  openworkSessionModelSchema,
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

// Epoch milliseconds or an ISO-8601 string; resolve with sessionTimestampMs.
const sessionTimestampArgSchema = z.union([z.number().int().nonnegative(), z.string().trim().min(1)])
  .refine((value) => typeof value === "number" || Number.isFinite(Date.parse(value)), {
    message: "Expected epoch milliseconds or an ISO-8601 date string.",
  });

export function sessionTimestampMs(value: z.infer<typeof sessionTimestampArgSchema>): number {
  return typeof value === "number" ? value : Date.parse(value);
}

export const sessionSearchArgsSchema = z.object({
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

export const sessionReadArgsSchema = z.object({
  sessionId: z.string().trim().min(1).describe("OpenWork/OpenCode session ID returned by session.search."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
  count: z.number().int().positive().max(100).optional().describe("Number of transcript messages to return. Defaults to 30, max 100."),
  from: z.enum(["start", "end"]).optional().describe("end (default): the last `count` messages; start: the first `count` messages."),
  summary: z.boolean().optional().describe("When true, return only the first user message and the last assistant message plus session metadata."),
});

// Same contract agents read back as `model`; `variant` may be omitted on input.
export const sessionModelArgSchema = openworkSessionModelSchema.extend({
  variant: openworkSessionModelSchema.shape.variant.optional().describe("Reasoning effort variant (e.g. low, medium, high). Omit or null for the provider default."),
});

export const sessionCreateArgsSchema = z.object({
  sessions: z.array(z.object({
    title: z.string().trim().min(1).transform((title) => title.length > 120 ? `${title.slice(0, 119)}…` : title).describe("Short title shown in the OpenWork session list."),
    prompt: z.string().trim().min(1).max(100_000).describe("Self-contained task to start in the new session."),
    model: sessionModelArgSchema.optional().describe("Model and reasoning effort for this session. Overrides the top-level model."),
  })).min(1).describe("One entry per new session to create and start."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Defaults to the workspace containing the current session."),
  model: sessionModelArgSchema.optional().describe("Model and reasoning effort for every created session unless an entry overrides it. Omit to use the engine default."),
});

export const sessionSendArgsSchema = z.object({
  sessionId: z.string().trim().min(1).describe("Session ID of the existing session to message, from session.search, session.read, or session.list_sessions."),
  text: z.string().trim().min(1).max(100_000).describe("Prompt text appended to that session as a new user message."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
  reveal: z.boolean().optional().describe("true to also open that session in the person's focused pane after sending. Defaults to false: nothing on screen changes."),
});

/** Argument schemas by affordance id; sessionContribution must advertise exactly these keys. */
export const sessionAffordanceArgsSchemas = {
  "session.search": sessionSearchArgsSchema,
  "session.read": sessionReadArgsSchema,
  "session.create": sessionCreateArgsSchema,
  "session.send": sessionSendArgsSchema,
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
        id: "session.search",
        kind: "query",
        title: "Find sessions",
        description: "Search session titles and transcripts without changing the visible workbench. Every root session's title is matched; transcripts are scanned for the `scanLimit` newest sessions only, so when the result's `truncated` is true, retry with a larger `scanLimit` (max 500). Title and phrase matches rank first, then newest `updatedAt`. Each result carries `createdAt`, `archived` and `parentId`.",
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
        description: "Read messages from a session without opening it. The result also carries `createdAt`, `archived`, `parentId`, `status` (idle, busy, retry, waiting), `working` (check it before session.archive), and `model` ({ providerId, modelId, variant } the session is bound to, variant being its reasoning effort; null before a model is bound). Pass `summary: true` to get only the first user message and the last assistant message (what was asked, what was concluded) in one call.",
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
        description: "Create and start one or more sessions without navigating away. Pass `model` ({ providerId, modelId, variant }) to bind the sessions to a model and reasoning effort; it is applied at creation and to the first turn, and read back as `model` by session.read and session.list_sessions.",
        provider,
        arguments: [
          argument("sessions", "array", true, "Array of { title (≤120 chars, longer is clipped), prompt (≤100000 chars), model? }. Each prompt is self-contained; model is { providerId, modelId, variant? (≤60 chars) }."),
          argument("workspaceId", "string", false, "Optional workspace id or name. Defaults to the requesting session's workspace."),
          argument("model", "object", false, "Optional providerId, modelId and variant (reasoning effort, ≤60 chars) for every created session. Omit to use the engine default."),
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
          argument("schedule", "object", true, "once/daily/weekly schedule with an IANA timezone. Intervals are not supported."),
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
          argument("schemaDigest", "string", false, "Schema digest returned by Connect search when required."),
          argument("path", "object", false, "Path parameters for the capability."),
          argument("query", "object", false, "Query parameters for the capability."),
          argument("body", "object", false, "Request body for the capability."),
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
    automationContribution(),
    extensionContribution(),
    ...mcps
      .filter((mcp) => mcp.name !== "openwork-cloud")
      .map(mcpContribution),
    ...(connect ? [connect] : []),
  ];
}
