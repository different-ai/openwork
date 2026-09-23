import { describe, expect, test } from "bun:test";

import {
  type DenMcpDiscovery,
  type McpServerCheckWords,
  mcpServerChecks,
  mcpServerChecksPassed,
  parseDenMcpDiscovery,
} from "../src/app/lib/den-mcp-discovery";

const words: McpServerCheckWords = {
  reachOk: "answered",
  reachFail: "nothing answered",
  protocolOk: (version) => `speaks MCP ${version ?? ""}`.trim(),
  protocolFail: "not MCP",
  signInOauth: "own account",
  signInNone: "no sign-in",
  signInKey: "key",
  signInUnknown: "unknown",
  registrationDynamic: "registers itself",
  registrationMetadata: "introduces itself",
  registrationManual: "admin registers",
  toolsReady: (count) => `${count} tools`,
  toolsAfterSignIn: "after sign-in",
  toolsNone: "no tools",
};

function oauthServer(methods: DenMcpDiscovery["authentication"]["availableRegistrationMethods"], status: DenMcpDiscovery["status"] = "ready"): DenMcpDiscovery {
  return {
    status,
    server: { url: "https://mcp.example.com/mcp", protocolVersion: "2025-06-18", initialize: "authentication_required" },
    authentication: { kind: "oauth", availableRegistrationMethods: methods, recommendedRegistrationMethod: methods.includes("dynamic") ? "dynamic" : "pre_registered" },
    tools: { visibility: "requires_auth" },
    manualRequirements: [],
  };
}

const rows = (discovery: DenMcpDiscovery) => mcpServerChecks(discovery, words).map((check) => `${check.id} ${check.status}${check.term ? ` ${check.term}` : ""}`);

describe("Add an MCP server checks, from Den's discovery", () => {
  test("a server OpenWork can register with passes every check", () => {
    expect(rows(oauthServer(["pre_registered", "dynamic"]))).toEqual([
      "reach pass",
      "protocol pass MCP initialize",
      "sign-in pass OAuth",
      "registration pass DCR",
      "tools pass",
    ]);
    expect(rows(oauthServer(["pre_registered", "client_metadata"]))).toContain("registration pass CIMD");
  });

  test("a server that only takes a client an admin registers is flagged, not blocked", () => {
    const checks = mcpServerChecks(oauthServer(["pre_registered"], "manual_action_required"), words);
    expect(checks.find((check) => check.id === "registration")).toEqual({ id: "registration", status: "warn", detail: "admin registers", term: "Pre-registered client" });
    expect(mcpServerChecksPassed(checks)).toBe(true);
  });

  test("an address with nothing behind it stops after the first check", () => {
    const checks = mcpServerChecks({ ...oauthServer([]), status: "unreachable", server: { url: "https://mcp.example.com/mcp", initialize: "failed" } }, words);
    expect(checks.map((check) => `${check.id} ${check.status}`)).toEqual(["reach fail", "protocol skip"]);
    expect(mcpServerChecksPassed(checks)).toBe(false);
  });

  test("reads Den's answer as sent, extra fields and all, and rejects anything else", () => {
    const payload = { ...oauthServer(["dynamic"]), authentication: { ...oauthServer(["dynamic"]).authentication, authorizationServers: [{ issuer: "https://auth.example.com" }] } };
    expect(parseDenMcpDiscovery(payload)?.authentication.availableRegistrationMethods).toEqual(["dynamic"]);
    expect(parseDenMcpDiscovery({ status: "ready" })).toBeNull();
  });
});
