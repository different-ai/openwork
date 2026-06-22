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
  const results: Array<{ role: string; match: string; before: string; after: string }> = [];
  const run = searcher.search({
    query,
    sessions: [session],
    onMatch: (match) => {
      results.push({
        role: match.role ?? "unknown",
        match: match.snippet?.match ?? "",
        before: match.snippet?.before ?? "",
        after: match.snippet?.after ?? "",
      });
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

    expect(results[0]).toMatchObject({
      role: "assistant",
      match: "redirect",
    });
    expect(results[0]?.after).toContain("authentication");
  });

  test("prefers the user's own matching message", async () => {
    const fetchMessages: SessionMessageFetcher = async () => [
      message("assistant", "The deployment error came from a missing Vercel token."),
      message("user", "Can you fix the Vercel deployment failure?"),
    ];

    const results = await search("deploy vercel", fetchMessages);

    expect(results[0]?.role).toBe("user");
  });

  test("does not highlight the full span when remembered words are far apart", async () => {
    const fetchMessages: SessionMessageFetcher = async () => [
      message("assistant", `deploy ${"lorem ipsum ".repeat(80)} vercel`),
    ];

    const results = await search("deploy vercel", fetchMessages);

    expect(results.length).toBe(1);
    expect(results[0]?.match).toBe("deploy");
    expect(results[0]?.match).not.toContain("vercel");
    expect(results[0]?.match.length).toBeLessThan(20);
  });

  test("does not fuzzy-match short identifiers or numeric ids", async () => {
    const searcher = createSessionSearcher(async () => [
      message("assistant", "Investigated issue 2331 in the node startup path."),
    ]);
    const results: string[] = [];

    for (const query of ["2332", "code"]) {
      const run = searcher.search({
        query,
        sessions: [session],
        onMatch: (match) => results.push(match.snippet?.match ?? ""),
        onProgress: () => undefined,
        concurrency: 1,
      });
      await run.done;
    }

    expect(results).toEqual([]);
  });

  test("matches non-ASCII query terms", async () => {
    const fetchMessages: SessionMessageFetcher = async () => [
      message("assistant", "Summarized the café menu translation notes."),
    ];

    const results = await search("café", fetchMessages);

    expect(results.length).toBe(1);
  });
});
