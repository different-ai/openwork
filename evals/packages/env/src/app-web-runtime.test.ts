import { rm } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { startLocalRuntime } from "./app-web-runtime.ts";
import type { EvalEngine } from "./eval-engine.ts";

const launcher = vi.hoisted(() => vi.fn(async () => ({
  manifest: { webUrl: "http://127.0.0.1:42001", openworkUrl: "http://127.0.0.1:42002" },
  stop: async () => {},
})));
vi.mock("@openwork/world", async (importOriginal) => ({
  ...await importOriginal<typeof import("@openwork/world")>(),
  launchHeadlessWeb: launcher,
}));
vi.mock("./app-web-bootstrap.ts", () => ({ seedSyntheticPreactivatedDen: async () => ({}) }));

const engines: EvalEngine[] = ["v1", "v2"];
for (const engine of engines) {
  test(`appWeb launches only the selected ${engine} engine`, async () => {
    launcher.mockClear();
    const runtime = await startLocalRuntime(`selected-${engine}`, import.meta.dirname, { engine });
    try {
      expect(launcher).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        v2Only: engine === "v2",
        env: expect.objectContaining({ OPENWORK_ENGINE_V2_PREVIEW: engine === "v2" ? "1" : "0" }),
      }));
    } finally {
      await runtime.stop();
      await rm(runtime.fixtureRoot, { recursive: true, force: true });
    }
  });
}
