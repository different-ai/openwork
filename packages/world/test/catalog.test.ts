import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EXAMPLE_PLACEHOLDERS, SEED_MEANINGS, WORLD_GUIDES, guideSeeds } from "../src/catalog.ts";
import { parseWorldArgs } from "../src/cli.ts";
import { discoverWorlds } from "../src/loader.ts";
import { readWorldSummary, readWorldSupport, targetMatches } from "../src/support.ts";
import { resolveTarget } from "../src/target.ts";

const WORLDS = fileURLToPath(new URL("../../../worlds", import.meta.url));

/** Sample values that keep example commands parseable. */
const SAMPLES: Readonly<Record<string, string>> = {
  "<stage>": "example",
  "<full-pushed-sha>": "a".repeat(40),
  "<x.y.z>": "0.18.52",
  "<distribution>": "enterprise",
};

test("the catalog advertises exactly the targets each world script declares", async () => {
  for (const [name, guide] of Object.entries(WORLD_GUIDES)) {
    const declared = await readWorldSupport(join(WORLDS, `${name}.ts`));
    assert.deepEqual(guide.targets.map((target) => target.target).sort(), [...(declared ?? [])].sort(), name);
    for (const seed of guideSeeds(guide)) assert.ok(SEED_MEANINGS[seed], `${seed} has a meaning`);
  }
});

test("every example is a valid world up invocation the catalog allows on its target", () => {
  for (const [name, guide] of Object.entries(WORLD_GUIDES)) {
    assert.ok(guide.examples.length > 0, `${name} has examples`);
    for (const example of guide.examples) {
      let command = example.command;
      for (const placeholder of Object.keys(EXAMPLE_PLACEHOLDERS)) command = command.replaceAll(placeholder, SAMPLES[placeholder] ?? "");
      assert.doesNotMatch(command, /<[^>]+>/, `${example.command} uses only documented placeholders`);
      const [pnpm, world, ...argv] = command.split(/\s+/);
      assert.deepEqual([pnpm, world], ["pnpm", "world"], example.command);
      const parsed = parseWorldArgs(argv);
      assert.equal(parsed.kind, "up", `${example.command}: ${parsed.kind === "help" ? parsed.error : ""}`);
      if (parsed.kind !== "up") continue;
      assert.equal(parsed.source, name, example.command);
      const target = resolveTarget({ provider: parsed.place, os: parsed.os });
      const entry = guide.targets.find((candidate) => targetMatches(candidate.target, target));
      assert.ok(entry, `${example.command} runs on a catalog target`);
      if (!entry) continue;
      for (const seed of parsed.seeds ?? []) assert.ok(entry.seeds.includes(seed.name), `${example.command}: ${seed.name} on ${entry.target}`);
      for (const source of parsed.sources ?? []) {
        assert.ok(guide.components.includes(source.component), `${example.command}: component ${source.component}`);
        assert.ok(entry.sources.includes(source.spec.kind), `${example.command}: ${source.spec.kind} on ${entry.target}`);
      }
      if ((parsed.sources ?? []).length === 0) assert.ok(entry.defaultSource, `${example.command} omits --source only where a default exists`);
    }
  }
});

test("every world in worlds/ declares a static one-line summary", async () => {
  for (const world of await discoverWorlds(WORLDS)) {
    const summary = await readWorldSummary(world.path);
    assert.ok(summary && !summary.includes("\n"), `${world.name} declares export const summary = "..."`);
  }
});
