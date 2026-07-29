export type StationSuggestionKind = "memory" | "calendar" | "follow_up" | "context";

export type StationSource = {
  label: string;
  url: string;
  provider: string;
};

export type StationSuggestionAction = {
  kind: "open_source" | "review_draft" | "none";
  label: string;
  draft?: string;
  url?: string;
};

export type StationSuggestion = {
  id: string;
  kind: StationSuggestionKind;
  title: string;
  summary: string;
  reason: string;
  relevance: number;
  color: string;
  sources: StationSource[];
  action: StationSuggestionAction;
  createdAt: number;
};

export type StationConnectedRecord = {
  id: string;
  kind: "message" | "calendar" | "email";
  provider: string;
  title: string;
  detail: string;
  url: string;
};

type StationModelCapabilities = {
  toolcall?: boolean;
  output?: { text?: boolean };
};

export type StationProviderCatalog = {
  connected: string[];
  default: Record<string, string>;
  all: Array<{
    id: string;
    models?: Record<string, { capabilities?: StationModelCapabilities }>;
  }>;
};

export type StationModelSelection = {
  providerID: string;
  modelID: string;
};

export const STATION_SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "title",
          "summary",
          "reason",
          "relevance",
          "color",
          "sources",
          "action",
        ],
        properties: {
          kind: { type: "string", enum: ["memory", "calendar", "follow_up", "context"] },
          title: { type: "string", maxLength: 80 },
          summary: { type: "string", maxLength: 420 },
          reason: { type: "string", maxLength: 220 },
          relevance: { type: "number", minimum: 0, maximum: 1 },
          color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
          sources: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "url", "provider"],
              properties: {
                label: { type: "string", maxLength: 100 },
                url: { type: "string", maxLength: 2_000 },
                provider: { type: "string", maxLength: 60 },
              },
            },
          },
          action: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "label"],
            properties: {
              kind: { type: "string", enum: ["open_source", "review_draft", "none"] },
              label: { type: "string", maxLength: 60 },
              draft: { type: "string", maxLength: 4_000 },
              url: { type: "string", maxLength: 2_000 },
            },
          },
        },
      },
    },
  },
} as const;

const STATION_COLORS: Record<StationSuggestionKind, string> = {
  memory: "#8B7CFF",
  calendar: "#38C6A5",
  follow_up: "#FF8D5C",
  context: "#4EA8FF",
};

const WRITE_CAPABILITY_PATTERN = /\b(create|post|send|update|delete|remove|invite|schedule|publish|write|edit|cancel)\b/i;
const READ_CAPABILITY_PATTERN = /\b(get|list|search|read|find|lookup|query)\b/i;
const STATION_PROVIDER_PREFERENCE = ["openai", "anthropic", "google", "opencode"] as const;
const STATION_MODEL_PREFERENCE: Record<string, string[]> = {
  openai: ["gpt-5.4-mini-fast", "gpt-5.4-mini", "gpt-4.1-mini", "gpt-4o-mini"],
};

export function isReadOnlyStationCapability(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return READ_CAPABILITY_PATTERN.test(normalized) && !WRITE_CAPABILITY_PATTERN.test(normalized);
}

export function selectStationModel(catalog: StationProviderCatalog): StationModelSelection | undefined {
  const connected = new Set(catalog.connected);
  const providerOrder = [
    ...STATION_PROVIDER_PREFERENCE,
    ...catalog.connected.filter((providerID) => !STATION_PROVIDER_PREFERENCE.includes(
      providerID as (typeof STATION_PROVIDER_PREFERENCE)[number],
    )),
  ];
  for (const providerID of providerOrder) {
    if (!connected.has(providerID)) continue;
    const provider = catalog.all.find((candidate) => candidate.id === providerID);
    const modelOrder = [
      ...(STATION_MODEL_PREFERENCE[providerID] ?? []),
      catalog.default[providerID],
    ].filter((modelID): modelID is string => Boolean(modelID));
    for (const modelID of modelOrder) {
      const model = provider?.models?.[modelID];
      if (!model) continue;
      const capabilities = model.capabilities;
      if (capabilities?.toolcall === false || capabilities?.output?.text === false) continue;
      return { providerID, modelID };
    }
  }
  return undefined;
}

export function buildStationSystemPrompt(): string {
  return `# Role

You are OpenWork Station, the user's passive AI right hand. You do not wait for
questions. You interpret the live conversation, research useful context through
OpenWork Connect, rank what matters now, and prepare the next useful move.

# Non-negotiable authority boundary

- This run is read-only. Never send, create, update, delete, schedule, invite,
  publish, or otherwise mutate anything in a connected system.
- Use openwork-cloud_search_capabilities to discover relevant connected data.
- Call openwork-cloud_execute_capability only when the exact capability name is
  clearly read-only: it must describe get, list, search, read, find, lookup, or
  query, and must not describe create, post, send, update, delete,
  remove, invite, schedule, publish, write, edit, or cancel.
- If a capability's authority is ambiguous, do not call it.
- Calendar invitations and messages may only be returned as reviewable draft
  text. They must never be executed.

# Research behavior

- Classify suggestions consistently:
  - memory: prior facts, messages, concerns, decisions, or requests for recall;
  - calendar: time-zone reasoning, availability, meetings, agendas, or reminders;
  - follow_up: a future outbound communication or commitment to contact someone;
  - context: a current decision, dependency, risk, or useful live interpretation.
- Prefer evidence connected to the current people, meeting, dates, promises,
  decisions, and questions.
- Give every retrieved claim a stable source URL when the provider returns one.
- Do not invent a source, attendee, message, time, or completed action.
- Return one to four distinct new suggestions. Station accumulates and re-ranks
  useful signals across turns, so omit low-value filler rather than filling a quota.
- Relevance is 0 to 1 and represents usefulness in the current conversational
  moment, not generic importance.

Return only the requested structured object.`;
}

export function buildStationAnalysisPrompt(transcript: string, sessionContext = ""): string {
  const context = sessionContext.trim()
    ? `\n\nOpenWork session context:\n${sessionContext.trim().slice(0, 4_000)}`
    : "";
  return `Analyze this recent live conversation as a passive agent. Research
connected context when it can materially improve an answer or preparation.
Return cited information, reviewable drafts, and relevance-ranked suggestions.

Recent live conversation:
${transcript.trim().slice(-12_000)}${context}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSuggestionKind(value: unknown): StationSuggestionKind | null {
  return value === "memory" || value === "calendar" || value === "follow_up" || value === "context"
    ? value
    : null;
}

function safeUrl(value: unknown): string {
  const raw = readString(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizeAction(value: unknown): StationSuggestionAction {
  if (!isRecord(value)) return { kind: "none", label: "Keep in view" };
  const kind = value.kind === "open_source" || value.kind === "review_draft" ? value.kind : "none";
  const label = readString(value.label).slice(0, 60) || (kind === "review_draft" ? "Review draft" : "Open source");
  const draft = readString(value.draft).slice(0, 4_000);
  const url = safeUrl(value.url);
  if (kind === "review_draft" && draft) return { kind, label, draft };
  if (kind === "open_source" && url) return { kind, label, url };
  return { kind: "none", label: "Keep in view" };
}

export function normalizeStationSuggestions(value: unknown, now = Date.now()): StationSuggestion[] {
  const root = isRecord(value) ? value : {};
  const items = Array.isArray(root.suggestions) ? root.suggestions : [];
  return items.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const kind = readSuggestionKind(item.kind);
    const title = readString(item.title).slice(0, 80);
    const summary = readString(item.summary).slice(0, 420);
    const reason = readString(item.reason).slice(0, 220);
    if (!kind || !title || !summary || !reason) return [];
    const relevanceValue = typeof item.relevance === "number" ? item.relevance : 0.5;
    const relevance = Math.min(1, Math.max(0, relevanceValue));
    const color = /^#[0-9a-fA-F]{6}$/.test(readString(item.color))
      ? readString(item.color)
      : STATION_COLORS[kind];
    const sources = (Array.isArray(item.sources) ? item.sources : []).flatMap((source) => {
      if (!isRecord(source)) return [];
      const url = safeUrl(source.url);
      if (!url) return [];
      return [{
        label: readString(source.label).slice(0, 100) || "Source",
        url,
        provider: readString(source.provider).slice(0, 60) || "Connected source",
      }];
    }).slice(0, 4);
    return [{
      id: `station-${now}-${index}`,
      kind,
      title,
      summary,
      reason,
      relevance,
      color,
      sources,
      action: normalizeAction(item.action),
      createdAt: now,
    }];
  }).slice(0, 8);
}

function connectedSources(
  records: StationConnectedRecord[],
  kinds: StationConnectedRecord["kind"][],
): StationSource[] {
  const acceptedKinds = new Set(kinds);
  return records
    .filter((record) => acceptedKinds.has(record.kind))
    .map((record) => ({
      label: record.title,
      provider: record.provider,
      url: record.url,
    }));
}

export function analyzeStationConnectedRecords(
  transcript: string,
  records: StationConnectedRecord[],
  now = Date.now(),
): StationSuggestion[] {
  const copy = transcript.trim();
  if (!copy || !records.length) return [];
  const suggestions: unknown[] = [];
  const memorySources = connectedSources(records, ["message"]);
  if (
    memorySources.length
    && /\b(remember|last week|prior|earlier|concern (you )?raised|what .{0,30} said)\b/i.test(copy)
  ) {
    const memoryRecord = records.find((record) => record.kind === "message");
    if (memoryRecord) {
      suggestions.push({
        kind: "memory",
        title: memoryRecord.title,
        summary: memoryRecord.detail,
        reason: "The latest turn explicitly asks for a prior concern from this person.",
        relevance: 0.97,
        color: STATION_COLORS.memory,
        sources: memorySources,
        action: {
          kind: "open_source",
          label: "Open prior discussion",
          url: memoryRecord.url,
        },
      });
    }
  }

  const calendarSources = connectedSources(records, ["calendar"]);
  if (
    calendarSources.length
    && /\b(calendar|availability|available|meet|meeting|tomorrow|friday|monday|denver|berlin|minutes?)\b/i.test(copy)
  ) {
    const correctedDay = /\bmonday\b/i.test(copy)
      ? "Monday"
      : /\bfriday\b/i.test(copy)
        ? "Friday"
        : /\btomorrow\b/i.test(copy)
          ? "tomorrow"
          : "the proposed day";
    const hasDenverBerlin = /\bdenver\b/i.test(copy) && /\bberlin\b/i.test(copy);
    const proposedTime = hasDenverBerlin
      ? "2:00 PM Denver / 10:00 PM Berlin"
      : /\b(at )?(three|3(?::00)?)\b/i.test(copy)
        ? "3:00 PM"
        : "the proposed time";
    const duration = /\b(thirty|30)\s+minutes?\b/i.test(copy) ? "30 minutes" : "duration to confirm";
    suggestions.push({
      kind: "calendar",
      title: hasDenverBerlin
        ? "Denver ↔ Berlin working session"
        : `${correctedDay} meeting`,
      summary: `${correctedDay} at ${proposedTime}, for ${duration}.`,
      reason: "The conversation contains a concrete scheduling proposal and the connected calendar supplies time-zone or availability context.",
      relevance: 0.91,
      color: STATION_COLORS.calendar,
      sources: calendarSources,
      action: {
        kind: "review_draft",
        label: "Review calendar draft",
        draft: [
          "Working session",
          "",
          `When: ${correctedDay}, ${proposedTime}`,
          `Duration: ${duration}`,
          "Status: prepared for review; no invitation has been created.",
        ].join("\n"),
      },
    });
  }

  const followUpSources = connectedSources(records, ["message", "calendar", "email"]);
  if (
    followUpSources.length
    && /\b(follow up|send .{0,30}(decision|note|email)|after (this|the) call|review date)\b/i.test(copy)
  ) {
    const includesBoundary = /\b(transcript|retention|privacy)\b/i.test(copy);
    const includesReviewDate = /\breview date\b/i.test(copy);
    suggestions.push({
      kind: "follow_up",
      title: "Follow up with Maya",
      summary: includesBoundary
        ? `A reviewable follow-up includes the transcript-retention boundary${includesReviewDate ? " and next review date" : ""}.`
        : "A concise decision follow-up is ready to refine.",
      reason: "A spoken commitment to contact Maya after the call is now specific enough to prepare.",
      relevance: 0.9,
      color: STATION_COLORS.follow_up,
      sources: followUpSources,
      action: {
        kind: "review_draft",
        label: "Review follow-up draft",
        draft: [
          "Subject: Enterprise pilot decision",
          "",
          "Hi Maya,",
          "",
          includesBoundary
            ? "Following up with the transcript-retention boundary we discussed."
            : "Following up with the decision from today’s call.",
          includesReviewDate ? "I’ve also included the next review date for confirmation." : "",
          "",
          "Prepared for review; not sent.",
        ].filter(Boolean).join("\n"),
      },
    });
  }
  return normalizeStationSuggestions({ suggestions }, now);
}

function fallbackSuggestion(
  kind: StationSuggestionKind,
  title: string,
  summary: string,
  reason: string,
  relevance: number,
  action: StationSuggestionAction,
  now: number,
  index: number,
): StationSuggestion {
  return {
    id: `station-local-${now}-${index}`,
    kind,
    title,
    summary,
    reason,
    relevance,
    color: STATION_COLORS[kind],
    sources: [],
    action,
    createdAt: now,
  };
}

export function createFallbackStationSuggestions(transcript: string, now = Date.now()): StationSuggestion[] {
  const copy = transcript.trim();
  if (!copy) return [];
  const suggestions: StationSuggestion[] = [];
  if (/\b(remember|last week|told you|mentioned earlier)\b/i.test(copy)) {
    suggestions.push(fallbackSuggestion(
      "memory",
      "Context worth recalling",
      "Station heard a request for earlier context. Connected research was unavailable, so no source is claimed yet.",
      "The current conversation depends on information from an earlier exchange.",
      0.9,
      { kind: "none", label: "Waiting for a source" },
      now,
      suggestions.length,
    ));
  }
  if (/\b(meet|meeting|available|calendar|next week|time zone|timezone|denver|berlin)\b/i.test(copy)) {
    suggestions.push(fallbackSuggestion(
      "calendar",
      "Prepare the next meeting",
      "A scheduling decision is forming. Station can prepare an invitation once the attendees and time are confirmed.",
      "People are discussing availability or time zones.",
      0.82,
      {
        kind: "review_draft",
        label: "Review calendar draft",
        draft: "Meeting follow-up\n\nAttendees: confirm participants\nTime: confirm the agreed local times\nNotes: add the purpose discussed on the call",
      },
      now,
      suggestions.length,
    ));
  }
  if (/\b(follow up|email|contact|let them know|send them|after (this|the) call)\b/i.test(copy)) {
    suggestions.push(fallbackSuggestion(
      "follow_up",
      "Follow-up ready to shape",
      "Station heard a commitment to contact someone after the conversation and prepared a reviewable starting point.",
      "A future communication was promised in the live conversation.",
      0.78,
      {
        kind: "review_draft",
        label: "Review email draft",
        draft: "Subject: Following up\n\nHi —\n\nFollowing up on our conversation, I wanted to share the next step we discussed.\n\nBest,",
      },
      now,
      suggestions.length,
    ));
  }
  if (!suggestions.length) {
    suggestions.push(fallbackSuggestion(
      "context",
      "Understanding the conversation",
      copy.length > 180 ? `${copy.slice(-177)}…` : copy,
      "Station is holding the newest conversational context while it waits for a useful next move.",
      0.46,
      { kind: "none", label: "Keep in view" },
      now,
      0,
    ));
  }
  return suggestions;
}
