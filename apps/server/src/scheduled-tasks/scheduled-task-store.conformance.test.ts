import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyScheduledTaskRepositoryConformance } from "@openwork/scheduled-tasks/testing";
import { createScheduledTaskStore } from "./scheduled-task-store.js";

test("the local SQLite adapter satisfies the portable repository contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduled-task-repository-"));
  try {
    const result = await verifyScheduledTaskRepositoryConformance({
      createRepository: () => createScheduledTaskStore({
        path: join(directory, "scheduled-tasks.sqlite"),
      }),
    });
    expect(result.checked).toEqual([
      "task-and-initial-revision",
      "immutable-revisions",
      "reviewed-authority-binding",
      "due-selection",
      "runtime-scope-isolation",
      "atomic-idempotent-claim",
      "atomic-overlap-policy",
      "attempt-ledger",
      "durable-terminal-run",
      "grant-revocation",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
