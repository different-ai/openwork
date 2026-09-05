import type { Surface } from "@openwork/cdp";
import { evalIn, waitFor } from "./desktop.ts";

const PLUG_BUTTON = 'button[title="Commands, skills, and MCPs"]';
const SKILL_MARKERS = ["/browser-automation"];

export interface SkillFacts {
  name: string;
  label: string;
  local: boolean;
}

export interface SkillsLoadFacts {
  elapsedMs: number;
  rowCount: number;
  skills: SkillFacts[];
  loadingCommandsVisible: boolean;
}

export interface ComposerCapabilitiesFacts {
  sections: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSkills(value: unknown): SkillFacts[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.label !== "string") return [];
    return [{ name: entry.name, label: entry.label, local: entry.local === true }];
  });
}

function parseSkillsLoad(value: unknown): SkillsLoadFacts {
  if (!isRecord(value)) throw new Error(`Skills load returned malformed facts: ${JSON.stringify(value)}`);
  return {
    elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : Number.POSITIVE_INFINITY,
    rowCount: typeof value.rowCount === "number" ? value.rowCount : 0,
    skills: parseSkills(value.skills),
    loadingCommandsVisible: value.loadingCommandsVisible === true,
  };
}

async function openPlugMenu(app: Surface): Promise<void> {
  // One guarded, retried step: the renderer freezes in bursts while the
  // workspace engine boots, so a bare click evaluation can eat a 20s CDP
  // timeout and fail the spec. Clicking only while the menu is closed keeps
  // retries from toggling it back shut.
  await waitFor(app, `(() => {
    const labels = [...document.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());
    if (labels.includes("Skills") && labels.includes("Extensions")) return true;
    const plug = document.querySelector(${JSON.stringify(PLUG_BUTTON)});
    if (!plug) return false;
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    plug.click();
    return false;
  })()`, { timeoutMs: 60_000, label: "plug menu sections" });
}

export async function readComposerCapabilities(app: Surface): Promise<ComposerCapabilitiesFacts> {
  await openPlugMenu(app);
  const value = await evalIn(app, `(() => {
    const labels = [...document.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());
    return ["Agents", "Commands", "Skills", "Extensions"].filter((section) => labels.includes(section));
  })()`);
  return { sections: Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [] };
}

export async function measureLoadedSkills(app: Surface): Promise<SkillsLoadFacts> {
  await openPlugMenu(app);
  const value = await evalIn(app, `new Promise((resolve) => {
    const skillsButton = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Skills");
    if (!skillsButton) { resolve({ error: "skills section button not found" }); return; }
    const startedAt = performance.now();
    skillsButton.click();
    const poll = () => {
      const rows = [...document.querySelectorAll("button")]
        .filter((button) => /^\\/[a-z0-9-]+/i.test((button.textContent ?? "").trim()));
      const hit = rows.some((button) => ${JSON.stringify(SKILL_MARKERS)}
        .some((marker) => (button.textContent ?? "").includes(marker)));
      if (hit) {
        resolve({
          elapsedMs: Math.round(performance.now() - startedAt),
          rowCount: rows.length,
          skills: rows.map((button) => {
            const label = (button.textContent ?? "").replace(/\\s+/g, " ").trim();
            return { name: (label.match(/^\\/[a-z0-9-]+/) ?? [label])[0], label, local: label.includes("Local") };
          }),
          loadingCommandsVisible: document.body.innerText.includes("Loading commands"),
        });
        return;
      }
      if (performance.now() - startedAt > 20_000) {
        resolve({ error: "timed out", bodyTail: document.body.innerText.slice(-400) });
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  })`, { awaitPromise: true, timeoutMs: 30_000 });
  // The in-page poll gives up at 20s; the CDP call must outlive it or the two
  // deadlines race and the spec dies with a raw CDP timeout instead of facts.
  if (isRecord(value) && typeof value.error === "string") throw new Error(`Skills did not render: ${JSON.stringify(value)}`);
  return parseSkillsLoad(value);
}

export async function readLoadedSkills(app: Surface): Promise<SkillFacts[]> {
  return (await measureLoadedSkills(app)).skills;
}

/**
 * Scroll a composer-menu row into view. The menu is a scrollable popover, so
 * a row can be loaded (and asserted from the DOM) while a screenshot still
 * cannot show it; reveal it first when a visual claim names it.
 */
export async function revealMenuRow(app: Surface, marker: string): Promise<void> {
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes(${JSON.stringify(marker)}));
    if (!row) return false;
    row.scrollIntoView({ block: "center" });
    return true;
  })()`, { timeoutMs: 10_000, label: `menu row ${marker} in view` });
}

export async function readLoadedExtensions(app: Surface): Promise<string[]> {
  await openPlugMenu(app);
  await waitFor(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim() === "Extensions");
    if (!button) return false;
    button.click();
    return true;
  })()`, { label: "Extensions section" });
  await waitFor(app, 'document.body.innerText.includes("OpenWork Browser")', {
    timeoutMs: 10_000,
    label: "OpenWork Browser extension",
  });
  const value = await waitFor(app, `([...document.querySelectorAll("button")]
    .map((button) => (button.textContent ?? "").replace(/\\s+/g, " ").trim())
    .filter((label) => label.includes("OpenWork Browser")))`, { timeoutMs: 60_000, label: "OpenWork Browser extension rows" });
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
