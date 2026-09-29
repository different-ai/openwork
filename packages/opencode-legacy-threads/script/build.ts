import solid from "@opentui/solid/bun-plugin";
const shared = ["@opencode-ai/plugin", "@opencode-ai/schema", "effect", "bun:sqlite"];
const server = await Bun.build({entrypoints:["src/plugin.ts","src/rpc.ts"],outdir:"dist",target:"node",format:"esm",external:shared});
if(!server.success)throw new AggregateError(server.logs,"Could not build legacy history plugin");
const tui = await Bun.build({entrypoints:["src/tui.tsx"],outdir:"dist",target:"bun",format:"esm",external:[...shared,"@opentui/core","@opentui/solid","solid-js"],plugins:[solid]});
if(!tui.success)throw new AggregateError(tui.logs,"Could not build legacy history browser");
