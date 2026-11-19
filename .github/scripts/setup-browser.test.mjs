import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../actions/setup-browser/setup.sh", import.meta.url));

for (const [name, time64, expected] of [["Ubuntu 22", "false", "libasound2"], ["Ubuntu 24", "true", "libasound2t64"]]) {
  test(`browser setup selects the available ALSA package on ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwork-browser-setup-"));
    try {
      const bin = join(directory, "bin"), log = join(directory, "apt.log");
      await mkdir(bin);
      for (const [name, content] of [
        ["sudo", '#!/bin/sh\nprintf "%s\\n" "$*" >> "$APT_LOG"\n'],
        ["apt-cache", '#!/bin/sh\n[ "$*" = "show libasound2t64" ] && [ "$HAS_TIME64" = true ]\n'],
        ["google-chrome", '#!/bin/sh\nprintf "Chrome fixture\\n"\n'],
      ]) await writeFile(join(bin, name), content, { mode: 0o755 });
      const result = spawnSync("bash", [script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OAUTH_HANDOFF: "false", HAS_TIME64: time64, APT_LOG: log, RUNNER_TEMP: directory, GITHUB_ENV: join(directory, "github.env") },
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = await readFile(log, "utf8");
      const install = commands.split("\n").find((line) => line.startsWith("apt-get install -y "));
      assert.ok(install);
      assert.ok(install.split(" ").includes(expected), install);
      assert.ok(!install.split(" ").includes(expected === "libasound2" ? "libasound2t64" : "libasound2"), install);
      assert.match(await readFile(join(directory, "github.env"), "utf8"), /CHROME_BIN=.*google-chrome/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
