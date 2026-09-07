import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { taskActivity } from "../worlds/chat.ts";

const test = spec.world(taskActivity);

test("running delegated-task activity uses a quiet shimmer without a spinner", async ({ user, probe }) => {
  await user.see({ role: "button", label: /Build isolated Azure repro/ });
  // TODO(primitive): inspect the visual treatment classes on a delegated-task status row.
  const rendered = await probe.eval(() => {
    const row = document.querySelector<HTMLElement>('[data-subagent-activity="shimmer"]');
    return {
      text: row instanceof HTMLElement ? row.innerText.replace(/\s+/g, " ").trim() : "",
      hasSpinner: Boolean(row?.querySelector<HTMLElement>(".animate-spin")),
      hasShimmer: Boolean(row?.querySelector<HTMLElement>(".ow-text-shimmer")),
    };
  });
  expect(rendered).toMatchObject({
    text: expect.stringMatching(/Build isolated Azure repro.*Working/),
    hasSpinner: false,
    hasShimmer: true,
  });
});
