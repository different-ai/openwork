import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { createManagedOpencodeServer } from "../../apps/server/src/managed-opencode";

/**
 * Engine v1 shares its storage defaults with a standalone opencode install, so a
 * newer opencode on the same machine makes the managed engine exit 1 on startup
 * and leaves the app unable to boot. These specs drive a stand-in engine that
 * reproduces those exact exits and record the storage environment it was handed,
 * proving the recovery is both taken when it applies and withheld when it does not.
 *
 * No real opencode binary runs here: the point under test is which environment
 * OpenWork spawns the engine with, not how the engine reads it.
 */

type FakeEngineMode = "foreign" | "healthy" | "unrelated-failure";

type SpawnRecord = {
  OPENCODE_DB?: string;
  OPENCODE_CONFIG_DIR?: string;
  XDG_CONFIG_HOME?: string;
};

const FOREIGN_STORAGE_STDERR =
  "Error: Unexpected error\n\nDatabase is not empty and has no session table";

/** The engine's own wording when its global config was written by opencode v2. */
const FOREIGN_CONFIG_STDERR =
  "Error: Unexpected error\n\nConfiguration is invalid at /home/example/.config/opencode/opencode.json\n" +
  "↳ V2 permissions are not supported by OpenCode V1. Use V1 \"permission\" rules or run opencode2. permissions";

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to reserve a port for the stand-in engine"));
      });
    });
  });
}

/**
 * A stand-in engine. `foreign` refuses to boot unless it was handed private
 * storage, which is exactly the choice the recovery retry has to make.
 */
function fakeEngineSource(): string {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const record = {
  OPENCODE_DB: process.env.OPENCODE_DB,
  OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(record) + "\\n");
const mode = process.env.FAKE_ENGINE_MODE;
const isolated = typeof process.env.OPENCODE_DB === "string" && process.env.OPENCODE_DB !== "";
if (mode === "unrelated-failure") {
  process.stderr.write("Error: Unexpected error\\n\\nsome unrelated startup failure\\n");
  process.exit(1);
}
if (mode === "foreign" && !isolated) {
  process.stderr.write(process.env.FAKE_ENGINE_STDERR + "\\n");
  process.exit(1);
}
process.stdout.write("opencode server listening on http://127.0.0.1:" + process.env.FAKE_ENGINE_PORT + "\\n");
setInterval(() => {}, 1 << 30);
`;
}

type Harness = {
  bin: string;
  cwd: string;
  stateDir: string;
  logPath: string;
  env: Record<string, string>;
  spawns: () => Promise<SpawnRecord[]>;
};

async function harness(mode: FakeEngineMode, stderr: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "engine-foreign-storage-"));
  const cwd = join(root, "cwd");
  const stateDir = join(root, "state");
  const logPath = join(root, "spawns.jsonl");
  await mkdir(cwd, { recursive: true });
  const bin = join(root, "fake-opencode.cjs");
  await writeFile(bin, fakeEngineSource(), "utf8");
  await chmod(bin, 0o755);
  return {
    bin,
    cwd,
    stateDir,
    logPath,
    env: {
      FAKE_ENGINE_LOG: logPath,
      FAKE_ENGINE_MODE: mode,
      FAKE_ENGINE_STDERR: stderr,
      FAKE_ENGINE_PORT: String(await freePort()),
    },
    spawns: async () => {
      const raw = await readFile(logPath, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SpawnRecord);
    },
  };
}

for (const [label, stderr] of [
  ["a v2 database", FOREIGN_STORAGE_STDERR],
  ["a v2 global config", FOREIGN_CONFIG_STDERR],
] satisfies [string, string][]) {
  test(`managed engine v1 recovers from ${label} by restarting on private storage`, async () => {
    const world = await harness("foreign", stderr);
    try {
      const server = await createManagedOpencodeServer({
        bin: world.bin,
        cwd: world.cwd,
        stateDir: world.stateDir,
        env: world.env,
      });
      try {
        expect(new URL(server.url).port).toBe(world.env.FAKE_ENGINE_PORT);
        const spawns = await world.spawns();
        expect(spawns).toHaveLength(2);
        // The first attempt inherited the colliding defaults and refused.
        expect(spawns[0]?.OPENCODE_DB).toBeUndefined();
        // The retry handed the engine a store no other opencode install writes.
        const isolated = spawns[1];
        expect(isolated?.OPENCODE_DB).toBe(join(world.stateDir, "foreign-storage", "opencode.db"));
        expect(isolated?.OPENCODE_CONFIG_DIR).toBe(join(world.stateDir, "foreign-storage", "config"));
        expect(isolated?.XDG_CONFIG_HOME).toBe(join(world.stateDir, "foreign-storage", "xdg-config"));
        // The engine's own view of its environment agrees with the record above.
        expect(server.execution.env.find((entry) => entry.name === "OPENCODE_DB")?.value).toBe(isolated?.OPENCODE_DB);
      } finally {
        await server.close();
      }
    } finally {
      await rm(join(world.cwd, ".."), { recursive: true, force: true });
    }
  });
}

test("managed engine v1 leaves a working shared store alone", async () => {
  const world = await harness("healthy", FOREIGN_STORAGE_STDERR);
  try {
    const server = await createManagedOpencodeServer({
      bin: world.bin,
      cwd: world.cwd,
      stateDir: world.stateDir,
      env: world.env,
    });
    try {
      // One spawn, and no storage redirect: sharing history stays the default
      // for the installs where sharing is correct.
      expect(await world.spawns()).toHaveLength(1);
      expect(server.execution.env.some((entry) => entry.name === "OPENCODE_DB")).toBe(false);
      expect(server.execution.env.some((entry) => entry.name === "XDG_CONFIG_HOME")).toBe(false);
    } finally {
      await server.close();
    }
  } finally {
    await rm(join(world.cwd, ".."), { recursive: true, force: true });
  }
});

test("managed engine v1 surfaces unrelated startup failures instead of retrying", async () => {
  const world = await harness("unrelated-failure", FOREIGN_STORAGE_STDERR);
  try {
    await expect(createManagedOpencodeServer({
      bin: world.bin,
      cwd: world.cwd,
      stateDir: world.stateDir,
      env: world.env,
    })).rejects.toThrow(/some unrelated startup failure/);
    // Retrying would only hide the real cause behind a second, quieter failure.
    expect(await world.spawns()).toHaveLength(1);
  } finally {
    await rm(join(world.cwd, ".."), { recursive: true, force: true });
  }
});

test("managed engine v1 does not retry when no private storage is offered", async () => {
  const world = await harness("foreign", FOREIGN_STORAGE_STDERR);
  try {
    await expect(createManagedOpencodeServer({
      bin: world.bin,
      cwd: world.cwd,
      env: world.env,
    })).rejects.toThrow(/has no session table/);
    expect(await world.spawns()).toHaveLength(1);
  } finally {
    await rm(join(world.cwd, ".."), { recursive: true, force: true });
  }
});