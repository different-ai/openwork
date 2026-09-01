import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "the sidebar title fade follows only the edges with hidden text"
  : "sidebar title overflow fade skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const longTitle = "Reading Google Drive documents for the quarterly workspace review";

const titleStateExpression = `(() => {
  const text = [...document.querySelectorAll("[data-session-title-text]")]
    .find((node) => (node.textContent ?? "").trim() === ${JSON.stringify(longTitle)});
  if (!(text instanceof HTMLElement) || !(text.parentElement instanceof HTMLElement)) return null;
  const viewport = text.parentElement;
  const rect = viewport.getBoundingClientRect();
  return {
    clientWidth: viewport.clientWidth,
    hiddenEdges: viewport.dataset.sessionTitleHiddenEdges ?? "",
    maskImage: getComputedStyle(viewport).maskImage,
    scrollWidth: text.scrollWidth,
    x: rect.left + Math.min(rect.width / 2, 80),
    y: rect.top + rect.height / 2,
  };
})()`;

const railPointExpression = `(() => {
  const rail = document.querySelector('[data-sidebar="rail"]');
  if (!(rail instanceof HTMLElement)) return null;
  const rect = rail.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

type TitleState = {
  clientWidth: number;
  hiddenEdges: string;
  maskImage: string;
  scrollWidth: number;
  x: number;
  y: number;
};

type Point = { x: number; y: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTitleState(value: unknown): TitleState {
  if (!isRecord(value)) throw new Error(`Could not read the sidebar title state: ${JSON.stringify(value)}`);
  const { clientWidth, hiddenEdges, maskImage, scrollWidth, x, y } = value;
  if (
    typeof clientWidth !== "number" ||
    typeof hiddenEdges !== "string" ||
    typeof maskImage !== "string" ||
    typeof scrollWidth !== "number" ||
    typeof x !== "number" ||
    typeof y !== "number"
  ) {
    throw new Error(`Sidebar title state had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { clientWidth, hiddenEdges, maskImage, scrollWidth, x, y };
}

function readPoint(value: unknown, label: string): Point {
  if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") {
    throw new Error(`${label} had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { x: value.x, y: value.y };
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "sidebar-title-overflow-fade" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-sidebar-title-overflow-fade-${Date.now()}`,
  });
  await seedSessions(app, [longTitle]);

  await waitFor(app, `${titleStateExpression}?.scrollWidth > ${titleStateExpression}?.clientWidth`, {
    timeoutMs: 60_000,
    label: "overflowing sidebar title",
  });

  const resting = readTitleState(await evalIn(app, titleStateExpression));
  expect(resting.hiddenEdges).toBe("end");
  expect(resting.maskImage).not.toBe("none");
  evidence.recordAssertionEvidence(
    "A resting clipped title fades only where more text is hidden on the right",
    `The title measured ${resting.scrollWidth}px inside a ${resting.clientWidth}px viewport and reported only its end edge hidden.`,
    true,
  );

  await app.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: resting.x,
    y: resting.y,
  });
  await waitFor(app, `${titleStateExpression}?.hiddenEdges === "both"`, {
    timeoutMs: 10_000,
    label: "title moving between clipped edges",
  });
  const moving = readTitleState(await evalIn(app, titleStateExpression));
  expect(moving.maskImage).not.toBe("none");
  evidence.recordAssertionEvidence(
    "A moving title fades both edges while text is hidden on both sides",
    `During the reveal transition the title reported ${JSON.stringify(moving.hiddenEdges)} hidden edges.`,
    true,
  );

  await waitFor(app, `${titleStateExpression}?.hiddenEdges === "start"`, {
    timeoutMs: 30_000,
    label: "title reveal reached its final characters",
  });
  const revealed = readTitleState(await evalIn(app, titleStateExpression));
  expect(revealed.maskImage).not.toBe("none");
  evidence.recordAssertionEvidence(
    "The final characters stay crisp once no text remains hidden on the right",
    `At the end of the reveal the title reported only its start edge hidden, removing the right-edge fade from the final characters.`,
    true,
  );
  await screenshot(app);

  const rail = readPoint(await evalIn(app, railPointExpression), "sidebar resize rail");
  await app.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rail.x,
    y: rail.y,
    button: "left",
    clickCount: 1,
  });
  await app.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rail.x + 340,
    y: rail.y,
    button: "left",
  });
  await app.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rail.x + 340,
    y: rail.y,
    button: "left",
    clickCount: 1,
  });
  await waitFor(app, `${titleStateExpression}?.hiddenEdges === "none"`, {
    timeoutMs: 15_000,
    label: "expanded sidebar exposes the full title",
  });

  const fitting = readTitleState(await evalIn(app, titleStateExpression));
  expect(fitting.clientWidth).toBeGreaterThanOrEqual(fitting.scrollWidth);
  expect(fitting.maskImage).toBe("none");
  evidence.recordAssertionEvidence(
    "Expanding the sidebar enough to show the full title removes every fade",
    `After resizing, the ${fitting.scrollWidth}px title fits inside its ${fitting.clientWidth}px viewport, reports no hidden edges, and has no mask.`,
    true,
  );
  await screenshot(app);
});
