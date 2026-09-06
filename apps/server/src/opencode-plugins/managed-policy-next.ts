import { check, checkManagedTool } from "./managed-policy-client.js";
// Plugin.define is the identity function in the pinned SDK. The structural
// contract avoids loading either engine's SDK into the other engine.
export default {
  id: "openwork.managed-policy",
  async setup(ctx: {
    tool: { hook(name: "execute.before", callback: (event: { tool: string; input: unknown }) => Promise<void>): Promise<unknown> };
    shell: { hook(name: "create.before", callback: (event: { command: string }) => Promise<void>): Promise<unknown> };
    session: { hook(name: "http.request", callback: (event: { model: { providerID: string; id: string } }) => Promise<void>): Promise<unknown> };
  }) {
    await ctx.tool.hook("execute.before", (event) => checkManagedTool(event.tool, event.input));
    await ctx.shell.hook("create.before", (event) => check("shell", { command: event.command }));
    await ctx.session.hook("http.request", (event) => check("model", event.model));
  },
};
