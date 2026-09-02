import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { arrangeControl, shimmerChat } from "../worlds/chat.ts";

const test = spec.world(shimmerChat);

test("chat working and command activity use quiet shimmer without spinners", async ({ world, user, seed, probe, step }) => {
  await step("the main Working state shimmers without a spinner", async () => {
    await user.see({ text: /Working/ });
    // TODO(primitive): inspect the visual treatment classes on a visible status row.
    const working = await probe.eval(`(() => {
      const row = document.querySelector('[data-loading-message="working"]');
      return {
        text: row instanceof HTMLElement ? row.innerText.trim() : "",
        hasSpinner: Boolean(row?.querySelector(".animate-spin")),
        hasShimmer: Boolean(row?.querySelector(".ow-text-shimmer")),
      };
    })()`);
    expect(working).toMatchObject({ text: expect.stringContaining("Working"), hasSpinner: false, hasShimmer: true });
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  await step("the aggregate activity state shimmers and keeps a singular summary", async () => {
    await user.see({ text: /Running command/ });
    await user.see({ text: /Reading brief\.md/ });
    // TODO(primitive): inspect the visual treatment and summary of an aggregate status row.
    const aggregate = await probe.eval(`(() => {
      const row = document.querySelector("[data-tool-aggregate-now]");
      const summary = [...document.querySelectorAll("[data-tool-aggregate] > button")]
        .find((button) => (button.textContent ?? "").includes("Running command"));
      return {
        text: row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, " ").trim() : "",
        hasSpinner: Boolean(row?.querySelector(".animate-spin")),
        hasShimmer: Boolean(row?.querySelector(".ow-text-shimmer")),
        summary: summary instanceof HTMLElement ? summary.innerText.replace(/\\s+/g, " ").trim() : "",
      };
    })()`);
    expect(aggregate).toMatchObject({ text: expect.stringContaining("Reading brief.md"), hasSpinner: false, hasShimmer: true });
    expect(aggregate).not.toMatchObject({ text: expect.stringContaining("Now:") });
    expect(aggregate).toMatchObject({ summary: expect.stringContaining("Running command") });
    expect(aggregate).not.toMatchObject({ summary: expect.stringContaining("Running 1 command") });
  });

  await step("expanded command history is readable", async () => {
    await user.click({ role: "button", label: /Running command/ });
    await user.see({ text: /git status --short --branch/ });
    // TODO(primitive): count command summaries in a visible aggregate.
    const command = await probe.eval(`(() => {
      const block = document.querySelector("[data-tool-aggregate-command]");
      const aggregate = block?.closest("[data-tool-aggregate]");
      return {
        text: block instanceof HTMLElement ? block.innerText.replace(/\\s+/g, " ").trim() : "",
        summaryCount: aggregate instanceof HTMLElement
          ? (aggregate.innerText.match(/(?:Ran|Running) command/g) ?? []).length
          : 0,
      };
    })()`);
    expect(command).toMatchObject({ text: expect.stringContaining("$"), summaryCount: 1 });
    expect(command).toMatchObject({ text: expect.stringContaining("git status --short --branch") });
  });
});
