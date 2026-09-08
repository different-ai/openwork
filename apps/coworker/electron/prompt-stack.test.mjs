/**
 * The instruction stack a coworker turn receives from the app itself — the six
 * always-loaded files and the tool server's catalog and instructions — measured
 * as characters and kept within a budget.
 * The engine adds its own system prompt on top; that part is measured in the
 * packaged journeys, not here.
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
import { teamToolCatalog } from "./team-tools.mjs";
import { workerToolCatalog } from "./workers.mjs";

/**
 * The whole fixed stack for a fresh coworker with one teammate, in characters
 * (about four characters per token). 30,000 held the shape rule; the working
 * notes ("Keeping track of what I'm doing", the memory_note tool) and "How I
 * decide" together added about 5,500 — the two sections are the first place to
 * tighten when the budget is next revisited.
 */
export const FIXED_STACK_BUDGET_CHARS = 34_000;
/** The same coworker with five documents in play and ten long-term memories. */
export const BUSY_STACK_BUDGET_CHARS = 36_000;

const roots = [];
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

function fullCatalog() {
  return [...toolCatalog(), ...workerToolCatalog(), ...assignmentToolCatalog(), ...selfToolCatalog(), ...teamToolCatalog()];
}

async function layers(coworker) {
  const files = await Promise.all(COWORKER_INSTRUCTIONS.concat("AGENTS.md").map(async (file) => [file, await readFile(path.join(coworker.path, file), "utf8")]));
  return [...files, ["tool catalog", JSON.stringify(fullCatalog())], ["tool server instructions", DEFAULT_INSTRUCTIONS]];
}

function total(stack) {
  return stack.reduce((sum, [, text]) => sum + text.length, 0);
}

test("the fixed instruction stack stays within its budget, and the variable part is the index lines alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-stack-"));
  roots.push(root);
  const dir = path.join(root, "coworkers");
  const nova = await createCoworker(dir, { name: "Nova", role: "Research and synthesis", mission: "I dig into questions, compare options, and bring back what matters in a page or less.", roleId: "research", firstNote: "Joined the team on Sep 4 to help with research and writing." });
  await createCoworker(dir, { name: "Editor", role: "Writing and content", mission: "I turn rough ideas into clear drafts and keep every piece in your voice.", roleId: "writing" });

  const fresh = await layers(nova);
  const freshTotal = total(fresh);
  for (const [name, text] of fresh) console.log(`fixed stack · ${name}: ${text.length} chars`);
  console.log(`fixed stack · total: ${freshTotal} chars (about ${Math.round(freshTotal / 4)} tokens)`);
  assert.ok(freshTotal <= FIXED_STACK_BUDGET_CHARS, `the fixed stack is ${freshTotal} chars; the budget is ${FIXED_STACK_BUDGET_CHARS}`);
  // The tool catalog is the largest fixed cost; the contract is the second. Both are known quantities.
  const catalog = fresh.find(([name]) => name === "tool catalog")[1];
  assert.equal(fullCatalog().length, 26);
  assert.ok(catalog.length < 18_000, `the tool catalog is ${catalog.length} chars`);
  assert.ok(fresh.find(([name]) => name === "AGENTS.md")[1].length < 15_000);

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
  console.log(`busy stack (5 documents, 10 memories) · total: ${busyTotal} chars (+${busyTotal - freshTotal})`);
  assert.ok(busyTotal <= BUSY_STACK_BUDGET_CHARS, `the busy stack is ${busyTotal} chars; the budget is ${BUSY_STACK_BUDGET_CHARS}`);
  // Only the two indexes grow: one line per document, one per memory; nothing else changes with the work.
  const grew = busy.filter(([name, text]) => text.length !== fresh.find(([other]) => other === name)[1].length).map(([name]) => name);
  assert.deepEqual(grew, ["memory/index.md", "documents/index.md"]);
  assert.ok(busyTotal - freshTotal < 2_000, `five documents and ten memories add ${busyTotal - freshTotal} chars`);
});
