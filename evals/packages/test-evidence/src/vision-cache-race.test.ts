import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { critiquePrompt, critiqueScreenshot } from "../../design-review/src/critique.ts";
import { judgeVision, visionModel } from "./validate.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const paths = new Set<string>();

beforeEach(() => {
  vi.mocked(writeFile).mockImplementation(fs.writeFile);
  vi.mocked(rename).mockImplementation(fs.rename);
});

afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all([...paths].map((path) => fs.rm(path, { force: true })));
  paths.clear();
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture(kind: "mandatory" | "advisory") {
  const hash = randomUUID();
  const model = visionModel();
  const expectations = ["The expected label is visible"];
  const input = { png: Buffer.from("fixture"), hash, caption: "Cache fixture", route: "/", layout: null, measured: [] };
  const rubric = { text: "Review the visible label", hash: "fixture" };
  const key = createHash("sha256").update(kind === "mandatory"
    ? hash + JSON.stringify(expectations) + model
    : `${hash}\n${model}\n${critiquePrompt(input, rubric)}`).digest("hex");
  const cachePath = join(root, "evals", "results", kind === "mandatory" ? ".vision-cache" : ".design-review-cache", `${key}.json`);
  paths.add(cachePath);
  return {
    cachePath,
    async run(evidence: string, bypassCache = false) {
      if (kind === "mandatory") {
        const result = await judgeVision({ png: input.png, hash, route: input.route, visibleText: "", at: "fixture" }, expectations, {
          bypassCache,
          ask: async ({ prompt }) => prompt.startsWith("Objectively")
            ? JSON.stringify({ description: evidence })
            : JSON.stringify({ results: [{ expectation: expectations[0], passed: true, evidence }] }),
        });
        return result.results[0]?.evidence;
      }
      const result = await critiqueScreenshot(input, rubric, {
        model,
        bypassCache,
        ask: async () => JSON.stringify({ findings: [{ rule: "OW-LIST", severity: "medium", title: "The visible label needs more space", evidence, where: null }] }),
      });
      return result[0]?.detail;
    },
  };
}

for (const kind of ["mandatory", "advisory"] satisfies Array<"mandatory" | "advisory">) {
  describe(`${kind} vision cache publication`, () => {
    test("overlapping differently sized responses leave concurrent readers complete entries", async () => {
      const { run, cachePath } = fixture(kind);
      expect(await run("previous complete entry")).toBe("previous complete entry");
      const long = "long response ".repeat(60).trim();
      const short = "short response";
      const started = [gate(), gate()];
      const finish = [gate(), gate()];
      const destinations: string[] = [];
      vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
        const index = destinations.length;
        const destination = String(path);
        destinations.push(destination);
        paths.add(destination);
        if (typeof data !== "string") throw new Error("Expected JSON text");
        const split = Math.floor(data.length / 2);
        await fs.writeFile(path, data.slice(0, split), options);
        started[index]?.release();
        await finish[index]?.promise;
        await fs.appendFile(path, data.slice(split), "utf8");
      });
      const first = run(long, true);
      await started[0]?.promise;
      const second = run(short, true);
      const writers = Promise.all([first, second]);
      try {
        await started[1]?.promise;
        // Both writes are deliberately paused halfway through their JSON.
        expect(await run("must not ask the provider")).toBe("previous complete entry");
        expect(new Set(destinations).size).toBe(2);
        expect(destinations.every((path) => path !== cachePath && dirname(path) === dirname(cachePath))).toBe(true);
        finish[1]?.release();
        expect(await second).toBe(short);
        expect(await run("must not ask the provider")).toBe(short);
        finish[0]?.release();
        expect(await first).toBe(long);
        expect(await run("must not ask the provider")).toBe(long);
        expect(JSON.parse(await readFile(cachePath, "utf8"))).toBeTruthy();
        expect((await fs.readdir(dirname(cachePath))).filter((name) => name.startsWith(`${basename(cachePath)}.`))).toEqual([]);
      } finally {
        for (const barrier of finish) barrier.release();
        await writers;
      }
    });

    for (const failure of ["write", "rename"]) {
      test(`a failed ${failure} removes its temporary file and preserves the existing cache and error`, async () => {
        const { run, cachePath } = fixture(kind);
        await run("previous complete entry");
        const error = new Error(`${failure} failed`);
        let temporaryPath = "";
        vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
          temporaryPath = String(path);
          paths.add(temporaryPath);
          await fs.writeFile(path, failure === "write" ? "partial JSON" : data, options);
          if (failure === "write") throw error;
        });
        if (failure === "rename") vi.mocked(rename).mockRejectedValue(error);
        await expect(run("replacement", true)).rejects.toBe(error);
        expect(temporaryPath).not.toBe(cachePath);
        await expect(fs.stat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await run("must not ask the provider")).toBe("previous complete entry");
      });
    }
  });
}

