import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeGatewayAccess } from "../app/(den)/dashboard/_components/inference-provider-request";
import { orderCatalog, providerTagline } from "../app/(den)/dashboard/_components/inference-provider-picker-screen";
import {
  getAiGatewayRoute,
  getEditAiGatewayProviderRoute,
  getAiGatewayProviderRoute,
  getAiGatewayProvidersRoute,
  getNewAiGatewayProviderRoute,
} from "../app/(den)/_lib/den-org";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function read(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const shell = read("dashboard", "_components", "org-dashboard-shell.tsx");
const navigation = read("dashboard", "_lib", "dashboard-navigation.ts");
const list = read("dashboard", "_components", "inference-providers-screen.tsx");
const editor = read("dashboard", "_components", "inference-provider-editor-screen.tsx");
const picker = read("dashboard", "_components", "inference-provider-picker-screen.tsx");
const policy = read("dashboard", "_components", "gateway-who-can-use-models.tsx");
const byok = read("dashboard", "_components", "llm-providers-screen.tsx");
const subjects = read("dashboard", "_components", "gateway-users-teams-section.tsx");
const usage = read("dashboard", "_components", "gateway-usage-section.tsx");
const llmDetail = read("dashboard", "_components", "llm-provider-detail-screen.tsx");

describe("AI Gateway nested provider routes", () => {
  test("removes every legacy route entry instead of retaining pages or redirects", () => {
    const pages = join(appRoot, "dashboard", "(admin)", "gateway-providers");
    for (const path of ["layout.tsx", "page.tsx", "new/page.tsx", "[inferenceProviderId]/page.tsx", "[inferenceProviderId]/edit/page.tsx"]) {
      expect(existsSync(join(pages, path))).toBe(false);
    }
    const routes = read("_lib", "den-org.ts");
    for (const legacy of ["getGatewayProvidersRoute", "getGatewayProviderRoute", "getNewGatewayProviderRoute", "getEditGatewayProviderRoute", "/gateway-providers"]) {
      expect(routes).not.toContain(legacy);
    }
  });

  test.each(["workspace", null, undefined])("uses only canonical routes and encodes IDs for %s", (orgSlug) => {
    expect(getAiGatewayRoute(orgSlug)).toBe("/dashboard/ai-gateway");
    expect(getAiGatewayProvidersRoute(orgSlug)).toBe("/dashboard/ai-gateway?tab=ai-providers");
    expect(getNewAiGatewayProviderRoute(orgSlug)).toBe("/dashboard/ai-gateway/providers/new");
    expect(getNewAiGatewayProviderRoute(orgSlug, "open/router")).toBe("/dashboard/ai-gateway/providers/new?provider=open%2Frouter");
    expect(getAiGatewayProviderRoute(orgSlug, "provider/id")).toBe("/dashboard/ai-gateway/providers/provider%2Fid");
    expect(getEditAiGatewayProviderRoute(orgSlug, "provider/id")).toBe("/dashboard/ai-gateway/providers/provider%2Fid/edit");
  });

  test("catalog, saved provider and edit render inside the tab shell and capability guard", () => {
    const pages = ["dashboard", "(admin)", "ai-gateway"];
    expect(read(...pages, "page.tsx")).toContain("<AiGatewayScreen");
    const layout = read(...pages, "providers", "layout.tsx");
    expect(layout).toContain("providerContent={<GatewayDashboardCapabilityGuard>{children}</GatewayDashboardCapabilityGuard>}");
    const newPage = read(...pages, "providers", "new", "page.tsx");
    expect(newPage).toContain("<InferenceProviderPickerScreen embedded />");
    expect(newPage).toContain("catalogProviderId={provider} embedded");
    for (const path of [["[inferenceProviderId]"], ["[inferenceProviderId]", "edit"]]) {
      const page = read(...pages, "providers", ...path, "page.tsx");
      expect(page).toContain("InferenceProviderEditorScreen");
      expect(page).toContain(" embedded");
    }
    for (const retired of ["inference-provider-detail-screen.tsx", "inference-provider-matrix.tsx"]) {
      expect(existsSync(join(appRoot, "dashboard", "_components", retired))).toBe(false);
    }
  });
});

describe("Gateway providers sidebar", () => {
  test("keeps the admin-gated AI Gateway item without submenu links and preserves the legacy page", () => {
    expect(navigation).not.toContain('label: "Bring Your Own Keys (Legacy)"');
    expect(existsSync(join(appRoot, "dashboard", "(admin)", "custom-llm-providers", "page.tsx"))).toBe(true);
    expect(navigation).toMatch(/const aiGatewayItem[\s\S]*access\.isAdmin && orgSlug[\s\S]*label: "AI Gateway"/);
    expect(shell).toContain('return "AI Gateway";');
  });
});

describe("AI Providers tab", () => {
  test("leads with who can use models, then one row per provider with Add provider beside the heading", () => {
    expect(list).toContain("export function GatewayProvidersSection");
    expect(list).not.toContain("InferenceProvidersScreen");
    expect(list).toContain("<GatewayWhoCanUseModels");
    expect(list).toContain("describeGatewayAccess");
    expect(list).toMatch(/Providers[\s\S]*gateway-provider-create/);
    expect(list).toContain("getAiGatewayProviderRoute(orgSlug, provider.id)");
    expect(list).toContain("getNewAiGatewayProviderRoute(orgSlug)");
    expect(list).toContain('data-testid="gateway-providers-empty"');
    expect(list).not.toContain("<DenCard");
  });

  test("the policy sheet and the BYOK page save the same desktop policy", () => {
    expect(policy).toContain('testId="gateway-model-access-managed"');
    expect(policy).toContain("Applies to every member, on Desktop and the web.");
    expect(policy).toContain("Free starter model (Auto)");
    for (const source of [policy, byok]) {
      expect(source).toContain("readModelAccessState");
      expect(source).toContain("saveModelAccess(");
      expect(source).not.toContain("updateDesktopPolicy");
    }
  });

  test("row copy names everyone, a team, or nobody", () => {
    const names = {
      organization: "Acme",
      teamName: (id: string) => (id === "team_design" ? "Design" : undefined),
      memberName: () => undefined,
    };
    const grant = (audience: { type: "organization" } | { type: "team"; teamId: string }) => ({ id: "g", modelGroupId: "mg", credentialSetId: "cs", audience });
    expect(describeGatewayAccess({ accessGrants: [] }, names)).toBe("No one has access yet");
    expect(describeGatewayAccess({ accessGrants: [grant({ type: "organization" })] }, names)).toBe("Everyone in Acme");
    expect(describeGatewayAccess({ accessGrants: [grant({ type: "team", teamId: "team_design" })] }, names)).toBe("Design");
  });
});

describe("Gateway provider form", () => {
  test("catalog picker then one form for key, who, and models", () => {
    expect(picker).toContain("Start here");
    expect(picker).toContain("Another provider");
    expect(picker).toContain("getNewAiGatewayProviderRoute(orgSlug, item.id)");
    expect(orderCatalog([{ id: "zeta", name: "Zeta" }, { id: "anthropic", name: "Anthropic" }, { id: "openrouter", name: "OpenRouter" }]).map((entry) => entry.id)).toEqual(["openrouter", "anthropic", "zeta"]);
    expect(providerTagline({ id: "anthropic", modelCount: 9 })).toBe("Claude models");
    expect(providerTagline({ id: "unknown", modelCount: 1 })).toBe("1 model");
    for (const heading of ["Key", "Who can use it", "Models"]) expect(editor).toContain(`>${heading}</h2>`);
    expect(editor).toContain("Everyone in the organization");
    expect(editor).toContain('data-testid="gateway-access-add-person"');
    expect(editor).toContain('data-testid="gateway-access-add-team"');
    expect(editor).toContain('testId="gateway-models-pick"');
    expect(editor).toContain('data-testid="gateway-models-select-all"');
    expect(editor).toContain('data-testid="gateway-models-clear"');
    expect(editor).toContain("Replace key");
  });

  test("create posts one body; edit rewrites group, set, and grants through the matrix routes", () => {
    expect(editor).toContain("buildInferenceProviderRequestBody(formInput)");
    expect(editor).toContain('resource: "model-groups"');
    expect(editor).toContain('resource: "credential-sets"');
    expect(editor).toContain('resource: "access-grants"');
    expect(editor).toContain("deleteGatewayResource");
    expect(editor).toContain("Paste a key before sharing these models.");
    expect(editor).toContain("modelIds: allowAllModels ? [] : modelIds");
    expect(editor).toContain("open={confirmDelete && !reauthDialogOpen}");
    expect(editor).toContain("getAiGatewayProvidersRoute(orgSlug)");
  });

  test("member sign-in is gated to Google Vertex and collects the org OAuth client", () => {
    expect(editor).toContain("supportsMemberCredentialMode(providerId)");
    expect(editor).toContain('data-testid="gateway-oauth-client-id"');
    expect(editor).toContain('data-testid="gateway-oauth-client-secret"');
    expect(editor).toContain("Saved — enter a replacement to change it");
  });
});

describe("Users & Teams", () => {
  test("reads access and limits without editing them in place", () => {
    expect(subjects).toContain("directoryAccess(providerList, subject)");
    expect(subjects).toContain("directoryLimit(policyList, subject)");
    expect(subjects).not.toContain("Dialog");
    expect(subjects).not.toContain("writeSubjectAccess");
  });
});

describe("Gateway usage", () => {
  test("offers tokens and cost without presenting missing costs as free", () => {
    expect(usage).toContain('onClick={() => setMetric("cost")}');
    expect(usage).toContain('unknownCost ? "Unknown" : formatUsageCost(usage.totalCostMicroUsd)');
    expect(usage).toContain("Gateway providers only. OpenWork Models not included.");
  });
});

describe("Move to gateway", () => {
  test("BYOK detail exposes the action for catalog providers with a confirm dialog", () => {
    expect(llmDetail).toContain('data-testid="llm-provider-move-to-gateway"');
    expect(llmDetail).toContain("migrateLlmProviderToGateway(provider.id)");
    expect(llmDetail).toContain("getAiGatewayProviderRoute(orgSlug, gatewayProvider.id)");
  });
});
