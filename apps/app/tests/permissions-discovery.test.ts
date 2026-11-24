import { expect, test } from "bun:test";
import { settingsWorkspaceState } from "@/react-app/domains/settings/state/workspace-discovery";
import { sandboxSettingsPollInterval } from "@/react-app/infra/use-sandbox";

test("only an authoritative workspace list can confirm a missing workspace", () => {
  expect(settingsWorkspaceState({ registry: "pending", workspaceFound: false, deadlineReached: false })).toBe("discovering");
  expect(settingsWorkspaceState({ registry: "pending", workspaceFound: true, deadlineReached: false })).toBe("discovering");
  expect(settingsWorkspaceState({ registry: "listed", workspaceFound: true, deadlineReached: false })).toBe("connected");
  expect(settingsWorkspaceState({ registry: "listed", workspaceFound: false, deadlineReached: false })).toBe("missing");
  expect(settingsWorkspaceState({ registry: "unreachable", workspaceFound: false, deadlineReached: false })).toBe("disconnected");
  expect(settingsWorkspaceState({ registry: "pending", workspaceFound: false, deadlineReached: true })).toBe("timed-out");
  expect(settingsWorkspaceState({ registry: "listed", workspaceFound: true, deadlineReached: true })).toBe("connected");
});

test("verification polls quickly in flight and retries an outage for two minutes", () => {
  expect(sandboxSettingsPollInterval(undefined, 0)).toBe(false);
  expect(sandboxSettingsPollInterval({ verification: "checking", pending: false }, 120_000)).toBe(1_000);
  expect(sandboxSettingsPollInterval({ verification: "unavailable", pending: false }, 119_999)).toBe(5_000);
  expect(sandboxSettingsPollInterval({ verification: "unavailable", pending: false }, 120_000)).toBe(false);
  expect(sandboxSettingsPollInterval({ verification: "refreshing", pending: false }, 120_000)).toBe(1_000);
  expect(sandboxSettingsPollInterval({ verification: "verified", pending: false }, 10_000)).toBe(false);
  expect(sandboxSettingsPollInterval({ verification: "verified", pending: true }, 120_000)).toBe(1_000);
});
