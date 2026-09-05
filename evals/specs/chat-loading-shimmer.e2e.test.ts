import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { arrangeControl, shimmerChat } from "../worlds/chat.ts";

const test = spec.world(shimmerChat);

// `.ow-text-shimmer` animates `background-position`, which Chromium paints on
// the main thread, so its sweep is stepped (`steps(48, end)` over 2.4s): twenty
// repaints a second instead of one per vsync. A second of sampled frames should
// therefore show about twenty distinct positions, with a little slack for step
// boundaries, while a smooth `linear` sweep changes on every sampled frame.
const maxDistinctShimmerPositions = 24;
// Below this many animation frames per second the sample cannot tell a stepped
// sweep from a smooth one, so the claim is unreadable rather than proven.
const minSampledFrames = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("chat working and command activity use quiet shimmer without spinners", async ({ world, user, seed, probe, step }) => {
  const working = await step("the main Working state shimmers without a spinner", async () => {
    await user.see({ text: /Working/ });
    // TODO(primitive): inspect the visual treatment, animation cadence, and backdrop composition of a visible status row.
    const reading = await probe.eval(`(async () => {
      const row = document.querySelector('[data-loading-message="working"]');
      const shimmer = row?.querySelector(".ow-text-shimmer");
      const pane = document.querySelector("main[data-session-pane]");
      const header = pane?.querySelector("header");
      const filterOf = (element) => getComputedStyle(element).backdropFilter;
      const nestedFilters = [];
      if (row instanceof HTMLElement && pane instanceof HTMLElement) {
        for (let node = row.parentElement; node && node !== pane; node = node.parentElement) {
          const filter = filterOf(node);
          if (filter !== "none") nestedFilters.push(node.tagName.toLowerCase() + ": " + filter);
        }
      }
      const positions = new Set();
      let sampledFrames = 0;
      if (shimmer instanceof HTMLElement) {
        const startedAt = performance.now();
        await new Promise((resolve) => {
          const sample = (now) => {
            positions.add(getComputedStyle(shimmer).backgroundPosition);
            sampledFrames += 1;
            if (now - startedAt >= 1000) resolve(undefined);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }
      return {
        text: row instanceof HTMLElement ? row.innerText.trim() : "",
        hasSpinner: Boolean(row?.querySelector(".animate-spin")),
        hasShimmer: shimmer instanceof HTMLElement,
        animationName: shimmer instanceof HTMLElement ? getComputedStyle(shimmer).animationName : "",
        sampledFrames,
        distinctPositions: positions.size,
        isMac: document.documentElement.classList.contains("openwork-platform-mac"),
        paneFilter: pane instanceof HTMLElement ? filterOf(pane) : "",
        headerFilter: header instanceof HTMLElement ? filterOf(header) : "",
        nestedFilters,
      };
    })()`, { awaitPromise: true, timeoutMs: 15_000 });
    expect(reading).toMatchObject({ text: expect.stringContaining("Working"), hasSpinner: false, hasShimmer: true });
    return reading;
  });

  await step("the Working shimmer keeps sweeping but repaints on a bounded cadence instead of every frame", async () => {
    expect(working).toMatchObject({ animationName: "ow-text-shimmer" });
    if (!isRecord(working) || typeof working.sampledFrames !== "number" || typeof working.distinctPositions !== "number") {
      throw new Error(`Shimmer cadence was not readable: ${JSON.stringify(working)}`);
    }
    expect(working.sampledFrames).toBeGreaterThanOrEqual(minSampledFrames);
    expect(working.distinctPositions).toBeGreaterThanOrEqual(2);
    expect(working.distinctPositions).toBeLessThanOrEqual(maxDistinctShimmerPositions);
  });

  await step("the session pane is the only backdrop-filter surface above the transcript", async () => {
    // The macOS shell blurs the vibrancy backdrop once, on the session pane.
    // Nothing scrolls beneath the pane header or behind the transcript surface,
    // so any further backdrop filter between the pane and the Working row is an
    // invisible extra full-pane blur pass on every transcript repaint.
    if (!isRecord(working) || typeof working.isMac !== "boolean") {
      throw new Error(`Pane composition was not readable: ${JSON.stringify(working)}`);
    }
    expect(working).toMatchObject({
      paneFilter: working.isMac ? expect.stringContaining("blur(") : "none",
      headerFilter: "none",
      nestedFilters: [],
    });
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
