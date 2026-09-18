import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InferenceCredentialStatusBadge } from "../app/(den)/dashboard/_components/inference-providers-screen";
import { GATEWAY_EXPLAINER } from "../app/(den)/dashboard/_components/inference-provider-detail-screen";
import { GatewayModelUniverse } from "../app/(den)/dashboard/_components/inference-provider-model-universe";
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
const detail = read("dashboard", "_components", "inference-provider-detail-screen.tsx");
const matrix = read("dashboard", "_components", "inference-provider-matrix.tsx");
const subjects = read("dashboard", "_components", "gateway-users-teams-section.tsx");
const universe = read("dashboard", "_components", "inference-provider-model-universe.tsx");
const usage = read("dashboard", "_components", "gateway-usage-section.tsx");
const llmDetail = read("dashboard", "_components", "llm-provider-detail-screen.tsx");
const llmEditor = read("dashboard", "_components", "llm-provider-editor-screen.tsx");

describe("AI Gateway nested provider routes", () => {
  test("removes every legacy route entry instead of retaining pages or redirects", () => {
    const pages = join(appRoot, "dashboard", "(admin)", "gateway-providers");
    for (const path of ["layout.tsx", "page.tsx", "new/page.tsx", "[inferenceProviderId]/page.tsx", "[inferenceProviderId]/edit/page.tsx"]) {
      expect(existsSync(join(pages, path))).toBe(false);
    }
    const routes = read("_lib", "den-org.ts");
    for (const legacy of ["GatewayProviderRouteContext", "getGatewayProviderRoutes", "getGatewayProvidersRoute", "getGatewayProviderRoute", "getNewGatewayProviderRoute", "getEditGatewayProviderRoute", "/gateway-providers"]) {
      expect(routes).not.toContain(legacy);
    }
  });

  test.each(["workspace", null, undefined])("uses only canonical routes and encodes IDs for %s", (orgSlug) => {
    expect(getAiGatewayRoute(orgSlug)).toBe("/dashboard/ai-gateway");
    expect(getAiGatewayProvidersRoute(orgSlug)).toBe("/dashboard/ai-gateway?tab=ai-providers");
    expect(getNewAiGatewayProviderRoute(orgSlug)).toBe("/dashboard/ai-gateway/providers/new");
    expect(getAiGatewayProviderRoute(orgSlug, "provider/id")).toBe("/dashboard/ai-gateway/providers/provider%2Fid");
    expect(getEditAiGatewayProviderRoute(orgSlug, "provider/id")).toBe("/dashboard/ai-gateway/providers/provider%2Fid/edit");
  });

  test("new, detail and edit retain the tab shell and capability guard", () => {
    const pages = ["dashboard", "(admin)", "ai-gateway"];
    expect(read(...pages, "page.tsx")).toContain("<AiGatewayScreen");
    const layout = read(...pages, "providers", "layout.tsx");
    expect(layout).toContain("<AiGatewayScreen");
    expect(layout).toContain("providerContent={<GatewayDashboardCapabilityGuard>{children}</GatewayDashboardCapabilityGuard>}");
    for (const path of [["new"], ["[inferenceProviderId]"], ["[inferenceProviderId]", "edit"]]) {
      const page = read(...pages, "providers", ...path, "page.tsx");
      expect(page).toContain(" embedded");
      expect(page).not.toContain("routeContext");
      expect(page).toContain(path.length === 1 && path[0] === "[inferenceProviderId]" ? "InferenceProviderDetailScreen" : "InferenceProviderEditorScreen");
    }
    for (const screen of [list, editor, detail]) {
      expect(screen).not.toContain("routeContext");
      expect(screen).not.toContain("getGatewayProviderRoutes");
    }
    expect(list).not.toContain("InferenceProvidersScreen");
    expect(list).toContain("getAiGatewayProviderRoute(orgSlug, provider.id)");
    expect(list).toContain("getNewAiGatewayProviderRoute(orgSlug)");
    expect(editor).toContain("getAiGatewayProviderRoute(orgSlug,");
    expect(editor).toContain("getAiGatewayProvidersRoute(orgSlug)");
    expect(detail).toContain("getEditAiGatewayProviderRoute(orgSlug,");
    expect(detail).toContain("getAiGatewayProvidersRoute(orgSlug)");
  });
});

describe("Gateway providers sidebar", () => {
  test("keeps the admin-gated AI Gateway root and legacy BYOK without Old Gateway", () => {
    expect(navigation).toContain('label: "Bring Your Own Keys (Legacy)"');
    expect(navigation).not.toContain('label: "Old Gateway"');
    expect(navigation).not.toContain("getGatewayProvidersRoute");
    expect(shell).not.toContain("getGatewayProvidersRoute");
    expect(navigation).toMatch(/const modelsGroup[\s\S]*access\.isAdmin && orgSlug[\s\S]*label: "AI Gateway"/);
    expect(shell).toContain('return "AI Gateway";');
  });
});

describe("Gateway providers list", () => {
  test("renders credential status labels with the shared badge", () => {
    const ready = renderToStaticMarkup(
      createElement(InferenceCredentialStatusBadge, { provider: { credentialMode: "org", credentialStatus: "ready" } }),
    );
    const missing = renderToStaticMarkup(
      createElement(InferenceCredentialStatusBadge, {
        provider: { credentialMode: "org", credentialStatus: "org_credential_missing" },
      }),
    );
    const member = renderToStaticMarkup(
      createElement(InferenceCredentialStatusBadge, {
        provider: { credentialMode: "member", credentialStatus: "member_auth_required" },
      }),
    );
    expect(ready).toContain("Ready");
    expect(ready).toContain("text-emerald-700");
    expect(missing).toContain("Org credential missing");
    expect(missing).toContain("text-amber-700");
    expect(member).toContain("Members authorize individually");
  });

  test("provider cards show identity, status, configured key and model group counts and open", () => {
    for (const content of ["<DenCard", "{provider.name}", "{provider.providerId}", "getProviderStatusLabel(provider.status)", 'set.credentialMode === "org" && set.configured', "provider.modelGroups?.length", "Keys unavailable", "Model groups unavailable"]) {
      expect(list).toContain(content);
    }
    expect(list).not.toContain("<DenTable");
    expect(list).toContain('data-testid="gateway-provider-create"');
    expect(list).toContain('data-testid="gateway-provider-open"');
    expect(list).not.toContain("<GatewayUsageSection");
    expect(read("dashboard", "_components", "ai-gateway-screen.tsx")).toContain("<GatewayUsageSection");
    expect(read("dashboard", "_components", "inference-provider-data.tsx")).toContain("scope=manageable");
  });
});

describe("Gateway provider editor", () => {
  test("reuses the BYOK pickers instead of duplicating them", () => {
    expect(editor).toContain("<GatewayAccessMatrix");
    expect(editor).toContain("<GatewayModelUniverse");
    expect(matrix).not.toContain("<ProviderAccessPicker");
    expect(subjects).toContain("<ProviderAccessPicker");
    expect(subjects).toContain("lockedMemberId={null} singleAudience");
    expect(matrix).toContain("<ProviderModelPicker");
    expect(universe).toContain("<ProviderModelPicker");
    expect(universe).toContain('layout="cards"');
    expect(editor).toContain("buildCatalogProviderOptions");
    expect(llmEditor).toContain("ProviderAccessPicker");
    expect(llmEditor).toContain("ProviderModelPicker");
    expect(llmEditor).toContain("buildCatalogProviderOptions");
  });

  test("offers credential modes in the matrix, fixed connection settings and explicit deletion", () => {
    expect(matrix).toContain('title="Shared/Private API Key"');
    expect(matrix).toContain('title="Each Member Signs In"');
    expect(editor).toContain("getRequiredSettingKeys(npm)");
    expect(editor).toContain("readOnly={Boolean(provider)}");
    expect(editor).toContain("The provider and its connection settings are fixed after creation.");
    expect(editor).toContain('JSON.stringify(settings) === JSON.stringify(provider.settings) ? {} : { settings }');
    expect(matrix).toContain("Service account JSON<DenTextarea");
    expect(matrix).toContain('value.type !== "service_account"');
    expect(editor).toContain('aria-label="Provider active"');
    expect(editor).toContain("<AlertDialog.Title");
    expect(editor).toContain("initialFocus={cancelDeleteRef}");
    expect(editor).toContain("open={confirmDelete && !reauthDialogOpen}");
    expect(editor).toContain("onClick={() => void remove()}");
    expect(editor).not.toContain("aws_keys");
    expect(matrix).not.toContain("aws_keys");
  });

  test("member mode collects the org's Google OAuth client and is gated to Google Vertex providers", () => {
    expect(matrix).toContain('OAuth client ID<DenInput value={editor.oauthClientId}');
    expect(matrix).toContain('type="password" value={editor.oauthClientSecret}');
    expect(matrix).toContain("{provider.oauthCallbackUrl}");
    expect(matrix).toContain("Add this URL to the allowed redirect URIs in your OAuth client configuration.");
    expect(matrix).not.toContain("denApiEndpoint(getOauthCallbackPath())");
    expect(matrix).toContain("editor.hasOauthClientSecret");
    expect(matrix).toContain("enter a replacement to change it");
    expect(matrix).toContain("if (editor.oauthClientSecret.trim()) body.oauthClientSecret = editor.oauthClientSecret.trim()");
    expect(matrix).toContain("supportsMemberCredentialMode(provider.providerId)");
    expect(matrix).toContain("disabled={!memberSignInSupported}");
    expect(matrix).toContain("This provider does not support per end user signin");
    expect(matrix).toContain("Member sign-in requires a supported provider and an OAuth client ID and secret.");
  });
});

describe("Gateway provider detail", () => {
  test("shows the matrix explainer and write-only upstream keys", () => {
    expect(GATEWAY_EXPLAINER).toBe(
      "Members call this provider with their own AI Gateway key. Access rules select a model group and credential set; upstream credentials never reach their devices.",
    );
    expect(detail).toContain("<GatewayAccessMatrix");
    for (const header of ['header: "Name"', 'header: "Created by"', 'header: "Created date"', 'header: "Status"']) {
      expect(matrix).toContain(header);
    }
    expect(matrix).toContain('oauthClientSecret: ""');
    expect(matrix).toContain('secret: "", apiKeys: {}');
    expect(matrix).not.toContain("set.secret");
    expect(matrix).not.toContain("set.oauthClientSecret");
  });

  test("upstream key rows identify their creator without expanding audience membership", () => {
    expect(matrix).toContain('set.createdBy?.name || set.createdBy?.email || "Not recorded"');
    expect(matrix).toContain("set.createdBy.email");
    expect(matrix).toContain('getRowKey={(set) => set.id}');
    expect(matrix).toContain('href={`${getAiGatewayRoute()}?tab=users-and-teams`}');
    expect(matrix).toContain("Manage access in Users &amp; Teams");
    expect(matrix).not.toContain('resource: "access-grants"');
    expect(subjects).toContain("for (const grant of provider.accessGrants) ensureCard(grant.audience).grants.push({ provider, grant })");
  });
});

describe("Gateway model and access defaults", () => {
  test("allow-all is an empty policy, while restricted empty selections are rejected", () => {
    expect(editor).toContain("modelIds: allowAllModels ? [] : modelIds");
    expect(editor).toContain("if (!allowAllModels && !modelIds.length) return setSaveError");
    expect(detail).toContain("provider.modelIds !== null && provider.modelIds.length === 0");
    expect(detail).toContain("modelIds: value.allowAllModels ? [] : value.modelIds");
    expect(detail).toContain("if (!value.allowAllModels && !value.modelIds.length) return setError");
    expect(detail).toContain("const value = draft ??");
    expect(detail).toContain("if (!catalog) return setError");
  });

  test("does not grant default access or save a new empty upstream key", () => {
    expect(editor).toContain('allMembers: false, memberIds: [], teamIds: []');
    expect(editor).not.toContain("saveGatewayResource");
    expect(subjects).toContain('access: { allMembers: false, memberIds: [], teamIds: [] }, providerId: "", modelGroupId: "", credentialSetId: ""');
    expect(matrix).toContain("if (needsCredential && !hasCredential) return setError");
    expect(subjects).toContain("Number(access.allMembers) + access.memberIds.length + access.teamIds.length !== 1");
    expect(subjects).toContain("directory.teams.some((team) => team.id === teamId)");
    expect(subjects).toContain("directory.members.some((member) => member.id === memberId)");
    expect(subjects).toContain("!audience || !validDetails || duplicate");
    expect(matrix).toContain("No models in this group. It does not grant access to any models.");
  });

  test.each([true, false])("renders the model universe with allow-all %s", (allowAllModels) => {
    const html = renderToStaticMarkup(createElement(GatewayModelUniverse, {
      models: [{ id: "model-1", name: "Test Model" }], allowAllModels, modelIds: ["model-1"], onChange: () => {},
    }));
    expect(html).toContain("Model universe");
    expect(html).toContain('aria-label="Allow all models"');
    expect(html).toContain(`aria-checked="${allowAllModels}"`);
    if (allowAllModels) expect(html).not.toContain("Test Model");
    else expect(html).toContain("Test Model");
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
    expect(llmDetail).toContain("getAiGatewayProviderRoute(orgSlug, gatewayProvider.id)");
  });
});
