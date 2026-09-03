"use client";

import { useMemo, useState } from "react";
import { Search, User, Users } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import type { DenComboboxOption } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenSelectableRow } from "../../_components/ui/selectable-row";
import { DenToggleRow } from "../../_components/ui/toggle-row";
import type { DenOrgContext } from "../../_lib/den-org";
import { getProviderIconSlug, type DenModelsDevProviderSummary } from "./llm-provider-data";

/**
 * Combobox options for the models.dev provider picker. Shared by the BYOK
 * editor and the gateway provider editor so companies always render as
 * icon + name with the same metadata line.
 */
export function buildCatalogProviderOptions(
    catalogProviders: DenModelsDevProviderSummary[],
    describe?: (catalogProvider: DenModelsDevProviderSummary) => string,
): DenComboboxOption[] {
    return catalogProviders.map((catalogProvider) => ({
        value: catalogProvider.id,
        label: catalogProvider.name,
        description: describe ? describe(catalogProvider) : catalogProvider.id,
        meta: `${catalogProvider.modelCount} ${catalogProvider.modelCount === 1 ? "model" : "models"}`,
        icon: (
            <DenBrandMark
                name={catalogProvider.name}
                simpleIconSlug={getProviderIconSlug(catalogProvider.id)}
                serviceUrl={catalogProvider.doc}
                className="h-6 w-6 rounded-[8px]"
                imageClassName="h-3.5 w-3.5"
            />
        ),
    }));
}

export type ProviderModelOption = { id: string; name: string };

/** Searchable multi-select over a provider's models. */
export function ProviderModelPicker({
    models,
    selectedModelIds,
    onChange,
    emptyLabel = "Select a provider to browse its models.",
}: {
    models: ProviderModelOption[] | null;
    selectedModelIds: string[];
    onChange: (next: string[]) => void;
    emptyLabel?: string;
}) {
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!models) return [];
        if (!normalized) return models;
        return models.filter(
            (model) =>
                model.name.toLowerCase().includes(normalized) ||
                model.id.toLowerCase().includes(normalized),
        );
    }, [models, query]);

    const toggle = (modelId: string) =>
        onChange(
            selectedModelIds.includes(modelId)
                ? selectedModelIds.filter((entry) => entry !== modelId)
                : [...selectedModelIds, modelId],
        );

    return (
        <>
            <div className="mt-6">
                <DenInput
                    type="search"
                    icon={Search}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search models..."
                />
            </div>
            {models ? (
                filtered.length ? (
                    <div className="mt-4 overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                        {filtered.map((model) => (
                            <DenSelectableRow
                                key={model.id}
                                selected={selectedModelIds.includes(model.id)}
                                title={model.name}
                                description={model.id}
                                onClick={() => toggle(model.id)}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                        No models match <span className="font-medium text-gray-700">&quot;{query}&quot;</span>.
                    </div>
                )
            ) : (
                <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                    {emptyLabel}
                </div>
            )}
        </>
    );
}

export type ProviderAccessValue = {
    allMembers: boolean;
    memberIds: string[];
    teamIds: string[];
};

/**
 * "Who can use it": everyone toggle plus tabbed team / people pickers. The
 * locked member (creator) always keeps direct access and cannot be removed.
 */
export function ProviderAccessPicker({
    orgContext,
    value,
    onChange,
    lockedMemberId,
    testIdPrefix,
}: {
    orgContext: DenOrgContext | null;
    value: ProviderAccessValue;
    onChange: (next: ProviderAccessValue) => void;
    lockedMemberId: string | null;
    testIdPrefix: string;
}) {
    const [accessTab, setAccessTab] = useState<"teams" | "people">("teams");
    const [accessQuery, setAccessQuery] = useState("");
    const { allMembers, memberIds, teamIds } = value;

    const filteredTeams = useMemo(() => {
        const teams = orgContext?.teams ?? [];
        const normalized = accessQuery.trim().toLowerCase();
        return normalized ? teams.filter((team) => team.name.toLowerCase().includes(normalized)) : teams;
    }, [accessQuery, orgContext?.teams]);

    const filteredMembers = useMemo(() => {
        const members = orgContext?.members ?? [];
        const normalized = accessQuery.trim().toLowerCase();
        return normalized
            ? members.filter(
                  (member) =>
                      member.user.name.toLowerCase().includes(normalized) ||
                      member.user.email.toLowerCase().includes(normalized),
              )
            : members;
    }, [accessQuery, orgContext?.members]);

    const toggleTeam = (teamId: string) =>
        onChange({
            ...value,
            teamIds: teamIds.includes(teamId) ? teamIds.filter((entry) => entry !== teamId) : [...teamIds, teamId],
        });
    const toggleMember = (memberId: string) =>
        onChange({
            ...value,
            memberIds: memberIds.includes(memberId)
                ? memberIds.filter((entry) => entry !== memberId)
                : [...memberIds, memberId],
        });

    return (
        <>
            <div className="mt-6">
                <DenToggleRow
                    icon={Users}
                    testId={`${testIdPrefix}-all-members`}
                    title={`Everyone in ${orgContext?.organization.name ?? "this organization"}`}
                    description={`All ${orgContext?.members.length ?? 0} current members — and anyone who joins later — can use these models.`}
                    checked={allMembers}
                    onChange={(checked) => onChange({ ...value, allMembers: checked })}
                />
            </div>

            {allMembers ? (
                <p className="mt-3 text-[13px] text-gray-400">Turn off “Everyone” to pick specific teams and people.</p>
            ) : null}

            <div className={allMembers ? "pointer-events-none select-none opacity-45" : undefined} aria-disabled={allMembers}>
                <div className="mt-6 grid w-80 grid-cols-2 rounded-xl bg-gray-200 p-1 text-[13px] font-medium text-gray-500">
                    <button
                        type="button"
                        onClick={() => {
                            setAccessTab("teams");
                            setAccessQuery("");
                        }}
                        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 transition ${accessTab === "teams" ? "bg-white text-gray-900 shadow-sm" : "hover:text-gray-700"}`}
                    >
                        <Users className="h-4 w-4" />
                        {`Teams (${teamIds.length})`}
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
                        {`People (${memberIds.length})`}
                    </button>
                </div>

                <div className="mt-6">
                    <DenInput
                        type="search"
                        icon={Search}
                        value={accessQuery}
                        onChange={(event) => setAccessQuery(event.target.value)}
                        placeholder={accessTab === "teams" ? "Search teams..." : "Search people..."}
                    />
                </div>

                {accessTab === "teams" ? (
                    orgContext?.teams.length ? (
                        filteredTeams.length ? (
                            <div className="mt-4 overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                                {filteredTeams.map((team) => (
                                    <DenSelectableRow
                                        key={team.id}
                                        selected={teamIds.includes(team.id)}
                                        leading={<Users className="h-4 w-4 text-gray-400" />}
                                        title={team.name}
                                        description={`${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}`}
                                        onClick={() => toggleTeam(team.id)}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                                No teams match <span className="font-medium text-gray-700">&quot;{accessQuery}&quot;</span>.
                            </div>
                        )
                    ) : (
                        <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                            Create teams from the Members page before assigning team access.
                        </div>
                    )
                ) : orgContext?.members.length ? (
                    filteredMembers.length ? (
                        <div className="mt-4 overflow-hidden rounded-[16px] border border-gray-200 bg-white divide-y divide-gray-200">
                            {filteredMembers.map((member) => {
                                const locked = lockedMemberId === member.id;
                                return (
                                    <DenSelectableRow
                                        key={member.id}
                                        disabled={locked}
                                        selected={memberIds.includes(member.id)}
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
                                        onClick={() => toggleMember(member.id)}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                            No people match <span className="font-medium text-gray-700">&quot;{accessQuery}&quot;</span>.
                        </div>
                    )
                ) : (
                    <div className="mt-4 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                        No people are available to assign yet.
                    </div>
                )}
            </div>
        </>
    );
}
