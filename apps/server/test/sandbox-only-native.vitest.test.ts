import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { serve } from "../src/serve-node.js";

// Explicit local native integration. No production identity, inference or VM required.
test.skipIf(process.env.OPENWORK_TEST_SANDBOX_NATIVE !== "1").each(["off", "only"])("pinned native registry applies %s mode before local MCP spawn", async mode => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-native-"));
  const directory = join(root, "project");
  const plugins = join(root, "plugins");
  await mkdir(directory); await mkdir(plugins);
  const captured = join(root, "capabilities.json");
  const catalog = join(root, "catalog.json");
  const sentinel = join(root, "must-not-spawn");
  for (const name of ["openwork-context-v2", "openwork-mcp-results-v2", "openwork-mcp-readiness-v2", "openwork-visible-reasoning-v2", "openwork-auto-route-v2", "openwork-sandbox-v2"]) {
    const source = pathToFileURL(fileURLToPath(new URL(`../src/opencode-plugins/${name}.ts`, import.meta.url))).href;
    await writeFile(join(plugins, `${name}.js`), name === "openwork-sandbox-v2"
      ? `import { writeFile } from "node:fs/promises";\nimport plugin from ${JSON.stringify(source)};\nexport default { id: plugin.id, async setup(context) { await writeFile(${JSON.stringify(captured)}, JSON.stringify({ context: Object.keys(context), tool: Object.keys(context.tool), mcp: Object.keys(context.mcp), session: Object.keys(context.session), browser: context.browser && Object.keys(context.browser), codemode: context.codemode && Object.keys(context.codemode) })); const close = await plugin.setup(context); await writeFile(${JSON.stringify(catalog)}, JSON.stringify(await context.tool.list())); return close; } };\n`
      : `export { default } from ${JSON.stringify(source)};\n`);
  }
  await writeFile(join(directory, "opencode.json"), JSON.stringify({ mcp: { forbidden_local: { type: "local", command: ["sh", "-c", `touch ${JSON.stringify(sentinel)}`] } } }));
  const bridge = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ mode }) });
  const previous = process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = plugins;
  const engine = await createManagedOpencodeV2Server({
    bin: process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2", rootDir: join(root, "engine"),
    contextTools: { url: `http://127.0.0.1:${bridge.port}/read`, token: "native-fixture", sandbox: { url: `http://127.0.0.1:${bridge.port}/sandbox`, token: "native-fixture" } },
    env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
  });
  try {
    const initialized = await engine.fetchJson("/api/agent", { directory, timeoutMs: 30_000 });
    expect(initialized.status, JSON.stringify(initialized)).toBe(200);
    const capability: unknown = JSON.parse(await readFile(captured, "utf8"));
    expect(capability).toMatchObject({ tool: expect.arrayContaining(["hook", "transform", "reload"]), mcp: expect.arrayContaining(["transform", "reload"]) });
    console.log("native required-mode extension APIs", capability);
    const nativeTools: { id: string; options?: { codemode?: boolean } }[] = JSON.parse(await readFile(catalog, "utf8"));
    if (mode === "only") {
      expect(nativeTools.every(tool => tool.options?.codemode === false)).toBe(true);
      expect(nativeTools.map(tool => tool.id).sort()).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
    } else {
      expect(nativeTools.map(tool => tool.id)).toEqual(expect.arrayContaining(["shell", "read", "patch", "subagent"]));
    }
    const status = await engine.fetchJson("/api/mcp", { directory });
    expect(status.status).toBe(200);
    console.log("native sandbox MCP status", JSON.stringify(status));
    if (mode === "only") {
      expect(JSON.stringify(status.json)).toContain("disabled");
      await expect(access(sentinel)).rejects.toThrow();
    } else {
      expect(JSON.stringify(status.json)).not.toContain("disabled");
      await expect(access(sentinel)).resolves.toBeUndefined();
    }
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
    else process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR = previous;
    await engine.close(); await bridge.stop(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);
