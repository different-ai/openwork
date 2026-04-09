"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import {
    getOrgAccessFlags,
    parseOrgApiKeysPayload,
    type DenOrgApiKey,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function formatDateTime(value: string | null) {
    if (!value) {
        return "Never";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Never";
    }

    return date.toLocaleString();
}

function formatKeyPreview(apiKey: DenOrgApiKey) {
    if (apiKey.start) {
        return `${apiKey.start}...`;
    }

    if (apiKey.prefix) {
        return `${apiKey.prefix}${apiKey.id.slice(0, 6)}...`;
    }

    return `${apiKey.id.slice(0, 6)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getCreatedKey(payload: unknown) {
    if (!isRecord(payload) || typeof payload.key !== "string") {
        return null;
    }

    return payload.key;
}

export function ApiKeysScreen() {
    const { orgId, orgContext } = useOrgDashboard();
    const [apiKeys, setApiKeys] = useState<DenOrgApiKey[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [createdKeyName, setCreatedKeyName] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const access = useMemo(
        () =>
            getOrgAccessFlags(
                orgContext?.currentMember.role ?? "member",
                orgContext?.currentMember.isOwner ?? false,
            ),
        [orgContext?.currentMember.isOwner, orgContext?.currentMember.role],
    );

    async function loadApiKeys() {
        if (!orgId || !access.canManageApiKeys) {
            setApiKeys([]);
            return;
        }

        setBusy(true);
        setError(null);
        try {
            const { response, payload } = await requestJson(
                `/v1/orgs/${encodeURIComponent(orgId)}/api-keys`,
                { method: "GET" },
                12000,
            );
            if (!response.ok) {
                throw new Error(
                    getErrorMessage(
                        payload,
                        `Failed to load API keys (${response.status}).`,
                    ),
                );
            }

            setApiKeys(parseOrgApiKeysPayload(payload));
        } catch (nextError) {
            setError(
                nextError instanceof Error
                    ? nextError.message
                    : "Failed to load API keys.",
            );
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        void loadApiKeys();
    }, [orgId, access.canManageApiKeys]);

    useEffect(() => {
        if (!copied) {
            return;
        }

        const timeout = window.setTimeout(() => setCopied(false), 1500);
        return () => window.clearTimeout(timeout);
    }, [copied]);

    async function handleCreate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!orgId) {
            setError("Organization not found.");
            return;
        }

        setCreating(true);
        setError(null);
        setCreatedKey(null);
        setCreatedKeyName(null);
        setCopied(false);
        try {
            const { response, payload } = await requestJson(
                `/v1/orgs/${encodeURIComponent(orgId)}/api-keys`,
                {
                    method: "POST",
                    body: JSON.stringify({ name }),
                },
                12000,
            );

            if (!response.ok) {
                throw new Error(
                    getErrorMessage(
                        payload,
                        `Failed to create API key (${response.status}).`,
                    ),
                );
            }

            const nextKey = getCreatedKey(payload);
            if (!nextKey) {
                throw new Error(
                    "API key was created, but the secret was not returned.",
                );
            }

            setCreatedKey(nextKey);
            setCreatedKeyName(name);
            setName("");
            setShowCreateForm(false);
            await loadApiKeys();
        } catch (nextError) {
            setError(
                nextError instanceof Error
                    ? nextError.message
                    : "Failed to create API key.",
            );
        } finally {
            setCreating(false);
        }
    }

    function openCreateForm() {
        setError(null);
        setCopied(false);
        setCreatedKey(null);
        setCreatedKeyName(null);
        setName("");
        setShowCreateForm(true);
    }

    function closeCreateForm() {
        setName("");
        setShowCreateForm(false);
    }

    async function handleDelete(apiKey: DenOrgApiKey) {
        if (
            !orgId ||
            !window.confirm(
                `Delete ${apiKey.name ?? apiKey.start ?? "this API key"}? This cannot be undone.`,
            )
        ) {
            return;
        }

        setDeletingId(apiKey.id);
        setError(null);
        try {
            const { response, payload } = await requestJson(
                `/v1/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(apiKey.id)}`,
                { method: "DELETE" },
                12000,
            );

            if (response.status !== 204 && !response.ok) {
                throw new Error(
                    getErrorMessage(
                        payload,
                        `Failed to delete API key (${response.status}).`,
                    ),
                );
            }

            await loadApiKeys();
        } catch (nextError) {
            setError(
                nextError instanceof Error
                    ? nextError.message
                    : "Failed to delete API key.",
            );
        } finally {
            setDeletingId(null);
        }
    }

    async function copyCreatedKey() {
        if (!createdKey) {
            return;
        }

        try {
            await navigator.clipboard.writeText(createdKey);
            setCopied(true);
        } catch {
            setError(
                "Could not copy the API key. Copy it manually before leaving this page.",
            );
        }
    }

    if (!orgContext) {
        return (
            <DashboardPageTemplate
                icon={KeyRound}
                badgeLabel="Admin"
                title="API Keys"
                description="Create named, rate-limited API keys for your own org membership and revoke any key in the workspace when needed."
                colors={["#E6FFFA", "#0F766E", "#14B8A6", "#99F6E4"]}
            >
                <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
                    Loading organization details...
                </div>
            </DashboardPageTemplate>
        );
    }

    return (
        <DashboardPageTemplate
            icon={KeyRound}
            badgeLabel="Admin"
            title="API Keys"
            description="Manage your OpenWork API keys."
            colors={["#E6FFFA", "#0F766E", "#14B8A6", "#99F6E4"]}
        >
            {!access.canManageApiKeys ? (
                <div className="rounded-[28px] border border-amber-200 bg-amber-50 px-6 py-5 text-[14px] text-amber-900">
                    Only organization owners and admins can view or manage API
                    keys.
                </div>
            ) : (
                <>
                    {error ? (
                        <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
                            {error}
                        </div>
                    ) : null}

                    <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
                        {createdKey ? (
                            <div className="rounded-[24px] bg-[#0f172a] p-6 text-white">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div>
                                        <p className="text-[16px] font-semibold tracking-[-0.03em]">
                                            {createdKeyName
                                                ? `${createdKeyName} is ready`
                                                : "Your new API key is ready"}
                                        </p>
                                        <p className="mt-1 text-[14px] leading-6 text-slate-300">
                                            The key will only be shown once.
                                        </p>
                                    </div>
                                </div>

                                <div className="mt-5 rounded-[20px] border border-white/10 bg-white/5 p-4">
                                    <code className="block break-all text-[13px] leading-6 text-emerald-200">
                                        {createdKey}
                                    </code>
                                </div>

                                <div className="mt-5 flex flex-wrap justify-end gap-3">
                                    <DenButton
                                        variant="secondary"
                                        icon={Copy}
                                        onClick={() => void copyCreatedKey()}
                                    >
                                        {copied ? "Copied" : "Copy key"}
                                    </DenButton>
                                    <DenButton onClick={openCreateForm}>
                                        Create another key
                                    </DenButton>
                                </div>
                            </div>
                        ) : showCreateForm ? (
                            <form onSubmit={handleCreate}>
                                <div className="mb-5 flex items-start justify-between gap-4">
                                    <div>
                                        <p className="text-[16px] font-semibold tracking-[-0.03em] text-gray-900">
                                            Issue a new key
                                        </p>
                                        <p className="mt-1 text-[14px] leading-6 text-gray-500">
                                            Keys are issued to you for this
                                            organization only.
                                        </p>
                                    </div>
                                </div>

                                <label className="grid gap-3">
                                    <span className="text-[14px] font-medium text-gray-700">
                                        Key name
                                    </span>
                                    <DenInput
                                        type="text"
                                        value={name}
                                        onChange={(event) =>
                                            setName(event.target.value)
                                        }
                                        placeholder="CI worker"
                                        required
                                    />
                                </label>

                                <div className="mt-5 flex flex-wrap justify-end gap-3">
                                    <DenButton
                                        type="button"
                                        variant="secondary"
                                        onClick={closeCreateForm}
                                    >
                                        Cancel
                                    </DenButton>
                                    <DenButton type="submit" loading={creating}>
                                        Create API key
                                    </DenButton>
                                </div>
                            </form>
                        ) : (
                            <div className="flex flex-wrap items-center justify-between gap-4">
                                <div>
                                    <p className="text-[16px] font-semibold tracking-[-0.03em] text-gray-900">
                                        Create a new API key
                                    </p>
                                </div>
                                <DenButton onClick={openCreateForm}>
                                    New key
                                </DenButton>
                            </div>
                        )}
                    </div>

                    <div className="overflow-hidden rounded-[28px] border border-gray-100 bg-white">
                        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_180px_120px] gap-4 border-b border-gray-100 px-6 py-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                            <span>Key</span>
                            <span>Owner</span>
                            <span>Last used</span>
                            <span />
                        </div>

                        {busy ? (
                            <div className="px-6 py-8 text-center text-[13px] text-gray-400">
                                Loading API keys...
                            </div>
                        ) : apiKeys.length === 0 ? (
                            <div className="px-6 py-8 text-center text-[13px] text-gray-400">
                                No API keys for this workspace yet.
                            </div>
                        ) : (
                            apiKeys.map((apiKey) => (
                                <div
                                    key={apiKey.id}
                                    className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_180px_120px] items-center gap-4 border-b border-gray-100 px-6 py-4 transition hover:bg-gray-50/70 last:border-b-0"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-[14px] font-medium text-gray-900">
                                            {apiKey.name ??
                                                apiKey.start ??
                                                "Untitled key"}
                                        </p>
                                        <p className="mt-1 truncate text-[12px] text-gray-400">
                                            {formatKeyPreview(apiKey)}{" "}
                                            {formatDateTime(apiKey.createdAt)}
                                        </p>
                                    </div>

                                    <div className="min-w-0">
                                        <p className="truncate text-[13px] font-medium text-gray-900">
                                            {apiKey.owner.name}
                                        </p>
                                        <p className="truncate text-[12px] text-gray-400">
                                            {apiKey.owner.email}
                                        </p>
                                    </div>

                                    <span className="text-[13px] text-gray-500">
                                        {formatDateTime(apiKey.lastRequest)}
                                    </span>

                                    <div className="flex justify-end">
                                        <DenButton
                                            variant="destructive"
                                            size="sm"
                                            icon={Trash2}
                                            onClick={() =>
                                                void handleDelete(apiKey)
                                            }
                                            disabled={deletingId === apiKey.id}
                                        >
                                            {deletingId === apiKey.id
                                                ? "Deleting..."
                                                : "Delete"}
                                        </DenButton>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </>
            )}
        </DashboardPageTemplate>
    );
}
