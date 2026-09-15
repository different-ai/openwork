import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { updateNativeConfig } from "./native-config.mjs";
import nativeRuntime from "../native-runtime.json" with { type: "json" };

export const NATIVE_PLUGIN_VERSION = nativeRuntime.opencodeV2Version;
export const NATIVE_PLUGIN_DEPENDENCIES = Object.freeze({ "@opencode-ai/plugin": NATIVE_PLUGIN_VERSION, "@opencode-ai/schema": NATIVE_PLUGIN_VERSION, effect: "4.0.0-rc.112", zod: "4.1.8" });
export const NATIVE_PLUGIN_FILES = Object.freeze(["coworker-collaboration.js", "coworker-browser.js", "coworker-computer.js",
  "coworker-group-documents.js", "progress-summary.js", "auto-memory.js", "coworker-turn-roles.js", "coworker-events.js", "coworker-abilities.js"]);

export function validateNativePluginManifest(manifest) {
  const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  if (manifest?.format !== "coworker-native-plugins/v1" || manifest.opencodeVersion !== NATIVE_PLUGIN_VERSION
    || !exactKeys(manifest.dependencies, Object.keys(NATIVE_PLUGIN_DEPENDENCIES))
    || Object.entries(NATIVE_PLUGIN_DEPENDENCIES).some(([name, version]) => manifest.dependencies[name] !== version)
    || !exactKeys(manifest.entries, NATIVE_PLUGIN_FILES)) throw new Error("Native plugin bundle manifest does not match this runtime.");
  for (const name of NATIVE_PLUGIN_FILES) {
    const entry = manifest.entries[name];
    if (entry?.file !== name.replace(/\.js$/, ".mjs") || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid native plugin bundle declaration: ${name}`);
  }
  return manifest;
}

async function readBundleManifest() {
  if (!bundleDirectory || !path.isAbsolute(bundleDirectory)) throw new Error("Native plugin bundles must be prepared before opening coworker workspaces.");
  return validateNativePluginManifest(JSON.parse(await readFile(path.join(bundleDirectory, "manifest.json"), "utf8")));
}

async function readBundle(entry) {
  const source = await readFile(path.join(bundleDirectory, entry.file));
  if (source.length !== entry.bytes || createHash("sha256").update(source).digest("hex") !== entry.sha256) throw new Error("Native plugin bundle failed integrity verification.");
  return source;
}

/** Validate the complete payload before opening any workspace, including a fresh profile. */
export async function verifyNativePluginBundles() {
  const manifest = await readBundleManifest();
  await Promise.all(NATIVE_PLUGIN_FILES.map((name) => readBundle(manifest.entries[name])));
}

let bundleDirectory = process.env.OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR || null;

/** Set once before workspace preparation. The directory is a packaged build
 * artifact, not node_modules or a per-coworker package installation. */
export function configureNativePluginBundles(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("Choose an absolute native plugin bundle directory.");
  bundleDirectory = directory;
}

// Embedded in each installed module. These are native Effect tools, not Promise
// plugin adapters: interruption cancels transport AND drains scoped broker cleanup.
function brokerTool(ctx, name, input, description, { control = false, textOnly = false } = {}) {
  // Standard Schema crosses bundle boundaries; native instanceof checks against
  // its own Zod copy do not. Keep runtime validation and JSON Schema together.
  const json = schema.toJSONSchema(input);
  const standard = { "~standard": { version: 1, vendor: "coworker-zod", validate: (value) => input["~standard"].validate(value), jsonSchema: { input: () => json, output: () => json } } };
  return {
    name, input: standard, description, options: { codemode: false },
    execute: (args, context) => Effect.scoped(Effect.gen(function* () {
      args = yield* Effect.try({ try: () => input.parse(args), catch: () => new Tool.Error({ message: "Invalid native tool arguments." }) });
      const directory = ctx.location.directory;
      if ([directory, context.sessionID, context.messageID, context.id].some((value) => typeof value !== "string" || !value)) {
        return yield* Effect.fail(new Tool.Error({ message: "This tool has no active native call identity." }));
      }
      const trusted = { sessionID: context.sessionID, messageID: context.messageID, callID: context.id, directory };
      const config = yield* Effect.tryPromise({
        try: async (signal) => JSON.parse(await readFile(path.join(directory, ".opencode", "coworker-context.json"), { encoding: "utf8", signal })),
        catch: () => new Tool.Error({ message: "The native coworker connection is unavailable." }),
      });
      const controller = new AbortController();
      let dispatched = false;
      let completed = false;
      const send = (cancel, signal) => fetch(config.url, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
        body: JSON.stringify({ name, args, context: trusted, ...(cancel ? { cancel: true } : {}) }), signal,
      });
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        controller.abort();
        if (control && dispatched && !completed) {
          // Cleanup uses the very same trusted call, never a new action or retry.
          try { const response = await send(true, AbortSignal.timeout(10000)); await response.arrayBuffer(); }
          catch { /* The broker retains uncertain cleanup as blocked. */ }
        }
      }));
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const active = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(control ? 150000 : 20000)]);
          active.throwIfAborted();
          dispatched = true;
          const response = await send(false, active);
          const result = await response.json();
          active.throwIfAborted();
          if (!response.ok) throw new Error(result?.error || "Native tool failed. Do not replay an uncertain action.");
          if (textOnly && typeof result?.text !== "string") throw new Error("The native result did not contain text.");
          const content = [];
          if (Array.isArray(result?.content)) {
            for (const part of result.content) {
              if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
              else if (part.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") {
                content.push({ type: "file", mime: part.mimeType, uri: "data:" + part.mimeType + ";base64," + part.data });
              } else if (part.type === "file" && typeof part.uri === "string" && typeof part.mime === "string") content.push(part);
              else throw new Error("Unsupported native tool content.");
            }
          } else content.push({ type: "text", text: typeof result === "string" ? result : typeof result?.text === "string" ? result.text : JSON.stringify(result) });
          completed = true;
          const metadata = { ...(result?.structured ? { structuredContent: result.structured } : {}), ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}) };
          if (name.startsWith("coworker_computer_")) metadata.title = name.replace("coworker_computer_", "Computer: ");
          else if (typeof result?.text === "string" && !name.startsWith("group_document")) metadata.title = result.text;
          return { content, metadata };
        },
        catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : "Native tool failed." }),
      });
    })),
  };
}

export const NATIVE_BROKER_SOURCE = `import { Plugin } from "@opencode-ai/plugin/effect";
import { Tool } from "@opencode-ai/schema/tool";
import { Effect } from "effect";
import { z as schema } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
${brokerTool.toString()}
`;

export async function installNativePlugin(home, filename, transform = (config) => config) {
  const manifest = await readBundleManifest();
  if (!NATIVE_PLUGIN_FILES.includes(filename)) throw new Error("Unknown native Coworker plugin.");
  const entry = manifest.entries[filename];
  const source = await readBundle(entry);
  const root = path.join(home.path, ".opencode");
  // Configured native local plugins must be directories. This descriptor
  // declares an ESM entrypoint only; it has no dependencies or install step.
  const pluginRoot = path.join(root, "coworker-plugins", filename.replace(/\.js$/, ""));
  await mkdir(pluginRoot, { recursive: true });
  const target = path.join(pluginRoot, "server.js");
  const current = await readFile(target).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (!current?.equals(source)) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, target);
  }
  const descriptor = path.join(pluginRoot, "package.json");
  const pkg = '{"private":true,"type":"module"}\n';
  if (await readFile(descriptor, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null; }) !== pkg) await writeFile(descriptor, pkg, { mode: 0o600 });
  return updateNativeConfig(home.path, (config) => {
    const updated = transform(config);
    const plugin = pathToFileURL(pluginRoot).href;
    const old = [pathToFileURL(path.join(root, filename)).href, pathToFileURL(path.join(root, entry.file)).href];
    // Retire only the exact app-managed v1 entry, not arbitrary user plugins.
    // Leave its old source and every user package file on disk untouched.
    const plugins = (updated.plugins ?? []).filter((entry) => !old.includes(typeof entry === "string" ? entry : entry.package));
    return plugins.some((entry) => (typeof entry === "string" ? entry : entry.package) === plugin)
      ? { ...updated, plugins } : { ...updated, plugins: [...plugins, plugin] };
  });
}
