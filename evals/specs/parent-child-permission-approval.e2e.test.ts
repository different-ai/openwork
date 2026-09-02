import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { parentChildPermissionWorld } from "../worlds/first-run.ts";

const test = spec.world(parentChildPermissionWorld);

test("a parent task surfaces and resolves its child session permission request", async ({ user, probe, step }) => {
  await step("The parent exposes the child request", async () => {
    await user.see({ text: /Needs permission/ }, { timeoutMs: 30_000 });
    await user.see({ text: /Requested by Investigate the deployment failure/ });
    await user.see({ text: /git status --short --branch/ });
    await user.see("Deny");
    await user.see("Allow once");
    await user.see("Allow for session");
    // TODO(primitive): read delegated-task permission treatment state.
    const waiting = await probe.eval(`(() => {
      const row = document.querySelector('[data-subagent-permission="pending"]');
      return {
        activity: row instanceof HTMLElement ? row.dataset.subagentActivity ?? "" : "",
        childSessionId: row instanceof HTMLElement ? row.dataset.subagentSessionId ?? "" : "",
        hasPermissionIcon: Boolean(row?.querySelector('[data-subagent-permission-icon]')),
        hasShimmer: Boolean(row?.querySelector('.ow-text-shimmer')),
      };
    })()`);
    expect(waiting).toMatchObject({ activity: "waiting-permission", hasPermissionIcon: true, hasShimmer: false });
    expect(waiting).toMatchObject({ childSessionId: expect.stringContaining(":eval-child") });
    await user.screenshot();
  });

  await step("Approving clears the blocked state", async () => {
    await user.click("Allow once");
    await user.notSee({ text: /Requested by Investigate the deployment failure/ }, { timeoutMs: 15_000 });
    await user.notSee({ text: /Needs permission/ });
    // TODO(primitive): read resolved delegated-task running treatment state.
    expect(await probe.eval(`({
      permissionPanelVisible: Boolean(document.querySelector('[data-permission-source="child-session"]')),
      waitingIconVisible: Boolean(document.querySelector('[data-subagent-permission="pending"]')),
      runningTreatmentVisible: Boolean(document.querySelector('[data-subagent-activity="shimmer"] .ow-text-shimmer')),
    })`)).toEqual({ permissionPanelVisible: false, waitingIconVisible: false, runningTreatmentVisible: true });
  });
});
