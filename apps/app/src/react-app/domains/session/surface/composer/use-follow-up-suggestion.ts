import { useEffect, useReducer, useRef } from "react";
import type { UIMessage } from "ai";

import type { createClient } from "@/app/lib/opencode";
import { isOpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import type { ModelRef } from "@/app/types";

import { followUpExchange, followUpPrompt, parseFollowUpSuggestion } from "./follow-up-suggestion";

const SETTLE_MS = 600;
const REMEMBERED_CHATS = 50;

const answers = new Map<string, { replyId: string; suggestion: string | null }>();

function remember(sessionId: string, replyId: string, suggestion: string | null) {
  answers.delete(sessionId);
  answers.set(sessionId, { replyId, suggestion });
  const oldest = answers.keys().next();
  if (answers.size > REMEMBERED_CHATS && !oldest.done) answers.delete(oldest.value);
}

export function useFollowUpSuggestion(input: {
  enabled: boolean;
  client: ReturnType<typeof createClient>;
  sessionId: string;
  messages: readonly UIMessage[];
  settled: boolean;
  model: ModelRef;
}): string | null {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const exchange = input.enabled && input.settled ? followUpExchange(input.messages) : null;
  const exchangeRef = useRef(exchange);
  exchangeRef.current = exchange;
  const replyId = exchange?.replyId ?? null;
  const workedInRef = useRef<string | null>(null);
  if (!input.settled) workedInRef.current = input.sessionId;

  const { client, sessionId } = input;
  const { providerID, modelID } = input.model;
  useEffect(() => {
    if (!replyId || workedInRef.current !== sessionId || answers.get(sessionId)?.replyId === replyId) return;
    if (!isOpencodeV2Client(client)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const current = exchangeRef.current;
      if (!current || current.replyId !== replyId) return;
      void client.generateWithSmallModel({ prompt: followUpPrompt(current), model: { providerID, modelID } }, { signal: controller.signal })
        .then((result) => result.data ? parseFollowUpSuggestion(result.data.text) : null, () => null)
        .then((suggestion) => {
          if (controller.signal.aborted) return;
          remember(sessionId, replyId, suggestion);
          refresh();
        });
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, modelID, providerID, replyId, sessionId]);

  const answer = answers.get(sessionId);
  return replyId && answer?.replyId === replyId ? answer.suggestion : null;
}
