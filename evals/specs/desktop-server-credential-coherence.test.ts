import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "@openwork/testkit";
import { expect } from "vitest";

import { migrateOpenworkServerTokenStore } from "../../apps/desktop/electron/runtime.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("desktop server credentials remain coherent across workspaces and reconnects", ({ evidence }) => {
  const migrated = migrateOpenworkServerTokenStore({
    version: 1,
    workspaces: {
      "/workspace/older": {
        clientToken: "older-client",
        hostToken: "older-host",
        ownerToken: "older-owner",
        updatedAt: 10,
      },
      "/workspace/current": {
        clientToken: "current-client",
        hostToken: "current-host",
        ownerToken: "current-owner",
        updatedAt: 20,
      },
    },
  });

  expect(migrated).toEqual({
    version: 2,
    credentials: {
      clientToken: "current-client",
      hostToken: "current-host",
      ownerToken: "current-owner",
      updatedAt: 20,
    },
  });
  expect(migrated).not.toHaveProperty("workspaces");
  expect(migrateOpenworkServerTokenStore(migrated)).toEqual(migrated);

  const reconnect = spawnSync("pnpm", [
    "--dir",
    "apps/app",
    "exec",
    "bun",
    "test",
    "--isolate",
    "--test-name-pattern",
    "desktop reconnect persists the complete live server credential bundle",
    "tests/gateway-runtime.test.ts",
  ], { cwd: repoRoot, encoding: "utf8" });
  const output = `${reconnect.stdout}${reconnect.stderr}`;
  expect(reconnect.error, output).toBeUndefined();
  expect(reconnect.status, output).toBe(0);
  expect(output).toContain("1 pass");
  expect(output).toContain("0 fail");

  evidence.recordAssertionEvidence(
    "One desktop server owns one credential bundle",
    "Legacy workspace credentials migrate to one global client, host, and owner token bundle with no workspace-scoped credentials remaining.",
    !Object.hasOwn(migrated, "workspaces"),
  );
  evidence.recordAssertionEvidence(
    "Reconnect cannot combine credentials from different server generations",
    "The renderer regression suite confirms that reconnect replaces both stale client and host tokens with the live server pair.",
    reconnect.status === 0,
  );
});
