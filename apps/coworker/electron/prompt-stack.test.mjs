/**
 * The six always-loaded files and registered MCP catalog/instructions, in characters.
 * The native Event catalog has its own budget, measured from shared schema metadata.
 * Combined subtotals exclude other native plugins, per-turn context and the engine
 * prompt. Native context bounds are exercised by the Event execution tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { assignmentToolCatalog, selfToolCatalog } from "./assignment-tools.mjs";
import { DEFAULT_INSTRUCTIONS, toolCatalog } from "./coworker-tools.mjs";
import { COWORKER_INSTRUCTIONS, createCoworker, createLongTermMemory } from "./coworkers.mjs";
import { createDocument } from "./documents.mjs";
import { eventToolCatalog } from "./events.mjs";
import { teamToolCatalog } from "./team-tools.mjs";
import { workerToolCatalog } from "./workers.mjs";
import { WORKER_MANAGEMENT } from "./worker-controls.mjs";

/**
 * The fixed files + registered MCP stack for a fresh coworker with one teammate.
 * These existing caps cover the Event routing contract, not the native Event catalog.
 */
export const FIXED_STACK_BUDGET_CHARS = 34_000;
/** The same coworker with five documents in play and ten long-term memories. */
export const BUSY_STACK_BUDGET_CHARS = 36_000;
/** A separately measured native layer; not an increase to the file/MCP caps. */
export const NATIVE_EVENT_CATALOG_BUDGET_CHARS = 10_000;

const roots = [];
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

function registeredMcpCatalog() {
  // Match main's MCP registration: spawning/management are native plugin tools.
  const workers = workerToolCatalog().filter((tool) => tool.name !== "worker_spawn" && !WORKER_MANAGEMENT.includes(tool.name));
  return [...toolCatalog(), ...workers, ...assignmentToolCatalog(), ...selfToolCatalog(), ...teamToolCatalog()];
}

async function layers(coworker) {
  const files = await Promise.all(COWORKER_INSTRUCTIONS.concat("AGENTS.md").map(async (file) => [file, await readFile(path.join(coworker.path, file), "utf8")]));
  return [...files, ["registered MCP catalog", JSON.stringify(registeredMcpCatalog())], ["registered MCP instructions", DEFAULT_INSTRUCTIONS]];
}

function total(stack) {
  return stack.reduce((sum, [, text]) => sum + text.length, 0);
}

test("files and registered MCP stay bounded, with a separate native Event catalog budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-stack-"));
  roots.push(root);
  const dir = path.join(root, "coworkers");
  const nova = await createCoworker(dir, { name: "Nova", role: "Research and synthesis", mission: "I dig into questions, compare options, and bring back what matters in a page or less.", roleId: "research", firstNote: "Joined the team on Sep 4 to help with research and writing." });
  await createCoworker(dir, { name: "Editor", role: "Writing and content", mission: "I turn rough ideas into clear drafts and keep every piece in your voice.", roleId: "writing" });

  const fresh = await layers(nova);
  const freshTotal = total(fresh);
  for (const [name, text] of fresh) console.log(`fixed files + registered MCP: ${name}: ${text.length} chars`);
  console.log(`fixed files + registered MCP: ${freshTotal} chars (about ${Math.round(freshTotal / 4)} tokens)`);
  assert.ok(freshTotal <= FIXED_STACK_BUDGET_CHARS, `fixed files + registered MCP are ${freshTotal} chars; the budget is ${FIXED_STACK_BUDGET_CHARS}`);
  // The contract and registered MCP catalog also have individual caps.
  const catalog = fresh.find(([name]) => name === "registered MCP catalog")[1];
  assert.equal(registeredMcpCatalog().length, 21);
  assert.ok(catalog.length < 18_000, `the registered MCP catalog is ${catalog.length} chars`);
  const agentsChars = fresh.find(([name]) => name === "AGENTS.md")[1].length;
  assert.ok(agentsChars < 15_000, `AGENTS.md is ${agentsChars} chars; the cap is 15,000`);

  const eventCatalog = eventToolCatalog();
  const eventCatalogChars = JSON.stringify(eventCatalog).length;
  assert.equal(eventCatalog.length, 7);
  assert.equal(new Set(eventCatalog.map((tool) => tool.name)).size, eventCatalog.length, "native Event tool names must be unique");
  console.log(`native Event catalog: ${eventCatalog.length} tools, ${eventCatalogChars} chars (${eventCatalog.reduce((sum, tool) => sum + tool.description.length, 0)} description chars included)`);
  console.log(`fixed files + registered MCP + native Event catalog subtotal: ${freshTotal + eventCatalogChars} chars; excludes other native plugins, per-turn context and engine prompt`);
  assert.ok(eventCatalogChars <= NATIVE_EVENT_CATALOG_BUDGET_CHARS, `the native Event catalog is ${eventCatalogChars} chars; its separate budget is ${NATIVE_EVENT_CATALOG_BUDGET_CHARS}`);

  for (let index = 1; index <= 5; index += 1) {
    await createDocument(dir, nova.slug, {
      title: `Working document ${index}`,
      summary: `One sentence saying what document ${index} holds for the current piece of work.`,
      highlights: ["First takeaway", "Second takeaway", "Third takeaway"],
      body: "## Summary\n\nBody.\n\n## Details\n\nMore body.",
    });
  }
  for (let index = 1; index <= 10; index += 1) {
    await createLongTermMemory(dir, nova.slug, { title: `About topic ${index}`, summary: `What stays true about topic ${index}, in one line the index carries every turn.` });
  }
  const busy = await layers(nova);
  const busyTotal = total(busy);
  console.log(`busy files + registered MCP (5 documents, 10 memories): ${busyTotal} chars (+${busyTotal - freshTotal})`);
  console.log(`busy files + registered MCP + native Event catalog subtotal: ${busyTotal + eventCatalogChars} chars; excludes other native plugins, per-turn context and engine prompt`);
  assert.ok(busyTotal <= BUSY_STACK_BUDGET_CHARS, `busy files + registered MCP are ${busyTotal} chars; the budget is ${BUSY_STACK_BUDGET_CHARS}`);
  // Only the two indexes grow: one line per document, one per memory; nothing else changes with the work.
  const grew = busy.filter(([name, text]) => text.length !== fresh.find(([other]) => other === name)[1].length).map(([name]) => name);
  assert.deepEqual(grew, ["memory/index.md", "documents/index.md"]);
  assert.ok(busyTotal - freshTotal < 2_000, `five documents and ten memories add ${busyTotal - freshTotal} chars`);
});
