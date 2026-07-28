"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Cpu, KeyRound, Plus, Search } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBadge } from "../../_components/ui/badge";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
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
  type DenLlmProviderSource,
  formatProviderTimestamp,
  getProviderDocUrl,
  getProviderEnvNames,
  getProviderIconSlug,
  useOrgLlmProviders,
} from "./llm-provider-data";

type ModelAccessMode = "open" | "managed";

type OpenWorkKeyRow = {
  id: string;
  name: string;
  email: string;
  createdAt: string | null;
};

const ADMIN_EXCEPTION_POLICY_NAME = "Admins may add providers";
const ADMIN_EXCEPTION_ROLES: DenDesktopPolicyRole[] = ["owner", "admin"];

function getProviderSourceLabel(source: DenLlmProviderSource) {
  if (source === "openwork") return "OpenWork";
  return source === "custom" ? "Custom" : "Catalog";
}

const openWorkKeyColumns: readonly DenTableColumn<OpenWorkKeyRow>[] = [
  {
    key: "member",
    header: "Member",
    render: (row) => (
      <>
        <p className="text-[14px] font-medium text-gray-950">{row.name}</p>
        <p className="text-[12px] text-gray-500">{row.email}</p>
      </>
    ),
  },
  {
    key: "created",
    header: "Created",
    render: (row) => <span className="text-[13px] text-gray-600">{formatProviderTimestamp(row.createdAt)}</span>,
  },
];

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

  const openWorkProviders = useMemo(
    () => llmProviders.filter((provider) => provider.source === "openwork"),
    [llmProviders],
  );

  const customProviders = useMemo(
    () => llmProviders.filter((provider) => provider.source !== "openwork"),
    [llmProviders],
  );

  const filteredProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return customProviders;
    }

    return customProviders.filter((provider) => {
      const env = getProviderEnvNames(provider.providerConfig).join(" ").toLowerCase();
      const doc = (getProviderDocUrl(provider.providerConfig) ?? "").toLowerCase();
      return (
        provider.name.toLowerCase().includes(normalizedQuery) ||
        provider.providerId.toLowerCase().includes(normalizedQuery) ||
        provider.models.some((model) => model.name.toLowerCase().includes(normalizedQuery)) ||
        env.includes(normalizedQuery) ||
        doc.includes(normalizedQuery)
      );
    });
  }, [customProviders, query]);

  const openWorkKeyRows = useMemo(() => {
    const rows = openWorkProviders.flatMap((provider) =>
      provider.access.members.map((member) => ({
        id: `${provider.id}:${member.id}`,
        name: member.user.name || member.user.email,
        email: member.user.email,
        createdAt: member.createdAt ?? provider.createdAt,
      })),
    );
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [openWorkProviders]);

  const modelNames = useMemo(() => {
    const names = llmProviders.flatMap((provider) =>
      provider.models.flatMap((model) => {
        const name = model.name.trim();
        return name ? [name] : [];
      }),
    );
    return [...new Set(names)];
  }, [llmProviders]);

  const managedOutcome = modelNames.length > 0
    ? `Members see exactly: ${modelNames.join(", ")}`
    : "Members see no models yet — add a provider below";
  const openOutcome = modelNames.length > 0
    ? `Members may add their own providers; org models below include: ${modelNames.join(", ")}`
    : "Members may add their own providers. No org models are defined yet.";
  const accessOutcome = accessMode === "managed" ? managedOutcome : openOutcome;
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
      badgeLabel="New"
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
          placeholder="Search providers, models, or env keys..."
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
      <div className="grid gap-8">
        {openWorkKeyRows.length > 0 ? (
          <section className="overflow-hidden rounded-[28px] border border-gray-200 bg-white">
            <DenSectionHeader
              className="border-b border-gray-100 px-6 py-4"
              title="OpenWork Model Keys"
              description="Members in this organization with an OpenWork Models key."
            />
            <DenTable columns={openWorkKeyColumns} rows={openWorkKeyRows} getRowKey={(row) => row.id} />
          </section>
        ) : null}

        <section className="grid gap-4">
          <DenSectionHeader
            title="Your providers"
            description="Each card is one set of credentials and the models it exposes."
          />
          {filteredProviders.length === 0 ? (
            <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
              <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
                {customProviders.length === 0 ? "No custom providers configured yet." : "No providers match that search yet."}
              </p>
              <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-8 text-gray-500">
                {customProviders.length === 0
                  ? "Start with a models.dev provider, select the models you want to expose, add the credential, and then grant access to the right people or teams."
                  : "Try a broader search term, or create a new provider if this org needs a different stack."}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {filteredProviders.map((provider) => {
            const envNames = getProviderEnvNames(provider.providerConfig);
            const memberAccessCount = provider.access.members.length;
            const teamAccessCount = provider.access.teams.length;
            return (
              <Link
                key={provider.id}
                href={getLlmProviderRoute(orgSlug, provider.id)}
                data-testid="llm-provider-card"
                className="block overflow-hidden rounded-[28px] border border-gray-200 bg-white p-6 transition-colors hover:border-gray-300"
              >
                <div className="flex items-start gap-3">
                  <DenBrandMark
                    name={provider.name}
                    simpleIconSlug={getProviderIconSlug(provider.providerId)}
                    serviceUrl={getProviderDocUrl(provider.providerConfig)}
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[16px] font-medium tracking-[-0.02em] text-gray-950">{provider.name}</h3>
                    <p className="mt-0.5 truncate text-[13px] text-gray-500">
                      {provider.providerId} · {getProviderSourceLabel(provider.source)}
                    </p>
                  </div>
                  <DenBadge>
                    {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                  </DenBadge>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <DenBadge tone={provider.hasApiKey ? "success" : "warning"} icon={KeyRound}>
                    {provider.hasApiKey ? "Credential saved" : "Credential missing"}
                  </DenBadge>
                  {envNames.slice(0, 2).map((envName) => (
                    <DenBadge key={envName}>{envName}</DenBadge>
                  ))}
                  {envNames.length > 2 ? <DenBadge>+{envNames.length - 2} more keys</DenBadge> : null}
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-gray-100 pt-4 text-[13px] text-gray-500">
                  <span>{memberAccessCount} people · {teamAccessCount} teams</span>
                  <span aria-hidden>·</span>
                  <span>{formatProviderTimestamp(provider.updatedAt)}</span>
                </div>
              </Link>
            );
          })}
            </div>
          )}
        </section>
      </div>
      )}
    </DashboardPageTemplate>
  );
}
