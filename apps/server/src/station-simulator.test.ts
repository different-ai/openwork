import { describe, expect, test } from "bun:test";

import {
  StationDevelopmentMcpSimulator,
  StationSimulatorUnavailableError,
} from "./station-simulator.js";
import { isReadOnlyStationCapability } from "./station.js";

describe("Station development MCP simulator", () => {
  test("discovers and executes only conservative read capabilities", () => {
    const simulator = new StationDevelopmentMcpSimulator();
    simulator.reset("workspace", "maya-memory", "maya-memory-ready");
    const result = simulator.research(
      "workspace",
      "Maya, do you remember the privacy concern from last week?",
    );
    expect(result.discoveredCapabilities.length).toBeGreaterThan(0);
    expect(result.discoveredCapabilities.every(isReadOnlyStationCapability)).toBe(true);
    expect(result.executedCapabilities).toEqual(result.discoveredCapabilities);
    expect(result.sourceProviders).toContain("Development Slack");
    expect(result.connectedContext).toContain("Source URL:");
    expect(result.connectedContext).not.toContain("\"suggestions\"");
  });

  test("connected-data patches produce no-result, failure, and recovery states over time", () => {
    const simulator = new StationDevelopmentMcpSimulator();
    simulator.reset("workspace", "mcp-recovery", "empty");
    expect(simulator.research("workspace", "Remember Maya’s concern").resultCategory).toBe("no-result");
    simulator.applyPatch("workspace", "mcp-recovery", "unavailable");
    expect(() => simulator.research("workspace", "Remember Maya’s concern"))
      .toThrow(StationSimulatorUnavailableError);
    simulator.applyPatch("workspace", "mcp-recovery", "maya-memory-ready");
    expect(simulator.research("workspace", "Remember Maya’s concern").resultCategory)
      .toBe("connected-data");
    expect(simulator.status("workspace").revision).toBe(3);
  });

  test("rejects a write-looking capability even when requested directly", () => {
    const simulator = new StationDevelopmentMcpSimulator();
    simulator.reset("workspace", "maya-memory", "maya-memory-ready");
    expect(() => simulator.execute("workspace", "sendSlackMessage"))
      .toThrow("not unambiguously read-only");
  });
});
