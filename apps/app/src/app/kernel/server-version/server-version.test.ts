import { expect, test } from "bun:test";
import { isServerV2Enabled } from "./flag";
import { LOCAL_SERVER_ID, createRemoteServerId } from "./ids";
import { resolveServerVersionRoute } from "./routing";

test("server version routing defaults to legacy until Server V2 is opted in", () => {
  const previous = process.env.OPENWORK_UI_USE_SERVER_V2;
  delete process.env.OPENWORK_UI_USE_SERVER_V2;
  expect(isServerV2Enabled()).toBe(false);
  process.env.OPENWORK_UI_USE_SERVER_V2 = "1";
  expect(isServerV2Enabled()).toBe(true);
  if (previous === undefined) {
    delete process.env.OPENWORK_UI_USE_SERVER_V2;
  } else {
    process.env.OPENWORK_UI_USE_SERVER_V2 = previous;
  }
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
