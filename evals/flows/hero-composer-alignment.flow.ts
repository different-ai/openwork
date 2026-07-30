import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "hero-composer-alignment";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

async function num(ctx: FlowContext, expr: string): Promise<number> {
  const value = await ctx.eval(expr);
  ctx.assert(typeof value === "number" && Number.isFinite(value), `Expected a number from ${expr}, got ${JSON.stringify(value)}`);
  return typeof value === "number" ? value : Number.NaN;
}

async function text(ctx: FlowContext, expr: string): Promise<string> {
  const value = await ctx.eval(expr);
  ctx.assert(typeof value === "string", `Expected a string from ${expr}, got ${JSON.stringify(value)}`);
  return typeof value === "string" ? value : "";
}

async function measure(ctx: FlowContext, expr: string, label: string): Promise<void> {
  const value = await ctx.eval(expr);
  ctx.assert(value === true, `${label}: ${JSON.stringify(value)}.`);
}

async function createTaskPrecondition(ctx: FlowContext): Promise<string | null> {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
  const state = await ctx.waitFor(`(() => {
    const control = window.__openworkControl;
    const route = String(control.snapshot().route || "");
    if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
    const action = control.listActions().find((candidate) => candidate.id === "session.create_task");
    return action && !action.disabled ? "ready" : null;
  })()`, { timeoutMs: 30_000, label: "session.create_task enabled or welcome/signin" });
  return state === "blocked"
    ? "Profile is on welcome/sign-in; hero composer alignment requires an onboarded workspace."
    : null;
}

const EMPTY_TASK_ROUTE_FROM_SESSION = `(() => {
  const route = String(window.__openworkControl.snapshot().route || "");
  const at = route.indexOf("/session/");
  return at === -1 ? "" : route.slice(0, at) + "/session";
})()`;

const MEASURE_HERO = `(() => {
  const heading = Array.from(document.querySelectorAll("h2")).find((h) => (h.textContent || "").trim() === "What do you need done?");
  const hero = heading && heading.parentElement ? heading.parentElement.parentElement : null;
  const editor = hero ? hero.querySelector('[contenteditable="true"]') : null;
  let panel = editor;
  while (panel && String(panel.className || "").indexOf("rounded-[18px]") === -1) panel = panel.parentElement;
  const grid = hero ? Array.from(hero.children).find((el) => el.classList.contains("grid")) : null;
  const cards = grid ? Array.from(grid.children) : [];
  if (!heading || !hero || !editor || !panel || !grid || cards.length < 1) return false;
  const panelRect = panel.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  const firstCardRect = cards[0].getBoundingClientRect();
  if (panelRect.width <= 0 || gridRect.width <= 0 || firstCardRect.width <= 0) return false;
  const widestCardRight = cards.reduce((right, card) => Math.max(right, card.getBoundingClientRect().right), firstCardRect.right);
  const composerRoot = panel.parentElement && panel.parentElement.parentElement ? panel.parentElement.parentElement : null;
  window.__heroAlign = {
    panelLeft: Math.round(panelRect.left), panelRight: Math.round(panelRect.right), panelWidth: Math.round(panelRect.width),
    gridLeft: Math.round(gridRect.left), gridRight: Math.round(gridRect.right), gridWidth: Math.round(gridRect.width),
    firstCardLeft: Math.round(firstCardRect.left), widestCardRight: Math.round(widestCardRight), cardsLength: cards.length,
    rootPosition: composerRoot ? getComputedStyle(composerRoot).position : "missing",
  };
  return true;
})()`;

const MEASURE_DOCKED_COMPOSER = `(() => {
  const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
  for (const editor of editors) {
    let panel = editor;
    while (panel && String(panel.className || "").indexOf("rounded-[18px]") === -1) panel = panel.parentElement;
    if (!panel || !panel.parentElement || !panel.parentElement.parentElement) continue;
    const inner = panel.parentElement;
    const root = inner.parentElement;
    if (getComputedStyle(root).position !== "sticky") continue;
    const rootRect = root.getBoundingClientRect();
    const innerRect = inner.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (rootRect.width <= 0 || panelRect.width <= 0) continue;
    window.__dockedComposer = {
      rootLeft: Math.round(rootRect.left), rootRight: Math.round(rootRect.right), rootWidth: Math.round(rootRect.width),
      innerLeft: Math.round(innerRect.left), innerRight: Math.round(innerRect.right), innerWidth: Math.round(innerRect.width),
      panelLeft: Math.round(panelRect.left), panelRight: Math.round(panelRect.right), panelWidth: Math.round(panelRect.width),
      leftInset: Math.round(panelRect.left - rootRect.left), rightInset: Math.round(rootRect.right - panelRect.right),
      centerDelta: Math.round(Math.abs((panelRect.left + panelRect.right) / 2 - (rootRect.left + rootRect.right) / 2)),
      rootPosition: getComputedStyle(root).position,
    };
    return true;
  }
  return false;
})()`;

export default defineFlow({
  id: FLOW_ID,
  title: "New-task composer spans the same width as the starter cards below it",
  kind: "user-facing",
  spec: "evals/react-session-flows.md",
  precondition: createTaskPrecondition,
  steps: [
    {
      name: "New-task screen is visible on launch",
      run: async (ctx) => {
        await ctx.prove("OpenWork lands on the empty new-task composer screen", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
            const emptyRoute = await ctx.eval(EMPTY_TASK_ROUTE_FROM_SESSION);
            if (typeof emptyRoute === "string" && emptyRoute.length > 0) await ctx.navigateHash(emptyRoute);
          },
          assert: async () => {
            await ctx.expectText("What do you need done?");
            await ctx.expectText("Describe your task");
            await ctx.expectText("Run task");
          },
          screenshot: { name: "new-task-screen", requireText: ["What do you need done?", "Run task"] },
        });
      },
    },
    {
      name: "New-task composer aligns to the starter-card column",
      run: async (ctx) => {
        await ctx.prove("The hero composer card and starter-card grid share the same edges", {
          voiceover: vo[1],
          action: async () => {
            const starterCardClicked = await ctx.eval(`(() => {
              const heading = Array.from(document.querySelectorAll("h2")).find((h) => (h.textContent || "").trim() === "What do you need done?");
              const hero = heading && heading.parentElement ? heading.parentElement.parentElement : null;
              const grid = hero ? Array.from(hero.children).find((el) => el.classList.contains("grid")) : null;
              const firstCard = grid ? grid.children[0] : null;
              if (!(firstCard instanceof HTMLButtonElement)) return false;
              firstCard.click();
              return true;
            })()`);
            ctx.assert(starterCardClicked === true, `Expected first starter card click to land, got ${JSON.stringify(starterCardClicked)}.`);
            await ctx.waitFor(`(() => {
              const heading = Array.from(document.querySelectorAll("h2")).find((h) => (h.textContent || "").trim() === "What do you need done?");
              const hero = heading && heading.parentElement ? heading.parentElement.parentElement : null;
              const editor = hero ? hero.querySelector('[contenteditable="true"]') : null;
              return Boolean(editor && String(editor.innerText || "").trim().length > 0);
            })()`, { timeoutMs: 30_000, label: "starter card prompt fills composer" });
            await ctx.waitFor(MEASURE_HERO, { timeoutMs: 30_000, label: "hero composer and starter cards laid out" });
          },
          assert: async () => {
            await measure(ctx, MEASURE_HERO, "Could not measure hero alignment metrics");
            const measured = await text(ctx, "JSON.stringify(window.__heroAlign)");
            ctx.output("hero-alignment-metrics", measured);
            const [panelLeft, panelRight, panelWidth, gridLeft, gridRight, gridWidth, cardsLength] = await Promise.all([
              num(ctx, "window.__heroAlign.panelLeft"), num(ctx, "window.__heroAlign.panelRight"), num(ctx, "window.__heroAlign.panelWidth"),
              num(ctx, "window.__heroAlign.gridLeft"), num(ctx, "window.__heroAlign.gridRight"), num(ctx, "window.__heroAlign.gridWidth"),
              num(ctx, "window.__heroAlign.cardsLength"),
            ]);
            const rootPosition = await text(ctx, "window.__heroAlign.rootPosition");
            ctx.assert(cardsLength >= 1, `Expected cards.length >= 1, got ${cardsLength}; measured ${measured}.`);
            ctx.assert(Math.abs(panelLeft - gridLeft) <= 1, `Composer left ${panelLeft}px must match grid left ${gridLeft}px within 1px; measured ${measured}.`);
            ctx.assert(Math.abs(panelRight - gridRight) <= 1, `Composer right ${panelRight}px must match grid right ${gridRight}px within 1px; measured ${measured}.`);
            ctx.assert(Math.abs(panelWidth - gridWidth) <= 1, `Composer width ${panelWidth}px must match grid width ${gridWidth}px within 1px; measured ${measured}.`);
            ctx.assert(panelWidth > 0, `Composer panel width must be positive, got ${panelWidth}px; measured ${measured}.`);
            ctx.assert(rootPosition !== "sticky", `New-task composer root must not be sticky, got position ${rootPosition}; measured ${measured}.`);
          },
          screenshot: { name: "composer-aligned-with-cards", requireText: ["What do you need done?"] },
        });
      },
    },
    {
      name: "Session composer keeps the docked chat chrome",
      run: async (ctx) => {
        await ctx.prove("Starting a task keeps the session composer docked and width-capped", {
          voiceover: vo[2],
          action: async () => {
            await ctx.control("session.create_task");
            await ctx.waitFor(`window.__openworkControl.snapshot().route.includes("/session/")`, { timeoutMs: 60_000, label: "session route after task creation" });
            await ctx.waitFor(MEASURE_DOCKED_COMPOSER, { timeoutMs: 30_000, label: "sticky session composer laid out" });
          },
          assert: async () => {
            await measure(ctx, MEASURE_DOCKED_COMPOSER, "Could not measure docked composer metrics");
            const measured = await text(ctx, "JSON.stringify(window.__dockedComposer)");
            ctx.output("docked-composer-metrics", measured);
            const [rootWidth, panelWidth, leftInset, rightInset, centerDelta] = await Promise.all([
              num(ctx, "window.__dockedComposer.rootWidth"), num(ctx, "window.__dockedComposer.panelWidth"),
              num(ctx, "window.__dockedComposer.leftInset"), num(ctx, "window.__dockedComposer.rightInset"),
              num(ctx, "window.__dockedComposer.centerDelta"),
            ]);
            const rootPosition = await text(ctx, "window.__dockedComposer.rootPosition");
            ctx.assert(rootPosition === "sticky", `Session composer root must be sticky, got position ${rootPosition}; measured ${measured}.`);
            ctx.assert(panelWidth <= 800, `Session composer panel must stay at most 800px wide, got ${panelWidth}px; measured ${measured}.`);
            if (rootWidth > 800) {
              ctx.assert(centerDelta <= 2, `Session composer panel must be centered in its ${rootWidth}px column within 2px, got center delta ${centerDelta}px; measured ${measured}.`);
            } else {
              ctx.assert(leftInset > 0 && rightInset > 0, `Narrow session composer must keep dock padding, got left inset ${leftInset}px and right inset ${rightInset}px; measured ${measured}.`);
            }
          },
          screenshot: { name: "session-composer-still-docked" },
        });
      },
    },
  ],
});
