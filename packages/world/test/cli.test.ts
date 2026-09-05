import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      "--stage",
      "feature one",
      "--place",
      "daytona",
      "--",
      "--replace",
      "value",
    ]),
    {
      kind: "up",
      source: "./worlds/dev-headless.ts",
      detach: true,
      timeoutMs: 5000,
      stage: "feature-one",
      place: "daytona",
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

  assert.deepEqual(parseWorldArgs(["plan", "dev-headless", "--stage", "preview"]), {
    kind: "plan",
    source: "dev-headless",
    stage: "preview",
  });
  assert.deepEqual(parseWorldArgs(["down", "dev-headless", "--stage", "preview"]), {
    kind: "down",
    name: "dev-headless",
    stage: "preview",
  });
  assert.deepEqual(parseWorldArgs(["down", "dev-headless", "--purge"]), {
    kind: "down",
    name: "dev-headless",
    purge: true,
  });
  assert.deepEqual(parseWorldArgs(["down", "dev-headless", "--stage", "preview", "--purge"]), {
    kind: "down",
    name: "dev-headless",
    stage: "preview",
    purge: true,
  });
  assert.deepEqual(parseWorldArgs(["down", "dev-headless", "--purge", "--stage", "preview"]), {
    kind: "down",
    name: "dev-headless",
    stage: "preview",
    purge: true,
  });
  assert.deepEqual(parseWorldArgs(["up", "dev-headless", "--plain"]), {
    kind: "up",
    source: "dev-headless",
    plain: true,
    args: [],
  });
  assert.deepEqual(parseWorldArgs(["attach", "dev-headless"]), {
    kind: "attach",
    name: "dev-headless",
  });
  assert.deepEqual(parseWorldArgs(["attach", "dev-headless", "--stage", "preview", "--plain"]), {
    kind: "attach",
    name: "dev-headless",
    stage: "preview",
    plain: true,
  });
  assert.deepEqual(parseWorldArgs(["outputs", "dev-headless"]), {
    kind: "outputs",
    name: "dev-headless",
  });
  assert.deepEqual(parseWorldArgs(["outputs", "dev-headless", "--stage", "preview", "--reveal", "--json"]), {
    kind: "outputs",
    name: "dev-headless",
    stage: "preview",
    reveal: true,
    json: true,
  });
  const missingOutputsName = parseWorldArgs(["outputs"]);
  assert.equal(missingOutputsName.kind, "help");
  if (missingOutputsName.kind !== "help") throw new Error("expected help");
  assert.match(missingOutputsName.error ?? "", /needs exactly one world name/);
  const outputsPurge = parseWorldArgs(["outputs", "dev-headless", "--purge"]);
  assert.equal(outputsPurge.kind, "help");
  if (outputsPurge.kind !== "help") throw new Error("expected help");
  assert.match(outputsPurge.error ?? "", /Unknown world CLI option "--purge"/);
  const missingAttachName = parseWorldArgs(["attach", "--plain"]);
  assert.equal(missingAttachName.kind, "help");
  if (missingAttachName.kind !== "help") throw new Error("expected help");
  assert.match(missingAttachName.error ?? "", /needs exactly one world name/);

  const invalidPlace = parseWorldArgs(["up", "dev-headless", "--place", "remote"]);
  assert.equal(invalidPlace.kind, "help");
  if (invalidPlace.kind !== "help") throw new Error("expected help");
  assert.match(invalidPlace.error ?? "", /local or daytona/);

  const emptyStage = parseWorldArgs(["up", "dev-headless", "--stage", "---"]);
  assert.equal(emptyStage.kind, "help");
  if (emptyStage.kind !== "help") throw new Error("expected help");
  assert.match(emptyStage.error ?? "", /non-empty stage value/);

  const unknownPlanFlag = parseWorldArgs(["plan", "dev-headless", "--detach"]);
  assert.equal(unknownPlanFlag.kind, "help");
  if (unknownPlanFlag.kind !== "help") throw new Error("expected help");
  assert.match(unknownPlanFlag.error ?? "", /Unknown world CLI option "--detach"/);

  for (const args of [["up", "dev-headless", "--purge"], ["plan", "dev-headless", "--purge"]]) {
    const result = parseWorldArgs(args);
    assert.equal(result.kind, "help");
    if (result.kind !== "help") throw new Error("expected help");
    assert.match(result.error ?? "", /Unknown world CLI option "--purge"/);
  }
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

test("preflight failures warn without blocking up and do not affect attach or plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-cli-preflight-"));
  const worldsDirectory = join(root, "worlds");
  const receiptPath = join(root, "evals", "results", ".worlds", "scripts", "warned.json");
  const holdUrl = new URL("../src/hold.ts", import.meta.url).href;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
  process.on("unhandledRejection", onUnhandledRejection);
  let checks = 0;
  const failingCheck = {
    id: "fixture",
    label: "fixture service",
    async run() {
      checks += 1;
      return { ok: false, detail: "offline", hint: "start fixture" };
    },
  };
  try {
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "warned.ts"), [
      `import { hold } from ${JSON.stringify(holdUrl)};`,
      'await hold({ name: "warned", outputs: { ready: "yes" } });',
      "",
    ].join("\n"), "utf8");

    const progress: string[] = [];
    assert.equal(await main(["up", "warned", "--detach"], {
      cwd: root,
      worldsDirectory,
      preflight: [failingCheck],
      print: () => {},
      progress: (line) => progress.push(line),
    }), 0);
    assert.ok(progress.includes("preflight  node ✔  fixture service ✖"));
    assert.ok(progress.includes("⚠ fixture service offline — start fixture"));
    assert.equal(await access(receiptPath).then(() => true, () => false), true);

    const attachProgress: string[] = [];
    assert.equal(await main(["attach", "warned", "--plain"], {
      cwd: root,
      worldsDirectory,
      preflight: [failingCheck],
      print: () => {},
      progress: (line) => attachProgress.push(line),
    }), 0);
    assert.ok(attachProgress.some((line) => line.startsWith("✔ warned is up")));
    assert.equal(checks, 1, "attach does not run preflight");

    const planLines: string[] = [];
    assert.equal(await main(["plan", "warned"], {
      cwd: root,
      worldsDirectory,
      preflight: [failingCheck],
      print: (line) => planLines.push(line),
      progress: () => {},
    }), 0);
    assert.equal(planLines[0], "• running (attachable)");
    assert.equal(checks, 1, "plan does not run preflight");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await main(["down", "warned"], {
      cwd: root,
      worldsDirectory,
      print: () => {},
      progress: () => {},
    });
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
