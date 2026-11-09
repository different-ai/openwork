"use client";

import type { ConfigAreaDescriptor } from "@openwork/types/den/config-blobs";
import { DenCheckbox } from "../../_components/ui/checkbox";
import { DenSegmented } from "../../_components/ui/segmented";
import type { DenConfigTokenScope, DenOrgApiKey, DenOrgApiKeyType } from "../../_lib/den-org";

/** What each config token scope lets a script do, in plain words. */
export const CONFIG_TOKEN_SCOPE_LABELS: Record<DenConfigTokenScope, string> = {
    "config:export": "Export",
    "config:submit": "Submit changes",
    "config:apply": "Approve & apply",
};

const CONFIG_TOKEN_SCOPE_HINTS: Record<DenConfigTokenScope, string> = {
    "config:export": "Download this organization's setup.",
    "config:submit": "Upload changes and check on them. Someone still approves them.",
    "config:apply": "Approve and apply changes without a person in the loop.",
};

const SCOPE_ORDER: readonly DenConfigTokenScope[] = ["config:export", "config:submit", "config:apply"];

export type ConfigTokenDraft = {
    type: DenOrgApiKeyType;
    scopes: DenConfigTokenScope[];
    limitAreas: boolean;
    areas: string[];
};

export const EMPTY_CONFIG_TOKEN_DRAFT: ConfigTokenDraft = {
    type: "standard",
    scopes: ["config:export"],
    limitAreas: false,
    areas: [],
};

/** The request body fields for this draft, or a reason it can't be sent yet. */
export function configTokenRequestFields(draft: ConfigTokenDraft): { ok: true; fields: Record<string, unknown> } | { ok: false; reason: string } {
    if (draft.type !== "config") return { ok: true, fields: {} };
    if (draft.scopes.length === 0) return { ok: false, reason: "Choose at least one thing this token can do." };
    if (draft.limitAreas && draft.areas.length === 0) return { ok: false, reason: "Choose at least one area, or allow every area." };
    return {
        ok: true,
        fields: {
            type: "config",
            scopes: SCOPE_ORDER.filter((scope) => draft.scopes.includes(scope)),
            ...(draft.limitAreas ? { areas: draft.areas } : {}),
        },
    };
}

function toggle<T>(values: readonly T[], value: T, on: boolean): T[] {
    return on ? (values.includes(value) ? [...values] : [...values, value]) : values.filter((entry) => entry !== value);
}

/**
 * The create-form part for config tokens (feature `configBlobs`): key type,
 * what the token can do and an optional area limit. Areas come from
 * GET /v1/config-blobs/areas; without them the limit is left out.
 */
export function ConfigTokenFields({
    draft,
    onChange,
    areas,
    disabled = false,
}: {
    draft: ConfigTokenDraft;
    onChange: (next: ConfigTokenDraft) => void;
    /** Null when the areas couldn't be loaded: the area limit is not offered. */
    areas: readonly ConfigAreaDescriptor[] | null;
    disabled?: boolean;
}) {
    const offeredAreas = areas?.filter((area) => area.supported) ?? null;

    return (
        <div className="mt-5 grid gap-5">
            <div className="grid gap-3">
                <span className="text-[14px] font-medium text-gray-700">Key type</span>
                <DenSegmented<DenOrgApiKeyType>
                    aria-label="Key type"
                    value={draft.type}
                    onChange={(type) => onChange({ ...draft, type })}
                    options={[
                        { value: "standard", label: "API key", disabled },
                        { value: "config", label: "Config token", disabled },
                    ]}
                    optionTestId={(value) => `api-key-type-${value}`}
                />
            </div>

            {draft.type === "config" ? (
                <>
                    <fieldset className="grid gap-3" data-testid="config-token-scopes">
                        <legend className="mb-3 text-[14px] font-medium text-gray-700">What it can do</legend>
                        {SCOPE_ORDER.map((scope) => (
                            <label key={scope} className="flex items-start gap-2 text-[13px] leading-5 text-gray-900">
                                <DenCheckbox
                                    name={`scope-${scope}`}
                                    checked={draft.scopes.includes(scope)}
                                    disabled={disabled}
                                    onCheckedChange={(checked) => onChange({ ...draft, scopes: toggle(draft.scopes, scope, checked) })}
                                    className="mt-0.5"
                                />
                                <span>
                                    <span className="font-medium">{CONFIG_TOKEN_SCOPE_LABELS[scope]}</span>
                                    <span className="block text-[12px] text-gray-500">{CONFIG_TOKEN_SCOPE_HINTS[scope]}</span>
                                </span>
                            </label>
                        ))}
                        <p className="text-[12px] text-gray-500">
                            The token can never do more than you can.
                        </p>
                    </fieldset>

                    {offeredAreas && offeredAreas.length > 0 ? (
                        <fieldset className="grid gap-3" data-testid="config-token-areas">
                            <legend className="mb-3 text-[14px] font-medium text-gray-700">Areas</legend>
                            <DenSegmented<"all" | "some">
                                aria-label="Areas"
                                value={draft.limitAreas ? "some" : "all"}
                                onChange={(value) => onChange({ ...draft, limitAreas: value === "some" })}
                                options={[
                                    { value: "all", label: "Every area", disabled },
                                    { value: "some", label: "Only some areas", disabled },
                                ]}
                            />
                            {draft.limitAreas ? (
                                // Column by column, so areas of one sidebar group stay together.
                                <div className="gap-x-6 sm:columns-2">
                                    {offeredAreas.map((area) => (
                                        <label key={area.key} className="mb-2 flex break-inside-avoid items-center gap-2 text-[13px] text-gray-900">
                                            <DenCheckbox
                                                name={`area-${area.key}`}
                                                checked={draft.areas.includes(area.key)}
                                                disabled={disabled}
                                                onCheckedChange={(checked) => onChange({ ...draft, areas: toggle(draft.areas, area.key, checked) })}
                                            />
                                            <span className="truncate">{area.path.length > 0 ? area.path.join(" › ") : area.label}</span>
                                        </label>
                                    ))}
                                </div>
                            ) : null}
                        </fieldset>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

/** One line for the list: what a config token can do and where. Null for standard keys. */
export function describeConfigToken(apiKey: DenOrgApiKey, areas: readonly ConfigAreaDescriptor[] | null): string | null {
    if (apiKey.type !== "config") return null;
    const can = apiKey.scopes.map((scope) => CONFIG_TOKEN_SCOPE_LABELS[scope]).join(", ");
    if (!apiKey.areas) return `${can}, every area`;
    const labels = apiKey.areas.map((key) => areas?.find((area) => area.key === key)?.label ?? key);
    return `${can}, only ${labels.join(", ")}`;
}
