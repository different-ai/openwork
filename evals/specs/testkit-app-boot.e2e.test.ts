import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import { expectVisualEvidence } from "@openwork/test-evidence/vitest";
import { app, localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

const expectation = "The OpenWork workspace shell is visible and ready for a task";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "testkit app boot skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "testkit app boot skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "testkit app boot skipped — needs MySQL on 127.0.0.1:3306"
      : "testkit boots a local Den and signed-in app with ambient evidence";

async function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  let apiPort = 0;
  let webPort = 0;
  {
    await using den = await server({ place });
    expect(den.ports).toBeDefined();
    if (!den.ports) throw new Error("The local testkit Den did not expose its ports.");
    apiPort = den.ports.api;
    webPort = den.ports.web;

    await using desktopApp = await app({ den, as: "admin", place });
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [expectation], {
      ask: async (request) => request.prompt.startsWith("Objectively describe")
        ? JSON.stringify({ description: "An OpenWork workspace shell with navigation and a task composer." })
        : JSON.stringify({
          results: [{
            expectation,
            passed: true,
            evidence: "The workspace navigation and task composer are visible.",
          }],
        }),
    });
    expectVisualEvidence(seen);
  }

  expect(await portCanBind(apiPort)).toBe(true);
  expect(await portCanBind(webPort)).toBe(true);

  await evidence.close();
  const testRun: unknown = JSON.parse(await readFile(join(evidence.dir, "test-run.json"), "utf8"));
  expect(testRun).toMatchObject({
    summary: {
      ok: true,
      totalArtifacts: 1,
      passedArtifacts: 1,
      unvalidatedArtifacts: 0,
    },
    artifacts: [{
      caption: expectation,
      fileName: expect.stringMatching(/\.png$/),
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ok: true,
    }],
  });
});
