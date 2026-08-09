import { describe, expect, test } from "bun:test";

import {
  openWorkConnectAttentionTitle,
  resolveOpenWorkConnectStateSummary,
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
  test("distinguishes missing, disabled, and unreadable Connect state", () => {
    expect(resolveOpenWorkConnectStateSummary("missing", false)).toEqual({
      status: "not_configured",
      statusLabel: "Not configured",
      tone: "neutral",
      stageLabel: "Connect setup is not finished",
      recommendedAction: "Sign in to OpenWork Cloud to finish setup.",
    });
    expect(resolveOpenWorkConnectStateSummary("available", false)).toEqual({
      status: "disabled",
      statusLabel: "Disabled",
      tone: "neutral",
      stageLabel: "Disabled by organization policy",
      recommendedAction: "Ask an organization admin to enable Connect.",
    });
    for (const status of ["invalid", "unreadable"] satisfies Array<"invalid" | "unreadable">) {
      expect(resolveOpenWorkConnectStateSummary(status, false)).toEqual({
        status: "unavailable",
        statusLabel: "Needs attention",
        tone: "error",
        stageLabel: "Connect settings are unavailable",
        recommendedAction: "Restart OpenWork. If this continues, run diagnostics.",
      });
    }
  });

  test("labels the diagnosed message as one possible issue for native tooltips", () => {
    expect(openWorkConnectAttentionTitle("Connected service tools could not be verified."))
      .toBe("One possible issue: Connected service tools could not be verified.");
  });

  test("is hidden while signed out", () => {
    expect(resolveOpenWorkConnectStatus(false, maintenance("ready"))).toBeNull();
  });

  test("shows the verified Cloud connection while workspace maintenance is idle", () => {
    expect(resolveOpenWorkConnectStatus(true, undefined)).toEqual({
      state: "ready",
      label: "Ready",
      description: "Signed in to OpenWork Cloud. Connected service tools will be checked when a workspace is active.",
    });
    expect(resolveOpenWorkConnectStatus(true, maintenance("idle"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
  });

  test("maps the active lifecycle to checking, ready, and needs attention", () => {
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
