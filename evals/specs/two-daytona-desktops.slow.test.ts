import { expect, test } from "vitest";
import { createAndSelectWorkspace } from "@openwork/behaviors";
import { daytonaSandbox, desktop } from "@openwork/hosts";

const sandboxA = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_A?.trim();
const sandboxB = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_B?.trim();
const enabled = Boolean(sandboxA && sandboxB);

test.skipIf(!enabled)("two desktops reach interactive workspaces on different Daytona sandboxes", async () => {
  if (!sandboxA || !sandboxB) throw new Error("Set OPENWORK_EVAL_DAYTONA_SANDBOX_A and OPENWORK_EVAL_DAYTONA_SANDBOX_B.");
  expect(sandboxA).not.toBe(sandboxB);

  await using appA = await desktop({ host: daytonaSandbox(sandboxA), name: "a" });
  await using appB = await desktop({ host: daytonaSandbox(sandboxB), name: "b" });

  const stamp = Date.now();
  const [workspaceA, workspaceB] = await Promise.all([
    createAndSelectWorkspace(appA, { path: `/tmp/openwork-two-sandboxes-a-${stamp}` }),
    createAndSelectWorkspace(appB, { path: `/tmp/openwork-two-sandboxes-b-${stamp}` }),
  ]);

  expect(appA.handle.sandboxId).toBe(sandboxA);
  expect(appB.handle.sandboxId).toBe(sandboxB);
  expect(workspaceA.workspaceId).toBeTruthy();
  expect(workspaceB.workspaceId).toBeTruthy();
});
