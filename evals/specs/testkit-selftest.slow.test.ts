import { createServer } from "node:net";
import { expect } from "vitest";
import { signIn } from "@openwork/behaviors";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1";
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "testkit local server skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in"
  : !localPlacement
    ? "testkit local server skipped: unset OPENWORK_EVAL_DAYTONA for the local boot selftest"
    : !mysqlOpen
      ? "testkit local server skipped: run pnpm dev:den:mysql"
      : "testkit boots and fully disposes an isolated local Den";

async function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

test("skipped — needs: set OPENWORK_TESTKIT_INTENTIONALLY_MISSING", ({ place }) => {
  void place;
  needs({ env: ["OPENWORK_TESTKIT_INTENTIONALLY_MISSING"] });
});

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ place }) => {
  const den = await server({ place });
  const database = den.database;
  const ports = den.ports;
  expect(database).toBeDefined();
  expect(ports).toBeDefined();
  if (!database || !ports) throw new Error("Local server did not expose its database and ports.");
  try {
    const health = await fetch(`${den.ref.apiUrl}/health`);
    expect(health.ok).toBe(true);
    expect((await signIn(den.ref, den.admin)).email).toBe(den.admin.email);
    expect(Object.keys(den.members).length).toBeGreaterThan(0);
    expect(await database.exists()).toBe(true);
  } finally {
    await den[Symbol.asyncDispose]();
  }
  expect(await portCanBind(ports.api)).toBe(true);
  expect(await portCanBind(ports.web)).toBe(true);
  expect(await database.exists()).toBe(false);
  await den[Symbol.asyncDispose]();
});
