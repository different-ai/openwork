import { expect, test } from "bun:test";
import { isServerV2Enabled } from "./flag";
import { LOCAL_SERVER_ID, createRemoteServerId } from "./ids";
import { resolveServerVersionRoute } from "./routing";

test("server version routing is always enabled for Server V2", () => {
  expect(isServerV2Enabled()).toBe(true);
});

test("createRemoteServerId keeps local server stable and remote ids deterministic", () => {
  expect(LOCAL_SERVER_ID).toBe("srv_local");
  expect(createRemoteServerId("http://localhost:8787")).toBe(createRemoteServerId("localhost:8787"));
});

test("routing now defaults to Server V2 after cutover", () => {
  expect(resolveServerVersionRoute({
    contractHint: "unknown",
    feature: "system-health",
    targetKind: "local",
  })).toMatchObject({ primary: "server-v2", fallback: "legacy" });

  expect(resolveServerVersionRoute({
    contractHint: "server-v2",
    feature: "system-status",
    targetKind: "local",
  })).toMatchObject({ primary: "server-v2", fallback: "legacy" });

  expect(resolveServerVersionRoute({
    contractHint: "server-v2",
    feature: "workspace-read",
    targetKind: "local",
  })).toMatchObject({ primary: "server-v2", fallback: "legacy" });
});
