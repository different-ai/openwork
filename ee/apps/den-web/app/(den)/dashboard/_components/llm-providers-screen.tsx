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
import {
  createDesktopPolicy,
  updateDesktopPolicy,
  useOrgDesktopPolicies,
  type DenDesktopPolicy,
  type DenDesktopPolicyRole,
} from "./desktop-policy-data";
import {
  formatProviderTimestamp,
  getProviderDocUrl,
  getProviderIconSlug,
  useOrgLlmProviders,
} from "./llm-provider-data";

type ModelAccessMode = "open" | "managed";

const ADMIN_EXCEPTION_POLICY_NAME = "Admins may add providers";
const ADMIN_EXCEPTION_ROLES: DenDesktopPolicyRole[] = ["owner", "admin"];

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function getPolicyMemberIds(policy: DenDesktopPolicy) {
  return policy.assignments.flatMap((assignment) => (assignment.orgMemberId ? [assignment.orgMemberId] : []));
}

function getPolicyTeamIds(policy: DenDesktopPolicy) {
  return policy.assignments.flatMap((assignment) => (assignment.teamId ? [assignment.teamId] : []));
}

function getPolicyRoles(policy: DenDesktopPolicy) {
  return policy.roles.length > 0
    ? policy.roles
    : policy.assignments.flatMap((assignment) => (assignment.role ? [assignment.role] : []));
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

  const defaultPolicy = useMemo(
    () => desktopPolicies.find((policy) => policy.isDefault) ?? null,
    [desktopPolicies],
  );

  const adminExceptionPolicies = useMemo(
    () => desktopPolicies.filter((policy) => !policy.isDefault && policy.policyName === ADMIN_EXCEPTION_POLICY_NAME),
    [desktopPolicies],
  );

  useEffect(() => {
    const defaultAllowsCustomProviders = defaultPolicy?.policy.allowCustomProviders !== false;
    setAccessMode(defaultAllowsCustomProviders ? "open" : "managed");
    setAdminExceptionChecked(defaultAllowsCustomProviders ? true : adminExceptionPolicies.some((policy) => policy.isEnabled));
    setZenAllowed(defaultPolicy?.policy.allowZenModel !== false);
  }, [defaultPolicy, adminExceptionPolicies]);

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

  const updateDefaultPolicy = async (allowCustomProviders: boolean, allowZenModel: boolean) => {
    if (!defaultPolicy) throw new Error("Default desktop policy not found.");
    await updateDesktopPolicy(defaultPolicy.id, {
      policyName: defaultPolicy.policyName,
      policy: {
        ...defaultPolicy.policy,
        allowCustomProviders,
        allowZenModel,
      },
      priority: 0,
      isEnabled: true,
      memberIds: [],
      teamIds: [],
      roles: [],
    });
  };

  const updateAdminExceptionPolicy = async (policy: DenDesktopPolicy, isEnabled: boolean) => {
    await updateDesktopPolicy(policy.id, {
      policyName: ADMIN_EXCEPTION_POLICY_NAME,
      policy: {
        ...policy.policy,
        allowCustomProviders: true,
      },
      priority: policy.priority,
      isEnabled,
      memberIds: [],
      teamIds: [],
      roles: ADMIN_EXCEPTION_ROLES,
    });
  };

  const disablePolicy = async (policy: DenDesktopPolicy) => {
    if (!policy.isEnabled) return;
    await updateDesktopPolicy(policy.id, {
      policyName: policy.policyName,
      policy: policy.policy,
      priority: policy.priority,
      isEnabled: false,
      memberIds: getPolicyMemberIds(policy),
      teamIds: getPolicyTeamIds(policy),
      roles: getPolicyRoles(policy),
    });
  };

  const ensureAdminExceptionPolicy = async () => {
    const primaryPolicy = adminExceptionPolicies[0] ?? null;
    if (primaryPolicy) {
      await updateAdminExceptionPolicy(primaryPolicy, true);
    } else {
      await createDesktopPolicy({
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        policy: { allowCustomProviders: true },
        priority: 0,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    }

    for (const policy of adminExceptionPolicies.slice(1)) {
      await disablePolicy(policy);
    }
  };

  const disableAdminExceptionPolicies = async () => {
    for (const policy of adminExceptionPolicies) {
      await disablePolicy(policy);
    }
  };

  const saveModelAccess = async () => {
    setAccessError(null);
    setAccessSaved(null);
    if (!defaultPolicy) {
      setAccessError("Default desktop policy not found.");
      return;
    }

    try {
      setAccessSaving(true);
      await runReauthableAction("save-model-access", async () => {
        if (accessMode === "managed") {
          await updateDefaultPolicy(false, zenAllowed);
          if (adminExceptionChecked) {
            await ensureAdminExceptionPolicy();
          } else {
            await disableAdminExceptionPolicies();
          }
        } else {
          await updateDefaultPolicy(true, true);
          await disableAdminExceptionPolicies();
        }
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
              onClick={() => void saveModelAccess()}
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
          <p className="rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-4 text-[14px] text-amber-800">
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
          <DenList>
            {filteredProviders.map((provider) => {
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
        )}
      </section>
      )}
    </DashboardPageTemplate>
  );
}
