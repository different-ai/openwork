import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const DICTATION_DEFAULT_ENDPOINT = "http://127.0.0.1:8080/v1/audio/transcriptions";
export const DICTATION_DEFAULT_MODEL = "whisper-1";
export const DICTATION_DEFAULT_DESKTOP_MODEL = "parakeet-110m-en";
/** Transcripts offered for copying from the mic menu; older ones move to the stash. */
export const DICTATION_RECENT_LIMIT = 5;
const DICTATION_HISTORY_LIMIT = 50;

/** builtin: a speech model OpenWork downloads and runs itself. server: the member's own transcription server. */
export type DictationEngine = "builtin" | "server";

export type DictationTranscript = {
  id: string;
  text: string;
  createdAt: number;
};

export type DictationSettings = {
  endpoint: string;
  model: string;
  language: string;
};

type DictationStore = DictationSettings & {
  engine: DictationEngine;
  desktopModel: string;
  /** Newest first. */
  transcripts: DictationTranscript[];
  updateSettings: (patch: Partial<DictationSettings & { engine: DictationEngine; desktopModel: string }>) => void;
  addTranscript: (text: string) => void;
  clearStash: () => void;
};

export const useDictationStore = create<DictationStore>()(
  persist(
    (set) => ({
      engine: "builtin",
      desktopModel: DICTATION_DEFAULT_DESKTOP_MODEL,
      endpoint: DICTATION_DEFAULT_ENDPOINT,
      model: DICTATION_DEFAULT_MODEL,
      language: "",
      transcripts: [],
      updateSettings: (patch) => set(patch),
      addTranscript: (text) =>
        set((state) => ({
          transcripts: [
            { id: crypto.randomUUID(), text, createdAt: Date.now() },
            ...state.transcripts,
          ].slice(0, DICTATION_HISTORY_LIMIT),
        })),
      clearStash: () =>
        set((state) => ({ transcripts: state.transcripts.slice(0, DICTATION_RECENT_LIMIT) })),
    }),
    {
      name: "openwork.dictation.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
