"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, KeyRound, Trash2, Users } from "lucide-react";
import { DenButton } from "../../../../_components/ui/button";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import {
    getEditLlmProviderRoute,
    getLlmProvidersRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
    formatProviderTimestamp,
    getProviderApiBase,
    getProviderDocUrl,
    getProviderEnvNames,
    getProviderNpmPackage,
    useOrgLlmProviders,
} from "./llm-provider-data";

function formatCountLabel(count: number, singular: string, plural: string) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function getLimitLabel(config: Record<string, unknown>) {
    const limit =
        typeof config.limit === "object" && config.limit !== null
            ? (config.limit as Record<string, unknown>)
            : null;
    const context = typeof limit?.context === "number" ? limit.context : null;
    return context ? `${context.toLocaleString()} ctx` : null;
}

export function LlmProviderDetailScreen({
    llmProviderId,
}: {
    llmProviderId: string;
}) {
    const router = useRouter();
    const { orgId, orgSlug } = useOrgDashboard();
    const { llmProviders, busy, error, reloadProviders } =
        useOrgLlmProviders(orgId);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const provider = useMemo(
        () => llmProviders.find((entry) => entry.id === llmProviderId) ?? null,
        [llmProviderId, llmProviders],
    );

    async function deleteProvider() {
        if (!orgId || !provider) {
            return;
        }

        if (
            !window.confirm(
                `Delete ${provider.name}? This will remove its saved model list and access rules.`,
            )
        ) {
            return;
        }

        setDeleteBusy(true);
        setDeleteError(null);
        try {
            const { response, payload } = await requestJson(
                `/v1/orgs/${encodeURIComponent(orgId)}/llm-providers/${encodeURIComponent(provider.id)}`,
                { method: "DELETE" },
                12000,
            );

            if (response.status !== 204 && !response.ok) {
                throw new Error(
                    getErrorMessage(
                        payload,
                        `Failed to delete provider (${response.status}).`,
                    ),
                );
            }

            await reloadProviders();
            router.push(getLlmProvidersRoute(orgSlug));
            router.refresh();
        } catch (nextError) {
            setDeleteError(
                nextError instanceof Error
                    ? nextError.message
                    : "Could not delete the provider.",
            );
        } finally {
            setDeleteBusy(false);
        }
    }

    if (busy && !provider) {
        return (
            <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
                <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
                    Loading provider details...
                </div>
            </div>
        );
    }

    if (!provider) {
        return (
            <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
                <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
                    {error ?? "That provider could not be found."}
                </div>
            </div>
        );
    }

    const envNames = getProviderEnvNames(provider.providerConfig);
    const npmPackage = getProviderNpmPackage(provider.providerConfig);
    const apiBase = getProviderApiBase(provider.providerConfig);
    const docUrl = getProviderDocUrl(provider.providerConfig);

    return (
        <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
            <div className="mb-8 flex flex-col gap-3">
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                    LLM provider
                </p>
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                        <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">
                            {provider.name}
                        </h1>
                    </div>
                </div>
            </div>

            <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
                <Link
                    href={getLlmProvidersRoute(orgSlug)}
                    className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
                >
                    <ArrowLeft className="h-5 w-5" />
                    Back to providers
                </Link>

                <div className="flex flex-wrap gap-3">
                    {provider.canManage ? (
                        <>
                            <Link
                                href={getEditLlmProviderRoute(
                                    orgSlug,
                                    provider.id,
                                )}
                            >
                                <DenButton variant="secondary">
                                    Edit Provider
                                </DenButton>
                            </Link>
                            <DenButton
                                variant="destructive"
                                loading={deleteBusy}
                                onClick={() => void deleteProvider()}
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete
                            </DenButton>
                        </>
                    ) : null}
                </div>
            </div>

            {deleteError ? (
                <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
                    {deleteError}
                </div>
            ) : null}

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                            Provider configuration
                        </h2>
                    </div>

                    <div
                        className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium ${provider.hasApiKey ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}
                    >
                        <KeyRound className="h-4 w-4" />
                        {provider.hasApiKey
                            ? "Credential saved"
                            : "Credential missing"}
                    </div>
                </div>

                <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-[24px] bg-gray-50 p-5">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                            Provider id
                        </p>
                        <p className="mt-3 text-[16px] font-medium text-gray-900">
                            {provider.providerId}
                        </p>
                    </div>
                    <div className="rounded-[24px] bg-gray-50 p-5">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                            NPM package
                        </p>
                        <p className="mt-3 text-[16px] font-medium text-gray-900">
                            {npmPackage ?? "Not set"}
                        </p>
                    </div>
                    <div className="rounded-[24px] bg-gray-50 p-5">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                            API base
                        </p>
                        <p className="mt-3 break-all text-[16px] font-medium text-gray-900">
                            {apiBase ?? "Not set"}
                        </p>
                    </div>
                    <div className="rounded-[24px] bg-gray-50 p-5">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                            Updated
                        </p>
                        <p className="mt-3 text-[16px] font-medium text-gray-900">
                            {formatProviderTimestamp(provider.updatedAt)}
                        </p>
                    </div>
                </div>

                <div className="mt-6 flex flex-wrap gap-2">
                    {envNames.map((envName) => (
                        <span
                            key={envName}
                            className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600"
                        >
                            {envName}
                        </span>
                    ))}
                    {docUrl ? (
                        <a
                            href={docUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-200"
                        >
                            Docs
                            <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                    ) : null}
                </div>
            </section>

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                            Selected models
                        </h2>
                    </div>
                    <div className="rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
                        {formatCountLabel(
                            provider.models.length,
                            "model",
                            "models",
                        )}
                    </div>
                </div>

                <div className="mt-8 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                    {provider.models.map((model) => {
                        const limitLabel = getLimitLabel(model.config);
                        return (
                            <div
                                key={model.id}
                                className="rounded-[24px] border border-gray-200 bg-gray-50 p-5"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-[17px] font-semibold tracking-[-0.03em] text-gray-950">
                                            {model.name}
                                        </p>
                                        <p className="mt-1 text-[13px] text-gray-500">
                                            {model.id}
                                        </p>
                                    </div>
                                    {limitLabel ? (
                                        <span className="rounded-full bg-white px-3 py-1 text-[12px] font-medium text-gray-600">
                                            {limitLabel}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                            Access
                        </h2>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
                        <Users className="h-4 w-4" />
                        {provider.access.members.length +
                            provider.access.teams.length}{" "}
                        grants
                    </div>
                </div>

                <div className="mt-8 grid gap-6 xl:grid-cols-2">
                    <div className="rounded-[24px] bg-gray-50 p-5">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                            People
                        </p>
                        <div className="mt-4 grid gap-3">
                            {provider.access.members.length === 0 ? (
                                <p className="text-[14px] text-gray-500">
                                    No direct people access yet.
                                </p>
                            ) : (
                                provider.access.members.map((member) => (
                                    <div
                                        key={member.id}
                                        className="rounded-[18px] border border-gray-200 bg-white px-4 py-3"
                                    >
                                        <p className="text-[15px] font-medium text-gray-900">
                                            {member.user.name}
                                        </p>
                                        <p className="mt-1 text-[13px] text-gray-500">
                                            {member.user.email}
                                        </p>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="rounded-[24px] bg-gray-50 p-5">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                            Teams
                        </p>
                        <div className="mt-4 grid gap-3">
                            {provider.access.teams.length === 0 ? (
                                <p className="text-[14px] text-gray-500">
                                    No team access yet.
                                </p>
                            ) : (
                                provider.access.teams.map((team) => (
                                    <div
                                        key={team.id}
                                        className="rounded-[18px] border border-gray-200 bg-white px-4 py-3"
                                    >
                                        <p className="text-[15px] font-medium text-gray-900">
                                            {team.name}
                                        </p>
                                        <p className="mt-1 text-[13px] text-gray-500">
                                            Updated{" "}
                                            {formatProviderTimestamp(
                                                team.updatedAt,
                                            )}
                                        </p>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </section>

            {provider.source === "custom" ? (
                <section className="rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                    <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                        Custom provider payload
                    </h2>
                    <p className="mt-2 text-[15px] text-gray-500">
                        The raw provider config saved for this custom source.
                    </p>
                    <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#0f172a] p-5 text-[13px] leading-6 text-slate-100">
                        {JSON.stringify(provider.providerConfig, null, 2)}
                    </pre>
                </section>
            ) : null}
        </div>
    );
}
