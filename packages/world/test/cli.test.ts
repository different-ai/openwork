import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, parseWorldArgs } from "../src/cli.ts";
import { discoverWorlds, resolveWorldScript } from "../src/loader.ts";

test("world arguments expose only script lifecycle flags and forward arguments after --", () => {
  assert.deepEqual(
    parseWorldArgs([
      "up",
      "./worlds/dev-headless.ts",
      "--detach",
      "--timeout",
      "5000",
      "--",
      "--replace",
      "value",
    ]),
    {
      kind: "up",
      source: "./worlds/dev-headless.ts",
      detach: true,
      timeoutMs: 5000,
      args: ["--replace", "value"],
    },
  );

  const foregroundTimeout = parseWorldArgs(["up", "dev-headless", "--timeout", "5000"]);
  assert.equal(foregroundTimeout.kind, "help");
  if (foregroundTimeout.kind !== "help") throw new Error("expected help");
  assert.match(foregroundTimeout.error ?? "", /only with --detach/);

  const oldFlag = parseWorldArgs(["up", "dev-headless", "--keep"]);
  assert.equal(oldFlag.kind, "help");
  if (oldFlag.kind !== "help") throw new Error("expected help");
  assert.match(oldFlag.error ?? "", /Unknown world CLI option "--keep"/);

  const oldCommand = parseWorldArgs(["resume", "dev-headless"]);
  assert.equal(oldCommand.kind, "help");
  if (oldCommand.kind !== "help") throw new Error("expected help");
  assert.match(oldCommand.error ?? "", /Unknown command "resume"/);
});

test("discovery, resolution, list, and help classify scripts without importing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-cli-discovery-"));
  try {
    const worldsDirectory = join(root, "worlds");
    const fixturePath = join(worldsDirectory, "throwing.ts");
    await mkdir(worldsDirectory);
    await writeFile(fixturePath, 'throw new Error("must not import");\n', "utf8");

    assert.deepEqual(await discoverWorlds(worldsDirectory), [{
      kind: "script",
      name: "throwing",
      path: fixturePath,
    }]);
    for (const source of ["throwing", "throwing.ts", fixturePath]) {
      assert.deepEqual(await resolveWorldScript(source, { cwd: root, worldsDirectory }), {
        kind: "script",
        name: "throwing",
        path: fixturePath,
      });
    }

    for (const command of [["list"], ["help"]]) {
      const lines: string[] = [];
      assert.equal(await main(command, {
        cwd: root,
        worldsDirectory,
        print: (line) => lines.push(line),
      }), 0);
      assert.match(lines.join("\n"), /world scripts/i);
      assert.match(lines.join("\n"), /throwing/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("foreground scripts receive argv after -- and mirror their exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-cli-argv-"));
  try {
    const worldsDirectory = join(root, "worlds");
    const outputPath = join(root, "argv.json");
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "argv.ts"), `
import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], JSON.stringify(process.argv.slice(3)), "utf8");
process.exitCode = 7;
`, "utf8");

    const code = await main(["up", "argv", "--", outputPath, "--detach", "plain"], {
      cwd: root,
      worldsDirectory,
      print: () => {},
    });
    assert.equal(code, 7);
    const recordedArgs: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(recordedArgs, ["--detach", "plain"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
