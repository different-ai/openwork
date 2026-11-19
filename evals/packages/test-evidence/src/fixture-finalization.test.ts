import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const evalsRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vitest = join(evalsRoot, "node_modules/vitest/vitest.mjs");
const fixtureModule = fileURLToPath(new URL("./vitest.ts", import.meta.url));

for (const teardownFails of [false, true]) {
  test(`real evidence is finalized when fixture teardown ${teardownFails ? "fails" : "succeeds"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "evidence-fixture-"));
    try {
      const fixture = join(directory, "fixture.test.ts");
      const config = join(directory, "vitest.config.mjs");
      await writeFile(config, `export default { test: { include: [${JSON.stringify(fixture)}], environment: "node" } };`);
      await writeFile(fixture, `
        import { test as base } from ${JSON.stringify(fixtureModule)};
        import { writeFileSync } from "node:fs";
        const test = base.extend({
          teardown: [async ({}, use) => {
            await use(null);
            ${teardownFails ? 'throw new Error("Expected fixture teardown failure");' : ""}
          }, { auto: true }],
        });
        test("fixture finalization regression", async ({ evidence, teardown }) => {
          writeFileSync(${JSON.stringify(join(directory, "evidence-dir"))}, evidence.dir);
          evidence.recordAssertionEvidence("The real body completed", "Assertion recorded before teardown", true);
          evidence.setOutcome("passed");
        });
      `);
      const result = await exec(process.execPath, [vitest, "run", "--config", config], { cwd: evalsRoot })
        .then(value => ({ ...value, code: 0 }), (error: unknown) => {
          if (!(error instanceof Error) || !("stdout" in error) || !("code" in error)) throw error;
          return { stdout: String(error.stdout), code: error.code };
        });
      expect(result.code).toBe(teardownFails ? 1 : 0);
      const evidenceDir = await readFile(join(directory, "evidence-dir"), "utf8");
      const record = JSON.parse(await readFile(join(evidenceDir, "test-run.json"), "utf8"));
      expect(record.outcome).toBe(teardownFails ? "failed" : "passed");
      expect(record.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ caption: "The real body completed", ok: true })]));
      if (teardownFails) expect(record.failure).toBe("Test failed during fixture teardown.");
      await rm(evidenceDir, { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
