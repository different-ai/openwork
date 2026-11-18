import { Context, Effect, Option, Schema, Scope } from "effect";
import { MCP_READINESS_RPC_ID, waitForMcpBindings, mcpNamespace, mcpToolId, type McpPublishedTool } from "../opencode-v2-mcp-readiness.js";

type Registration = { readonly dispose: Effect.Effect<void> };
type NativeMcpCatalog = {
  readonly tools: () => Effect.Effect<readonly { readonly server: string; readonly name: string }[]>;
  readonly servers: () => Effect.Effect<readonly { readonly name: string; readonly status: { readonly status: string } }[]>;
};
// Compatibility bridge for the officially pinned 2.0.26. Its public MCP domain
// omits the discovered catalog and McpTool.flush only fences startup. A scoped
// RPC has the native location graph: read its existing client, never open a
// second transport, resolve OAuth credentials, or spawn a stdio probe. Keep
// these exact core service identities version-guarded. Remove this bridge when
// upstream exposes a public executable-registry mutation fence.
class NativeMcp extends Context.Service<NativeMcp, NativeMcpCatalog>()("@opencode/MCP") {}
class NativeMcpTool extends Context.Service<NativeMcpTool, { readonly flush: Effect.Effect<void> }>()("@opencode/McpTool") {}

const serverSchema = { type: "string", minLength: 1 };
const toolsSchema = { type: "array", maxItems: 4096, items: { type: "string", minLength: 1 } };
const definition = {
  id: MCP_READINESS_RPC_ID,
  methods: {
    catalog: {
      input: { type: "object", properties: { server: serverSchema }, required: ["server"], additionalProperties: false },
      output: { type: "object", properties: { tools: toolsSchema }, required: ["tools"], additionalProperties: false },
    },
    waitForTools: {
      input: { type: "object", properties: { server: serverSchema }, required: ["server"], additionalProperties: false },
      output: { type: "object", properties: { ready: { const: true } }, required: ["ready"], additionalProperties: false },
    },
  },
  events: {},
};
type PluginContext = {
  readonly app: { readonly version: string };
  readonly tool: {
    readonly list: () => Effect.Effect<readonly McpPublishedTool[]>;
    readonly reload: () => Effect.Effect<void>;
    readonly transform: (observe: () => void) => Effect.Effect<Registration, never, Scope.Scope>;
  };
  readonly rpc: { readonly register: (schema: typeof definition, handlers: {
    catalog: (input: unknown) => Effect.Effect<{ tools: string[] }>;
    waitForTools: (input: unknown) => Effect.Effect<{ ready: true }>;
  }) => Effect.Effect<Registration, never, Scope.Scope> };
};
const serverInput = Schema.Struct({ server: Schema.String });
const inputServer = (input: unknown) => Schema.decodeUnknownSync(serverInput)(input).server;
const nativeCatalog = Effect.gen(function* () {
  const context = yield* Effect.context();
  const mcp = Context.getOption(context, NativeMcp);
  const source = Context.getOption(context, NativeMcpTool);
  if (Option.isNone(mcp) || Option.isNone(source)) return yield* Effect.die(new Error("Native MCP readiness services are unavailable"));
  yield* source.value.flush;
  return mcp.value;
});

const waitForNativeMcpBindings = Effect.fn("OpenWorkMcp.waitForBindings")(function* (tool: PluginContext["tool"], server: string, desired: readonly string[], previous: readonly string[]) {
  const scope = yield* Scope.Scope;
  yield* Effect.tryPromise({
    try: signal => waitForMcpBindings({
      list: () => Effect.runPromise(tool.list()),
      transform: async observe => {
        const registration = await Effect.runPromise(tool.transform(observe).pipe(Effect.provideService(Scope.Scope, scope)));
        return { dispose: () => Effect.runPromise(registration.dispose) };
      },
    }, server, desired, previous, signal),
    catch: cause => cause,
  });
}, Effect.orDie);

export default {
  id: MCP_READINESS_RPC_ID,
  effect: (ctx: PluginContext) => {
    const supported = () => {
      if (ctx.app.version !== "2.0.26") throw new Error("Review the native MCP readiness bridge before changing the engine pin");
    };
    return ctx.rpc.register(definition, {
      catalog: Effect.fn("OpenWorkMcp.catalog")(function* (input: unknown) {
        supported();
        const server = inputServer(input);
        const mcp = yield* nativeCatalog;
        const discovered = (yield* mcp.tools()).filter(tool => tool.server === server).map(tool => mcpToolId(server, tool.name));
        const published = (yield* ctx.tool.list()).filter(tool => tool.options?.namespace === mcpNamespace(server)).map(tool => tool.id);
        return { tools: [...new Set([...discovered, ...published])].sort() };
      }),
      waitForTools: Effect.fn("OpenWorkMcp.waitForTools")(function* (input: unknown) {
        supported();
        const server = inputServer(input);
        const mcp = yield* nativeCatalog;
        // Publish the currently captured source before observing its successor;
        // a reload alone is not readiness, because MCP discovery is deferred.
        yield* ctx.tool.reload();
        const previous = (yield* ctx.tool.list()).filter(tool => tool.options?.namespace === mcpNamespace(server)).map(tool => tool.id);
        const target = (yield* mcp.servers()).find(item => item.name === server);
        if (target && !["connected", "disabled"].includes(target.status.status)) {
          return yield* Effect.die(new Error(`MCP ${server} is ${target.status.status}, not executable`));
        }
        const desired = (yield* mcp.tools()).filter(tool => tool.server === server).map(tool => mcpToolId(server, tool.name));
        yield* waitForNativeMcpBindings(ctx.tool, server, desired, previous).pipe(Effect.scoped);
        return { ready: true };
      }),
    }).pipe(Effect.asVoid);
  },
};
