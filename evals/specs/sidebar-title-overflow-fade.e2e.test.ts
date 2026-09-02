import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { sidebarOverflow } from "../worlds/session-shell.ts";

const test = spec.world(sidebarOverflow);

interface TitleState {
  clientWidth: number;
  hiddenEdges: string;
  maskImage: string;
  scrollWidth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function titleState(probe: Probe, title: string): Promise<TitleState> {
  // TODO(primitive): probe.computedStyle should read overflow geometry and computed masks for a visible target.
  const value = await probe.eval(`(title) => {
    const text = [...document.querySelectorAll("[data-session-title-text]")]
      .find((node) => (node.textContent ?? "").trim() === title);
    if (!(text instanceof HTMLElement) || !(text.parentElement instanceof HTMLElement)) return null;
    const viewport = text.parentElement;
    return {
      clientWidth: viewport.clientWidth,
      hiddenEdges: viewport.dataset.sessionTitleHiddenEdges ?? "",
      maskImage: getComputedStyle(viewport).maskImage,
      scrollWidth: text.scrollWidth,
    };
  }`, { args: [title] });
  if (!isRecord(value)
    || typeof value.clientWidth !== "number"
    || typeof value.hiddenEdges !== "string"
    || typeof value.maskImage !== "string"
    || typeof value.scrollWidth !== "number") throw new Error(`Unexpected title state: ${JSON.stringify(value)}`);
  return {
    clientWidth: value.clientWidth,
    hiddenEdges: value.hiddenEdges,
    maskImage: value.maskImage,
    scrollWidth: value.scrollWidth,
  };
}

test("the sidebar title fade follows only the edges with hidden text", async ({ world, user, probe, step }) => {
  const resting = await probe.eventually(() => titleState(probe, world.longTitle), {
    within: 60_000,
    label: "overflowing sidebar title",
    until: (state) => state.scrollWidth > state.clientWidth && state.hiddenEdges === "end",
  });
  expect(resting.maskImage).not.toBe("none");

  await step("hover reveals the clipped ending without fading it", async () => {
    await user.hover({ text: world.longTitle });
    const moving = await probe.eventually(() => titleState(probe, world.longTitle), {
      within: 10_000,
      label: "title moves between clipped edges",
      until: (state) => state.hiddenEdges === "both",
    });
    expect(moving.maskImage).not.toBe("none");
    const revealed = await probe.eventually(() => titleState(probe, world.longTitle), {
      within: 30_000,
      label: "title reveal reaches its final characters",
      until: (state) => state.hiddenEdges === "start",
    });
    expect(revealed.maskImage).not.toBe("none");
    await user.screenshot();
  });

  await step("widening the sidebar removes the fade", async () => {
    // TODO(primitive): user.drag should resize a visible rail using trusted pointer input.
    // TODO(primitive): probe.geometry should resolve the center of a visible target.
    const point = await probe.eval(`(() => {
      const rail = document.querySelector('[data-sidebar="rail"]');
      if (!(rail instanceof HTMLElement)) return null;
      const rect = rail.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") throw new Error("Sidebar rail was not measurable.");
    await world.app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await world.app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + 340, y: point.y, button: "left" });
    await world.app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + 340, y: point.y, button: "left", clickCount: 1 });
    const fitting = await probe.eventually(() => titleState(probe, world.longTitle), {
      within: 15_000,
      label: "expanded sidebar exposes full title",
      until: (state) => state.hiddenEdges === "none",
    });
    expect(fitting.clientWidth).toBeGreaterThanOrEqual(fitting.scrollWidth);
    expect(fitting.maskImage).toBe("none");
    await user.screenshot();
  });
});
