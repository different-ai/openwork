import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2Client } from "@/app/lib/opencode-v2-adapter";
import type { Client, PendingQuestion } from "@/app/types";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { isReservedConnectionQuestion } from "../surface/mcp-chat-reconnect";
import { questionKey, settleQuestionState } from "./session-sync";

type SessionQuestions = {
  client: Client;
  workspaceId: string;
  sessionId: string;
  directory?: string;
};

export async function dismissSessionQuestion(
  { client, workspaceId, sessionId, directory }: SessionQuestions,
  requestID: string,
  options?: { signal: AbortSignal },
) {
  unwrap(await (isOpencodeV2Client(client)
    ? client.rejectSessionQuestion({ sessionID: sessionId, requestID }, options)
    : client.question.reject({ requestID, directory }, options)));
  settleQuestionState(workspaceId, sessionId, requestID);
}

export async function submitAfterDismissingSessionQuestions<T>(
  context: SessionQuestions,
  assertCurrent: () => void,
  submit: () => Promise<T>,
  submitWithoutQuestion: () => Promise<T> = submit,
): Promise<T> {
  const { client, workspaceId, sessionId, directory } = context;
  const options = { signal: AbortSignal.timeout(10_000) };
  const list = async () => {
    assertCurrent();
    const result = isOpencodeV2Client(client)
      ? await client.listSessionQuestions({ sessionID: sessionId }, options)
      : await client.question.list({ directory }, options);
    return unwrap(result).filter(question => question.sessionID === sessionId);
  };
  const cached = getReactQueryClient().getQueryData<PendingQuestion[]>(questionKey(workspaceId, sessionId)) ?? [];
  const questions = await list();
  const listed = new Set(questions.map(question => question.id));
  for (const question of cached) {
    if (!listed.has(question.id) && !isReservedConnectionQuestion(question)) settleQuestionState(workspaceId, sessionId, question.id);
  }
  for (const question of questions) {
    if (isReservedConnectionQuestion(question)) continue;
    assertCurrent();
    try {
      await dismissSessionQuestion(context, question.id, options);
    } catch (error) {
      if ((await list()).some(current => current.id === question.id)) throw error;
      settleQuestionState(workspaceId, sessionId, question.id);
    }
  }
  assertCurrent();
  return questions.length > 0 || cached.length > 0 ? submit() : submitWithoutQuestion();
}
