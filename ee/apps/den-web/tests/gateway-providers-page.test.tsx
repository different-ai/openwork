import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InferenceCredentialStatusBadge } from "../app/(den)/dashboard/_components/inference-providers-screen";
import { GATEWAY_EXPLAINER } from "../app/(den)/dashboard/_components/inference-provider-detail-screen";
import {
  getCustomLlmProvidersRoute,
  getEditGatewayProviderRoute,
  getGatewayProviderRoute,
  getGatewayProvidersRoute,
  getNewGatewayProviderRoute,
} from "../app/(den)/_lib/den-org";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function read(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const shell = read("dashboard", "_components", "org-dashboard-shell.tsx");
const list = read("dashboard", "_components", "inference-providers-screen.tsx");
const editor = read("dashboard", "_components", "inference-provider-editor-screen.tsx");
const detail = read("dashboard", "_components", "inference-provider-detail-screen.tsx");
const llmDetail = read("dashboard", "_components", "llm-provider-detail-screen.tsx");
const llmEditor = read("dashboard", "_components", "llm-provider-editor-screen.tsx");

describe("Gateway providers routes", () => {
  test("live next to custom-llm-providers under the org dashboard", () => {
    const base = getGatewayProvidersRoute("acme");
    expect(base).toBe(getCustomLlmProvidersRoute("acme").replace("custom-llm-providers", "gateway-providers"));
    expect(getNewGatewayProviderRoute("acme")).toBe(`${base}/new`);
    expect(getGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1`);
    expect(getEditGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1/edit`);
  });

  test("route pages exist for list, new, detail and edit", () => {
    const pages = join(appRoot, "dashboard", "(admin)", "gateway-providers");
    expect(readFileSync(join(pages, "page.tsx"), "utf8")).toContain("InferenceProvidersScreen");
    expect(readFileSync(join(pages, "new", "page.tsx"), "utf8")).toContain("InferenceProviderEditorScreen");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "page.tsx"), "utf8")).toContain("InferenceProviderDetailScreen");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "edit", "page.tsx"), "utf8")).toContain(
      "InferenceProviderEditorScreen",
    );
  });
});

describe("Gateway providers sidebar", () => {
  test("appears under the admin-gated Models group next to Bring your Own Keys", () => {
    const byok = shell.indexOf('label: "Bring your Own Keys" }');
    const gateway = shell.indexOf('label: "Gateway providers" }');
    expect(byok).toBeGreaterThan(-1);
    expect(gateway).toBeGreaterThan(byok);
    expect(shell).toMatch(/const modelsGroup[\s\S]*access\.isAdmin && activeOrg[\s\S]*label: "Gateway providers"/);
    expect(shell).toContain('return "Gateway providers";');
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

  test("table columns cover name, provider, models, credential mode, credential status, status and open", () => {
    for (const header of ['header: "Name"', 'header: "Provider"', 'header: "Models"', 'header: "Credential"', 'header: "Credential status"', 'header: "Status"']) {
      expect(list).toContain(header);
    }
    expect(list).toContain('data-testid="gateway-provider-create"');
    expect(list).toContain('data-testid="gateway-provider-open"');
    expect(list).toContain("via OpenWork Gateway");
    expect(read("dashboard", "_components", "inference-provider-data.tsx")).toContain("scope=manageable");
  });
});

describe("Gateway provider editor", () => {
  test("reuses the BYOK pickers instead of duplicating them", () => {
    expect(editor).toContain("ProviderAccessPicker");
    expect(editor).toContain("ProviderModelPicker");
    expect(editor).toContain("buildCatalogProviderOptions");
    expect(llmEditor).toContain("ProviderAccessPicker");
    expect(llmEditor).toContain("ProviderModelPicker");
    expect(llmEditor).toContain("buildCatalogProviderOptions");
  });

  test("offers both credential modes, conditional settings, service account JSON and a status toggle", () => {
    expect(editor).toContain('testId="gateway-credential-mode-org"');
    expect(editor).toContain('testId="gateway-credential-mode-member"');
    expect(editor).toContain("getRequiredSettingKeys(npm)");
    expect(editor).toContain('data-testid="gateway-provider-service-account"');
    expect(editor).toContain('testId="gateway-provider-active"');
    expect(editor).toContain('data-testid="gateway-provider-delete-confirm"');
    expect(editor).not.toContain("aws_keys");
  });

  test("member mode collects the org's Google OAuth client and is gated to Google Vertex providers", () => {
    expect(editor).toContain('data-testid="gateway-provider-oauth-client-id"');
    expect(editor).toContain('data-testid="gateway-provider-oauth-client-secret"');
    expect(editor).toContain('data-testid="gateway-provider-oauth-redirect-uri"');
    expect(editor).toContain("Create an Internal OAuth client in your Google Cloud project and add this redirect URI:");
    expect(editor).toContain("denApiEndpoint(getOauthCallbackPath())");
    expect(editor).toContain("provider?.hasOauthClientSecret");
    expect(editor).toContain("Leave blank to keep the current secret");
    expect(editor).toContain("supportsMemberCredentialMode(selectedProviderId)");
    expect(editor).toContain("disabled={!memberModeSupported}");
    expect(editor).toContain("Only available for Google Vertex providers");
  });
});

describe("Gateway provider detail", () => {
  test("shows the explainer and a credentials table without values", () => {
    expect(GATEWAY_EXPLAINER).toBe(
      "Members call this provider through the OpenWork inference gateway with their OpenWork key; the provider credential never leaves OpenWork.",
    );
    expect(detail).toContain("Values are never shown");
    for (const header of ['header: "Holder"', 'header: "Kind"', 'header: "Status"', 'header: "Expires"']) {
      expect(detail).toContain(header);
    }
  });

  test("member credential rows show who authorized instead of a generic label", () => {
    expect(detail).toContain('row.memberName ?? row.memberEmail ?? "Member"');
    expect(detail).toContain("row.memberEmail");
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
