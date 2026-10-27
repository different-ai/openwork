import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerCredentialBrokerSource } from "../../../apps/server/src/opencode-v2-provider-channel.ts"

const capability = "private-channel-test-capability"
const endpoint = "http://127.0.0.1:1234/provider-session"
const entry = new URL("./server.ts", import.meta.url).href
const broker = new URL("./desktop-credential-channel.ts", import.meta.url).href

for (const runtime of [process.execPath, ...(process.execPath.endsWith("/bun") ? [] : ["bun"])]) {
  test(`${runtime}: one-shot channel closes before setup and remains private across Locations/reloads`, async t => {
    const root = await mkdtemp(join(tmpdir(), "openwork-channel-test-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const brokerPath = join(root, "broker.cjs")
    await writeFile(brokerPath, providerCredentialBrokerSource)
    assert.ok(!providerCredentialBrokerSource.includes(capability))
    const script = `
      import assert from "node:assert/strict";
      import { fstatSync, readFileSync } from "node:fs";
      import { spawnSync } from "node:child_process";
      const initial = JSON.stringify(process.env);
      assert.ok(!initial.includes(${JSON.stringify(capability)}));
      if (process.platform === "linux") assert.ok(!readFileSync("/proc/self/environ", "utf8").includes(${JSON.stringify(capability)}));
      const plugin = (await import(${JSON.stringify(entry)})).default;
      assert.throws(() => fstatSync(3), /EBADF/);
      // Flag-off setup must not expose or consume a second copy of the channel.
      await plugin.setup({ options: { desktopSession: ${JSON.stringify(endpoint)}, liveProviderSync: false } });
      const { fetchDesktopSession } = await import(${JSON.stringify(broker)});
      // Separate ESM copies (matching native Location/source graphs) must share
      // the native broker without a global credential getter or another fd read.
      const otherGraph = await import(${JSON.stringify(`${broker}?another-location`)});
      let reads = 0;
      const fetcher = async (url, init) => {
        assert.equal(url, ${JSON.stringify(endpoint)});
        assert.equal(init.headers.authorization, ${JSON.stringify(`Bearer ${capability}`)});
        assert.equal(init.redirect, "error");
        reads++;
        return new Response("null");
      };
      for (let location = 0; location < 3; location++) {
        const read = location === 1 ? otherGraph.fetchDesktopSession : fetchDesktopSession;
        assert.equal((await read(fetcher, ${JSON.stringify(endpoint)})).status, 200);
      }
      assert.equal(reads, 3);
      assert.equal(await fetchDesktopSession(fetcher, "http://127.0.0.1:5678/steal"), null);
      const shell = spawnSync(process.env.SHELL || "/bin/sh", ["-c", "env"], { encoding: "utf8" });
      assert.equal(shell.status, 0);
      assert.ok(!shell.stdout.includes(${JSON.stringify(capability)}));
      assert.ok(!Object.values(globalThis).includes(${JSON.stringify(capability)}));
      console.log("private-channel-ok");
    `
    const env: Record<string, string | undefined> = { ...process.env, OPENWORK_PROVIDER_SESSION_FD: "3", OPENWORK_PROVIDER_SESSION_BROKER: brokerPath }
    delete env.OPENWORK_PROVIDER_SESSION_TOKEN
    const child = spawn(runtime, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe", "pipe"] })
    assert.ok(child.stdout && child.stderr)
    let output = ""
    let errors = ""
    child.stdout.on("data", chunk => { output += String(chunk) })
    child.stderr.on("data", chunk => { errors += String(chunk) })
    const channel = child.stdio[3]
    assert.ok(channel && "end" in channel)
    let channelError: Error | undefined
    channel.on("error", error => { channelError = error })
    // Subscribe before writing so a missing required runtime reports its spawn
    // error, rather than an incidental EPIPE hiding the CI prerequisite.
    const closed = once(child, "close")
    channel.end(JSON.stringify({ endpoint, token: capability }))
    const [code] = await closed
    assert.equal(code, 0, errors)
    assert.equal(channelError, undefined, `credential delivery failed: ${channelError?.message ?? ""}`)
    assert.match(output, /private-channel-ok/)
  })
}
