import { describe, expect, test } from "bun:test";

import {
  createSessionSearcher,
  type SearchableSession,
  type SessionMessageFetcher,
} from "../src/react-app/domains/session/search/session-search";

const session: SearchableSession = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  title: "Auth callback debugging",
  workspaceTitle: "OpenWork",
  updatedAt: 123,
};

function message(role: "user" | "assistant", text: string) {
  return JSON.parse(JSON.stringify({
    info: { role },
    parts: [{ type: "text", text }],
  }));
}

async function search(query: string, fetchMessages: SessionMessageFetcher) {
  const searcher = createSessionSearcher(fetchMessages);
  const results: string[] = [];
  const run = searcher.search({
    query,
    sessions: [session],
    onMatch: (match) => {
      results.push(`${match.role ?? "unknown"}:${match.snippet?.match ?? ""}`);
    },
    onProgress: () => undefined,
    concurrency: 1,
  });
  await run.done;
  return results;
}

describe("session transcript search", () => {
  test("matches remembered words without requiring the exact phrase", async () => {
    const fetchMessages: SessionMessageFetcher = async () => [
      message("assistant", "The OAuth redirect failed after the authentication callback returned."),
    ];

    const results = await search("auth redirect", fetchMessages);

    expect(results).toEqual([
      "assistant:redirect failed after the authentication",
    ]);
  });

  test("prefers the user's own matching message", async () => {
    const fetchMessages: SessionMessageFetcher = async () => [
      message("assistant", "The deployment error came from a missing Vercel token."),
      message("user", "Can you fix the Vercel deployment failure?"),
    ];

    const results = await search("deploy vercel", fetchMessages);

    expect(results[0]?.startsWith("user:")).toBe(true);
  });

  test("matches small typos", async () => {
    const fetchMessages: SessionMessageFetcher = async () => [
      message("assistant", "Updated the environment variable configuration."),
    ];

    const results = await search("enviroment config", fetchMessages);

    expect(results.length).toBe(1);
  });
});
