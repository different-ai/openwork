import { create } from "zustand";

import type { OpencodeV2Client } from "@/app/lib/opencode-v2-adapter";

import {
  SIDE_QUESTION_TIMEOUT_MS,
  askSideQuestion,
  removeSideQuestion,
  retrySideQuestion,
  settleSideQuestion,
  sideQuestionPrompt,
  type SideQuestion,
  type SideQuestionFailure,
} from "./side-question";

const NONE: readonly SideQuestion[] = [];

type SideQuestionResult = { text: string } | { failure: SideQuestionFailure };
export type SideQuestionClient = Pick<OpencodeV2Client, "generateFromSession">;

type SideQuestionState = {
  bySession: Record<string, readonly SideQuestion[]>;
  draftBySession: Record<string, string>;
  openSessionId: string | null;
  open: (sessionId: string, quote?: string) => void;
  close: () => void;
  setDraft: (sessionId: string, draft: string) => void;
  ask: (client: SideQuestionClient, sessionId: string, question: string) => void;
  retry: (client: SideQuestionClient, sessionId: string, id: string) => void;
  remove: (sessionId: string, id: string) => void;
};

function withQuestions(
  state: SideQuestionState,
  sessionId: string,
  change: (list: readonly SideQuestion[]) => readonly SideQuestion[],
): Partial<SideQuestionState> {
  const current = state.bySession[sessionId] ?? NONE;
  const next = change(current);
  return next === current ? {} : { bySession: { ...state.bySession, [sessionId]: next } };
}

function draftWithQuote(draft: string, quote: string): string {
  const typed = draft.trimEnd();
  return typed ? `${typed}\n\n${quote}` : quote;
}

export const useSideQuestionStore = create<SideQuestionState>()((set, get) => {
  const settle = (sessionId: string, id: string, attempt: number, result: SideQuestionResult) =>
    set((state) => withQuestions(state, sessionId, (list) => settleSideQuestion(list, id, attempt, result)));

  const sendWaitingAttempt = (client: SideQuestionClient, sessionId: string, id: string) => {
    const item = (get().bySession[sessionId] ?? NONE).find((candidate) => candidate.id === id);
    if (!item || item.status !== "asking") return;
    const { attempt, question } = item;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      settle(sessionId, id, attempt, { failure: "timeout" });
    }, SIDE_QUESTION_TIMEOUT_MS);
    void client.generateFromSession({ sessionID: sessionId, prompt: sideQuestionPrompt(question) }, { signal: controller.signal })
      .then((result): SideQuestionResult => (result.data ? { text: result.data.text } : { failure: "error" }), (): SideQuestionResult => ({ failure: "error" }))
      .then((result) => {
        clearTimeout(timer);
        if (!controller.signal.aborted) settle(sessionId, id, attempt, result);
      });
  };

  return {
    bySession: {},
    draftBySession: {},
    openSessionId: null,
    open: (sessionId, quote) => set((state) => ({
      openSessionId: sessionId,
      ...(quote ? { draftBySession: { ...state.draftBySession, [sessionId]: draftWithQuote(state.draftBySession[sessionId] ?? "", quote) } } : {}),
    })),
    close: () => set({ openSessionId: null }),
    setDraft: (sessionId, draft) => set((state) => ({ draftBySession: { ...state.draftBySession, [sessionId]: draft } })),
    ask: (client, sessionId, question) => {
      const id = crypto.randomUUID();
      set((state) => ({ ...withQuestions(state, sessionId, (list) => askSideQuestion(list, id, question)), openSessionId: sessionId }));
      sendWaitingAttempt(client, sessionId, id);
    },
    retry: (client, sessionId, id) => {
      set((state) => withQuestions(state, sessionId, (list) => retrySideQuestion(list, id)));
      sendWaitingAttempt(client, sessionId, id);
    },
    remove: (sessionId, id) => set((state) => withQuestions(state, sessionId, (list) => removeSideQuestion(list, id))),
  };
});

export function useSideQuestions(sessionId: string): readonly SideQuestion[] {
  return useSideQuestionStore((state) => state.bySession[sessionId] ?? NONE);
}
