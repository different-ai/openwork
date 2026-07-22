import { describe, expect, test } from "bun:test";

import type { OpenworkSessionMessage } from "../src/app/lib/openwork-server";
import {
  createSessionSearcher,
  type SearchableSession,
  type SessionSearchMatch,
} from "../src/react-app/domains/session/search/session-search";

const session: SearchableSession = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  title: "Searchable session",
  workspaceTitle: "Workspace A",
  updatedAt: 1,
};

function textMessage(id: string, role: "user" | "assistant", text: string) {
  return {
    info: {
      id,
      role,
      sessionID: session.sessionId,
      time: { created: 1 },
    },
    parts: [
      {
        id: `part-${id}`,
        type: "text",
        text,
        sessionID: session.sessionId,
        messageID: id,
      },
    ],
  } satisfies OpenworkSessionMessage;
}

describe("session search", () => {
  test("includes the matching message id", async () => {
    const searcher = createSessionSearcher(async () => [
      textMessage("msg-user", "user", "Find this exact phrase"),
    ]);
    const matches: SessionSearchMatch[] = [];
    const run = searcher.search({
      query: "exact",
      sessions: [session],
      onMatch: (match) => matches.push(match),
      onProgress: () => {},
      concurrency: 1,
    });

    await run.done;

    expect(matches[0]?.kind).toBe("message");
    expect(matches[0]?.messageId).toBe("msg-user");
  });
});
