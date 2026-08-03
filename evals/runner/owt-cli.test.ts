import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { manifestPath, readEnvManifest } from "./env-manifest.ts";
import { main, parseAdoptSpec, parseArgs } from "./owt-cli.ts";
import type { Host, SurfaceHandle } from "./hosts/types.ts";

function fakeSurface(name: string, kind: "electron" | "chrome"): SurfaceHandle {
  const handle: SurfaceHandle = {
    name,
    kind,
    hostKind: "local",
    cdpUrl: `http://127.0.0.1/${kind}/${name}`,
    pid: 987654321,
    profileDir: `/tmp/openwork-fake-${name}`,
  };
  if (kind === "electron") handle.meta = { log: `/tmp/openwork-fake-${name}/electron.log` };
  return handle;
}

test("owt arg parsing handles subcommands and rejects unknown input", () => {
  assert.deepEqual(parseArgs([
    "up",
    "--name",
    "dev",
    "--org-mode",
    "multi_org",
    "--seed",
    "none",
    "--electron",
    "app-a,app-b",
    "--chrome",
    "web",
    "--den-base-url",
    "http://web.test",
    "--den-api-base-url",
    "http://api.test",
    "--host",
    "daytona",
    "--sandbox",
    "sandbox-1",
    "--adopt",
    "electron:existing:9825",
    "--cdp-url",
    "https://primary.example.test",
  ]), {
    command: "up",
    name: "dev",
    den: true,
    orgMode: "multi_org",
    seed: "none",
    electrons: ["app-a", "app-b"],
    chromes: ["web"],
    denBaseUrl: "http://web.test",
    denApiBaseUrl: "http://api.test",
    hostKind: "daytona",
    sandboxId: "sandbox-1",
    adopts: [{ kind: "electron", name: "existing", port: 9825 }],
    cdpUrl: "https://primary.example.test",
  });
  assert.deepEqual(parseArgs(["share", "--name", "dev"]), { command: "share", name: "dev" });
  assert.deepEqual(parseArgs(["down", "--name", "dev", "--stack"]), { command: "down", name: "dev", stack: true });
  assert.deepEqual(parseArgs(["run", "--name", "dev", "--flow", "x"]), { command: "run", name: "dev", rest: ["--flow", "x"] });
  assert.deepEqual(parseArgs(["proof", "--flow", "x"]), { command: "proof", name: "default", rest: ["--flow", "x"] });
  assert.throws(() => parseArgs(["wat"]), /Unknown owt command/);
  assert.throws(() => parseArgs(["up", "--wat"]), /Unknown up argument/);
});

test("owt --adopt parsing validates kind, name, and port", () => {
  assert.deepEqual(parseAdoptSpec("chrome:jamie-web:9222"), { kind: "chrome", name: "jamie-web", port: 9222 });
  assert.throws(() => parseAdoptSpec("browser:jamie-web:9222"), /Invalid --adopt kind/);
  assert.throws(() => parseAdoptSpec("chrome::9222"), /Surface name cannot be empty/);
  assert.throws(() => parseAdoptSpec("chrome:jamie-web:not-a-port"), /Port must be a number/);
  assert.throws(() => parseAdoptSpec("chrome:jamie-web:70000"), /between 1 and 65535/);
  assert.throws(() => parseAdoptSpec("chrome:jamie-web"), /Expected <kind>:<name>:<port>/);
});

test("owt delegates run/proof to the eval CLI with the selected env", async () => {
  const delegated: string[][] = [];
  await main(["run", "--name", "dev", "--flow", "alpha"], {
    evalMain: async (argv) => {
      delegated.push(argv);
    },
    print: () => undefined,
  });
  await main(["proof", "--flow", "beta"], {
    evalMain: async (argv) => {
      delegated.push(argv);
    },
    print: () => undefined,
  });

  assert.deepEqual(delegated, [
    ["--mode", "automation", "--env", "dev", "--flow", "alpha"],
    ["--mode", "demo", "--env", "default", "--flow", "beta"],
  ]);
});

test("owt manifest lifecycle writes fake surfaces, shares links, and tolerates ESRCH on down", async () => {
  const name = `owt-test-${Date.now()}`;
  const printed: string[] = [];
  const bootstraps: string[] = [];
  const previousToken = process.env.OPENWORK_EVAL_DEN_TOKEN;
  delete process.env.OPENWORK_EVAL_DEN_TOKEN;
  const host: Host = {
    kind: "fake-local",
    workspaceRoot: "/workspace",
    async spawnElectron(surfaceName, opts) {
      bootstraps.push(opts?.bootstrap?.baseUrl ?? "none");
      return fakeSurface(surfaceName, "electron");
    },
    async spawnChrome(surfaceName) {
      return fakeSurface(surfaceName, "chrome");
    },
    async startDen() {
      return { webUrl: "http://den-web.test", apiUrl: "http://den-api.test", orgMode: "multi_org", hostKind: "local" };
    },
    async disposeSurface() {
      return undefined;
    },
  };

  try {
    await main(["up", "--name", name, "--den", "--electron", "desk", "--chrome", "web"], {
      createHost: () => host,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      print: (line) => printed.push(line),
    });

    const manifest = await readEnvManifest(name);
    assert(manifest);
    assert.equal(manifest.name, name);
    assert.equal(manifest.createdAt, "2026-07-28T00:00:00.000Z");
    assert.equal(manifest.den?.webUrl, "http://den-web.test");
    assert.equal(manifest.surfaces.desk?.kind, "electron");
    assert.equal(manifest.surfaces.web?.kind, "chrome");
    assert.deepEqual(bootstraps, ["http://den-web.test"]);
    assert(printed.some((line) => line.includes("phase den:")));
    assert(printed.some((line) => line.includes("electron desk CDP: http://127.0.0.1/electron/desk")));

    printed.length = 0;
    await main(["share", "--name", name], { print: (line) => printed.push(line) });
    assert(printed.some((line) => line === "Den Web: http://den-web.test"));
    assert(printed.some((line) => line === "electron desk log: /tmp/openwork-fake-desk/electron.log"));

    printed.length = 0;
    await main(["down", "--name", name], { print: (line) => printed.push(line) });
    assert(printed.some((line) => line.includes("pid 987654321 was not running")));
    assert.equal(await readEnvManifest(name), null);
  } finally {
    if (previousToken === undefined) delete process.env.OPENWORK_EVAL_DEN_TOKEN;
    else process.env.OPENWORK_EVAL_DEN_TOKEN = previousToken;
    await rm(manifestPath(name), { force: true });
  }
});

test("owt up adopts existing Daytona surfaces without spawning", async () => {
  const name = `owt-adopt-test-${Date.now()}`;
  const printed: string[] = [];
  let spawnCount = 0;
  const host: Host = {
    kind: "fake-daytona",
    workspaceRoot: "/workspace",
    async previewUrl(port) {
      return `https://preview-${port}.example.test`;
    },
    async spawnElectron(surfaceName) {
      spawnCount += 1;
      return fakeSurface(surfaceName, "electron");
    },
    async spawnChrome(surfaceName) {
      spawnCount += 1;
      return fakeSurface(surfaceName, "chrome");
    },
    async disposeSurface() {
      return undefined;
    },
  };

  try {
    await main(["up", "--name", name, "--host", "daytona", "--sandbox", "sandbox-9", "--adopt", "electron:alex-desktop:9825", "--cdp-url", "https://primary.example.test"], {
      createHost: () => host,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      print: (line) => printed.push(line),
    });

    const manifest = await readEnvManifest(name);
    assert(manifest);
    assert.equal(spawnCount, 0);
    assert.equal(manifest.defaultHostKind, "daytona");
    assert.equal(manifest.env?.OPENWORK_EVAL_DAYTONA_SANDBOX, "sandbox-9");
    assert.equal(manifest.env?.OPENWORK_EVAL_CDP_URL, "https://primary.example.test");
    assert.deepEqual(manifest.surfaces["alex-desktop"], {
      name: "alex-desktop",
      kind: "electron",
      hostKind: "daytona",
      cdpUrl: "https://preview-9825.example.test",
      sandboxId: "sandbox-9",
      meta: { adopted: "1", cdpPort: "9825" },
    });
    assert(printed.some((line) => line === "electron alex-desktop CDP: https://preview-9825.example.test"));
  } finally {
    await rm(manifestPath(name), { force: true });
  }
});
