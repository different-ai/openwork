import { describe, expect, test } from "bun:test";

import { resolveAccountStatusLines } from "../src/react-app/domains/session/sidebar/account-status-lines";
import type { OpenWorkConnectStatus } from "../src/react-app/domains/connections/openwork-connect-status";

const readyRuntime = {
  variant: "connected" as const,
  label: "Ready for new tasks",
  detail: null,
};

const readyConnect: OpenWorkConnectStatus = {
  state: "ready",
  label: "Ready",
  description: "Connected service tools are available.",
};

describe("account status lines", () => {
  test("collapses a healthy workspace and Connect into a single Ready line", () => {
    expect(resolveAccountStatusLines({
      runtime: readyRuntime,
      connect: readyConnect,
      developerMode: false,
    })).toEqual([{
      variant: "connected",
      label: "Ready",
      detail: null,
    }]);
  });

  test("keeps Connect background checks out of the non-developer summary", () => {
    expect(resolveAccountStatusLines({
      runtime: readyRuntime,
      connect: {
        state: "checking",
        label: "Checking",
        description: "Checking connected service tools in the background.",
      },
      developerMode: false,
    })).toEqual([{
      variant: "connected",
      label: "Ready",
      detail: null,
    }]);
  });

  test("surfaces Connect attention without developer mode", () => {
    expect(resolveAccountStatusLines({
      runtime: readyRuntime,
      connect: {
        state: "needs_attention",
        label: "Needs attention",
        description: "Connected service tools could not be verified.",
      },
      developerMode: false,
    })).toEqual([{
      testId: "openwork-connect-status",
      variant: "disconnected",
      label: "Needs attention",
      detail: "Connected service tools could not be verified.",
    }]);
  });

  test("keeps the granular breakdown when developer mode is on", () => {
    expect(resolveAccountStatusLines({
      runtime: readyRuntime,
      connect: readyConnect,
      developerMode: true,
    })).toEqual([
      {
        variant: "connected",
        label: "Ready for new tasks",
        detail: null,
      },
      {
        testId: "openwork-connect-status",
        variant: "connected",
        label: "OpenWork Connect: Ready",
        detail: "Connected service tools are available.",
      },
    ]);
  });
});
