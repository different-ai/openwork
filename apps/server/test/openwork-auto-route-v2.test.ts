import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_ROUTER_SESSION_ROUTES_KEY, AUTO_ROUTER_SESSION_ROUTES_MAX } from "@openwork/types/den/auto-router";
import plugin, { autoRouteFromResponse, type AutoRouteContext } from "../src/opencode-plugins/openwork-auto-route-v2.js";

type Callback = Parameters<AutoRouteContext["session"]["hook"]>[1];

function routed(name?: string) {
  return new Response("data: {}\n\n", { headers: {
    "x-openwork-auto-provider": "anthropic",
    "x-openwork-auto-model": "claude-haiku-5-5",
    "x-openwork-auto-thinking": "high",
    "x-openwork-auto-reason": "jev",
    ...(name ? { "x-openwork-auto-model-name": encodeURIComponent(name) } : {}),
  } });
}

function fakeEngine(initial: Record<string, unknown> = {}) {
  const metadata = new Map<string, Record<string, unknown>>([["ses_auto", initial]]);
  const hooks: { callback: Callback; providerID?: string }[] = [];
  let disposed = false;
  const context: AutoRouteContext = { session: {
    get: async ({ sessionID }) => ({ metadata: metadata.get(sessionID) }),
    update: async ({ sessionID, metadata: next }) => { metadata.set(sessionID, next); },
    hook: async (_name, callback, options) => {
      hooks.push({ callback, providerID: options?.providerID });
      return { dispose: async () => { disposed = true; } };
    },
  } };
  const fire = async (event: { providerID?: string; kind?: string; response: Response }) => {
    for (const hook of hooks) await hook.callback({ sessionID: "ses_auto", kind: event.kind ?? "primary",
      model: { providerID: event.providerID ?? "openwork-auto" }, response: event.response });
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  return { context, hooks, fire, metadata, disposed: () => disposed };
}

test("reads the routing decision from the gateway's headers", () => {
  assert.deepEqual(autoRouteFromResponse(routed("Claude Haiku 5.5"), 42),
    { at: 42, provider: "anthropic", model: "claude-haiku-5-5", name: "Claude Haiku 5.5", thinking: "high" });
  assert.deepEqual(autoRouteFromResponse(routed(), 42), { at: 42, provider: "anthropic", model: "claude-haiku-5-5", thinking: "high" });
  assert.equal(autoRouteFromResponse(new Response("{}"), 42), undefined);
  const malformed = new Response("{}", { headers: { "x-openwork-auto-model": "m", "x-openwork-auto-model-name": "%E0%A4%A" } });
  assert.equal(autoRouteFromResponse(malformed, 1)?.name, undefined);
});

test("records each Smart reply's model, whichever router answered, in the session metadata, keeping other metadata", async () => {
  const engine = fakeEngine({ other: { kept: true } });
  const stop = await plugin.setup(engine.context);
  assert.deepEqual(engine.hooks.map(hook => hook.providerID), ["openwork-auto"]);
  await engine.fire({ response: routed("Claude Haiku 5.5") });
  await engine.fire({ response: routed("Claude Haiku 5.5") });
  const saved = engine.metadata.get("ses_auto");
  assert.deepEqual(saved?.other, { kept: true });
  const routes = saved?.[AUTO_ROUTER_SESSION_ROUTES_KEY];
  assert.ok(Array.isArray(routes));
  assert.equal(routes.length, 2);
  assert.deepEqual({ ...routes[0], at: 0 }, { at: 0, provider: "anthropic", model: "claude-haiku-5-5", name: "Claude Haiku 5.5", thinking: "high" });
  await stop();
  assert.equal(engine.disposed(), true);
});

test("ignores titles, compaction, other providers and responses without a route", async () => {
  const engine = fakeEngine();
  await plugin.setup(engine.context);
  await engine.fire({ kind: "title", response: routed("Claude Haiku 5.5") });
  await engine.fire({ kind: "compaction", response: routed("Claude Haiku 5.5") });
  await engine.fire({ providerID: "anthropic", response: routed("Claude Haiku 5.5") });
  await engine.fire({ response: new Response("{}") });
  assert.deepEqual(engine.metadata.get("ses_auto"), {});
});

test("keeps only the most recent decisions", async () => {
  const old = Array.from({ length: AUTO_ROUTER_SESSION_ROUTES_MAX }, (_, index) => ({ at: index, provider: "anthropic", model: `old-${index}`, thinking: "default" }));
  const engine = fakeEngine({ [AUTO_ROUTER_SESSION_ROUTES_KEY]: old });
  await plugin.setup(engine.context);
  await engine.fire({ response: routed() });
  const routes = engine.metadata.get("ses_auto")?.[AUTO_ROUTER_SESSION_ROUTES_KEY];
  assert.ok(Array.isArray(routes));
  assert.equal(routes.length, AUTO_ROUTER_SESSION_ROUTES_MAX);
  assert.equal(routes.at(-1)?.model, "claude-haiku-5-5");
  assert.equal(routes[0]?.model, "old-1");
});

test("a failed metadata write never fails the reply", async () => {
  const engine = fakeEngine();
  engine.context.session.update = async () => { throw new Error("engine busy"); };
  await plugin.setup(engine.context);
  await engine.fire({ response: routed() });
});
