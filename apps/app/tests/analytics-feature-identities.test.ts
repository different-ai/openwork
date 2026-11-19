import { expect, test } from "bun:test";
import { MCP_QUICK_CONNECT, isBuiltInOpenWorkExtension } from "../src/app/constants";
import { connectorAnalyticsIdentity } from "../src/react-app/domains/connections/analytics-feature-identities";

test("only an actual built-in catalog entry can emit a connector id", () => {
  const builtin = MCP_QUICK_CONNECT.find(isBuiltInOpenWorkExtension);
  expect(builtin).toBeDefined();
  if (!builtin) return;
  expect(connectorAnalyticsIdentity(builtin).connector_kind).toBe("catalog");
  const custom = { ...builtin, name: "private service", url: "https://private.example/mcp" };
  expect(connectorAnalyticsIdentity(custom)).toEqual({ connector_kind: "custom" });
  expect(connectorAnalyticsIdentity({ name: "private service", id: "private-id", description: "private", url: "https://private.example/mcp", oauth: true })).toEqual({ connector_kind: "custom" });
});
