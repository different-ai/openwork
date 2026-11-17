import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEvidence } from "./test-evidence.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("process timing at evidence finalization", () => {
  for (const outcome of ["passed", "failed", "skipped"] satisfies Array<"passed" | "failed" | "skipped">) {
    it(`reports ${outcome} once from the stored step records, without free text`, async () => {
      const requests: unknown[] = [];
      vi.stubEnv("OPENWORK_PROCESS_TIMING_URL", "https://invalid.test/timing");
      vi.stubEnv("OPENWORK_PROCESS_TIMING_KEY", "private-key");
      vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
        requests.push(JSON.parse(String(options.body)));
        return new Response(null, { status: 204 });
      });
      const dir = await mkdtemp(join(tmpdir(), "evals-timing-"));
      directories.push(dir);
      const evidence = createTestEvidence({ name: "Private spec title", specFile: "/private/spec.test.ts", outDir: dir });
      evidence.recordStep({ name: "Private step description", depth: 0, ok: true, ms: 1234 });
      evidence.recordStep({ name: "Private failure", depth: 1, ok: false, ms: 500, error: "Private error" });
      evidence.recordStep({ name: "Private unreached", depth: 0, ok: "not-reached" });
      evidence.setOutcome(outcome);
      await Promise.all([evidence.close(), evidence.close()]);
      const record = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        process: "evals", startedAt: record.createdAt,
        totalSeconds: expect.closeTo((Date.parse(record.closedAt) - Date.parse(record.createdAt)) / 1000, 3),
        outcome: outcome === "failed" ? "fail" : "ok",
        steps: [
          { step: `spec:${record.steps[0].seq}`, seconds: record.steps[0].ms / 1000, outcome: "ok" },
          { step: `spec:${record.steps[1].seq}`, seconds: record.steps[1].ms / 1000, outcome: "fail" },
          { step: `spec:${record.steps[2].seq}`, seconds: 0, outcome: "skipped" },
        ],
      });
      expect(JSON.stringify(requests)).not.toContain("Private");
      expect(JSON.stringify(requests)).not.toContain("private-key");
    });
  }

  it("still emits a fixed run phase when no steps were reached", async () => {
    const requests: unknown[] = [];
    vi.stubEnv("OPENWORK_PROCESS_TIMING_URL", "https://invalid.test/timing");
    vi.stubEnv("OPENWORK_PROCESS_TIMING_KEY", "private-key");
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      requests.push(JSON.parse(String(options.body)));
      return new Response(null, { status: 204 });
    });
    const dir = await mkdtemp(join(tmpdir(), "evals-timing-"));
    directories.push(dir);
    const evidence = createTestEvidence({ name: "Private title", outDir: dir });
    evidence.setOutcome("failed");
    await evidence.close();
    expect(requests[0]).toMatchObject({ process: "evals", outcome: "fail", steps: [{ step: "run", outcome: "fail", seconds: expect.any(Number) }] });
  });
});
