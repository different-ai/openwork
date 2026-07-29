import type { OpenworkStationSuggestion } from "@/app/lib/openwork-server";

export type StationStatus = "idle" | "connecting" | "listening" | "analyzing" | "error";

export type StationSuggestion = OpenworkStationSuggestion & {
  effectiveRelevance: number;
};

export type StationState = {
  status: StationStatus;
  statusText: string;
  listening: boolean;
  visible: boolean;
  transcript: string;
  partialTranscript: string;
  audioEnergy: number;
  suggestions: StationSuggestion[];
  selectedId: string | null;
  source: "openwork-connect" | "local-signal" | "demo" | null;
  error: string | null;
};

export type StationCommand = {
  type: "activate" | "dismiss" | "hide" | "select" | "seed-demo" | "start" | "stop" | "toggle-listening";
  id?: string;
};

export const INITIAL_STATION_STATE: StationState = {
  status: "idle",
  statusText: "Ready when you are.",
  listening: false,
  visible: false,
  transcript: "",
  partialTranscript: "",
  audioEnergy: 0,
  suggestions: [],
  selectedId: null,
  source: null,
  error: null,
};

export function isStationCommand(value: unknown): value is StationCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const type = Reflect.get(value, "type");
  return type === "activate"
    || type === "dismiss"
    || type === "hide"
    || type === "select"
    || type === "seed-demo"
    || type === "start"
    || type === "stop"
    || type === "toggle-listening";
}

export function isStationState(value: unknown): value is StationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof Reflect.get(value, "status") === "string"
    && typeof Reflect.get(value, "listening") === "boolean"
    && Array.isArray(Reflect.get(value, "suggestions"));
}
