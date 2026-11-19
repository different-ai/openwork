import { clickButton, denFetch } from "@openwork/behaviors";
import { provider } from "../ctx.ts";
import { inPage } from "../inpage.ts";
import { org } from "../seed.ts";
import { denWeb } from "../surfaces.ts";
import type { DenWebSurface, DesktopShotSurface } from "../surfaces.ts";
import { dismissOverlays } from "../steps.ts";
import { app } from "./desktop.ts";
import { shot } from "./shot.ts";

/**
 * "Providers for your org" docs: the legacy bring-your-own-key provider flow in
 * Den (AI Gateway > AI Providers > Legacy Providers) and its detail page.
 */

const PROVIDER_NAME = "Acme LLM Gateway";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One org-wide legacy custom provider, so list and detail shots show real data. */
const legacyProvider = provider(async (ctx) => {
  const organization = await ctx.use(org);
  const admin = organization.den.admin;
  const route = "/v1/llm-providers";
  const created = await denFetch(admin, route, {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": organization.orgId },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: "acme-llm-gateway",
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: ["ACME_LLM_GATEWAY_API_KEY"],
        api: "https://llm.acme.example/v1",
        models: [
          { id: "gpt-5.2", name: "GPT-5.2", tool_call: true, limit: { context: 400000, output: 128000 } },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", tool_call: true, limit: { context: 200000, output: 64000 } },
        ],
      },
      apiKey: "sk-docs-shots",
      allMembers: true,
    }),
  });
  const record = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  const id = record && typeof record.id === "string" ? record.id : "";
  if (!created.response.ok || !id) {
    throw new Error(`POST ${route} failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  return { organization, id };
});

const browser = denWeb({ org, as: "admin" });

interface SeededDenWebSurface extends DenWebSurface {
  llmProviderId: string;
}

const seededBrowser = provider(async (ctx): Promise<SeededDenWebSurface> => {
  const seeded = await ctx.use(legacyProvider);
  const surface = await ctx.use(browser);
  return { ...surface, llmProviderId: seeded.id };
});

async function scrollToLegacyProviders(surface: DenWebSurface): Promise<void> {
  await inPage(surface, () => {
    document.querySelector<HTMLElement>('[data-testid="gateway-legacy-providers"]')?.scrollIntoView({ block: "center" });
    return true;
  }, {});
}

export const denLegacyProviders = shot("den-legacy-providers", {
  use: seededBrowser,
  at: "/dashboard/ai-gateway?tab=ai-providers",
  steps: [scrollToLegacyProviders],
  expect: ["No providers yet", "Legacy Providers", "Add legacy provider", PROVIDER_NAME],
  never: ["Loading legacy providers", "Could not load legacy providers", "not part of your deployment", "Checking workspace access"],
  viewport: { width: 1440, height: 1300, deviceScaleFactor: 2 },
  out: "packages/docs/images/cloud-ai-gateway-legacy-providers.png",
});

export const denLegacyProviderCatalogForm = shot("den-legacy-provider-catalog-form", {
  use: browser,
  at: "/dashboard/custom-llm-providers/new",
  expect: ["Catalog provider", "Custom provider", "API key / credential", "Who can use it"],
  viewport: { width: 1440, height: 1200, deviceScaleFactor: 2 },
  out: "packages/docs/images/cloud-managed-llm-provider-form.png",
});

export const denLegacyProviderCustomForm = shot("den-legacy-provider-custom-form", {
  use: browser,
  at: "/dashboard/custom-llm-providers/new",
  steps: [(surface) => clickButton(surface, "Custom provider", { timeoutMs: 60_000 })],
  expect: ["Provider ID", "Base URL", "API key / credential", "Advanced: edit as JSON"],
  viewport: { width: 1440, height: 1400, deviceScaleFactor: 2 },
  out: "packages/docs/images/cloud-custom-llm-provider-form.png",
});

export const denLegacyProviderDetail = shot("den-legacy-provider-detail", {
  use: seededBrowser,
  at: (surface) => `/dashboard/custom-llm-providers/${encodeURIComponent(surface.llmProviderId)}`,
  expect: [PROVIDER_NAME, "Edit Provider", "Credential saved", "Selected models", "GPT-5.2"],
  never: ["Credential missing"],
  out: "packages/docs/images/cloud-custom-llm-provider-detail.png",
});

const seededDesktop = provider(async (ctx): Promise<DesktopShotSurface> => {
  await ctx.use(legacyProvider);
  return ctx.use(app);
});

export const desktopCloudProviders = shot("desktop-cloud-providers", {
  use: seededDesktop,
  at: (surface) => `/workspace/${surface.workspaceId}/settings/ai`,
  steps: [dismissOverlays, scrollToCloudProviders, dismissOverlays],
  expect: ["Cloud providers", "Sync now", PROVIDER_NAME, "Credential ready"],
  never: ["Loading providers", "Syncing", "Sync error", "Needs organization credential"],
  out: "packages/docs/images/desktop-cloud-providers.png",
});

async function scrollToCloudProviders(surface: DesktopShotSurface): Promise<void> {
  await inPage(surface, () => {
    const heading = [...document.querySelectorAll("h1, h2, h3, h4, div, span")]
      .find((element) => (element.textContent ?? "").trim() === "Cloud providers");
    heading?.scrollIntoView({ block: "start" });
    return true;
  }, {});
}
