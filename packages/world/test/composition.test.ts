import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseWorldArgs } from "../src/cli.ts";
import { parseSeedFlag, seedsFromEnv } from "../src/seed.ts";
import { parseSourceFlag, resolveSources, sourceFor, sourcesFromEnv } from "../src/source.ts";
import { resolveTarget, targetFromEnv } from "../src/target.ts";
import { assertWorldSupport, readWorldSupport } from "../src/support.ts";
import { fileURLToPath } from "node:url";

const SHA = "a".repeat(40);

test("targets are explicit and reject impossible provider/OS combinations", () => {
  assert.deepEqual(resolveTarget({ provider: "local" }, "darwin"), { provider: "local", os: "macos" });
  assert.deepEqual(resolveTarget({ provider: "daytona", os: "windows" }), { provider: "daytona", os: "windows" });
  assert.deepEqual(resolveTarget({ provider: "freestyle" }), { provider: "freestyle", os: "linux" });
  assert.throws(() => resolveTarget({ provider: "local", os: "windows" }, "darwin"), /cannot run windows/);
  assert.throws(() => resolveTarget({ provider: "freestyle", os: "windows" }), /cannot run windows/);
  assert.throws(() => targetFromEnv({ OPENWORK_WORLD_PLACE: "future" }), /Unknown world placement/);
});

test("sources resolve moving refs before their identity is calculated", async () => {
  assert.deepEqual(parseSourceFlag("desktop=release:0.18.52/enterprise"), {
    component: "desktop", spec: { kind: "release", version: "0.18.52", distribution: "enterprise" },
  });
  const sources = await resolveSources([parseSourceFlag("den=ref:dev"), parseSourceFlag("desktop=release:0.18.52/enterprise")], async (ref) => {
    assert.equal(ref, "dev");
    return SHA;
  });
  assert.deepEqual(sourceFor(sources, "den"), { kind: "sha", sha: SHA, ref: "dev" });
  assert.deepEqual(sourceFor({ "*": { kind: "local" } }, "den"), { kind: "local" });
  assert.deepEqual(sourcesFromEnv({ OPENWORK_WORLD_SOURCES: JSON.stringify(sources) }), sources);
  await assert.rejects(resolveSources([parseSourceFlag("local"), parseSourceFlag("sha:" + SHA)], async () => SHA), /given twice/);
  assert.throws(() => parseSourceFlag("desktop=release:latest"), /release source/);
  assert.throws(() => parseSourceFlag("den=sha:dev"), /full 40-character/);
});

test("seeds have a bounded, round-trippable syntax", () => {
  assert.deepEqual(parseSeedFlag("team,sessions:20"), [{ name: "team" }, { name: "sessions", arg: "20" }]);
  assert.deepEqual(seedsFromEnv({ OPENWORK_WORLD_SEEDS: JSON.stringify(parseSeedFlag("team")) }), [{ name: "team" }]);
  assert.throws(() => parseSeedFlag("customer:private/key"), /Invalid argument/);
});

test("world support is read without importing the script and rejects unsupported targets", async () => {
  const preview = fileURLToPath(new URL("../../../worlds/preview-desktop.ts", import.meta.url));
  const support = await readWorldSupport(preview);
  assert.deepEqual(support, ["local/host", "daytona/linux"]);
  assert.doesNotThrow(() => assertWorldSupport("preview-desktop", support, { provider: "daytona", os: "linux" }));
  assert.throws(() => assertWorldSupport("preview-desktop", support, { provider: "freestyle", os: "linux" }), /cannot run on freestyle\/linux/);
  assert.throws(() => assertWorldSupport("custom", undefined, { provider: "freestyle", os: "linux" }), /no supportedTargets declaration/);
});

test("world CLI rejects a declared unsupported target before it launches the script", async () => {
  const directory = await mkdtemp(join(tmpdir(), "world-support-"));
  try {
    await writeFile(join(directory, "example.ts"), 'export const supportedTargets = ["local/host"];\nthrow new Error("script was launched");\n');
    const lines: string[] = [];
    const options = { cwd: directory, worldsDirectory: directory, print: (line: string) => { lines.push(line); } };
    assert.equal(await main(["up", "example", "--place", "freestyle"], options), 1);
    assert.match(lines.join("\n"), /cannot run on freestyle\/linux/);
    assert.doesNotMatch(lines.join("\n"), /script was launched/);
    lines.length = 0;
    assert.equal(await main(["help", "example", "--json"], options), 0);
    assert.deepEqual(JSON.parse(lines.join("")), { name: "example", path: "example.ts", supportedTargets: ["local/host"] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("world CLI parses sources and target independently from script arguments", () => {
  const parsed = parseWorldArgs(["up", "preview-desktop", "--place", "daytona", "--os", "windows", "--source", "desktop=release:0.18.52/enterprise", "--seed", "blank", "--", "--lifetime", "60"]);
  assert.equal(parsed.kind, "up");
  if (parsed.kind !== "up") return;
  assert.equal(parsed.os, "windows");
  assert.deepEqual(parsed.sources, [parseSourceFlag("desktop=release:0.18.52/enterprise")]);
  assert.deepEqual(parsed.seeds, [{ name: "blank" }]);
  assert.deepEqual(parsed.args, ["--lifetime", "60"]);
});
