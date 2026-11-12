import { expect, test } from "bun:test";
import {
  automationRunConnectionFix,
  automationRunNotice,
  runStatusLabel,
} from "../src/react-app/domains/automations/automation-format.ts";

const run = {
  status: "failed" as const,
  attemptCount: 1,
  startedAt: 1,
  error: {
    code: "connection_action_required" as const,
    message: "Gmail needs to be reconnected, so this run could not use it. Reconnect Gmail in OpenWork, then run the Automation again.",
    retryable: false,
  },
};
const warning = {
  type: "warning" as const,
  payload: {
    code: "connection_action_required",
    connectionId: "mcp_gmail",
    connectionName: "Gmail",
    state: "reauth_required",
  },
};

test("a run that could not use a connection reads as needing that connection, not as completed", () => {
  expect(runStatusLabel(run)).toBe("Connection needed");
  expect(automationRunNotice(run)).toEqual({ variant: "destructive", title: "Connection needed", message: run.error.message });
});

test("the run links to the connection on Your Connections in the signed-in Den", () => {
  expect(automationRunConnectionFix(run, [{ type: "assistant", payload: { text: "Done" } }, warning], "https://den.example")).toEqual({
    label: "Reconnect Gmail",
    url: "https://den.example/dashboard/your-connections?connectionId=mcp_gmail",
  });
  expect(automationRunConnectionFix(run, [{ ...warning, payload: { ...warning.payload, state: "needs_connection" } }], "https://den.example")?.label).toBe("Connect Gmail");
  // A link in the run's own data is ignored; only the connection id is used.
  expect(automationRunConnectionFix(run, [{ ...warning, payload: { ...warning.payload, connectionId: "a&b", actionUrl: "https://elsewhere.example" } }], "https://den.example")?.url)
    .toBe("https://den.example/dashboard/your-connections?connectionId=a%26b");
  // No link without the run's own error or a Den to open it on.
  expect(automationRunConnectionFix({ error: null }, [warning], "https://den.example")).toBeNull();
  expect(automationRunConnectionFix(run, [warning], "")).toBeNull();
});
