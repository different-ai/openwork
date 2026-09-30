import { describe, expect, test } from "bun:test";
import { legacyConnectorRedirects } from "../next-config-legacy-connector-redirects.cjs";

describe("old connector editor URLs", () => {
  test("land on the connector list, the connector page, or its setup page", () => {
    const rules = legacyConnectorRedirects();
    expect(rules.every((rule) => rule.permanent === false)).toBe(true);
    expect(rules.map(({ source, destination, has }) => ({ source, destination, query: has?.[0]?.key }))).toEqual([
      { source: "/dashboard/mcp-connections/all", destination: "/dashboard/mcp-connections", query: undefined },
      { source: "/dashboard/mcp-connections/all/:connectorId", destination: "/dashboard/mcp-connections/:connectorId", query: undefined },
      { source: "/dashboard/mcp-connections/configured", destination: "/dashboard/mcp-connections/:connectionId", query: "connectionId" },
      { source: "/dashboard/mcp-connections/configured", destination: "/dashboard/mcp-connections", query: undefined },
      { source: "/dashboard/mcp-connections", destination: "/dashboard/mcp-connections/new/:catalogId", query: "quickAdd" },
    ]);
  });
});
