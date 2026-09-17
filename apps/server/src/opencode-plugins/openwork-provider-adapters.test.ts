import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openworkFeatureContributionSchema } from "@openwork/types/openwork-provider";
import { OPENWORK_SESSION_DETAIL_LIMITS, openworkSessionDetailPageArgsSchema, openworkSessionActivityResultSchema, openworkSessionToolProjectionSchema, labelOpenworkSessionModel, openworkCatalogModels, openworkModelSelectorSchema, resolveOpenworkModel } from "@openwork/types/openwork-affordance";

import { buildOpenworkProviderContributions, sessionAffordanceArgsSchemas } from "./openwork-provider-adapters.js";

function advertisedValues(schema: unknown): string[] {
  if (schema instanceof z.ZodString) {
    return (schema._def.checks ?? []).flatMap((check) => {
      const def = check._zod.def;
      return def.check === "max_length" && "maximum" in def && typeof def.maximum === "number" ? [String(def.maximum)] : [];
    });
  }
  if (schema instanceof z.ZodEnum) return schema.options.map(String);
  if (schema instanceof z.ZodDefault) {
    const value: unknown = schema._def.defaultValue;
    return [...advertisedValues(schema.unwrap()), ...(Array.isArray(value) ? value.map(String) : [String(value)])];
  }
  if (schema instanceof z.ZodObject) return Object.values(schema.shape).flatMap(advertisedValues);
  if (schema instanceof z.ZodArray) return advertisedValues(schema.element);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return advertisedValues(schema.unwrap());
  if (schema instanceof z.ZodPipe) return advertisedValues(schema.in);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(advertisedValues);
  return [];
}

describe("workspace model resolution", () => {
  const catalog = openworkCatalogModels({
    connected: ["managed", "local"],
    all: [
      { id: "managed", name: "Managed", models: { opaque: { name: "GPT-6 Luna" }, fallback: {} } },
      { id: "local", name: "Local", models: { other: { name: "GPT-6 Luna" } } },
      { id: "offline", name: "Offline", models: { hidden: { name: "Offline model" } } },
    ],
  });
  test("lists connected models using picker names and id fallback", () => {
    expect(catalog).toEqual([
      { providerId: "managed", modelId: "opaque", displayName: "GPT-6 Luna", providerName: "Managed" },
      { providerId: "managed", modelId: "fallback", displayName: "fallback", providerName: "Managed" },
      { providerId: "local", modelId: "other", displayName: "GPT-6 Luna", providerName: "Local" },
    ]);
  });
  test.each(["alias", "displayName"])("resolves %s case-insensitively with provider qualifier and preserves effort", (field) => {
    const selector = openworkModelSelectorSchema.parse({ [field]: " gPt-6 lUnA ", providerId: "MANAGED", variant: "high" });
    expect(resolveOpenworkModel(selector, catalog)).toEqual({ ...catalog[0], variant: "high" });
  });
  test("exact ids select a duplicate label without ambiguity", () => {
    expect(resolveOpenworkModel({ providerId: "local", modelId: "other", variant: "default" }, catalog)).toEqual({ ...catalog[2], variant: null });
  });
  test("binding ids override display decorations and availability does not leak into bindings", () => {
    const selector = openworkModelSelectorSchema.parse({ providerId: "local", modelId: "other", variant: "high", displayName: "Stale name", providerName: "Stale provider" });
    expect(resolveOpenworkModel(selector, catalog.map((model) => ({ ...model, available: true })))).toEqual({ ...catalog[2], variant: "high" });
  });
  test.each(["GPT-6", "Luna", "Offline model", "opaque"])("does not fuzzily resolve %s or use model ids as names", (alias) => {
    expect(() => resolveOpenworkModel({ alias }, catalog)).toThrow("Unavailable model");
  });
  test("rejects ambiguous labels and unavailable ids", () => {
    expect(() => resolveOpenworkModel({ alias: "GPT-6 Luna" }, catalog)).toThrow("Ambiguous model");
    expect(() => resolveOpenworkModel({ providerId: "managed", modelId: "absent" }, catalog)).toThrow("Unavailable model");
  });
  test.each([{}, { providerId: "managed" }, { modelId: "opaque" }, { alias: "" }, { alias: "GPT-6 Luna", displayName: "GPT-6 Luna" }, { alias: "GPT-6 Luna", modelId: "opaque", providerId: "managed" }])("rejects malformed selectors %j", (value) => {
    expect(openworkModelSelectorSchema.safeParse(value).success).toBe(false);
  });
  test("labels known models without replacing bound ids, effort or unbound state", () => {
    const model = { providerId: "managed", modelId: "opaque", variant: "low" };
    expect(labelOpenworkSessionModel(model, catalog)).toEqual({ ...catalog[0], variant: "low" });
    expect(labelOpenworkSessionModel(model, [])).toEqual(model);
    expect(labelOpenworkSessionModel(null, catalog)).toBeNull();
  });
});

describe("OpenWork provider adapters", () => {
  test("every session affordance advertises exactly the arguments its schema accepts", () => {
    const sessions = buildOpenworkProviderContributions([]).find((contribution) => contribution.featureId === "sessions");
    const affordances = sessions?.affordances ?? [];

    // A schema key the descriptor omits is invisible to agents (they cannot
    // know it exists); an advertised argument the schema drops is silently
    // ignored. Both are drift, so the sets must be equal in both directions.
    expect(affordances.map((affordance) => affordance.id).sort()).toEqual(Object.keys(sessionAffordanceArgsSchemas).sort());
    for (const [id, schema] of Object.entries(sessionAffordanceArgsSchemas)) {
      const advertised = affordances.find((affordance) => affordance.id === id)?.arguments.map((argument) => argument.name).sort();
      expect({ id, advertised }).toEqual({ id, advertised: Object.keys(schema.shape).sort() });
      for (const [name, field] of Object.entries(schema.shape)) {
        const description = affordances.find((affordance) => affordance.id === id)?.arguments.find((argument) => argument.name === name)?.description;
        for (const maximum of advertisedValues(field)) expect(description).toContain(String(maximum));
      }
    }
  });

  test("bulk repick requires a confirmed set for mutations but allows an unconfirmed dry-run", () => {
    const schema = sessionAffordanceArgsSchemas["session.rebind_model"];
    const args = { workspaceId: "workspace_fixture", from: { providerId: "provider_fixture", modelId: "removed_fixture" }, to: { alias: "Available fixture" } };
    for (const dryRun of [undefined, false]) {
      const rejected = schema.safeParse({ ...args, dryRun });
      expect(rejected.success).toBe(false);
      if (rejected.success) throw new Error("Unconfirmed mutation was accepted");
      expect(rejected.error.issues).toContainEqual(expect.objectContaining({ path: ["expectedSessionIds"] }));
      expect(schema.safeParse({ ...args, dryRun, expectedSessionIds: ["session_fixture"] }).success).toBe(true);
    }
    expect(schema.safeParse({ ...args, dryRun: true }).success).toBe(true);
    expect(schema.safeParse({ ...args, expectedSessionIds: [] }).success).toBe(true);
    expect(schema.safeParse({ ...args, expectedSessionIds: null }).success).toBe(false);
  });

  test("the bound walker reaches nested and optional strings, including transformed inputs", () => {
    expect(advertisedValues(sessionAffordanceArgsSchemas["session.create"].shape.sessions)).toEqual(["100000", "60"]);
    expect(advertisedValues(z.object({ entries: z.array(z.object({ label: z.string().max(17).transform((value) => value).optional() })) }))).toEqual(["17"]);
    expect(advertisedValues(z.object({ entries: z.array(z.enum(["text", "tool", "reasoning"])).default(["text"]) }))).toEqual(["text", "tool", "reasoning", "text"]);
    expect(advertisedValues(z.union([z.enum(["start", "end"]).nullable(), z.boolean().default(false)]))).toEqual(["start", "end", "false"]);
    const create = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances).find((entry) => entry.id === "session.create");
    expect(create?.arguments.find((argument) => argument.name === "sessions")?.description).toContain("title (≤120 chars, longer is clipped)");
  });

  test("detail contracts share cursor schemas and advertise numeric bounds and partial scope", () => {
    const affordances = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances);
    const read = affordances.find((entry) => entry.id === "session.read");
    const activity = affordances.find((entry) => entry.id === "session.activity");
    for (const id of ["session.read", "session.activity"]) {
      const schema = id === "session.read" ? sessionAffordanceArgsSchemas["session.read"] : sessionAffordanceArgsSchemas["session.activity"];
      for (const [name, field] of Object.entries(openworkSessionDetailPageArgsSchema.shape)) {
        expect(schema.shape[name === "before" ? "before" : "partOffset"]).toBe(field);
        const argument = affordances.find((entry) => entry.id === id)?.arguments.find((entry) => entry.name === name);
        expect(argument).toMatchObject({ type: name === "before" ? "string" : "number", required: false });
        expect(argument?.description).toContain(name === "before" ? "512" : "1000000");
      }
      expect(schema.safeParse({ sessionId: "ses_fixture", before: "x".repeat(513) }).success).toBe(false);
      expect(schema.safeParse({ sessionId: "ses_fixture", partOffset: 1000001 }).success).toBe(false);
      expect(schema.safeParse({ sessionId: "ses_fixture", partOffset: -1 }).success).toBe(false);
    }
    const parts = read?.arguments.find((argument) => argument.name === "parts")?.description;
    for (const value of [OPENWORK_SESSION_DETAIL_LIMITS.fieldChars, OPENWORK_SESSION_DETAIL_LIMITS.identifierChars, OPENWORK_SESSION_DETAIL_LIMITS.readParts]) expect(parts).toContain(String(value));
    for (const value of [OPENWORK_SESSION_DETAIL_LIMITS.activityMessages, OPENWORK_SESSION_DETAIL_LIMITS.activityParts, OPENWORK_SESSION_DETAIL_LIMITS.activityErrors, OPENWORK_SESSION_DETAIL_LIMITS.outcomeChars, OPENWORK_SESSION_DETAIL_LIMITS.responseBytes]) expect(activity?.description).toContain(String(value));
    for (const value of ["fixed labels", "scope.complete", "NOT full-session", "other/unknown", "uninspected"]) expect(activity?.description).toContain(value);
    const tool = { type: "tool", tool: "bash", callId: "call_fixture", status: "completed", input: "null", output: "x".repeat(2000), error: "null" };
    expect(openworkSessionToolProjectionSchema.safeParse(tool).success).toBe(true);
    expect(openworkSessionToolProjectionSchema.safeParse({ ...tool, output: "x".repeat(2001) }).success).toBe(false);
    expect(openworkSessionToolProjectionSchema.safeParse({ ...tool, callId: "x".repeat(129) }).success).toBe(false);
    expect(openworkSessionActivityResultSchema.shape.errors.shape.list.safeParse(Array.from({ length: 51 }, () => ({ callId: "call", tool: "bash", code: "tool_error", message: "Tool execution failed", at: null }))).success).toBe(false);
    const failure = { callId: "call", tool: "bash", code: "tool_error", message: "Tool execution failed", at: null };
    expect(openworkSessionActivityResultSchema.shape.errors.shape.list.safeParse([failure]).success).toBe(true);
    expect(openworkSessionActivityResultSchema.shape.errors.shape.list.safeParse([{ ...failure, message: "PROMPT_CANARY" }]).success).toBe(false);
    expect(openworkSessionActivityResultSchema.shape.errors.shape.list.safeParse([{ ...failure, code: "failed_outcome" }]).success).toBe(false);
  });

  test("activity advertises its query, error cap and timestamp semantics", () => {
    const activity = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances).find((entry) => entry.id === "session.activity");
    expect(activity).toMatchObject({ kind: "query", effects: { data: "read", ui: "none", external: false }, executor: { kind: "openwork" } });
    for (const value of ["300", "byAffordanceId", "ok: false", "firstAt", "lastAt", "scope.complete", "callId"]) expect(activity?.description).toContain(value);
    const since = activity?.arguments.find((argument) => argument.name === "since")?.description;
    for (const value of ["Inclusive", "ISO-8601", "end, then start", "Undated"]) expect(since).toContain(value);
  });

  test("normalizes sessions and extensions into semantic contributions", () => {
    const contributions = buildOpenworkProviderContributions([]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
    ]);
    expect(
      contributions.flatMap((contribution) => contribution.affordances)
        .find((affordance) => affordance.id === "session.read"),
    ).toMatchObject({
      kind: "query",
      effects: { data: "read", ui: "none", external: false },
      executor: { kind: "openwork" },
    });
    // Talking to a session is a server command addressed by id: it declares
    // no UI effect, so agents never need session.open + composer.* for it.
    const send = contributions.flatMap((contribution) => contribution.affordances)
      .find((affordance) => affordance.id === "session.send");
    expect(send).toMatchObject({
      kind: "command",
      provider: { id: "openwork-server", kind: "builtin" },
      effects: { data: "write", ui: "none", external: false },
      executor: { kind: "openwork" },
    });
    expect(send?.arguments.map((argument) => [argument.name, argument.required])).toEqual([
      ["sessionId", true],
      ["text", true],
      ["workspaceId", false],
      ["reveal", false],
    ]);
    for (const contribution of contributions) {
      expect(openworkFeatureContributionSchema.safeParse(contribution).success).toBe(true);
    }
  });

  test("tells agents that sessions carry a model and that session.create takes one", () => {
    const affordances = buildOpenworkProviderContributions([]).flatMap((contribution) => contribution.affordances);
    const read = affordances.find((affordance) => affordance.id === "session.read");
    const create = affordances.find((affordance) => affordance.id === "session.create");

    // openwork_context is the only place an agent learns the result shape.
    expect(read?.description).toContain("`model`");
    expect(read?.description).toContain("variant");
    expect(read?.description).toContain("`lastError`");
    expect(read?.description).toContain("fetched newest `count` messages");
    expect(read?.description).toContain("start/summary inspect the whole transcript");
    expect(read?.description).toContain("event-only failures");
    expect(create?.arguments.map((argument) => [argument.name, argument.type, argument.required])).toEqual([
      ["sessions", "array", true],
      ["workspaceId", "string", false],
      ["model", "object", false],
    ]);
    expect(create?.arguments.find((argument) => argument.name === "model")?.description).toContain("variant");
    expect(create?.description).toContain("accepted: true");
    expect(create?.description).toContain("not proof that inference started or succeeded");
    expect(create?.description).toContain("unavailable model can fail afterward");
    expect(create?.description).toContain("`issues`");
    expect(create?.description).toContain("before retrying to avoid duplicates");
    expect(create?.description).toContain("existing renderer host");
    expect(create?.description).toContain("without a renderer catalog");
    expect(create?.description).toContain("Sidebar visibility is not guaranteed");
    expect(affordances.find((entry) => entry.id === "models.list")?.description).toContain("including headless callers");
  });

  test("keeps known Connect skills direct and search available for unknown capabilities", () => {
    const contributions = buildOpenworkProviderContributions([{
      name: "customer-briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      capability: "skill:skl_customer_briefing",
    }]);
    const connect = contributions.find((contribution) => contribution.featureId === "connect");

    expect(connect?.guidance).toEqual([{
      ref: "skill:skl_customer_briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      provider: { id: "openwork-cloud", kind: "connect" },
      loading: "catalog",
    }]);
    expect(connect?.affordances.map((affordance) => ({
      id: affordance.id,
      executor: affordance.executor,
    }))).toEqual([
      {
        id: "connect.capabilities.search",
        executor: { kind: "tool", tool: "openwork-cloud_search_capabilities" },
      },
      {
        id: "connect.capability.execute",
        executor: { kind: "tool", tool: "openwork-cloud_execute_capability" },
      },
    ]);
    expect(
      connect?.affordances.find((affordance) => affordance.id === "connect.capability.execute")
        ?.arguments.map((argument) => argument.name),
    ).toEqual(["name", "schemaDigest", "path", "query", "body"]);
  });

  test("includes only MCP providers observed from the engine", () => {
    const contributions = buildOpenworkProviderContributions([], [
      { name: "notion", status: "connected" },
      { name: "openwork-cloud", status: "connected" },
    ]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
      "mcp:notion",
      "connect",
    ]);
    expect(contributions[3]).toMatchObject({
      provider: { id: "notion", kind: "mcp" },
      affordances: [],
    });
    expect(contributions[4]?.affordances.map((affordance) => affordance.id)).toEqual([
      "connect.capabilities.search",
      "connect.capability.execute",
    ]);
  });

  test("exposes an Automations proposal affordance that writes nothing", () => {
    const proposal = buildOpenworkProviderContributions([])
      .flatMap((contribution) => contribution.affordances)
      .find((affordance) => affordance.id === "automation.propose");

    expect(proposal).toMatchObject({
      kind: "command",
      // No data effect: a proposal is rendered for a person, never persisted.
      effects: { data: "none", ui: "none", external: false },
      executor: { kind: "openwork" },
    });
    expect(proposal?.arguments.map((argument) => argument.name)).toEqual([
      "name",
      "instructions",
      "schedule",
      "model",
    ]);
    expect(proposal?.arguments.find((argument) => argument.name === "model")?.required).toBe(false);
  });
});
