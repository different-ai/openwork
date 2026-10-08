"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, KeyRound, Plus, Search } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { DenSectionHeader } from "../../_components/ui/section-header";
import {
  getLlmProviderRoute,
  getNewLlmProviderRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgDesktopPolicies } from "./desktop-policy-data";
import { readModelAccessState, saveModelAccess, type ModelAccessMode } from "./model-access-policy";
import {
  formatProviderTimestamp,
  getProviderDocUrl,
  getProviderIconSlug,
  useOrgLlmProviders,
  type DenLlmProvider,
} from "./llm-provider-data";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function LlmProviderList({ providers, orgSlug }: { providers: DenLlmProvider[]; orgSlug: string | null }) {
  return (
    <DenList>
      {providers.map((provider) => {
        const members = provider.access.members.length;
        const teams = provider.access.teams.length;
        const accessText = provider.access.allMembers
          ? "Everyone in the org"
          : `${members} ${members === 1 ? "person" : "people"} · ${plural(teams, "team")}`;
        return (
          <DenListRow
            key={provider.id}
            href={getLlmProviderRoute(orgSlug, provider.id)}
            dataAttributes={{ "data-testid": "llm-provider-card" }}
            leading={
              <DenBrandMark
                name={provider.name}
                simpleIconSlug={getProviderIconSlug(provider.providerId)}
                serviceUrl={getProviderDocUrl(provider.providerConfig)}
              />
            }
            title={provider.name}
            chips={
              <>
                <DenChip>{plural(provider.models.length, "model")}</DenChip>
                {!provider.hasApiKey ? (
                  <DenChip tone="warning" icon={KeyRound}>
                    Credential missing
                  </DenChip>
                ) : null}
              </>
            }
            meta={`${provider.providerId} · ${accessText} · Updated ${formatProviderTimestamp(provider.updatedAt)}`}
            action={<ChevronRight aria-hidden className="h-4 w-4 text-gray-400" />}
          />
        );
      })}
    </DenList>
  );
}

export function LegacyProvidersSection({ orgId, orgSlug }: { orgId: string; orgSlug: string | null }) {
  const { llmProviders, busy, error, reloadProviders } = useOrgLlmProviders(orgId);
  const legacyProviders = llmProviders.filter((provider) => provider.source !== "openwork" && provider.organizationId === orgId);

  return (
    <section aria-label="Legacy Providers" data-testid="gateway-legacy-providers" className="mt-10 grid gap-4">
      <DenSectionHeader
        title="Legacy Providers"
        description="Bring Your Own Key (Legacy System) providers send the API key directly to users’ desktop applications. Usage tracking and usage limit policies are not available with this feature. If you want usage tracking and usage limits, use the provider section above."
      />
      <div>
        <Link
          href={getNewLlmProviderRoute(orgSlug)}
          data-testid="legacy-provider-create"
          className={buttonVariants({ variant: "secondary" })}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add legacy provider
        </Link>
      </div>
      {busy ? (
        <p role="status" className="text-sm text-gray-500">Loading legacy providers...</p>
      ) : error ? (
        <div className="flex flex-col items-start gap-4">
          <DenNotice tone="error" message={`Could not load legacy providers: ${error}`} />
          <DenButton variant="secondary" onClick={() => void reloadProviders()}>Retry legacy providers</DenButton>
        </div>
      ) : legacyProviders.length > 0 ? (
        <LlmProviderList providers={legacyProviders} orgSlug={orgSlug} />
      ) : null}
    </section>
  );
}

export function LlmProvidersScreen() {
  const { orgId, orgSlug, runReauthableAction } = useOrgDashboard();
  const { llmProviders, busy: providersBusy, error: providersError } = useOrgLlmProviders(orgId);
  const {
    desktopPolicies,
    busy: policiesBusy,
    error: policiesError,
    reloadPolicies,
  } = useOrgDesktopPolicies(orgId);
  const [query, setQuery] = useState("");
  const [accessMode, setAccessMode] = useState<ModelAccessMode>("open");
  const [adminExceptionChecked, setAdminExceptionChecked] = useState(true);
  const [zenAllowed, setZenAllowed] = useState(true);
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessSaved, setAccessSaved] = useState<string | null>(null);

  const accessState = useMemo(() => readModelAccessState(desktopPolicies), [desktopPolicies]);
  const defaultPolicy = accessState.defaultPolicy;

  useEffect(() => {
    setAccessMode(accessState.mode);
    setAdminExceptionChecked(accessState.adminException);
    setZenAllowed(accessState.zenAllowed);
  }, [accessState]);

  const customProviders = useMemo(
    () => llmProviders.filter((provider) => provider.source !== "openwork"),
    [llmProviders],
  );

  const filteredProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return customProviders;
    }

    return customProviders.filter(
      (provider) =>
        provider.name.toLowerCase().includes(normalizedQuery) ||
        provider.providerId.toLowerCase().includes(normalizedQuery) ||
        provider.models.some((model) => model.name.toLowerCase().includes(normalizedQuery)),
    );
  }, [customProviders, query]);

  const modelCount = customProviders.reduce((total, provider) => total + provider.models.length, 0);
  const providerCount = customProviders.length;
  const hasOpenWorkModels = llmProviders.some((provider) => provider.source === "openwork");

  const accessOutcome = accessMode === "managed"
    ? modelCount > 0
      ? `Members see exactly the ${plural(modelCount, "model")} from the ${plural(providerCount, "provider")} below${hasOpenWorkModels ? ", plus OpenWork Models" : ""}.`
      : "Members see no models yet — add a provider below."
    : modelCount > 0
      ? `Members may add their own providers alongside the ${plural(modelCount, "model")} below.`
      : "Members may add their own providers. No org models are defined yet.";
  const accessFormDisabled = policiesBusy || accessSaving || !defaultPolicy;

  const saveModelAccessPolicy = async () => {
    setAccessError(null);
    setAccessSaved(null);
    try {
      setAccessSaving(true);
      await runReauthableAction("save-model-access", async () => {
        await saveModelAccess(accessState, { mode: accessMode, adminException: adminExceptionChecked, zenAllowed });
        await reloadPolicies();
      });
      setAccessSaved("Model access saved.");
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Failed to save model access.");
    } finally {
      setAccessSaving(false);
    }
  };

  return (
    <DashboardPageTemplate
      icon={KeyRound}
      title="Bring your Own Keys"
      description="Connect Anthropic, OpenAI, Azure or any models.dev provider with your own credentials, choose the exact models each one exposes, and grant access to the right people and teams."
      colors={["#F3FFF9", "#0F766E", "#34D399", "#7DD3FC"]}
    >
      <DenCard data-testid="models-access-card" className="mb-8 grid gap-5">
        <DenSectionHeader
          title="Who can use models"
          description="Choose whether members bring their own providers or use only the models managed here."
          action={
            <DenButton
              type="button"
              data-testid="models-access-save"
              onClick={() => void saveModelAccessPolicy()}
              loading={accessSaving}
              disabled={accessFormDisabled}
            >
              Save
            </DenButton>
          }
        />

        {policiesError ? <DenNotice message={policiesError} tone="error" /> : null}
        {accessError ? <DenNotice message={accessError} tone="error" /> : null}
        {accessSaved ? (
          <p className="rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-700">
            {accessSaved}
          </p>
        ) : null}
        {!policiesBusy && !defaultPolicy ? (
          <p className="rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-5 py-4 text-[14px] text-[var(--dls-text-primary)]">
            Default desktop policy not found.
          </p>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          <DenOptionCard
            type="radio"
            name="models-access-mode"
            testId="models-access-open"
            title="Open"
            description="Members may add their own providers."
            checked={accessMode === "open"}
            disabled={accessFormDisabled}
            onChange={() => {
              setAccessMode("open");
              setAccessSaved(null);
              setAccessError(null);
            }}
          />
          <DenOptionCard
            type="radio"
            name="models-access-mode"
            testId="models-access-managed"
            title="Managed"
            description="Members use exactly the models below."
            checked={accessMode === "managed"}
            disabled={accessFormDisabled}
            onChange={() => {
              setAccessMode("managed");
              setAccessSaved(null);
              setAccessError(null);
            }}
          />
        </div>

        {accessMode === "managed" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <DenOptionCard
              type="checkbox"
              testId="models-access-admin-exception"
              title="Admins may add their own providers"
              checked={adminExceptionChecked}
              disabled={accessFormDisabled}
              onChange={(checked) => {
                setAdminExceptionChecked(checked);
                setAccessSaved(null);
                setAccessError(null);
              }}
            />
            <DenOptionCard
              type="checkbox"
              testId="models-access-zen"
              title="Allow OpenCode Zen models"
              checked={zenAllowed}
              disabled={accessFormDisabled}
              onChange={(checked) => {
                setZenAllowed(checked);
                setAccessSaved(null);
                setAccessError(null);
              }}
            />
          </div>
        ) : null}

        <p data-testid="models-access-outcome" className="rounded-[20px] bg-gray-50 px-4 py-3 text-[13px] leading-6 text-gray-600">
          {accessOutcome}
        </p>
      </DenCard>

      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <DenInput
          type="search"
          icon={Search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search providers or models..."
        />

        <Link href={getNewLlmProviderRoute(orgSlug)} className={buttonVariants({ variant: "primary" })}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Provider
        </Link>
      </div>

      {providersError ? <DenNotice message={providersError} tone="error" className="mb-6" /> : null}

      {providersBusy ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading your provider library...
        </div>
      ) : (
      <section className="grid gap-4">
        <DenSectionHeader
          title="Your providers"
          description="One row per credential and the models it exposes."
        />
        {filteredProviders.length === 0 ? (
          <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
            <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
              {customProviders.length === 0 ? "No custom providers configured yet." : "No providers match that search yet."}
            </p>
            <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-8 text-gray-500">
              {customProviders.length === 0
                ? "Pick a models.dev provider, choose the models to expose, add the credential, and grant access."
                : "Try a broader search term, or create a new provider if this org needs a different stack."}
            </p>
          </div>
        ) : (
          <LlmProviderList providers={filteredProviders} orgSlug={orgSlug} />
        )}
      </section>
      )}
    </DashboardPageTemplate>
  );
}
