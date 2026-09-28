import { expect, test } from "bun:test";
import { loginAgentContextHeaders } from "../app/(den)/_lib/login-agent-context";

test("sends the signed MCP OAuth query for agent sign-up", () => {
  expect(loginAgentContextHeaders({ kind: "mcp-oauth", oauthQuery: "?client_id=a&exp=1&sig=s" }))
    .toEqual({ "x-openwork-oauth-query": "client_id=a&exp=1&sig=s" });
});

test("sends normalized device and claim codes", () => {
  expect(loginAgentContextHeaders({ kind: "device", userCode: "ABCD-2345" })).toEqual({ "x-openwork-device-user-code": "ABCD2345" });
  expect(loginAgentContextHeaders({ kind: "claim", userCode: "WXYZ-6789" })).toEqual({ "x-openwork-claim-user-code": "WXYZ6789" });
});

test("sends nothing for plain browser sign-in or empty values", () => {
  expect(loginAgentContextHeaders(undefined)).toBeNull();
  expect(loginAgentContextHeaders({ kind: "mcp-oauth", oauthQuery: "" })).toBeNull();
  expect(loginAgentContextHeaders({ kind: "device", userCode: " - " })).toBeNull();
});
