import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  __setCloudMcpMaintenanceOutcomeStorageForTest,
  readCloudMcpMaintenanceOutcome,
  recordCloudMcpMaintenanceOutcome,
} from "../src/react-app/domains/connections/cloud-mcp-maintenance-outcome";
import { runSessionMcpMaintenanceTask } from "../src/react-app/domains/connections/use-session-mcp-maintenance";

let storageValues: Map<string, string>;

function installStorageStub() {
  storageValues = new Map();
  __setCloudMcpMaintenanceOutcomeStorageForTest({
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: (key) => storageValues.delete(key),
  });
}

afterAll(() => {
  __setCloudMcpMaintenanceOutcomeStorageForTest(null);
});

describe("cloud MCP maintenance watchdog", () => {
  beforeEach(() => installStorageStub());

  test("a hung tick releases the lock after the timeout and records timed_out", async () => {
    const targetKey = "target-hung";
    let secondRan = false;

    const first = await runSessionMcpMaintenanceTask({
      targetKey,
      task: () => new Promise<void>(() => {
        // never settles — simulates a network await with no timeout
      }),
      timeoutMs: 10,
    });
    expect(first).toBe(true);
    expect(readCloudMcpMaintenanceOutcome(targetKey)?.status).toBe("timed_out");

    // The lock must be free: the next tick for the same target executes.
    const second = await runSessionMcpMaintenanceTask({
      targetKey,
      task: async () => {
        secondRan = true;
      },
    });
    expect(second).toBe(true);
    expect(secondRan).toBe(true);
    expect(readCloudMcpMaintenanceOutcome(targetKey)?.status).toBe("ok");
  });

  test("a late-settling timed-out task cannot release a newer run's lock", async () => {
    const targetKey = "target-late-settle";
    let settleFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    await runSessionMcpMaintenanceTask({
      targetKey,
      task: () => firstGate,
      timeoutMs: 5,
    });
    expect(readCloudMcpMaintenanceOutcome(targetKey)?.status).toBe("timed_out");

    // Second run acquires the lock and blocks.
    let settleSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      settleSecond = resolve;
    });
    const second = runSessionMcpMaintenanceTask({ targetKey, task: () => secondGate });
    await Promise.resolve();

    // The first (timed-out) task finally settles — it must NOT free the lock
    // held by the second run.
    settleFirst();
    await Promise.resolve();
    await expect(runSessionMcpMaintenanceTask({
      targetKey,
      task: async () => {},
    })).resolves.toBe(false);

    settleSecond();
    await expect(second).resolves.toBe(true);
  });

  test("a throwing tick records the error and releases the lock", async () => {
    const targetKey = "target-error";
    const ran = await runSessionMcpMaintenanceTask({
      targetKey,
      task: async () => {
        throw new Error("sync: mint failed with 401");
      },
    });
    expect(ran).toBe(true);
    const outcome = readCloudMcpMaintenanceOutcome(targetKey);
    expect(outcome?.status).toBe("error");
    expect(outcome?.detail).toBe("sync: mint failed with 401");

    await expect(runSessionMcpMaintenanceTask({
      targetKey,
      task: async () => {},
    })).resolves.toBe(true);
    expect(readCloudMcpMaintenanceOutcome(targetKey)?.status).toBe("ok");
  });

  test("details are length-capped and outcome storage keeps only the newest entries", () => {
    recordCloudMcpMaintenanceOutcome("target-detail", { status: "error", detail: "x".repeat(1000) }, 1);
    expect(readCloudMcpMaintenanceOutcome("target-detail")?.detail).toHaveLength(200);

    for (let index = 0; index < 10; index += 1) {
      recordCloudMcpMaintenanceOutcome(`target-${index}`, { status: "ok" }, index + 2);
    }
    // 11 total recorded; the two oldest (target-detail at t=1, target-0 at t=2)
    // fall out of the capped map.
    expect(readCloudMcpMaintenanceOutcome("target-detail")).toBeNull();
    expect(readCloudMcpMaintenanceOutcome("target-0")).toBeNull();
    expect(readCloudMcpMaintenanceOutcome("target-9")).toMatchObject({ status: "ok", at: 11 });
  });

  test("corrupt storage is treated as no recorded outcomes", () => {
    storageValues.set("openwork.den.mcp.lastMaintenanceOutcome", "{not json");
    expect(readCloudMcpMaintenanceOutcome("anything")).toBeNull();
    recordCloudMcpMaintenanceOutcome("anything", { status: "ok" }, 5);
    expect(readCloudMcpMaintenanceOutcome("anything")?.at).toBe(5);
  });
});
