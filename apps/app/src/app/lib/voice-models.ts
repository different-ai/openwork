// Realtime models documented September 4, 2026. These handle audio only;
// conversation execution continues to use the task's selected model.
export const DEFAULT_VOICE_REALTIME_MODEL = "gpt-realtime-2.1";
export const VOICE_REALTIME_MODELS = [
  { id: DEFAULT_VOICE_REALTIME_MODEL, label: "GPT Realtime 2.1", description: "Recommended for voice quality." },
  { id: "gpt-realtime-2.1-mini", label: "GPT Realtime 2.1 Mini", description: "A faster, lower-cost audio model. Managed Voice usage follows your plan." },
];
