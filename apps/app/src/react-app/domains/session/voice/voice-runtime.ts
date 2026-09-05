/**
 * Module-scope Voice Mode runtime state. It intentionally outlives the panel
 * so a background session keeps streaming into the timeline, but it must stay
 * bounded: entries are capped and an explicit stop releases the whole
 * snapshot instead of retaining transcript text for the rest of the app run.
 */

export type VoiceStatus = "idle" | "connecting" | "listening" | "muted" | "speaking" | "error";

export type VoiceTimelineEntry = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  error?: boolean;
  at: number;
};

export type VoiceRuntimeSnapshot = {
  status: VoiceStatus;
  statusText: string;
  micMuted: boolean;
  micDiagnostics: string;
  realtimeDiagnostics: string;
  entries: VoiceTimelineEntry[];
  latestUserTranscript: string;
  assistantPreview: string;
};

export const VOICE_TIMELINE_LIMIT = 120;

export const initialVoiceRuntimeSnapshot: VoiceRuntimeSnapshot = {
  status: "idle",
  statusText: "Ready for voice control.",
  micMuted: false,
  micDiagnostics: "Microphone has not started yet.",
  realtimeDiagnostics: "Realtime is not connected.",
  entries: [],
  latestUserTranscript: "",
  assistantPreview: "",
};

let voiceRuntimeSnapshot: VoiceRuntimeSnapshot = initialVoiceRuntimeSnapshot;
const voiceRuntimeListeners = new Set<() => void>();

export function getVoiceRuntimeSnapshot() {
  return voiceRuntimeSnapshot;
}

export function subscribeVoiceRuntime(listener: () => void) {
  voiceRuntimeListeners.add(listener);
  return () => {
    voiceRuntimeListeners.delete(listener);
  };
}

export function setVoiceRuntimeSnapshot(update: (current: VoiceRuntimeSnapshot) => VoiceRuntimeSnapshot) {
  voiceRuntimeSnapshot = update(voiceRuntimeSnapshot);
  voiceRuntimeListeners.forEach((listener) => listener());
}

/** Release everything the voice runtime retained, including timeline text. */
export function resetVoiceRuntimeSnapshot() {
  setVoiceRuntimeSnapshot(() => initialVoiceRuntimeSnapshot);
}

export function appendVoiceTimelineEntry(
  role: VoiceTimelineEntry["role"],
  text: string,
  options: { toolName?: string; error?: boolean } = {},
) {
  const trimmed = text.trim();
  if ((role === "user" || role === "assistant") && !trimmed) return;
  setVoiceRuntimeSnapshot((current) => ({
    ...current,
    entries: [
      ...current.entries,
      {
        id: `voice-${Date.now()}-${current.entries.length}`,
        role,
        text: trimmed || options.toolName || "Tool call",
        toolName: options.toolName,
        error: options.error,
        at: Date.now(),
      },
    ].slice(-VOICE_TIMELINE_LIMIT),
  }));
}
