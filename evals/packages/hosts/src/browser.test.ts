import { afterEach, expect, test, vi } from "vitest";
import { chrome } from "./browser.ts";
import type { Host, SurfaceHandle } from "./types.ts";

vi.mock("@openwork/cdp", () => ({
  attachSurface: vi.fn(async () => ({
    client: { send: vi.fn(async () => undefined) },
    stop: vi.fn(async () => undefined),
  })),
}));

afterEach(() => vi.clearAllMocks());

test("chrome forwards the exact caller profile and windowed option to its host", async () => {
  const handle: SurfaceHandle = { name: "oauth", kind: "chrome", hostKind: "daytona", cdpUrl: "http://localhost:9222" };
  const host: Host = {
    kind: "daytona",
    workspaceRoot: "/home/daytona",
    spawnElectron: async () => { throw new Error("Not used"); },
    spawnChrome: vi.fn(async () => handle),
    disposeSurface: vi.fn(async () => undefined),
  };
  const surface = await chrome({
    host, name: "oauth", profileDir: "/home/daytona/workshop/browser", headless: false,
  });

  expect(host.spawnChrome).toHaveBeenCalledWith("oauth", expect.objectContaining({
    profileDir: "/home/daytona/workshop/browser", headless: false,
  }));
  await surface.stop();
  expect(host.disposeSurface).toHaveBeenCalledWith(handle);
});
