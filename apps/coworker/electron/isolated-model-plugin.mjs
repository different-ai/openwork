// This function is embedded in the two installed plugins. Only the native
// session hooks see input; no client, tool, history, or ambient instruction is reused.
export function isolatedModelHooks(ctx, { agent, system, limits }, validate) {
  return Effect.gen(function* () {
    // beta19086 AgentEditor.update creates a missing agent (core/src/agent.ts).
    // Register only here: an unloaded plugin must leave an unknown agent, not an
    // ordinary unbounded inference path supplied by persisted configuration.
    yield* ctx.agent.transform((editor) => editor.update(agent, (item) => {
      Object.assign(item, { hidden: true, mode: "subagent", description: "Isolated bounded text request", system,
        request: { settings: {}, headers: {}, body: {} }, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
      delete item.steps;
      delete item.model;
    }));
    const sessions = new Map();
    const refuse = () => { throw new Error("Isolated model request refused."); };
    const same = (a, b) => a?.providerID === b?.providerID && a?.id === b?.id && (a?.variant ?? "default") === (b?.variant ?? "default");
    yield* ctx.session.hook("prompt", (event) => Effect.gen(function* () {
      const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie);
      if (session.agent !== agent) { if (sessions.has(event.sessionID)) refuse(); return; }
      if (sessions.has(event.sessionID) || session.parentID || session.fork || !session.model || (session.model.variant && session.model.variant !== "default")
        || Object.entries(event.prompt).some(([key, value]) => key !== "text" && value !== undefined)) refuse();
      validate(event.prompt.text);
      sessions.set(event.sessionID, { messageID: event.messageID, text: event.prompt.text, model: { ...session.model }, contexts: 0, requests: 0, http: 0 });
    }));
    yield* ctx.session.hook("context", (event) => Effect.gen(function* () {
      const session = sessions.get(event.sessionID);
      if (!session && event.agent !== agent) return;
      if (!session || event.agent !== agent || !same(session.model, event.model) || session.contexts++) refuse();
      const catalog = yield* ctx.catalog.model.list().pipe(Effect.orDie);
      const model = catalog.data.find((item) => item.providerID === event.model.providerID && item.id === event.model.id);
      const provider = yield* ctx.catalog.provider.get({ providerID: event.model.providerID }).pipe(Effect.orDie);
      if (!model || !model.enabled || model.status !== "active" || provider.data.activation === "disabled"
        || !["aisdk:@ai-sdk/openai", "aisdk:@ai-sdk/openai-compatible", "@opencode-ai/ai/providers/openai", "@opencode-ai/ai/providers/openai/chat", "@opencode-ai/ai/providers/openai/responses", "@opencode-ai/ai/providers/openai-compatible"].includes(model.package ?? provider.data.package)
        || !model.capabilities.input.includes("text") || !model.capabilities.output.includes("text")
        || model.capabilities.output.some((type) => type !== "text") || model.compatibility?.requireReasoning || model.compatibility?.reasoningField
        || model.variants.some((variant) => variant.id !== "default") || !model.cost.length || !model.cost.some((cost) => !cost.tier)
        || model.cost.some((cost) => !Number.isFinite(cost.input) || cost.input <= 0 || cost.input > limits.maxInputPrice
          || !Number.isFinite(cost.output) || cost.output <= 0 || cost.output > limits.maxOutputPrice)) refuse();
      session.wireModel = model.modelID;
      session.maxTokens = Math.min(limits.maxOutputTokens, model.limit.output, Number.isFinite(event.generation.maxTokens) && event.generation.maxTokens > 0 ? event.generation.maxTokens : limits.maxOutputTokens);
      if (!Number.isInteger(session.maxTokens) || session.maxTokens <= 0) refuse();
      event.system.splice(0, event.system.length, { type: "text", text: system });
      event.messages.splice(0, event.messages.length, { role: "user", content: [{ type: "text", text: session.text }] });
      for (const key of Object.keys(event.tools)) delete event.tools[key];
      for (const key of Object.keys(event.generation)) delete event.generation[key];
      Object.assign(event.generation, { maxTokens: session.maxTokens, temperature: 0, topP: 1 });
      for (const key of Object.keys(event.providerOptions)) delete event.providerOptions[key];
    }));
    yield* ctx.session.hook("model.request", (event) => Effect.sync(() => {
      const session = sessions.get(event.sessionID);
      if (!session && event.agent !== agent) return;
      if (!session || event.agent !== agent || event.kind !== "primary" || !same(session.model, event.model) || !session.maxTokens || session.requests++) refuse();
    }));
    yield* ctx.session.hook("http.request", (event) => Effect.gen(function* () {
      const session = sessions.get(event.sessionID);
      if (!session && event.agent !== agent) return;
      if (!session || event.agent !== agent || event.kind !== "primary" || !same(session.model, event.model) || session.requests !== 1 || session.http++) refuse();
      const body = yield* Effect.promise(() => event.request.clone().json());
      if (event.request.method !== "POST" || body.model !== session.wireModel || body.stream !== true) refuse();
      const url = new URL(event.request.url);
      let bounded;
      if (url.pathname.endsWith("/chat/completions")) {
        // Keep only the protocol fields whose bounds and parsing we verified.
        const cap = Object.hasOwn(body, "max_completion_tokens") ? "max_completion_tokens" : Object.hasOwn(body, "max_tokens") ? "max_tokens" : refuse();
        if (!Number.isInteger(body[cap]) || body[cap] <= 0) refuse();
        bounded = { model: body.model, stream: true, stream_options: { include_usage: true }, n: 1, [cap]: Math.min(body[cap], session.maxTokens), temperature: 0, top_p: 1,
          messages: [{ role: "system", content: system }, { role: "user", content: session.text }] };
      } else if (url.pathname.endsWith("/responses") && Object.hasOwn(body, "max_output_tokens")) {
        if (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens <= 0) refuse();
        bounded = { model: body.model, stream: true, store: false, max_output_tokens: Math.min(body.max_output_tokens, session.maxTokens), temperature: 0, top_p: 1,
          instructions: system, input: [{ role: "user", content: [{ type: "input_text", text: session.text }] }] };
      } else refuse();
      const headers = new Headers(event.request.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      event.request = new Request(event.request, { headers, body: JSON.stringify(bounded) });
      // Keep only the one-attempt tombstone after dispatch, not private input.
      session.text = undefined;
    }));
    yield* ctx.session.hook("retry", (event) => Effect.sync(() => {
      if (sessions.has(event.sessionID) || event.agent === agent) event.decision = { retry: false };
    }));
    yield* ctx.tool.hook("execute.before", (event) => sessions.has(event.sessionID) || event.agent === agent
      ? Effect.fail(new Tool.Error({ message: "Isolated model requests cannot use tools." })) : Effect.void);
    yield* Effect.addFinalizer(() => Effect.sync(() => sessions.clear()));
  });
}

export function isolatedModelSource(policy, validatorSource) {
  return `import { Plugin } from "@opencode-ai/plugin/effect";
import { Effect } from "effect";
import { Tool } from "@opencode-ai/schema/tool";
const policy = ${JSON.stringify(policy)};
${isolatedModelHooks.toString()}
const validate = ${validatorSource};
export default Plugin.define({ id: "coworker." + policy.agent, effect: (ctx) => isolatedModelHooks(ctx, policy, validate) });
`;
}

export function withoutIsolatedAgent(config, { agent }) {
  const agents = { ...config.agents };
  delete agents[agent];
  return { ...config, agents };
}
