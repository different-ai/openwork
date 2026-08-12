import { afterEach, describe, expect, test } from "bun:test";

import { shouldDeferInPlaceEngineReload } from "./engine-reload-defer.js";
import { clearEnginePoolForConfig, setEnginePoolForConfig, type EnginePool } from "./engine-pool.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

function fixtureConfig(engineRollover: boolean): ServerConfig {
  return {
    engineRollover,
  } as ServerConfig;
}

const workspace: WorkspaceInfo = { id: "ws_test", path: "/tmp/workspace", workspaceType: "local" } as WorkspaceInfo;

describe("shouldDeferInPlaceEngineReload", () => {
  afterEach(() => {
    clearEnginePoolForConfig(fixtureConfig(true));
  });

  test("defers when the engine has active sessions and no rollover pool", async () => {
    const config = fixtureConfig(false);
    const hasActiveSessions = async () => true;
    expect(await shouldDeferInPlaceEngineReload(config, workspace, hasActiveSessions)).toBe(true);
  });

  test("does not defer when the engine is idle", async () => {
    const config = fixtureConfig(false);
    const hasActiveSessions = async () => false;
    expect(await shouldDeferInPlaceEngineReload(config, workspace, hasActiveSessions)).toBe(false);
  });

  test("never defers when a rollover pool exists, even with active sessions", async () => {
    const config = fixtureConfig(true);
    const pool = { adoptPrimary: () => undefined } as unknown as EnginePool;
    setEnginePoolForConfig(config, pool);
    const hasActiveSessions = async () => true;
    expect(await shouldDeferInPlaceEngineReload(config, workspace, hasActiveSessions)).toBe(false);
  });

  test("does not probe sessions when a rollover pool exists", async () => {
    const config = fixtureConfig(true);
    const pool = { adoptPrimary: () => undefined } as unknown as EnginePool;
    setEnginePoolForConfig(config, pool);
    let probed = false;
    const hasActiveSessions: Parameters<typeof shouldDeferInPlaceEngineReload>[2] = async () => {
      probed = true;
      return true;
    };
    expect(await shouldDeferInPlaceEngineReload(config, workspace, hasActiveSessions)).toBe(false);
    expect(probed).toBe(false);
  });

  test("rollover flag alone does not count as a pool until one is set", async () => {
    const config = fixtureConfig(true);
    const hasActiveSessions = async () => true;
    expect(await shouldDeferInPlaceEngineReload(config, workspace, hasActiveSessions)).toBe(true);
  });
});