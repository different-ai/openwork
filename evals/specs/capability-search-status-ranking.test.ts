import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  compareCapabilityMatches,
  type CapabilityMatch,
} from "../../ee/apps/den-api/src/mcp/search.js";

function match(input: Pick<CapabilityMatch, "name" | "score"> & Partial<CapabilityMatch>): CapabilityMatch {
  return {
    method: "GET",
    path: "/v1/example",
    summary: input.name,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    ...input,
  };
}

test("capability search ranks stronger task matches above unrelated connection prompts", async ({ evidence }) => {
  const invitation = match({
    name: "postInvitations",
    method: "POST",
    path: "/v1/invitations",
    score: 5,
    summary: "Create organization invitation",
    hasBody: true,
    bodySchema: { type: "object", required: ["email", "role"] },
  });
  const microsoftConnection = match({
    name: "native:microsoft-365:*",
    method: "NATIVE",
    path: "https://www.microsoft.com/microsoft-365",
    score: 3,
    summary: "Microsoft 365 needs connection",
    kind: "connection_status",
  });

  const ranked = [microsoftConnection, invitation].sort(compareCapabilityMatches);

  expect(ranked.map((candidate) => candidate.name)).toEqual([
    "postInvitations",
    "native:microsoft-365:*",
  ]);
  expect(ranked[0]).toBe(invitation);
  expect(ranked[0]?.bodySchema).toEqual({ type: "object", required: ["email", "role"] });
  evidence.recordAssertionEvidence(
    "Task relevance leads capability search ordering",
    "The score-5 organization invitation capability and its request schema remain intact above the score-3 Microsoft 365 connection prompt.",
    true,
  );
});

test("an actionable connection prompt wins an equal-relevance tie", async ({ evidence }) => {
  const callable = match({ name: "getTeams", score: 5, summary: "List teams" });
  const connection = match({
    name: "native:microsoft-365:*",
    method: "NATIVE",
    path: "https://www.microsoft.com/microsoft-365",
    score: 5,
    summary: "Microsoft 365 needs connection",
    kind: "connection_status",
  });

  const ranked = [callable, connection].sort(compareCapabilityMatches);

  expect(ranked[0]?.kind).toBe("connection_status");
  evidence.recordAssertionEvidence(
    "Connection recovery stays actionable when relevance ties",
    "At the same lexical score, the connection-status row remains ahead of an ordinary callable capability.",
    true,
  );
});
