/**
 * Work Bot threads are native OpenWork sessions in the bot's workspace,
 * driven through the shared `@openwork/headless-threads` client against the
 * embedded server's workspace-scoped engine proxy. Nothing here invents a
 * conversation type: a thread created in Work Bot opens in OpenWork.
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  createHeadlessThreadClient,
  type HeadlessThreadClient,
} from "@openwork/headless-threads";
import { z } from "zod";

export type ThreadListItem = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const sessionListSchema = z.array(
  z
    .object({
      id: z.string(),
      title: z.string().optional(),
      parentID: z.string().optional(),
      time: z.object({ created: z.number(), updated: z.number() }).partial().optional(),
    })
    .loose(),
);

export type BotThreads = {
  client: HeadlessThreadClient;
  listThreads: () => Promise<ThreadListItem[]>;
};

export function createBotThreads(options: {
  serverUrl: string;
  workspaceId: string;
  token: string;
}): BotThreads {
  const client = createHeadlessThreadClient({
    baseUrl: options.serverUrl,
    workspaceId: options.workspaceId,
    token: options.token,
  });

  const opencode = createOpencodeClient({
    baseUrl: `${options.serverUrl}/workspace/${encodeURIComponent(options.workspaceId)}/opencode`,
    headers: { Authorization: `Bearer ${options.token}` },
    redirect: "error",
  });

  async function listThreads(): Promise<ThreadListItem[]> {
    const result = await opencode.session.list();
    if (result.error !== undefined) {
      throw new Error(`Listing threads failed (${result.response?.status ?? "network"})`);
    }
    const sessions = sessionListSchema.parse(result.data ?? []);
    return sessions
      .filter((session) => !session.parentID)
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || "Untitled thread",
        createdAt: session.time?.created ?? 0,
        updatedAt: session.time?.updated ?? 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return { client, listThreads };
}
