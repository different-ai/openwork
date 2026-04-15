// @ts-nocheck
import { expect, test } from "bun:test";
import { parseServerV2Flag } from "./flag";
import { LOCAL_SERVER_ID, createRemoteServerId } from "./ids";
import { resolveServerVersionRoute } from "./routing";

test("parseServerV2Flag accepts common truthy values", () => {
  expect(parseServerV2Flag("1")).toBe(true);
  expect(parseServerV2Flag("true")).toBe(true);
  expect(parseServerV2Flag("yes")).toBe(true);
  expect(parseServerV2Flag("on")).toBe(true);
  expect(parseServerV2Flag("0")).toBe(false);
  expect(parseServerV2Flag(undefined)).toBe(false);
});

test("createRemoteServerId keeps local server stable and remote ids deterministic", () => {
  expect(LOCAL_SERVER_ID).toBe("srv_local");
  expect(createRemoteServerId("http://localhost:8787")).toBe(createRemoteServerId("localhost:8787"));
});

test("routing prefers Server V2 only when rollout is enabled", () => {
  expect(resolveServerVersionRoute({
    contractHint: "unknown",
    feature: "system-health",
    rolloutEnabled: false,
    targetKind: "local",
  })).toMatchObject({ primary: "legacy", fallback: "none" });

  expect(resolveServerVersionRoute({
    contractHint: "server-v2",
    feature: "system-status",
    rolloutEnabled: true,
    targetKind: "local",
  })).toMatchObject({ primary: "server-v2", fallback: "legacy" });

  expect(resolveServerVersionRoute({
    contractHint: "server-v2",
    feature: "workspace-read",
    rolloutEnabled: true,
    targetKind: "local",
  })).toMatchObject({ primary: "server-v2", fallback: "legacy" });
});
