import {
  isReadOnlyStationCapability,
  type StationConnectedRecord,
} from "./station.js";

export type StationSimulatorCapability = {
  name: string;
  description: string;
  provider: string;
};

export type StationSimulatorResearch = {
  connectedContext: string;
  records: StationConnectedRecord[];
  discoveredCapabilities: string[];
  executedCapabilities: string[];
  sourceProviders: string[];
  resultCategory: "connected-data" | "no-result";
};

type StationSimulatorRecord = StationConnectedRecord;

type StationSimulatorState = {
  scenarioId: string;
  patchId: string;
  available: boolean;
  revision: number;
  records: StationSimulatorRecord[];
};

const CAPABILITIES: StationSimulatorCapability[] = [
  {
    name: "searchRecentMessages",
    description: "Search recent message metadata and matching excerpts.",
    provider: "Development Slack",
  },
  {
    name: "findPriorDiscussions",
    description: "Find prior discussions about a named person or topic.",
    provider: "Development Slack",
  },
  {
    name: "readCalendarAvailability",
    description: "Read attendee availability and time-zone metadata.",
    provider: "Development Calendar",
  },
  {
    name: "inspectCalendarEvent",
    description: "Read one existing calendar event and its source URL.",
    provider: "Development Calendar",
  },
  {
    name: "searchEmailThreads",
    description: "Search email thread metadata without sending or changing mail.",
    provider: "Development Email",
  },
  {
    name: "getSourceUrl",
    description: "Read a stable source URL for a connected record.",
    provider: "Development Sources",
  },
];

const MAYA_MESSAGE: StationSimulatorRecord = {
  id: "slack-enterprise-pilot-42",
  kind: "message",
  provider: "Development Slack",
  title: "Maya · enterprise pilot privacy concern",
  detail: "Last week Maya said enterprise-pilot audio may be used transiently during the call, but customer transcripts must not enter durable project history until retention and deletion controls are explicit.",
  url: "https://station.demo.openwork.local/slack/enterprise-pilot/42",
};

const MAYA_REVIEW: StationSimulatorRecord = {
  id: "calendar-enterprise-review",
  kind: "calendar",
  provider: "Development Calendar",
  title: "Enterprise pilot privacy review",
  detail: "Maya and Jalil are attendees. The existing review is Friday at 16:00 Europe/Berlin. The transcript-retention boundary is already an agenda candidate.",
  url: "https://station.demo.openwork.local/calendar/enterprise-pilot-review",
};

const DENVER_AVAILABILITY: StationSimulatorRecord = {
  id: "calendar-denver-berlin",
  kind: "calendar",
  provider: "Development Calendar",
  title: "Maya and Jalil availability",
  detail: "Maya is in America/Denver. Jalil is in Europe/Berlin. Tomorrow at 14:00 in Denver is 22:00 in Berlin in the current daylight-saving period. Both calendars have a thirty-minute opening.",
  url: "https://station.demo.openwork.local/calendar/availability/denver-berlin",
};

const MAYA_EMAIL: StationSimulatorRecord = {
  id: "email-maya-pilot",
  kind: "email",
  provider: "Development Email",
  title: "Prior enterprise pilot follow-up with Maya",
  detail: "The prior thread asks that the eventual decision include the transcript-retention boundary and the next review date. No message has been drafted or sent in the connected system.",
  url: "https://station.demo.openwork.local/email/threads/maya-enterprise-pilot",
};

function recordsForPatch(patchId: string): { available: boolean; records: StationSimulatorRecord[] } {
  if (patchId === "unavailable") return { available: false, records: [] };
  if (patchId === "empty") return { available: true, records: [] };
  if (patchId === "calendar-ready") {
    return { available: true, records: [DENVER_AVAILABILITY, MAYA_REVIEW] };
  }
  if (patchId === "maya-memory-ready") {
    return { available: true, records: [MAYA_MESSAGE, MAYA_REVIEW, MAYA_EMAIL] };
  }
  return { available: true, records: [] };
}

function relevantCapabilityNames(transcript: string): string[] {
  const names = new Set<string>();
  if (/\b(maya|remember|last week|prior|earlier|concern|privacy|pilot)\b/i.test(transcript)) {
    names.add("findPriorDiscussions");
    names.add("searchRecentMessages");
  }
  if (/\b(calendar|availability|available|meet|meeting|tomorrow|friday|monday|denver|berlin|minutes?)\b/i.test(transcript)) {
    names.add("readCalendarAvailability");
    names.add("inspectCalendarEvent");
  }
  if (/\b(email|follow up|send|after (this|the) call|decision|review date)\b/i.test(transcript)) {
    names.add("searchEmailThreads");
  }
  if (names.size) names.add("getSourceUrl");
  return Array.from(names);
}

function recordsForCapability(
  capabilityName: string,
  records: StationSimulatorRecord[],
): StationSimulatorRecord[] {
  if (capabilityName === "searchRecentMessages" || capabilityName === "findPriorDiscussions") {
    return records.filter((record) => record.kind === "message");
  }
  if (capabilityName === "readCalendarAvailability" || capabilityName === "inspectCalendarEvent") {
    return records.filter((record) => record.kind === "calendar");
  }
  if (capabilityName === "searchEmailThreads") {
    return records.filter((record) => record.kind === "email");
  }
  if (capabilityName === "getSourceUrl") return records;
  return [];
}

export class StationSimulatorUnavailableError extends Error {
  constructor() {
    super("The development MCP simulator is temporarily unavailable.");
    this.name = "StationSimulatorUnavailableError";
  }
}

export class StationDevelopmentMcpSimulator {
  readonly #states = new Map<string, StationSimulatorState>();

  reset(workspaceId: string, scenarioId: string, patchId: string) {
    const patch = recordsForPatch(patchId);
    const state: StationSimulatorState = {
      scenarioId,
      patchId,
      available: patch.available,
      revision: 1,
      records: patch.records,
    };
    this.#states.set(workspaceId, state);
    return this.status(workspaceId);
  }

  applyPatch(workspaceId: string, scenarioId: string, patchId: string) {
    const current = this.#states.get(workspaceId);
    const patch = recordsForPatch(patchId);
    const state: StationSimulatorState = {
      scenarioId,
      patchId,
      available: patch.available,
      revision: (current?.revision ?? 0) + 1,
      records: patch.records,
    };
    this.#states.set(workspaceId, state);
    return this.status(workspaceId);
  }

  status(workspaceId: string) {
    const state = this.#states.get(workspaceId);
    if (!state) {
      return {
        configured: false,
        scenarioId: null,
        patchId: null,
        available: false,
        revision: 0,
        recordCount: 0,
        provider: "development-mcp" as const,
      };
    }
    return {
      configured: true,
      scenarioId: state.scenarioId,
      patchId: state.patchId,
      available: state.available,
      revision: state.revision,
      recordCount: state.records.length,
      provider: "development-mcp" as const,
    };
  }

  discover(workspaceId: string, query: string): StationSimulatorCapability[] {
    const state = this.#states.get(workspaceId);
    if (!state?.available) throw new StationSimulatorUnavailableError();
    const relevant = new Set(relevantCapabilityNames(query));
    return CAPABILITIES.filter((capability) => (
      relevant.has(capability.name) && isReadOnlyStationCapability(capability.name)
    ));
  }

  execute(workspaceId: string, capabilityName: string): StationSimulatorRecord[] {
    const state = this.#states.get(workspaceId);
    if (!state?.available) throw new StationSimulatorUnavailableError();
    const capability = CAPABILITIES.find((candidate) => candidate.name === capabilityName);
    if (!capability || !isReadOnlyStationCapability(capabilityName)) {
      throw new Error("Station rejected a capability that is not unambiguously read-only.");
    }
    return recordsForCapability(capabilityName, state.records);
  }

  research(workspaceId: string, transcript: string): StationSimulatorResearch {
    const discovered = this.discover(workspaceId, transcript);
    const byId = new Map<string, StationSimulatorRecord>();
    for (const capability of discovered) {
      for (const record of this.execute(workspaceId, capability.name)) {
        byId.set(record.id, record);
      }
    }
    const records = Array.from(byId.values());
    const connectedContext = records.map((record) => [
      `Provider: ${record.provider}`,
      `Record: ${record.title}`,
      `Observed detail: ${record.detail}`,
      `Source URL: ${record.url}`,
    ].join("\n")).join("\n\n");
    return {
      connectedContext,
      records,
      discoveredCapabilities: discovered.map((capability) => capability.name),
      executedCapabilities: discovered.map((capability) => capability.name),
      sourceProviders: Array.from(new Set(records.map((record) => record.provider))),
      resultCategory: records.length ? "connected-data" : "no-result",
    };
  }
}
