import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayAccessGrant } from "@openwork/types/den/gateway";
import { describeModelAccess } from "../app/(den)/dashboard/_components/gateway-model-access-sheet";
import { GatewayModelsPanel } from "../app/(den)/dashboard/_components/gateway-provider-sections";
import {
  describeProviderRow,
  getKeyShape,
  getTestKeyApiBase,
  isSimpleProvider,
  needsInstanceName,
  planGrantChanges,
  resolvePrimaryPair,
  sortCatalogProviders,
  whoFromGrants,
} from "../app/(den)/dashboard/_components/gateway-provider-model";
import {
  getCustomLlmProvidersRoute,
  getEditGatewayProviderRoute,
  getGatewayProviderRoute,
  getGatewayProvidersRoute,
  getNewGatewayProviderForCatalogRoute,
  getNewGatewayProviderRoute,
} from "../app/(den)/_lib/den-org";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function read(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const shell = read("dashboard", "_components", "org-dashboard-shell.tsx");
const navigation = read("dashboard", "_lib", "dashboard-navigation.ts");
const list = read("dashboard", "_components", "inference-providers-screen.tsx");
const form = read("dashboard", "_components", "gateway-provider-form.tsx");
const sections = read("dashboard", "_components", "gateway-provider-sections.tsx");
const catalogScreen = read("dashboard", "_components", "gateway-provider-catalog-screen.tsx");
const dashboardAccess = read("dashboard", "_components", "org-dashboard-detail-screen.tsx");
const matrix = read("dashboard", "_components", "inference-provider-matrix.tsx");
const usage = read("dashboard", "_components", "gateway-usage-section.tsx");
const llmDetail = read("dashboard", "_components", "llm-provider-detail-screen.tsx");

describe("Gateway providers routes", () => {
  test("live next to custom-llm-providers under the org dashboard", () => {
    const base = getGatewayProvidersRoute("acme");
    expect(base).toBe(getCustomLlmProvidersRoute("acme").replace("custom-llm-providers", "gateway-providers"));
    expect(getNewGatewayProviderRoute("acme")).toBe(`${base}/new`);
    expect(getGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1`);
    expect(getEditGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1/edit`);
    expect(getNewGatewayProviderForCatalogRoute("acme", "anthropic")).toBe(`${base}/new/anthropic`);
  });

  test("list, catalog, add form, and one saved-provider form (old /edit links land on it)", () => {
    const pages = join(appRoot, "dashboard", "(admin)", "gateway-providers");
    expect(readFileSync(join(pages, "page.tsx"), "utf8")).toContain("InferenceProvidersScreen");
    expect(readFileSync(join(pages, "new", "page.tsx"), "utf8")).toContain("GatewayProviderCatalogScreen");
    expect(readFileSync(join(pages, "new", "[catalogProviderId]", "page.tsx"), "utf8")).toContain("<GatewayProviderForm catalogProviderId");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "page.tsx"), "utf8")).toContain("<GatewayProviderForm inferenceProviderId");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "edit", "page.tsx"), "utf8")).toContain("<GatewayProviderForm inferenceProviderId");
  });
});

describe("Gateway providers sidebar", () => {
  test("appears first under the admin-gated Models group before legacy BYOK", () => {
    const byok = navigation.indexOf('label: "Bring Your Own Keys (Legacy)"');
    const gateway = navigation.indexOf('label: "Gateway", badge: "New"');
    expect(gateway).toBeGreaterThan(-1);
    expect(byok).toBeGreaterThan(gateway);
    expect(navigation).toMatch(/const modelsGroup[\s\S]*access\.isAdmin && orgSlug[\s\S]*label: "Gateway"/);
    expect(shell).toContain('return "Gateway";');
  });
});

const anthropicGrant = (id: string, audience: GatewayAccessGrant["audience"]): GatewayAccessGrant => ({ id, modelGroupId: "gmg_1", credentialSetId: "gcs_1", audience });
const readySet = { id: "gcs_1", name: "Default credentials", credentialMode: "org" as const, status: "active" as const, configured: true, credentialStatus: "ready" as const };
const group = { id: "gmg_1", name: "All Allowed Models", description: null, status: "active" as const, modelIds: ["claude-sonnet"] };
const orgContext = {
  teams: [{ id: "team_marketing", name: "Marketing", createdAt: null, updatedAt: null, memberIds: [], managedByScim: false, grantsOrganizationAdmin: false }],
  members: [],
};

describe("AI Gateway list", () => {
  test("one row per provider: models, who, and status in plain words", () => {
    expect(describeProviderRow({ status: "active", modelIds: [], credentialSets: [readySet], accessGrants: [anthropicGrant("g1", { type: "organization" })] }, orgContext))
      .toEqual({ models: "All models", who: "Everyone", status: "ready" });
    expect(describeProviderRow({ status: "active", modelIds: ["gpt-5"], credentialSets: [readySet], accessGrants: [anthropicGrant("g1", { type: "team", teamId: "team_marketing" })] }, orgContext))
      .toEqual({ models: "1 model", who: "Marketing", status: "ready" });
    expect(describeProviderRow({ status: "active", modelIds: [], credentialSets: [readySet], accessGrants: [] }, orgContext).status).toBe("give_access");
    expect(describeProviderRow({ status: "active", modelIds: [], credentialSets: [{ ...readySet, configured: false }], accessGrants: [] }, orgContext).status).toBe("key_missing");
  });

  test("rows open the provider; the page leads with the org rule and an empty state", () => {
    for (const content of ['data-testid="gateway-provider-open"', 'data-testid="gateway-provider-create"', "<GatewayModelAccessRow", "<EmptyState", "No providers yet", "Bring Your Own Keys", "<GatewayUsageSection"]) {
      expect(list).toContain(content);
    }
    expect(list).not.toContain("<DenCard");
    expect(read("dashboard", "_components", "inference-provider-data.tsx")).toContain("scope=manageable");
  });
});

describe("Who can use models", () => {
  test("summarises the default desktop policy the BYOK page also edits", () => {
    expect(describeModelAccess({ mode: "managed", adminException: true, zenAllowed: true }))
      .toEqual({ pill: "Only models you provide", line: "Members can’t add their own keys · admins can" });
    expect(describeModelAccess({ mode: "open", adminException: true, zenAllowed: true }).pill).toBe("Any model");
    expect(read("dashboard", "_components", "llm-providers-screen.tsx")).toContain("useModelAccessPolicy(orgId)");
    expect(read("dashboard", "_components", "gateway-model-access-sheet.tsx")).toContain("useModelAccessPolicy(orgId)");
  });
});

describe("Add a provider", () => {
  test("most common first, the rest behind Show N more", () => {
    const { featured, rest } = sortCatalogProviders([
      { id: "zeta", name: "Zeta" }, { id: "openai", name: "OpenAI" }, { id: "alpha", name: "Alpha" }, { id: "anthropic", name: "Anthropic" }, { id: "openrouter", name: "OpenRouter" },
    ]);
    expect(featured.map((provider) => provider.id)).toEqual(["openrouter", "anthropic", "openai"]);
    expect(rest.map((provider) => provider.id)).toEqual(["alpha", "zeta"]);
    expect(catalogScreen).toContain("Show {rest.length} more providers");
    expect(catalogScreen).toContain("isSupportedGatewayNpm(provider.npm)");
  });
});

describe("Provider form", () => {
  test("Key → Who can use it → Models, one column, same form for add and edit", () => {
    const key = form.indexOf("{keyPanel}");
    const who = form.indexOf("<GatewayWhoCanUseIt");
    const models = form.indexOf("<GatewayModelsPanel");
    expect(key).toBeGreaterThan(-1);
    expect(who).toBeGreaterThan(key);
    expect(models).toBeGreaterThan(who);
    expect(form).toContain("Replace key");
    expect(form).toContain("Save changes");
    expect(form).toContain("Remove");
    expect(form).not.toContain('type="password" value={secret}');
  });

  test("Who can use it reuses the Dashboards access block", () => {
    for (const piece of ["OrgWideAccessToggle", "AccessGrantRow", "AccessAddPicker", "TeamIdentity"]) {
      expect(sections).toContain(piece);
      expect(dashboardAccess).toContain(piece);
    }
  });

  test("a name appears only for a second instance of the same provider", () => {
    const existing = [{ id: "infp_1", providerId: "openai" }];
    expect(needsInstanceName("openai", existing, null)).toBe(true);
    expect(needsInstanceName("openai", existing, "infp_1")).toBe(false);
    expect(needsInstanceName("anthropic", existing, null)).toBe(false);
  });

  test("key shape and Test key follow the provider, without a new endpoint", () => {
    expect(getKeyShape("@ai-sdk/google-vertex", ["GOOGLE_VERTEX_PROJECT"])).toBe("service_account");
    expect(getKeyShape("@ai-sdk/anthropic", ["ANTHROPIC_API_KEY"])).toBe("api_key");
    expect(getKeyShape("@ai-sdk/azure", ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])).toBe("api_keys");
    expect(getTestKeyApiBase("@ai-sdk/openai", null)).toBe("https://api.openai.com/v1");
    expect(getTestKeyApiBase("@ai-sdk/anthropic", "https://api.anthropic.com")).toBeNull();
  });

  test("editing who creates and deletes only the grants that changed", () => {
    const existing = [anthropicGrant("g_org", { type: "organization" })];
    const plan = planGrantChanges(existing, { orgWide: false, teamIds: ["team_design"], memberIds: [] });
    expect(plan.create).toEqual([{ type: "team", teamId: "team_design" }]);
    expect(plan.removeGrantIds).toEqual(["g_org"]);
    expect(planGrantChanges(existing, whoFromGrants(existing))).toEqual({ create: [], removeGrantIds: [] });
  });

  test("the form edits the provider's one key and one model list; anything more falls back to the matrix", () => {
    const provider = { credentialSets: [readySet], modelGroups: [group], accessGrants: [anthropicGrant("g1", { type: "organization" })] };
    expect(resolvePrimaryPair(provider)).toEqual({ credentialSetId: "gcs_1", modelGroupId: "gmg_1" });
    expect(isSimpleProvider(provider)).toBe(true);
    expect(isSimpleProvider({ ...provider, credentialSets: [readySet, { ...readySet, id: "gcs_2" }] })).toBe(false);
    expect(form).toContain("<GatewayAccessMatrix");
  });

  test.each([true, false])("Models panel with all models %s", (allModels) => {
    const html = renderToStaticMarkup(createElement(GatewayModelsPanel, {
      providerName: "OpenAI", catalogProviderId: "openai", models: [{ id: "gpt-5", name: "GPT-5" }], value: { allModels, modelIds: ["gpt-5"] }, onChange: () => {}, disabled: false,
    }));
    expect(html).toContain("All OpenAI models");
    expect(html).toContain("Only the ones I pick");
    if (allModels) expect(html).not.toContain("GPT-5");
    else {
      expect(html).toContain("GPT-5");
      expect(html).toContain("Filter models");
      expect(html).not.toContain(">gpt-5<");
    }
  });
});

describe("Gateway access matrix (providers with several keys or model lists)", () => {
  test("keeps credential modes, member sign-in gating and write-only secrets", () => {
    expect(matrix).toContain('title="Shared/Private API Key"');
    expect(matrix).toContain('title="Each Member Signs In"');
    expect(matrix).toContain("supportsMemberCredentialMode(provider.providerId)");
    expect(matrix).toContain('oauthClientSecret: ""');
    expect(matrix).not.toContain("set.secret");
    expect(matrix).toContain("Choose exactly one audience: organization, team or person.");
  });
});

describe("Gateway usage", () => {
  test("offers tokens and cost without presenting missing costs as free", () => {
    expect(usage).toContain('onClick={() => setMetric("tokens")}');
    expect(usage).toContain('onClick={() => setMetric("cost")}');
    expect(usage).toContain('aria-pressed={isCost}');
    expect(usage).toContain("Click here to see how costs are calculated");
    expect(usage).toContain("https://openworklabs.com/docs/ai-gateway/token-costs");
    expect(usage).toContain('unknownCost ? "Unknown" : formatUsageCost(usage.totalCostMicroUsd)');
    expect(usage).toContain('valueFormat={isCost ? "usd" : "tokens"}');
    expect(usage).toContain("Gateway providers only. OpenWork Models not included.");
    expect(usage).toContain("query.isPending || query.isFetching || query.isPlaceholderData");
    expect(usage).toContain('"Usage unavailable"');
  });
});

describe("Move to gateway", () => {
  test("BYOK detail exposes the action for catalog providers with a confirm dialog", () => {
    expect(llmDetail).toContain('provider.canManage && provider.source === "models_dev"');
    expect(llmDetail).toContain('data-testid="llm-provider-move-to-gateway"');
    expect(llmDetail).toContain('data-testid="llm-provider-move-to-gateway-confirm"');
    expect(llmDetail).toContain("migrateLlmProviderToGateway(provider.id)");
    expect(llmDetail).toContain("re-sync");
    expect(llmDetail).toContain("getGatewayProviderRoute(orgSlug, gatewayProvider.id)");
  });
});
