import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { test } from "node:test"

const run = promisify(execFile)

test("an old sparse checkout loads normally with remote sessions off; opt-in failure is inspectable and nonfatal", async () => {
  const root = await mkdtemp(join(process.env.OPENWORK_PLUGIN_TEST_TMPDIR ?? tmpdir(), "plugin-sparse-"))
  try {
    const source = join(root, "packages", "opencode-plugin", "src")
    await mkdir(source, { recursive: true })
    await cp(new URL(".", import.meta.url), source, { recursive: true })
    const plugin = pathToFileURL(join(source, "plugin.ts")).href
    const fakeHost = pathToFileURL(join(source, "test-native.ts")).href
    const script = `
      import assert from "node:assert/strict";
      import { createPlugin } from ${JSON.stringify(plugin)};
      import { createNativeHost } from ${JSON.stringify(fakeHost)};
      const host = createNativeHost();
      host.connection = undefined;
      const ordinary = await createPlugin({ fetch: async () => { throw new Error("No remote traffic expected") } }).setup(host.ctx);
      assert.equal(host.storage.has("remoteSessions/status"), false);
      await ordinary?.();
      const optedIn = await createPlugin().setup({ ...host.ctx, options: { remoteSessions: true } });
      for (let i = 0; i < 20 && !host.storage.has("remoteSessions/status"); i++) await new Promise(resolve => setTimeout(resolve, 10));
      const status = host.storage.get("remoteSessions/status");
      assert.equal(status?.status, "unavailable");
      assert.match(status?.message ?? "", /sparse-checkout set packages\\/opencode-plugin packages\\/remote-sessions/);
      await optedIn?.();
      console.log("sparse compatibility passed");
    `
    const result = await run(process.execPath, ["--input-type=module", "-e", script], { cwd: root })
    assert.match(result.stdout, /sparse compatibility passed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
