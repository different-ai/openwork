"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowLeft,
    CodeXml,
    Cpu,
    Search,
    User,
    Users,
} from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenSelectableRow } from "../../_components/ui/selectable-row";
import { UnderlineTabs } from "../../_components/ui/tabs";
import { DenTextarea } from "../../_components/ui/textarea";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import {
    getLlmProviderRoute,
    getLlmProvidersRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
    buildGuidedCustomProviderConfig,
    parseGuidedModelIds,
    readGuidedCustomProviderFields,
    readGuidedCustomProviderFieldsFromText,
    slugifyProviderId,
    validateGuidedCustomProvider,
} from "./llm-provider-guided";
import {
    buildCustomProviderTemplate,
    buildEditableCustomProviderText,
    getProviderApiBase,
    requestLlmProviderTestConnection,
    type LlmProviderProbeResult,
    getProviderDocUrl,
    getProviderEnvNames,
    getProviderNpmPackage,
    requestLlmProviderCatalog,
    requestLlmProviderCatalogDetail,
    useOrgLlmProviders,
    type DenLlmProvider,
    type DenModelsDevProviderDetail,
    type DenModelsDevProviderSummary,
} from "./llm-provider-data";

const SOURCE_TABS = [
    { value: "models_dev" as const, label: "Catalog provider", icon: Cpu },
    { value: "custom" as const, label: "Custom provider", icon: CodeXml },
];

type EditableLlmProviderSource = (typeof SOURCE_TABS)[number]["value"];

function getLockMemberId(
    provider: DenLlmProvider | null,
    currentMemberId: string | null,
) {
    return provider?.createdByOrgMembershipId ?? currentMemberId;
}

export function LlmProviderEditorScreen({
    llmProviderId,
}: {
    llmProviderId?: string;
}) {
    const router = useRouter();
    const { orgId, orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
    const { llmProviders, busy, error, reloadProviders } =
        useOrgLlmProviders(orgId);
    const provider = useMemo(
        () =>
            llmProviderId
                ? (llmProviders.find((entry) => entry.id === llmProviderId) ??
                  null)
                : null,
        [llmProviderId, llmProviders],
    );
    const [source, setSource] = useState<EditableLlmProviderSource>("models_dev");
    const [accessTab, setAccessTab] = useState<"teams" | "people">("teams");
    const [accessQuery, setAccessQuery] = useState("");
    const [catalogProviders, setCatalogProviders] = useState<
        DenModelsDevProviderSummary[]
    >([]);
    const [catalogBusy, setCatalogBusy] = useState(false);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const [selectedProviderId, setSelectedProviderId] = useState("");
    const [catalogDetail, setCatalogDetail] =
        useState<DenModelsDevProviderDetail | null>(null);
    const [detailBusy, setDetailBusy] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [providerName, setProviderName] = useState("");
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
    const [modelQuery, setModelQuery] = useState("");
    const [customConfigText, setCustomConfigText] = useState(
        buildCustomProviderTemplate(),
    );
    const [customMode, setCustomMode] = useState<"form" | "json">("form");
    const [customProviderId, setCustomProviderId] = useState("");
    const [customProviderIdTouched, setCustomProviderIdTouched] = useState(false);
    const [customBaseUrl, setCustomBaseUrl] = useState("");
    const [customModelsText, setCustomModelsText] = useState("");
    const [customEnvName, setCustomEnvName] = useState<string | null>(null);
    const [customJsonHint, setCustomJsonHint] = useState<string | null>(null);
    const [probeState, setProbeState] = useState<"idle" | "probing" | "ok" | "failed">("idle");
    const [probeResult, setProbeResult] = useState<LlmProviderProbeResult | null>(null);
    const [selectedCustomModelIds, setSelectedCustomModelIds] = useState<string[]>([]);
    const [customModelQuery, setCustomModelQuery] = useState("");
    const [customManualModels, setCustomManualModels] = useState(false);
    const lastProbeKeyRef = useRef("");
    const [apiKey, setApiKey] = useState("");
    const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
    const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
    const [saveBusy, setSaveBusy] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        if (!orgId) {
            setCatalogProviders([]);
            return;
        }

        let canceled = false;
        setCatalogBusy(true);
        setCatalogError(null);
        void requestLlmProviderCatalog(orgId)
            .then((providers) => {
                if (!canceled) {
                    setCatalogProviders(providers);
                }
            })
            .catch((loadError) => {
                if (!canceled) {
                    setCatalogError(
                        loadError instanceof Error
                            ? loadError.message
                            : "Failed to load the provider catalog.",
                    );
                }
            })
            .finally(() => {
                if (!canceled) {
                    setCatalogBusy(false);
                }
            });

        return () => {
            canceled = true;
        };
    }, [orgId]);

    useEffect(() => {
        if (provider) {
            setSource(provider.source === "custom" ? "custom" : "models_dev");
            setSelectedProviderId(provider.providerId);
            setProviderName(provider.name);
            setSelectedModelIds(provider.models.map((entry) => entry.id));
            setSelectedMemberIds(
                provider.access.members.map((entry) => entry.orgMembershipId),
            );
            setSelectedTeamIds(
                provider.access.teams.map((entry) => entry.teamId),
            );
            setCustomConfigText(
                provider.source === "custom"
                    ? buildEditableCustomProviderText(provider)
                    : buildCustomProviderTemplate(),
            );
            if (provider.source === "custom") {
                // Reopen simple configs in the guided form; anything richer
                // (per-model metadata, custom npm, provider options) opens in
                // the JSON editor so no data is dropped.
                const guided = readGuidedCustomProviderFields({
                    ...provider.providerConfig,
                    models: provider.models.map((entry) => entry.config),
                });
                if (guided) {
                    setCustomMode("form");
                    setCustomProviderId(guided.providerId);
                    setCustomProviderIdTouched(true);
                    setCustomBaseUrl(guided.baseUrl);
                    setCustomModelsText(guided.modelIds.join("\n"));
                    setCustomEnvName(guided.envName);
                } else {
                    setCustomMode("json");
                }
            }
            setCustomJsonHint(null);
            setApiKey("");
            return;
        }

        setSource("models_dev");
        setSelectedProviderId("");
        setProviderName("");
        setSelectedModelIds([]);
        setSelectedMemberIds(
            orgContext?.currentMember.id ? [orgContext.currentMember.id] : [],
        );
        setSelectedTeamIds([]);
        setCustomConfigText(buildCustomProviderTemplate());
        setCustomMode("form");
        setCustomProviderId("");
        setCustomProviderIdTouched(false);
        setCustomBaseUrl("");
        setCustomModelsText("");
        setCustomEnvName(null);
        setCustomJsonHint(null);
        setApiKey("");
    }, [orgContext?.currentMember.id, provider]);

    useEffect(() => {
        if (source !== "models_dev" || !orgId || !selectedProviderId) {
            setCatalogDetail(null);
            setDetailError(null);
            setDetailBusy(false);
            return;
        }

        let canceled = false;
        setDetailBusy(true);
        setDetailError(null);
        void requestLlmProviderCatalogDetail(orgId, selectedProviderId)
            .then((detail) => {
                if (!canceled) {
                    setCatalogDetail(detail);
                    setSelectedModelIds((current) =>
                        current.filter((entry) =>
                            detail.models.some((model) => model.id === entry),
                        ),
                    );
                }
            })
            .catch((loadError) => {
                if (!canceled) {
                    setCatalogDetail(null);
                    setDetailError(
                        loadError instanceof Error
                            ? loadError.message
                            : "Failed to load provider details.",
                    );
                }
            })
            .finally(() => {
                if (!canceled) {
                    setDetailBusy(false);
                }
            });

        return () => {
            canceled = true;
        };
    }, [orgId, selectedProviderId, source]);

    const currentMemberId = orgContext?.currentMember.id ?? null;
    const lockedMemberId = getLockMemberId(provider, currentMemberId);

    const filteredModels = useMemo(() => {
        const models = catalogDetail?.models ?? [];
        const normalizedQuery = modelQuery.trim().toLowerCase();
        if (!normalizedQuery) {
            return models;
        }

        return models.filter(
            (model) =>
                model.name.toLowerCase().includes(normalizedQuery) ||
                model.id.toLowerCase().includes(normalizedQuery),
        );
    }, [catalogDetail?.models, modelQuery]);

    const filteredTeams = useMemo(() => {
        const teams = orgContext?.teams ?? [];
        const normalizedQuery = accessQuery.trim().toLowerCase();
        if (!normalizedQuery) {
            return teams;
        }

        return teams.filter((team) =>
            team.name.toLowerCase().includes(normalizedQuery),
        );
    }, [accessQuery, orgContext?.teams]);

    const filteredMembers = useMemo(() => {
        const members = orgContext?.members ?? [];
        const normalizedQuery = accessQuery.trim().toLowerCase();
        if (!normalizedQuery) {
            return members;
        }

        return members.filter(
            (member) =>
                member.user.name.toLowerCase().includes(normalizedQuery) ||
                member.user.email.toLowerCase().includes(normalizedQuery),
        );
    }, [accessQuery, orgContext?.members]);

    const catalogProviderOptions = useMemo(
        () =>
            catalogProviders.map((catalogProvider) => ({
                value: catalogProvider.id,
                label: catalogProvider.name,
                description: catalogProvider.id,
                meta: `${catalogProvider.modelCount} ${catalogProvider.modelCount === 1 ? "model" : "models"}`,
            })),
        [catalogProviders],
    );

    const resolvedCustomProviderId = customProviderIdTouched
        ? customProviderId.trim()
        : slugifyProviderId(providerName);

    // Models used for save/validation: picked from the probed endpoint list
    // when available, or parsed from the manual text fallback.
    const resolvedCustomModelIds =
        probeState === "ok" && !customManualModels
            ? selectedCustomModelIds
            : parseGuidedModelIds(customModelsText);

    // Probe the endpoint as soon as base URL + key are present (debounced):
    // heals common URL mistakes and loads the models the endpoint actually
    // serves, so users pick deployments instead of guessing ids.
    useEffect(() => {
        if (source !== "custom" || customMode !== "form") return;
        const api = customBaseUrl.trim();
        const key = apiKey.trim();
        if (!api || !key) {
            setProbeState("idle");
            setProbeResult(null);
            return;
        }
        const probeKey = `${api}::${key}`;
        if (lastProbeKeyRef.current === probeKey) return;
        const timer = window.setTimeout(() => {
            lastProbeKeyRef.current = probeKey;
            setProbeState("probing");
            requestLlmProviderTestConnection({ api, apiKey: key })
                .then((result) => {
                    if (lastProbeKeyRef.current !== probeKey) return;
                    setProbeResult(result);
                    setProbeState(result.ok ? "ok" : "failed");
                    if (result.ok) {
                        if (result.normalizedApi && result.normalizedApi !== api) {
                            // Pre-mark the healed URL as probed so updating the
                            // field does not schedule a redundant probe.
                            lastProbeKeyRef.current = `${result.normalizedApi}::${key}`;
                            setCustomBaseUrl(result.normalizedApi);
                        }
                        // Keep previously chosen/stored ids selected when they
                        // still exist on the endpoint.
                        setSelectedCustomModelIds((current) => {
                            const base = current.length
                                ? current
                                : parseGuidedModelIds(customModelsText);
                            return base.filter((id) =>
                                result.models.some((model) => model.id === id),
                            );
                        });
                    }
                })
                .catch(() => {
                    if (lastProbeKeyRef.current !== probeKey) return;
                    setProbeResult(null);
                    setProbeState("failed");
                });
        }, 700);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- probe on endpoint/key edits only
    }, [source, customMode, customBaseUrl, apiKey]);

    const filteredProbeModels = useMemo(() => {
        const models = probeResult?.models ?? [];
        const query = customModelQuery.trim().toLowerCase();
        if (!query) return models;
        return models.filter((model) => model.id.toLowerCase().includes(query));
    }, [customModelQuery, probeResult?.models]);

    function switchCustomModeToJson() {
        const modelIds = resolvedCustomModelIds;
        if (!validateGuidedCustomProvider({
            providerId: resolvedCustomProviderId,
            baseUrl: customBaseUrl,
            modelIds,
        })) {
            setCustomConfigText(
                JSON.stringify(
                    buildGuidedCustomProviderConfig({
                        providerId: resolvedCustomProviderId,
                        name: providerName,
                        baseUrl: customBaseUrl,
                        modelIds,
                        envName: customEnvName,
                    }),
                    null,
                    2,
                ),
            );
        }
        setCustomJsonHint(null);
        setCustomMode("json");
    }

    function switchCustomModeToForm() {
        const guided = readGuidedCustomProviderFieldsFromText(customConfigText);
        if (!guided) {
            setCustomJsonHint(
                "This config uses advanced fields the form cannot represent — keep editing it as JSON.",
            );
            return;
        }
        setCustomProviderId(guided.providerId);
        setCustomProviderIdTouched(true);
        setCustomBaseUrl(guided.baseUrl);
        setCustomModelsText(guided.modelIds.join("\n"));
        setCustomEnvName(guided.envName);
        setCustomJsonHint(null);
        setCustomMode("form");
    }

    async function saveProvider() {
        if (!orgId) {
            setSaveError("Organization not found.");
            return;
        }

        if (provider?.source === "openwork") {
            setSaveError("OpenWork-managed providers are controlled from Inference settings.");
            return;
        }

        if (!providerName.trim()) {
            setSaveError("Give this provider a name.");
            return;
        }

        if (source === "models_dev") {
            if (!selectedProviderId) {
                setSaveError("Select a provider.");
                return;
            }
            if (!selectedModelIds.length) {
                setSaveError("Select at least one model.");
                return;
            }
        }

        if (source === "custom" && customMode === "form") {
            const validationError = validateGuidedCustomProvider({
                providerId: resolvedCustomProviderId,
                baseUrl: customBaseUrl,
                modelIds: resolvedCustomModelIds,
            });
            if (validationError) {
                setSaveError(validationError);
                return;
            }
        }

        if (source === "custom" && customMode === "json" && !customConfigText.trim()) {
            setSaveError("Paste a custom provider config.");
            return;
        }

        setSaveError(null);
        try {
            await runReauthableAction("save-llm-provider", async () => {
            setSaveBusy(true);
            const body: Record<string, unknown> = {
                name: providerName.trim(),
                source,
                memberIds: [...new Set(selectedMemberIds)],
                teamIds: [...new Set(selectedTeamIds)],
            };

            if (source === "models_dev") {
                body.providerId = selectedProviderId;
                body.modelIds = selectedModelIds;
            } else if (customMode === "form") {
                body.customConfig = buildGuidedCustomProviderConfig({
                    providerId: resolvedCustomProviderId,
                    name: providerName,
                    baseUrl: customBaseUrl,
                    modelIds: resolvedCustomModelIds,
                    envName: customEnvName,
                });
            } else {
                body.customConfigText = customConfigText;
            }

            if (apiKey.trim() || !provider) {
                body.apiKey = apiKey.trim();
            }

            const path = provider
                ? `/v1/llm-providers/${encodeURIComponent(provider.id)}`
                : `/v1/llm-providers`;
            const method = provider ? "PATCH" : "POST";

            const { response, payload } = await requestJson(
                path,
                {
                    method,
                    body: JSON.stringify(body),
                },
                20000,
            );

            if (!response.ok) {
                throw getRequestError(payload, response, `Failed to save provider (${response.status}).`);
            }

            const nextProvider =
                payload &&
                typeof payload === "object" &&
                payload &&
                "llmProvider" in payload &&
                payload.llmProvider &&
                typeof payload.llmProvider === "object"
                    ? (payload.llmProvider as { id?: unknown })
                    : null;
            const nextProviderId =
                typeof nextProvider?.id === "string"
                    ? nextProvider.id
                    : (provider?.id ?? null);
            if (!nextProviderId) {
                throw new Error(
                    "The provider was saved, but no provider id was returned.",
                );
            }

            await reloadProviders();
            router.push(getLlmProviderRoute(orgSlug, nextProviderId));
            router.refresh();
            });
        } catch (nextError) {
            setSaveError(
                nextError instanceof Error
                    ? nextError.message
                    : "Could not save the provider.",
            );
        } finally {
            setSaveBusy(false);
        }
    }

    if (busy && llmProviderId && !provider) {
        return (
            <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
                <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
                    Loading provider details...
                </div>
            </div>
        );
    }

    if (llmProviderId && !provider) {
        return (
            <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
                <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
                    {error ?? "That provider could not be found."}
                </div>
            </div>
        );
    }

    const providerDoc = catalogDetail
        ? getProviderDocUrl(catalogDetail.config)
        : null;
    const providerNpm = catalogDetail
        ? getProviderNpmPackage(catalogDetail.config)
        : null;
    const providerApiBase = catalogDetail
        ? getProviderApiBase(catalogDetail.config)
        : null;
    const providerEnv = catalogDetail
        ? getProviderEnvNames(catalogDetail.config)
        : [];

    return (
        <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
            <div className="mb-8 flex flex-col gap-3">
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                    {provider ? "Edit provider" : "Add provider"}
                </p>
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                        <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">
                            {provider
                                ? (providerName.trim() || provider.name)
                                : "Add a new LLM provider"}
                        </h1>
                        <p className="mt-3 max-w-[720px] text-[16px] leading-8 text-gray-500">
                            Pick a provider from the catalog or describe a
                            custom endpoint, then decide which models to allow
                            and which teammates can use it.
                        </p>
                    </div>
                </div>
            </div>

            <div className="mb-8 flex items-center justify-between gap-4">
                <Link
                    href={
                        provider
                            ? getLlmProviderRoute(orgSlug, provider.id)
                            : getLlmProvidersRoute(orgSlug)
                    }
                    className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
                >
                    <ArrowLeft className="h-5 w-5" />
                    Back
                </Link>

                <DenButton
                    loading={saveBusy}
                    onClick={() => void saveProvider()}
                >
                    {provider ? "Save Provider" : "Create Provider"}
                </DenButton>
            </div>

            {saveError ? (
                <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
                    {saveError}
                </div>
            ) : null}

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <label className="grid gap-3">
                    <span className="text-[14px] font-medium text-gray-700">
                        Name
                    </span>
                    <DenInput
                        value={providerName}
                        onChange={(event) => setProviderName(event.target.value)}
                        placeholder="Give this key a name"
                        autoComplete="off"
                    />
                </label>
                <p className="mt-3 text-[13px] text-gray-500">
                    Pick a clear label so teammates know which key or provider
                    setup they are using.
                </p>
            </section>

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <h2 className="mb-6 text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                    Provider type
                </h2>
                <UnderlineTabs
                    tabs={SOURCE_TABS}
                    activeTab={source}
                    onChange={setSource}
                />

                {source === "models_dev" ? (
                    <div className="mt-8 grid gap-6">
                        <div className="grid gap-3">
                            <span className="text-[14px] font-medium text-gray-700">
                                Provider
                            </span>
                            <DenCombobox
                                value={selectedProviderId}
                                options={catalogProviderOptions}
                                onChange={setSelectedProviderId}
                                ariaLabel="Provider"
                                placeholder="Select a provider..."
                                searchPlaceholder="Search providers..."
                                emptyLabel="No providers match"
                            />
                        </div>

                        {catalogBusy ? (
                            <p className="text-[14px] text-gray-500">
                                Loading provider catalog...
                            </p>
                        ) : null}
                        {catalogError ? (
                            <p className="text-[14px] text-red-600">
                                {catalogError}
                            </p>
                        ) : null}

                        {detailBusy ? (
                            <p className="text-[14px] text-gray-500">
                                Loading provider details...
                            </p>
                        ) : null}
                        {detailError ? (
                            <p className="text-[14px] text-red-600">
                                {detailError}
                            </p>
                        ) : null}

                        {catalogDetail ? (
                            <div className="rounded-[28px] bg-gray-50 p-6">
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div>
                                        <p className="text-[12px] font-semibold uppercase text-gray-400">
                                            NPM package
                                        </p>
                                        <p className="mt-2">
                                            <span className="inline-flex max-w-full rounded-md bg-white px-3 py-1.5 font-mono text-[11px] leading-5 text-gray-700 ring-1 ring-inset ring-gray-200">
                                                {providerNpm ?? "Not set"}
                                            </span>
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-[12px] font-semibold uppercase text-gray-400">
                                            API base
                                        </p>
                                        <p className="mt-2">
                                            <span className="inline-flex max-w-full break-all rounded-md bg-white px-3 py-1.5 font-mono text-[11px] leading-5 text-gray-700 ring-1 ring-inset ring-gray-200">
                                                {providerApiBase ?? "Not set"}
                                            </span>
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-[12px] font-semibold uppercase text-gray-400">
                                            Env keys
                                        </p>
                                        {providerEnv.length > 0 ? (
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {providerEnv.map((envName) => (
                                                    <span
                                                        key={envName}
                                                        className="inline-flex max-w-full break-all rounded-md bg-white px-3 py-1.5 font-mono text-[11px] leading-5 text-gray-700 ring-1 ring-inset ring-gray-200"
                                                    >
                                                        {envName}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="mt-2">
                                                <span className="inline-flex max-w-full rounded-md bg-white px-3 py-1.5 font-mono text-[11px] leading-5 text-gray-700 ring-1 ring-inset ring-gray-200">
                                                    None listed
                                                </span>
                                            </p>
                                        )}
                                    </div>
                                    <div>
                                        <p className="text-[12px] font-semibold uppercase text-gray-400">
                                            Docs
                                        </p>
                                        <p className="mt-2">
                                            <span className="inline-flex max-w-full break-all rounded-md bg-white px-3 py-1.5 font-mono text-[11px] leading-5 text-gray-700 ring-1 ring-inset ring-gray-200">
                                                {providerDoc ?? "Not set"}
                                            </span>
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : customMode === "form" ? (
                    <div className="mt-8 grid gap-6">
                        <p className="text-[15px] text-gray-500">
                            Connect any OpenAI-compatible endpoint — Azure AI
                            Foundry, LiteLLM, vLLM, or an internal gateway — by
                            describing it below. No JSON required.
                        </p>

                        <label className="grid gap-3">
                            <span className="text-[14px] font-medium text-gray-700">
                                Provider ID
                            </span>
                            <DenInput
                                value={resolvedCustomProviderId}
                                onChange={(event) => {
                                    setCustomProviderId(event.target.value);
                                    setCustomProviderIdTouched(true);
                                }}
                                placeholder="azure-foundry"
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </label>
                        <p className="-mt-3 text-[13px] text-gray-500">
                            A short identifier for this provider. Filled in from
                            the name automatically.
                        </p>

                        <label className="grid gap-3">
                            <span className="text-[14px] font-medium text-gray-700">
                                Base URL
                            </span>
                            <DenInput
                                value={customBaseUrl}
                                onChange={(event) =>
                                    setCustomBaseUrl(event.target.value)
                                }
                                placeholder="https://my-resource.openai.azure.com/openai/v1"
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </label>
                        <p className="-mt-3 text-[13px] text-gray-500">
                            The OpenAI-compatible endpoint of the provider
                            (usually ends in{" "}
                            <code className="rounded bg-gray-100 px-1 py-0.5">
                                /v1
                            </code>
                            ).
                        </p>

                        {probeState === "probing" ? (
                            <p className="-mt-2 text-[13px] text-gray-500">
                                Checking the endpoint…
                            </p>
                        ) : null}
                        {probeState === "ok" && probeResult ? (
                            <p className="-mt-2 text-[13px] text-emerald-700">
                                Endpoint reachable — {probeResult.models.length}{" "}
                                {probeResult.models.length === 1 ? "model" : "models"} available.
                            </p>
                        ) : null}
                        {probeState === "failed" ? (
                            <p className="-mt-2 text-[13px] text-red-600">
                                {probeResult?.hint ?? "Could not reach the endpoint with this URL and key."}
                            </p>
                        ) : null}
                        {probeState === "idle" && customBaseUrl.trim() && !apiKey.trim() ? (
                            <p className="-mt-2 text-[13px] text-gray-500">
                                Enter the API key below to load the models this endpoint serves.
                            </p>
                        ) : null}

                        {probeState === "ok" && probeResult && !customManualModels ? (
                            <div className="grid gap-3">
                                <div className="flex flex-wrap items-center gap-3">
                                    <span className="text-[14px] font-medium text-gray-700">
                                        Models
                                    </span>
                                    <span className="rounded-full bg-gray-200 px-3 py-1 text-[12px] font-medium text-gray-700">
                                        {resolvedCustomModelIds.length}{" "}
                                        {resolvedCustomModelIds.length === 1 ? "model selected" : "models selected"}
                                    </span>
                                </div>
                                <DenInput
                                    type="search"
                                    icon={Search}
                                    value={customModelQuery}
                                    onChange={(event) => setCustomModelQuery(event.target.value)}
                                    placeholder="Search models..."
                                />
                                {filteredProbeModels.length ? (
                                    <div className="max-h-72 overflow-y-auto overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                                        {filteredProbeModels.map((model) => {
                                            const selected = selectedCustomModelIds.includes(model.id);
                                            return (
                                                <DenSelectableRow
                                                    key={model.id}
                                                    selected={selected}
                                                    title={model.id}
                                                    description={
                                                        probeResult.vendor === "azure"
                                                            ? "Deployment"
                                                            : "Model"
                                                    }
                                                    onClick={() =>
                                                        setSelectedCustomModelIds((current) =>
                                                            current.includes(model.id)
                                                                ? current.filter((entry) => entry !== model.id)
                                                                : [...current, model.id],
                                                        )
                                                    }
                                                />
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <p className="text-[13px] text-gray-500">
                                        No models match &quot;{customModelQuery}&quot;.
                                    </p>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setCustomManualModels(true)}
                                    className="justify-self-start text-[13px] font-medium text-gray-500 underline underline-offset-2 transition hover:text-gray-900"
                                >
                                    My model isn&apos;t listed — enter IDs manually
                                </button>
                            </div>
                        ) : (
                            <>
                                <label className="grid gap-3">
                                    <span className="text-[14px] font-medium text-gray-700">
                                        Model IDs
                                    </span>
                                    <DenTextarea
                                        value={customModelsText}
                                        onChange={(event) =>
                                            setCustomModelsText(event.target.value)
                                        }
                                        rows={4}
                                        placeholder={"gpt-5.2\nmy-deployment-name"}
                                    />
                                </label>
                                <p className="-mt-3 text-[13px] text-gray-500">
                                    One per line (or comma-separated). Use the model IDs
                                    the endpoint serves — on Azure AI Foundry these are
                                    your deployment names.
                                </p>
                                {probeState === "ok" && probeResult ? (
                                    <button
                                        type="button"
                                        onClick={() => setCustomManualModels(false)}
                                        className="-mt-2 justify-self-start text-[13px] font-medium text-gray-500 underline underline-offset-2 transition hover:text-gray-900"
                                    >
                                        Pick from the endpoint&apos;s model list instead
                                    </button>
                                ) : null}
                            </>
                        )}

                        <button
                            type="button"
                            onClick={switchCustomModeToJson}
                            className="justify-self-start text-[13px] font-medium text-gray-500 underline underline-offset-2 transition hover:text-gray-900"
                        >
                            Advanced: edit as JSON
                        </button>
                    </div>
                ) : (
                    <div className="mt-8 grid gap-3">
                        <span className="text-[14px] font-medium text-gray-700">
                            Custom provider JSON / JSONC
                        </span>
                        <DenTextarea
                            value={customConfigText}
                            onChange={(event) =>
                                setCustomConfigText(event.target.value)
                            }
                            rows={18}
                        />
                        <p className="text-[13px] text-gray-500">
                            Paste a models.dev provider, a single provider block,
                            or a full{" "}
                            <code className="rounded bg-gray-100 px-1 py-0.5">
                                opencode.jsonc
                            </code>
                            . Model maps are imported automatically.
                        </p>
                        {customJsonHint ? (
                            <p className="text-[13px] text-amber-700">
                                {customJsonHint}
                            </p>
                        ) : null}
                        <button
                            type="button"
                            onClick={switchCustomModeToForm}
                            className="justify-self-start text-[13px] font-medium text-gray-500 underline underline-offset-2 transition hover:text-gray-900"
                        >
                            Use the guided form instead
                        </button>
                    </div>
                )}
            </section>

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                            Credential
                        </h2>
                    </div>
                    {provider?.hasApiKey ? (
                        <span className="rounded-full bg-emerald-50 px-4 py-2 text-[13px] font-medium text-emerald-700">
                            Existing credential saved
                        </span>
                    ) : null}
                </div>

                <label className="grid gap-3">
                    <span className="text-[14px] font-medium text-gray-700">
                        API key / credential
                    </span>
                    <DenInput
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={
                            provider?.hasApiKey
                                ? "Leave blank to keep current credential"
                                : "Paste the provider credential"
                        }
                    />
                </label>
            </section>

            {source === "models_dev" ? (
                <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                    <div>
                        <div>
                            <div className="flex flex-wrap items-center gap-3">
                                <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                                    Models
                                </h2>
                                {catalogDetail ? (
                                    <span className="rounded-full bg-gray-200 px-3 py-1 text-[12px] font-medium text-gray-700">
                                        {selectedModelIds.length}{" "}
                                        {selectedModelIds.length === 1
                                            ? "model selected"
                                            : "models selected"}
                                    </span>
                                ) : null}
                            </div>
                            <p className="mt-2 text-[15px] text-gray-500">
                                Pick the exact models this provider should
                                allow.
                            </p>
                        </div>

                        <div className="mt-6">
                            <DenInput
                                type="search"
                                icon={Search}
                                value={modelQuery}
                                onChange={(event) =>
                                    setModelQuery(event.target.value)
                                }
                                placeholder="Search models..."
                            />
                        </div>
                    </div>

                    {catalogDetail ? (
                        filteredModels.length ? (
                            <div className="mt-4">
                                <div className="overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                                    {filteredModels.map((model) => {
                                        const selected =
                                            selectedModelIds.includes(model.id);
                                        return (
                                            <DenSelectableRow
                                                key={model.id}
                                                selected={selected}
                                                title={model.name}
                                                description={model.id}
                                                onClick={() =>
                                                    setSelectedModelIds(
                                                        (current) =>
                                                            current.includes(
                                                                model.id,
                                                            )
                                                                ? current.filter(
                                                                      (entry) =>
                                                                          entry !==
                                                                          model.id,
                                                                  )
                                                                : [
                                                                      ...current,
                                                                      model.id,
                                                                  ],
                                                    )
                                                }
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        ) : (
                            <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                                No models match{" "}
                                <span className="font-medium text-gray-700">
                                    &quot;{modelQuery}&quot;
                                </span>
                                .
                            </div>
                        )
                    ) : (
                        <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                            Select a provider to browse its models.
                        </div>
                    )}
                </section>
            ) : null}

            <section className="rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <div>
                    <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                        Configure access
                    </h2>
                    <p className="mt-2 text-[15px] text-gray-500">
                        Select which teams and people can use this provider.
                    </p>
                </div>

                <div className="mt-8 grid w-80 grid-cols-2 rounded-xl bg-gray-200 p-1 text-[13px] font-medium text-gray-500">
                    <button
                        type="button"
                        onClick={() => {
                            setAccessTab("teams");
                            setAccessQuery("");
                        }}
                        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 transition ${accessTab === "teams" ? "bg-white text-gray-900 shadow-sm" : "hover:text-gray-700"}`}
                    >
                        <Users className="h-4 w-4" />
                        {`Teams (${selectedTeamIds.length})`}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setAccessTab("people");
                            setAccessQuery("");
                        }}
                        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 transition ${accessTab === "people" ? "bg-white text-gray-900 shadow-sm" : "hover:text-gray-700"}`}
                    >
                        <User className="h-4 w-4" />
                        {`People (${selectedMemberIds.length})`}
                    </button>
                </div>

                <div className="mt-6">
                    <DenInput
                        type="search"
                        icon={Search}
                        value={accessQuery}
                        onChange={(event) => setAccessQuery(event.target.value)}
                        placeholder={
                            accessTab === "teams"
                                ? "Search teams..."
                                : "Search people..."
                        }
                    />
                </div>

                {accessTab === "teams" ? (
                    orgContext?.teams.length ? (
                        filteredTeams.length ? (
                            <div className="mt-4 overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                                {filteredTeams.map((team) => {
                                    const selected = selectedTeamIds.includes(team.id);
                                    return (
                                        <DenSelectableRow
                                            key={team.id}
                                            selected={selected}
                                            leading={
                                                <Users className="h-4 w-4 text-gray-400" />
                                            }
                                            title={team.name}
                                            description={`${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}`}
                                            onClick={() =>
                                                setSelectedTeamIds((current) =>
                                                    current.includes(team.id)
                                                        ? current.filter(
                                                              (entry) =>
                                                                  entry !== team.id,
                                                          )
                                                        : [...current, team.id],
                                                )
                                            }
                                        />
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                                No teams match{" "}
                                <span className="font-medium text-gray-700">
                                    &quot;{accessQuery}&quot;
                                </span>
                                .
                            </div>
                        )
                    ) : (
                        <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                            Create teams from the Members page before assigning team
                            access.
                        </div>
                    )
                ) : orgContext?.members.length ? (
                    filteredMembers.length ? (
                        <div className="mt-4 overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                            {filteredMembers.map((member) => {
                                const selected = selectedMemberIds.includes(
                                    member.id,
                                );
                                const locked = lockedMemberId === member.id;
                                return (
                                    <DenSelectableRow
                                        key={member.id}
                                        disabled={locked}
                                        selected={selected}
                                        leading={
                                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0f172a] text-[11px] font-semibold uppercase text-white">
                                                {member.user.name
                                                    .split(" ")
                                                    .map((part) => part[0])
                                                    .join("")
                                                    .slice(0, 2)}
                                            </div>
                                        }
                                        descriptionBelow
                                        title={member.user.name}
                                        description={member.user.email}
                                        aside={
                                            locked ? (
                                                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-500">
                                                    Locked
                                                </span>
                                            ) : undefined
                                        }
                                        onClick={() =>
                                            setSelectedMemberIds((current) =>
                                                current.includes(member.id)
                                                    ? current.filter(
                                                          (entry) =>
                                                              entry !== member.id,
                                                      )
                                                    : [...current, member.id],
                                            )
                                        }
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                            No people match{" "}
                            <span className="font-medium text-gray-700">
                                &quot;{accessQuery}&quot;
                            </span>
                            .
                        </div>
                    )
                ) : (
                    <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                        No people are available to assign yet.
                    </div>
                )}
            </section>
        </div>
    );
}
