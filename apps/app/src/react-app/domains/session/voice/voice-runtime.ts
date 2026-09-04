/** One store per mounted conversation. No audio or transcript lives in a global singleton. */
export type VoiceStatus = "idle" | "connecting" | "reconnecting" | "listening" | "processing" | "speaking" | "muted" | "paused" | "error";
export type VoiceTimelineEntry = { id: string; role: "user" | "assistant" | "system"; text: string; at: number };
export const VOICE_TIMELINE_LIMIT = 120;
export type VoiceRuntimeSnapshot = {
  status: VoiceStatus;
  statusText: string;
  captureActive: boolean;
  micMuted: boolean;
  working: boolean;
  pendingText: string;
  assistantPreview: string;
  entries: VoiceTimelineEntry[];
  devices: { id: string; label: string; kind: string }[];
  inputDevice: string;
  outputDevice: string;
  outputSelectionSupported: boolean;
};
export const initialVoiceRuntimeSnapshot: VoiceRuntimeSnapshot = {
  status: "idle", statusText: "Start speaking in this conversation.",
  captureActive: false, micMuted: false, working: false, pendingText: "", assistantPreview: "",
  entries: [], devices: [], inputDevice: "", outputDevice: "", outputSelectionSupported: false,
};
export function createVoiceRuntime() {
  let snapshot = initialVoiceRuntimeSnapshot;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<VoiceRuntimeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update,
    append(role: VoiceTimelineEntry["role"], text: string) {
      if (!text.trim()) return;
      update({ entries: [...snapshot.entries, { id: crypto.randomUUID(), role, text: text.trim().slice(0, 8_000), at: Date.now() }].slice(-VOICE_TIMELINE_LIMIT) });
    },
    reset() { snapshot = initialVoiceRuntimeSnapshot; listeners.forEach((listener) => listener()); },
  };
}
