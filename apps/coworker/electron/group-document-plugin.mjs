import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { groupDocumentToolCatalog } from "./group-documents.mjs";

// Generate only the field types used by this catalog; limits stay owned by the store.
function argumentSource(schema) {
  let source;
  if (schema.type === "string") {
    source = "tool.schema.string()";
    if (schema.minLength !== undefined) source += `.min(${schema.minLength})`;
    if (schema.maxLength !== undefined) source += `.max(${schema.maxLength})`;
    if (schema.pattern !== undefined) source += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
  } else if (schema.type === "integer") {
    source = "tool.schema.number().int()";
    if (schema.minimum !== undefined) source += `.min(${schema.minimum})`;
  } else if (schema.type === "array") {
    source = `tool.schema.array(${argumentSource(schema.items)})`;
    if (schema.maxItems !== undefined) source += `.max(${schema.maxItems})`;
  } else throw new Error(`Unsupported shared-document argument type: ${schema.type}`);
  return source;
}

const definitions = groupDocumentToolCatalog().map((entry) => {
  const fields = Object.entries(entry.inputSchema.properties).map(([key, schema]) =>
    `${JSON.stringify(key)}: ${argumentSource(schema)}${entry.inputSchema.required.includes(key) ? "" : ".optional()"}`);
  return `${JSON.stringify(`coworker_${entry.name}`)}: define(${JSON.stringify(entry)}, { ${fields.join(", ")} })`;
}).join(",\n    ");

export const GROUP_DOCUMENT_PLUGIN = `import { tool } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import path from "node:path";
export default async ({ directory }) => {
  const calls = new Map();
  const define = ({ name, description, inputSchema }, args) => {
    const schema = tool.schema.object(args).strict();
    return tool({ description, args, execute: async (input, context) => {
      const parsed = schema.parse(input);
      for (const [key, required] of Object.entries(inputSchema.dependentRequired || {})) {
        if (parsed[key] !== undefined && required.some((field) => parsed[field] === undefined)) {
          throw new Error("An existing shared document requires both id and expectedRevision.");
        }
      }
      const nativeDirectory = context.directory || directory;
      if ([context.sessionID, context.messageID, nativeDirectory].some((value) => typeof value !== "string" || !value)) {
        throw new Error("This shared-document tool has no native conversation identity.");
      }
      const key = JSON.stringify([context.sessionID, "coworker_" + name, input]);
      const queue = calls.get(key) || [];
      let callID = context.callID;
      if (callID) {
        const index = queue.indexOf(callID);
        if (index !== -1) queue.splice(index, 1);
      } else callID = queue.shift();
      if (!queue.length) calls.delete(key);
      if (typeof callID !== "string" || !callID || !context.abort) throw new Error("The engine did not provide an active native tool-call identity.");
      context.abort.throwIfAborted();
      const trusted = { sessionID: context.sessionID, messageID: context.messageID, callID, directory: nativeDirectory };
      const config = JSON.parse(await readFile(path.join(directory, ".opencode", "coworker-context.json"), "utf8"));
      context.abort.throwIfAborted();
      const response = await fetch(config.url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
        body: JSON.stringify({ name, args: parsed, context: trusted }), redirect: "error",
        signal: AbortSignal.any([context.abort, AbortSignal.timeout(20000)]),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Shared documents are unavailable.");
      if (typeof result.text !== "string") throw new Error("The shared-document result did not contain text.");
      return result.text;
    } });
  };
  const tools = {
    ${definitions}
  };
  return { "tool.execute.before": async (input, output) => {
    if (!Object.hasOwn(tools, input.tool) || typeof input.callID !== "string" || !input.callID) return;
    const key = JSON.stringify([input.sessionID, input.tool, output.args]);
    calls.set(key, [...(calls.get(key) || []), input.callID]);
  }, tool: tools };
};
`;

/** Install after the collaboration transport, before opening the native workspace. */
export async function installGroupDocumentPlugin(coworker) {
  const root = path.join(coworker.path, ".opencode");
  await mkdir(root, { recursive: true });
  const source = path.join(root, "coworker-group-documents.js");
  if (await readFile(source, "utf8").catch(() => "") !== GROUP_DOCUMENT_PLUGIN) await writeFile(source, GROUP_DOCUMENT_PLUGIN, "utf8");
  const target = path.join(coworker.path, "opencode.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  const plugin = pathToFileURL(source).href;
  if ((config.plugin ?? []).includes(plugin)) return;
  await writeFile(`${target}.group-documents.tmp`, JSON.stringify({ ...config, plugin: [...(config.plugin ?? []), plugin] }, null, 2), "utf8");
  await rename(`${target}.group-documents.tmp`, target);
}
