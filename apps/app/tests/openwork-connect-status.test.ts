import { describe, expect, test } from "bun:test";

import {
  openWorkConnectAttentionTitle,
  resolveOpenWorkConnectStatus,
} from "../src/react-app/domains/connections/openwork-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../src/react-app/domains/connections/use-session-mcp-maintenance";

function maintenance(
  status: SessionCloudMcpMaintenanceState["status"],
): SessionCloudMcpMaintenanceState {
  return {
    status,
    issue: status === "failed"
      ? {
          code: "cloud_mcp_unavailable",
          stage: "engine_delivery",
          retryable: false,
          recommendedAction: "Run diagnostics",
          message: "Connected service tools could not be verified.",
        }
      : null,
    attempt: status === "retrying" ? 2 : 1,
    maxAttempts: 3,
  };
}

describe("OpenWork Connect status", () => {
  test("labels the diagnosed message as one possible issue for native tooltips", () => {
    expect(openWorkConnectAttentionTitle("Connected service tools could not be verified."))
      .toBe("One possible issue: Connected service tools could not be verified.");
  });

  test("is hidden while signed out", () => {
    expect(resolveOpenWorkConnectStatus(false, maintenance("ready"))).toBeNull();
  });

  test("maps the shared lifecycle to checking, ready, and needs attention", () => {
    expect(resolveOpenWorkConnectStatus(true, undefined)).toMatchObject({
      state: "checking",
      label: "Checking",
    });
    expect(resolveOpenWorkConnectStatus(true, maintenance("checking"))).toMatchObject({
      state: "checking",
      label: "Checking",
    });
    expect(resolveOpenWorkConnectStatus(true, maintenance("retrying"))).toMatchObject({
      state: "checking",
      description: "Restoring connected service tools (2/3).",
    });
    expect(resolveOpenWorkConnectStatus(true, maintenance("ready"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
    expect(resolveOpenWorkConnectStatus(true, maintenance("failed"))).toEqual({
      state: "needs_attention",
      label: "Needs attention",
      description: "Connected service tools could not be verified.",
    });
    expect(resolveOpenWorkConnectStatus(true, maintenance("skipped"))).toMatchObject({
      state: "needs_attention",
      label: "Needs attention",
    });
  });
});
