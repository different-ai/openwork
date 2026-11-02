import { expect, test } from "bun:test";
import type { DenOrgLlmProvider } from "../src/app/lib/den.ts";
import { resolveProposalModel } from "../src/react-app/domains/automations/automation-model-options.ts";

const custom = { id: "lpr_team", providerId: "team-gateway", name: "Team gateway", source: "custom", models: [{ id: "team-model", name: "Team model" }] } as unknown as DenOrgLlmProvider;

test("a proposal without a model uses the first model the member can run in Cloud placement", () => {
  const resolved = resolveProposalModel(undefined, [custom], { includeFreeStarter: false });
  expect(resolved.resolution).toBe("default");
  expect(resolved.model).toEqual({ providerId: "lpr_team", modelId: "team-model", variant: null });
});

test("a proposal without a model stays unavailable when the member can run nothing", () => {
  expect(resolveProposalModel(undefined, [], { includeFreeStarter: false }).resolution).toBe("unavailable");
});

test("the free starter model still wins on Desktop when it is offered", () => {
  const resolved = resolveProposalModel(undefined, [custom], { includeFreeStarter: true });
  expect(resolved.resolution).toBe("default");
  expect(resolved.model.modelId).not.toBe("team-model");
});

test("an explicitly selected available model replaces an unavailable proposal without silent fallback", () => {
  const unavailable = { providerId: "revoked-provider", modelId: "removed-model", variant: null };
  expect(resolveProposalModel(unavailable, [custom], { includeFreeStarter: false }).resolution).toBe("unavailable");

  const selected = { providerId: "lpr_team", modelId: "team-model", variant: "high" };
  expect(resolveProposalModel(selected, [custom], { includeFreeStarter: false })).toEqual({
    model: selected,
    resolution: "exact",
  });
});
