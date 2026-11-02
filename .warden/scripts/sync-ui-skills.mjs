#!/usr/bin/env node
// Pins UI Skills rule sets (https://www.ui-skills.com/mcp/docs) for Warden's
// ui-skills-review and regenerates .warden/skills/ui-skills-review/SKILL.md.
//
//   node .warden/scripts/sync-ui-skills.mjs          fetch the sources, update the pins, regenerate
//   node .warden/scripts/sync-ui-skills.mjs --generate  offline: regenerate SKILL.md from the pins (after editing header.md)
//   node .warden/scripts/sync-ui-skills.mjs --check     offline: fail if SKILL.md is out of date
//
// Warden never fetches these at review time: third-party text would become
// reviewer instructions without review. Updates land as a normal PR diff.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "ui-skills");
const SKILL = join(ROOT, "skills", "ui-skills-review", "SKILL.md");
const MCP = "https://www.ui-skills.com/mcp";

export const SOURCES = [
  { id: "baseline-ui", skill: "ibelick/baseline-ui", license: "https://raw.githubusercontent.com/ibelick/ui-skills/main/LICENSE" },
  { id: "fixing-accessibility", skill: "ibelick/fixing-accessibility", license: "https://raw.githubusercontent.com/ibelick/ui-skills/main/LICENSE" },
  { id: "fixing-motion-performance", skill: "ibelick/fixing-motion-performance", license: "https://raw.githubusercontent.com/ibelick/ui-skills/main/LICENSE" },
  // The catalog's vercel-labs/web-design-guidelines skill only says to fetch
  // this file at review time; pin the rules themselves instead.
  { id: "web-interface-guidelines", url: "https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md", license: "https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/LICENSE" },
];

// Sections that tell an agent how to be invoked or how to format output; the
// Warden skill defines both.
const DROP = /^(how to use|usage|when to apply|output format|mode)$/i;

/** Rules only: no frontmatter, no invocation or output-format sections. */
export function rulesOnly(markdown) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\r\n/g, "\n");
  const out = [];
  let dropping = false;
  let level = 0;
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    // Lines inside code blocks are never headings.
    const heading = fence || /^\s*(```|~~~)/.test(line) ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (dropping && depth <= level) dropping = false;
      if (!dropping && DROP.test(heading[2].trim())) {
        dropping = true;
        level = depth;
        continue;
      }
      // Demote so every reference sits under "## Reference rule sets".
      if (!dropping) out.push(`${"#".repeat(Math.min(depth + 2, 6))} ${heading[2]}`);
      continue;
    }
    if (dropping) continue;
    if (/\$ARGUMENTS/.test(line)) continue;
    out.push(line);
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function buildSkill(header, pins, texts) {
  const parts = [header.trimEnd(), ""];
  for (const pin of pins) {
    parts.push(`### ${pin.id}`, "", `Source: ${pin.source} (sha256 ${pin.sha256.slice(0, 12)})`, "", texts[pin.id].trimEnd(), "");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function mcpSkill(name) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_skill", arguments: { name } } }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = JSON.parse(await response.text());
  const text = result?.result?.content?.[0]?.text;
  if (!response.ok || typeof text !== "string" || !text.trim()) throw new Error(`UI Skills MCP returned no text for ${name}`);
  return text;
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function generate() {
  const pins = JSON.parse(readFileSync(join(DIR, "sources.json"), "utf8")).sources;
  for (const pin of pins) {
    if (sha256(readFileSync(join(DIR, "rules", `${pin.id}.md`), "utf8")) !== pin.sha256) throw new Error(`rules/${pin.id}.md does not match its pinned sha256`);
  }
  const texts = Object.fromEntries(pins.map((pin) => [pin.id, rulesOnly(readFileSync(join(DIR, "rules", `${pin.id}.md`), "utf8"))]));
  return buildSkill(readFileSync(join(DIR, "header.md"), "utf8"), pins, texts);
}

async function sync() {
  mkdirSync(join(DIR, "rules"), { recursive: true });
  const pins = [];
  const licenses = new Map();
  for (const source of SOURCES) {
    const text = source.skill ? await mcpSkill(source.skill) : await get(source.url);
    writeFileSync(join(DIR, "rules", `${source.id}.md`), text);
    pins.push({ id: source.id, source: source.skill ? `${MCP} get_skill ${source.skill}` : source.url, license: source.license, sha256: sha256(text) });
    if (!licenses.has(source.license)) licenses.set(source.license, await get(source.license));
  }
  writeFileSync(join(DIR, "sources.json"), `${JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), sources: pins }, null, 2)}\n`);
  writeFileSync(join(DIR, "LICENSES.md"), `# Licenses of the pinned UI Skills rule sets\n\n${[...licenses].map(([url, text]) => `## ${url}\n\n\`\`\`\n${text.trim()}\n\`\`\`\n`).join("\n")}`);
  mkdirSync(dirname(SKILL), { recursive: true });
  writeFileSync(SKILL, generate());
  console.log(`Pinned ${pins.length} rule sets; regenerated ${SKILL}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--generate")) {
    writeFileSync(SKILL, generate());
    console.log(`Regenerated ${SKILL}.`);
  } else if (process.argv.includes("--check")) {
    if (readFileSync(SKILL, "utf8") !== generate()) {
      console.error("ui-skills-review/SKILL.md is out of date: run node .warden/scripts/sync-ui-skills.mjs --generate");
      process.exit(1);
    }
    console.log("ui-skills-review/SKILL.md is up to date.");
  } else {
    sync().catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  }
}
