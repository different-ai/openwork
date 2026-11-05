import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@openwork/world", async importOriginal => ({
  ...await importOriginal<typeof import("@openwork/world")>(),
  launchHeadlessWeb: launch,
}));
vi.mock("./eval-engine.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./eval-engine.ts")>(),
  resolveEvalEngine: () => "v2",
}));

import { startLocalRuntime } from "./app-web-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

for (const engine of ["v1", "v2", undefined] satisfies Array<"v1" | "v2" | undefined>) {
  test(`appWeb ${engine ?? "default V2"} launches only the selected engine`, async () => {
    launch.mockResolvedValue({
      manifest: { webUrl: "http://127.0.0.1:8001", openworkUrl: "http://127.0.0.1:8002" },
      stop: async () => {},
    });
    // The launcher is replaced before any process can start. The fixture creates only isolated directories.
    const workspace = await mkdtemp(join(tmpdir(), "mcp-engine-selection-"));
    roots.push(workspace);
    const runtime = await startLocalRuntime("engine-selection-unit", workspace, { engine });
    roots.push(runtime.fixtureRoot);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      state: "isolated",
      v2Only: engine !== "v1",
      env: { OPENWORK_ENGINE_V2_PREVIEW: engine === "v1" ? "0" : "1" },
    });
    await runtime.stop();
  });
}
