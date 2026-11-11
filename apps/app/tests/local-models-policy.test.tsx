/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { checkDesktopAppRestriction, isDesktopProviderBlocked } from "../src/app/cloud/desktop-app-restrictions";
import type { DenDesktopConfig } from "../src/app/lib/den";
import { computePolicyProviderReconcilePlan } from "../src/react-app/domains/connections/policy-provider-reconcile";
import { isProviderAllowedByDesktopPolicy } from "../src/react-app/domains/connections/provider-auth/provider-policy";
import { LocalModelsBlocked } from "../src/react-app/domains/settings/ollama-config";

function checker(config: Partial<DenDesktopConfig> | null) {
  return (input: { restriction: Parameters<typeof checkDesktopAppRestriction>[0]["restriction"] }) =>
    checkDesktopAppRestriction({ config: config as DenDesktopConfig | null, restriction: input.restriction });
}

const allowed = (config: Partial<DenDesktopConfig> | null, providerId: string) => {
  const checkRestriction = checker(config);
  return isProviderAllowedByDesktopPolicy({ providerId, restrictToCloud: checkRestriction({ restriction: "allowCustomProviders" }), checkRestriction });
};

test("Ollama and LM Studio follow the local models switch; other providers do not", () => {
  const off = { allowCustomProviders: true, allowLocalModels: false };
  expect(isDesktopProviderBlocked({ providerId: "ollama", checkRestriction: checker(off) })).toBe(true);
  expect(isDesktopProviderBlocked({ providerId: "LMStudio", checkRestriction: checker(off) })).toBe(true);
  expect(isDesktopProviderBlocked({ providerId: "anthropic", checkRestriction: checker(off) })).toBe(false);
  expect(allowed(off, "anthropic")).toBe(true);
  expect(allowed(off, "ollama")).toBe(false);
  // Only models you provide, local models on.
  const managedLocal = { allowCustomProviders: false, allowLocalModels: true };
  expect(allowed(managedLocal, "ollama")).toBe(true);
  expect(allowed(managedLocal, "anthropic")).toBe(false);
  expect(allowed(managedLocal, "ipr_team")).toBe(true);
});

test("without the key (older Den, or the rollout off) local models follow the provider setting, and signed out nothing is blocked", () => {
  expect(allowed({ allowCustomProviders: false }, "ollama")).toBe(false);
  expect(allowed({ allowCustomProviders: true }, "ollama")).toBe(true);
  expect(allowed(null, "ollama")).toBe(true);
  expect(checkDesktopAppRestriction({ config: null, restriction: "allowLocalModels" })).toBe(false);
});

test("a connected Ollama is set aside when local models are turned off, and comes back when they are on again", () => {
  const base = { allProviders: [{ id: "ollama" }, { id: "anthropic" }], connectedProviderIds: ["ollama", "anthropic"] };
  const off = computePolicyProviderReconcilePlan({ ...base, disabledProviderIds: [], markedDisabledProviderIds: [], checkRestriction: checker({ allowCustomProviders: true, allowLocalModels: false }) });
  expect(off.toDisable).toEqual(["ollama"]);
  const on = computePolicyProviderReconcilePlan({ ...base, disabledProviderIds: ["ollama"], markedDisabledProviderIds: off.nextMarkedDisabledProviderIds, checkRestriction: checker({ allowCustomProviders: true, allowLocalModels: true }) });
  expect(on.toReenable).toEqual(["ollama"]);
});

test("Settings › Ollama stays visible with a lock and who turned it off, never red", () => {
  const markup = renderToStaticMarkup(<LocalModelsBlocked organizationName="Acme" />);
  expect(markup).toContain('data-testid="local-models-blocked"');
  expect(markup).toContain("Local models are off");
  expect(markup).toContain("Acme turned off Ollama and LM Studio.");
  expect(markup).toContain("An admin can turn them on in AI Gateway.");
  expect(markup).toContain("lucide-lock");
  expect(markup).not.toContain("<button");
  expect(markup).not.toMatch(/destructive|text-red/);
});
