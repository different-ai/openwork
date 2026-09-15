import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openworkFeatureContributionSchema } from "@openwork/types/openwork-provider";

import { buildOpenworkProviderContributions, sessionAffordanceArgsSchemas } from "./openwork-provider-adapters.js";

function stringMaxima(schema: unknown): number[] {
  if (schema instanceof z.ZodString) {
    return (schema._def.checks ?? []).flatMap((check) => {
      const def = check._zod.def;
      return def.check === "max_length" && "maximum" in def && typeof def.maximum === "number" ? [def.maximum] : [];
    });
  }
  if (schema instanceof z.ZodObject) return Object.values(schema.shape).flatMap(stringMaxima);
  if (schema instanceof z.ZodArray) return stringMaxima(schema.element);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return stringMaxima(schema.unwrap());
  if (schema instanceof z.ZodPipe) return stringMaxima(schema.in);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(stringMaxima);
  return [];
}

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
        for (const maximum of stringMaxima(field)) expect(description).toContain(String(maximum));
      }
    }
  });

  test("the bound walker reaches nested and optional strings, including transformed inputs", () => {
    expect(stringMaxima(sessionAffordanceArgsSchemas["session.create"].shape.sessions)).toEqual([100_000, 60]);
    expect(stringMaxima(z.object({ entries: z.array(z.object({ label: z.string().max(17).transform((value) => value).optional() })) }))).toEqual([17]);
    const create = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances).find((entry) => entry.id === "session.create");
    expect(create?.arguments.find((argument) => argument.name === "sessions")?.description).toContain("title (≤120 chars, longer is clipped)");
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
