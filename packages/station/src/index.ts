export * from "./runtime";

export const OPENWORK_STATION_REALTIME_MODEL = "gpt-realtime-2.1";
export const OPENWORK_STATION_MODE_SHORTCUT = "CommandOrControl+Shift+Space";

export type StationInputSource = "microphone" | "fixture" | "simulated" | null;
export type StationInferenceMode = "openai-realtime" | "simulation" | null;

export type StationProvenance = {
  inputSource: StationInputSource;
  inferenceMode: StationInferenceMode;
  model: string | null;
};

export const INITIAL_STATION_PROVENANCE: StationProvenance = {
  inputSource: null,
  inferenceMode: null,
  model: null,
};
