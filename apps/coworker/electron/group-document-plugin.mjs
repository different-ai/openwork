import { groupDocumentToolCatalog } from "./group-documents.mjs";
import { installNativePlugin, NATIVE_BROKER_SOURCE } from "./native-plugin.mjs";

// Preserve store-owned limits. Native JSON Schema conversion can omit unsupported
// keywords, so dependentRequired is also enforced by the Standard Schema validator.
export const GROUP_DOCUMENT_PLUGIN = NATIVE_BROKER_SOURCE + `
export default Plugin.define({ id: "coworker.group-documents", effect: (ctx) => Effect.gen(function* () {
  const catalog = ${JSON.stringify(groupDocumentToolCatalog())};
  const field = (value) => {
    let result;
    if (value.type === "string") {
      result = schema.string();
      if (value.minLength !== undefined) result = result.min(value.minLength);
      if (value.maxLength !== undefined) result = result.max(value.maxLength);
      if (value.pattern !== undefined) result = result.regex(new RegExp(value.pattern));
    } else if (value.type === "integer") {
      result = schema.number().int();
      if (value.minimum !== undefined) result = result.min(value.minimum);
    } else if (value.type === "array") {
      result = schema.array(field(value.items));
      if (value.maxItems !== undefined) result = result.max(value.maxItems);
    } else throw new Error("Unsupported shared-document schema.");
    return result;
  };
  yield* ctx.tool.transform((editor) => {
    for (const { name, description, inputSchema } of catalog) {
      const fields = Object.fromEntries(Object.entries(inputSchema.properties).map(([key, value]) => [key, inputSchema.required.includes(key) ? field(value) : field(value).optional()]));
      const input = schema.object(fields).strict().refine((value) => Object.entries(inputSchema.dependentRequired ?? {}).every(([key, required]) => value[key] === undefined || required.every((key) => value[key] !== undefined)), "An existing shared document requires both id and expectedRevision.");
      const tool = brokerTool(ctx, name, input, description, { textOnly: true });
      editor.add({ ...tool, name: "coworker_" + name });
    }
  });
}) });
`;

/** Install after the collaboration transport, before opening the native workspace. */
export async function installGroupDocumentPlugin(coworker) {
  await installNativePlugin(coworker, "coworker-group-documents.js");
}
