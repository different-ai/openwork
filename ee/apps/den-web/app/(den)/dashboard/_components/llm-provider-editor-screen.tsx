"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
    buildCustomProviderTemplate,
    buildEditableCustomProviderText,
    getProviderApiBase,
    getProviderDocUrl,
    getProviderEnvNames,
    getProviderNpmPackage,
    requestLlmProviderCatalog,
    requestLlmProviderCatalogDetail,
    useOrgLlmProviders,
    type DenLlmProvider,
    type DenLlmProviderCredentialKind,
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
    const [credentialKind, setCredentialKind] =
        useState<DenLlmProviderCredentialKind>("api_key");
    const [apiKey, setApiKey] = useState("");
    const [opencodeAuth, setOpencodeAuth] = useState("");
    const [openAiOauthBusy, setOpenAiOauthBusy] = useState(false);
    const [openAiOauthError, setOpenAiOauthError] = useState<string | null>(null);
    const [openAiOauthSession, setOpenAiOauthSession] = useState<{
        verificationUrl: string;
        userCode: string;
        deviceAuthId: string;
        intervalMs: number;
    } | null>(null);
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
            setCredentialKind(provider.credentialKind);
            setApiKey("");
            setOpencodeAuth("");
            setOpenAiOauthError(null);
            setOpenAiOauthSession(null);
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
        setCredentialKind("api_key");
        setApiKey("");
        setOpencodeAuth("");
        setOpenAiOauthError(null);
        setOpenAiOauthSession(null);
    }, [orgContext?.currentMember.id, provider]);

    useEffect(() => {
        setOpenAiOauthError(null);
        setOpenAiOauthSession(null);
    }, [credentialKind, selectedProviderId, source]);

    const canUseOpenCodeOAuth =
        source === "models_dev" && selectedProviderId.trim().toLowerCase() === "openai";

    useEffect(() => {
        if (credentialKind === "opencode_oauth" && !canUseOpenCodeOAuth) {
            setCredentialKind("api_key");
        }
    }, [canUseOpenCodeOAuth, credentialKind]);

    async function startOpenAiOauth() {
        setOpenAiOauthBusy(true);
        setOpenAiOauthError(null);
        try {
            const { response, payload } = await requestJson(
                "/v1/llm-providers/openai-oauth/start",
                { method: "POST", body: JSON.stringify({}) },
                20000,
            );
            if (!response.ok) {
                throw new Error(getErrorMessage(payload, `Failed to start OpenAI OAuth (${response.status}).`));
            }
            if (!payload || typeof payload !== "object") {
                throw new Error("OpenAI OAuth response was empty.");
            }
            const data = payload as Record<string, unknown>;
            if (
                typeof data.verificationUrl !== "string" ||
                typeof data.userCode !== "string" ||
                typeof data.deviceAuthId !== "string" ||
                typeof data.intervalMs !== "number"
            ) {
                throw new Error("OpenAI OAuth response was incomplete.");
            }
            setOpenAiOauthSession({
                verificationUrl: data.verificationUrl,
                userCode: data.userCode,
                deviceAuthId: data.deviceAuthId,
                intervalMs: data.intervalMs,
            });
            window.open(data.verificationUrl, "_blank", "noopener,noreferrer");
        } catch (error) {
            setOpenAiOauthError(error instanceof Error ? error.message : "Could not start OpenAI OAuth.");
        } finally {
            setOpenAiOauthBusy(false);
        }
    }

    async function completeOpenAiOauth() {
        if (!openAiOauthSession) {
            setOpenAiOauthError("Start OpenAI OAuth first.");
            return;
        }
        setOpenAiOauthBusy(true);
        setOpenAiOauthError(null);
        try {
            const { response, payload } = await requestJson(
                "/v1/llm-providers/openai-oauth/complete",
                {
                    method: "POST",
                    body: JSON.stringify({
                        deviceAuthId: openAiOauthSession.deviceAuthId,
                        userCode: openAiOauthSession.userCode,
                    }),
                },
                20000,
            );
            if (!response.ok) {
                throw new Error(getErrorMessage(payload, response.status === 409 ? "OpenAI authorization is not complete yet." : `Failed to complete OpenAI OAuth (${response.status}).`));
            }
            if (!payload || typeof payload !== "object" || typeof (payload as Record<string, unknown>).opencodeAuth !== "string") {
                throw new Error("OpenAI OAuth completion response was incomplete.");
            }
            setOpencodeAuth((payload as { opencodeAuth: string }).opencodeAuth);
            setOpenAiOauthSession(null);
        } catch (error) {
            setOpenAiOauthError(error instanceof Error ? error.message : "Could not complete OpenAI OAuth.");
        } finally {
            setOpenAiOauthBusy(false);
        }
    }

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

        if (credentialKind === "opencode_oauth" && !canUseOpenCodeOAuth) {
            setSaveError("OpenCode OAuth credentials are only available for the OpenAI catalog provider.");
            return;
        }

        if (source === "custom" && !customConfigText.trim()) {
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
                credentialKind,
                memberIds: [...new Set(selectedMemberIds)],
                teamIds: [...new Set(selectedTeamIds)],
            };

            if (source === "models_dev") {
                body.providerId = selectedProviderId;
                body.modelIds = selectedModelIds;
            } else {
                body.customConfigText = customConfigText;
            }

            if (credentialKind === "api_key" && (apiKey.trim() || !provider || provider.credentialKind !== "api_key")) {
                body.apiKey = apiKey.trim();
            }

            if (credentialKind === "opencode_oauth" && (opencodeAuth.trim() || !provider || provider.credentialKind !== "opencode_oauth")) {
                body.opencodeAuth = opencodeAuth.trim();
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
                            Pick a provider or paste a custom config, then
                            decide which models to allow and which teammates can
                            use it.
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
                    {provider?.hasCredential ? (
                        <span className="rounded-full bg-emerald-50 px-4 py-2 text-[13px] font-medium text-emerald-700">
                            Existing credential saved
                        </span>
                    ) : null}
                </div>

                <div className="mb-6 grid gap-3 md:grid-cols-2">
                    <DenSelectableRow
                        selected={credentialKind === "api_key"}
                        title="API key"
                        description="Store a provider API key and import it into teammates' workspaces."
                        onClick={() => setCredentialKind("api_key")}
                    />
                    <DenSelectableRow
                        selected={credentialKind === "opencode_oauth"}
                        title="OpenCode OAuth"
                        description={canUseOpenCodeOAuth
                            ? "Store the native OpenCode OAuth auth JSON for the OpenAI provider."
                            : "Only available for the OpenAI catalog provider."}
                        disabled={!canUseOpenCodeOAuth}
                        onClick={() => {
                            if (canUseOpenCodeOAuth) setCredentialKind("opencode_oauth");
                        }}
                    />
                </div>

                {credentialKind === "api_key" ? (
                    <label className="grid gap-3">
                        <span className="text-[14px] font-medium text-gray-700">
                            API key / credential
                        </span>
                        <DenInput
                            type="password"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={
                                provider?.credentialKind === "api_key" && provider.hasApiKey
                                    ? "Leave blank to keep current credential"
                                    : "Paste the provider credential"
                            }
                        />
                    </label>
                ) : (
                    <div className="grid gap-4">
                        <div className="rounded-[24px] border border-blue-100 bg-blue-50 p-5">
                            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                <div>
                                    <p className="text-[14px] font-semibold text-blue-950">Connect OpenAI with OpenCode OAuth</p>
                                    <p className="mt-2 text-[13px] leading-6 text-blue-800">
                                        This uses the same ChatGPT Pro/Plus device flow as OpenCode, then stores the resulting OAuth auth JSON encrypted in Den.
                                    </p>
                                </div>
                                <DenButton
                                    variant="secondary"
                                    loading={openAiOauthBusy && !openAiOauthSession}
                                    onClick={() => void startOpenAiOauth()}
                                >
                                    Connect OpenAI
                                </DenButton>
                            </div>

                            {openAiOauthSession ? (
                                <div className="mt-5 rounded-[18px] bg-white p-4 ring-1 ring-inset ring-blue-100">
                                    <p className="text-[13px] font-medium text-gray-800">Enter this code on OpenAI:</p>
                                    <div className="mt-3 inline-flex rounded-xl bg-gray-950 px-4 py-2 font-mono text-[22px] font-semibold tracking-[0.18em] text-white">
                                        {openAiOauthSession.userCode}
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-3">
                                        <a
                                            href={openAiOauthSession.verificationUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-[13px] font-medium text-gray-700 ring-1 ring-inset ring-gray-200 transition hover:bg-gray-50"
                                        >
                                            Open OpenAI page
                                        </a>
                                        <DenButton
                                            loading={openAiOauthBusy}
                                            onClick={() => void completeOpenAiOauth()}
                                        >
                                            I finished authorization
                                        </DenButton>
                                    </div>
                                </div>
                            ) : null}

                            {openAiOauthError ? (
                                <p className="mt-4 text-[13px] leading-6 text-red-700">{openAiOauthError}</p>
                            ) : null}
                        </div>

                        <label className="grid gap-3">
                            <span className="text-[14px] font-medium text-gray-700">
                                OpenCode OAuth JSON
                            </span>
                            <DenTextarea
                                value={opencodeAuth}
                                onChange={(event) => setOpencodeAuth(event.target.value)}
                                rows={8}
                                placeholder={
                                    provider?.credentialKind === "opencode_oauth" && provider.hasOpencodeAuth
                                        ? "Leave blank to keep current OpenCode OAuth credential"
                                        : '{ "type": "oauth", "access": "...", "refresh": "...", "expires": 0 }'
                                }
                            />
                            <p className="text-[13px] leading-6 text-gray-500">
                                You can connect above or paste the same auth shape OpenCode writes to auth.json for OAuth providers.
                            </p>
                        </label>
                    </div>
                )}
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
