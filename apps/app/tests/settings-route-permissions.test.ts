import { describe, expect, test } from "bun:test";

import { resolveCanManageMcp } from "../src/react-app/shell/settings-route-permissions";

describe("resolveCanManageMcp", () => {
  test("allows local fallback when no OpenWork server is connected", () => {
    expect(resolveCanManageMcp({ serverConnected: false, serverMcpWrite: null, isRemoteWorkspace: false })).toBe(true);
  });

  test("keeps remote workspaces read-only without a writable OpenWork server", () => {
    expect(resolveCanManageMcp({ serverConnected: false, serverMcpWrite: null, isRemoteWorkspace: true })).toBe(false);
    expect(resolveCanManageMcp({ serverConnected: true, serverMcpWrite: false, isRemoteWorkspace: true })).toBe(false);
  });

  test("uses server write capability as the source of truth when connected", () => {
    expect(resolveCanManageMcp({ serverConnected: true, serverMcpWrite: true, isRemoteWorkspace: true })).toBe(true);
    expect(resolveCanManageMcp({ serverConnected: true, serverMcpWrite: true, isRemoteWorkspace: false })).toBe(true);
    expect(resolveCanManageMcp({ serverConnected: true, serverMcpWrite: false, isRemoteWorkspace: false })).toBe(false);
  });
});
