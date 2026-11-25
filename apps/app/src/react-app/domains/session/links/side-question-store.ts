import { create } from "zustand";

import type { OpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import { t } from "@/i18n";

import { useUiStateStore } from "../../../shell/ui-state-store";
import { SIDE_CHAT_TAB_ID, usePanelTabStore } from "../panel/panel-tab-store";
import { getSidePanelSessionKey } from "../panel/side-panel-session";
import {
  SIDE_QUESTION_TIMEOUT_MS,
  askSideQuestion,
  removeSideQuestion,
  retrySideQuestion,
  settleSideQuestion,
  sideQuestionPrompt,
  sideQuestionQuote,
  type SideQuestion,
  type SideQuestionFailure,
} from "./side-question";

const NONE: readonly SideQuestion[] = [];

type SideQuestionResult = { text: string } | { failure: SideQuestionFailure };
export type SideQuestionClient = Pick<OpencodeV2Client, "generateFromSession">;

type SideQuestionState = {
  bySession: Record<string, readonly SideQuestion[]>;
  draftBySession: Record<string, string>;
  quoteBySession: Record<string, string>;
  setDraft: (sessionId: string, draft: string) => void;
  setQuote: (sessionId: string, selection: string | null) => void;
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

function without(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function showSideChatTab(sessionId: string) {
  const owner = getSidePanelSessionKey(sessionId);
  usePanelTabStore.getState().openTab(owner, { id: SIDE_CHAT_TAB_ID, type: "side-chat", label: t("session_management.split_view") });
  useUiStateStore.getState().setSidePanelState(owner, "panel");
}

export const useSideQuestionStore = create<SideQuestionState>()((set, get) => {
  const settle = (sessionId: string, id: string, attempt: number, result: SideQuestionResult) =>
    set((state) => withQuestions(state, sessionId, (list) => settleSideQuestion(list, id, attempt, result)));

  const sendWaitingAttempt = (client: SideQuestionClient, sessionId: string, id: string) => {
    const item = (get().bySession[sessionId] ?? NONE).find((candidate) => candidate.id === id);
    if (!item || item.status !== "asking") return;
    const { attempt, question, quote } = item;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      settle(sessionId, id, attempt, { failure: "timeout" });
    }, SIDE_QUESTION_TIMEOUT_MS);
    void client.generateFromSession({ sessionID: sessionId, prompt: sideQuestionPrompt(question, quote) }, { signal: controller.signal })
      .then((result): SideQuestionResult => (result.data ? { text: result.data.text } : { failure: "error" }), (): SideQuestionResult => ({ failure: "error" }))
      .then((result) => {
        clearTimeout(timer);
        if (!controller.signal.aborted) settle(sessionId, id, attempt, result);
      });
  };

  return {
    bySession: {},
    draftBySession: {},
    quoteBySession: {},
    setDraft: (sessionId, draft) => set((state) => ({ draftBySession: { ...state.draftBySession, [sessionId]: draft } })),
    setQuote: (sessionId, selection) => set((state) => {
      const quote = selection ? sideQuestionQuote(selection) : "";
      return { quoteBySession: quote ? { ...state.quoteBySession, [sessionId]: quote } : without(state.quoteBySession, sessionId) };
    }),
    ask: (client, sessionId, question) => {
      const id = crypto.randomUUID();
      set((state) => ({
        ...withQuestions(state, sessionId, (list) => askSideQuestion(list, id, question, state.quoteBySession[sessionId])),
        quoteBySession: without(state.quoteBySession, sessionId),
      }));
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
