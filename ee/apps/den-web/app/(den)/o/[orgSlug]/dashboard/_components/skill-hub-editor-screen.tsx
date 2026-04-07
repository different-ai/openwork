"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
    ArrowLeft,
    BookOpen,
    CheckCircle2,
    Circle,
    Search,
} from "lucide-react";
import { DenButton } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import { DenTextarea } from "../../../../_components/ui/textarea";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import {
    getOrgAccessFlags,
    getSkillHubsRoute,
    getSkillHubRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
    getSkillVisibilityLabel,
    parseSkillCategory,
    useOrgSkillLibrary,
} from "./skill-hub-data";

export function SkillHubEditorScreen({ skillHubId }: { skillHubId?: string }) {
    const router = useRouter();
    const { orgId, orgSlug, orgContext } = useOrgDashboard();
    const { skills, skillHubs, busy, error, reloadLibrary } =
        useOrgSkillLibrary(orgId);
    const skillHub = useMemo(
        () =>
            skillHubId
                ? (skillHubs.find((entry) => entry.id === skillHubId) ?? null)
                : null,
        [skillHubId, skillHubs],
    );

    const access = useMemo(
        () =>
            getOrgAccessFlags(
                orgContext?.currentMember.role ?? "member",
                orgContext?.currentMember.isOwner ?? false,
            ),
        [orgContext?.currentMember.isOwner, orgContext?.currentMember.role],
    );

    const canManage = skillHubId ? skillHub?.canManage === true : true;
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
    const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
    const [skillQuery, setSkillQuery] = useState("");
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (skillHubId) {
            if (!skillHub) {
                return;
            }

            setName(skillHub.name);
            setDescription(skillHub.description ?? "");
            setSelectedTeamIds(
                skillHub.access.teams.map((entry) => entry.teamId),
            );
            setSelectedSkillIds(skillHub.skills.map((entry) => entry.id));
            return;
        }

        setName("");
        setDescription("");
        setSelectedTeamIds([]);
        setSelectedSkillIds([]);
    }, [skillHub, skillHubId]);

    const filteredSkills = useMemo(() => {
        const normalizedQuery = skillQuery.trim().toLowerCase();
        if (!normalizedQuery) {
            return skills;
        }

        return skills.filter((skill) => {
            const category = parseSkillCategory(skill.skillText) ?? "";
            return (
                skill.title.toLowerCase().includes(normalizedQuery) ||
                (skill.description ?? "")
                    .toLowerCase()
                    .includes(normalizedQuery) ||
                category.toLowerCase().includes(normalizedQuery)
            );
        });
    }, [skillQuery, skills]);

    const currentTeamAccessById = useMemo(
        () =>
            new Map(
                (skillHub?.access.teams ?? []).map((entry) => [
                    entry.teamId,
                    entry.id,
                ]),
            ),
        [skillHub?.access.teams],
    );

    const currentSkillIds = useMemo(
        () => new Set(skillHub?.skills.map((entry) => entry.id) ?? []),
        [skillHub?.skills],
    );

    async function saveHub() {
        if (!orgId) {
            setSaveError("Organization not found.");
            return;
        }

        if (!name.trim()) {
            setSaveError("Enter a hub name.");
            return;
        }

        setSaving(true);
        setSaveError(null);
        try {
            let nextSkillHubId = skillHubId ?? null;

            if (!nextSkillHubId) {
                const { response, payload } = await requestJson(
                    `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs`,
                    {
                        method: "POST",
                        body: JSON.stringify({
                            name: name.trim(),
                            description: description.trim() || null,
                        }),
                    },
                    12000,
                );

                if (!response.ok) {
                    throw new Error(
                        getErrorMessage(
                            payload,
                            `Failed to create hub (${response.status}).`,
                        ),
                    );
                }

                const nextHub =
                    payload &&
                    typeof payload === "object" &&
                    payload &&
                    "skillHub" in payload &&
                    payload.skillHub &&
                    typeof payload.skillHub === "object"
                        ? (payload.skillHub as { id?: unknown })
                        : null;
                nextSkillHubId =
                    typeof nextHub?.id === "string" ? nextHub.id : null;
                if (!nextSkillHubId) {
                    throw new Error(
                        "The hub was created, but no hub id was returned.",
                    );
                }
            } else if (
                skillHub &&
                (skillHub.name !== name.trim() ||
                    (skillHub.description ?? "") !== description.trim())
            ) {
                const { response, payload } = await requestJson(
                    `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs/${encodeURIComponent(nextSkillHubId)}`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({
                            name: name.trim(),
                            description: description.trim() || null,
                        }),
                    },
                    12000,
                );

                if (!response.ok) {
                    throw new Error(
                        getErrorMessage(
                            payload,
                            `Failed to update hub (${response.status}).`,
                        ),
                    );
                }
            }

            const teamIdsToAdd = selectedTeamIds.filter(
                (teamId) => !currentTeamAccessById.has(teamId),
            );
            const teamAccessIdsToRemove = [...currentTeamAccessById.entries()]
                .filter(([teamId]) => !selectedTeamIds.includes(teamId))
                .map(([, accessId]) => accessId);
            const skillIdsToAdd = selectedSkillIds.filter(
                (entry) => !currentSkillIds.has(entry),
            );
            const skillIdsToRemove = [...currentSkillIds].filter(
                (entry) => !selectedSkillIds.includes(entry),
            );

            await Promise.all(
                teamIdsToAdd.map(async (teamId) => {
                    const { response, payload } = await requestJson(
                        `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs/${encodeURIComponent(nextSkillHubId)}/access`,
                        {
                            method: "POST",
                            body: JSON.stringify({ teamId }),
                        },
                        12000,
                    );

                    if (!response.ok) {
                        throw new Error(
                            getErrorMessage(
                                payload,
                                `Failed to grant team access (${response.status}).`,
                            ),
                        );
                    }
                }),
            );

            await Promise.all(
                teamAccessIdsToRemove.map(async (accessId) => {
                    const { response, payload } = await requestJson(
                        `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs/${encodeURIComponent(nextSkillHubId)}/access/${encodeURIComponent(accessId)}`,
                        { method: "DELETE" },
                        12000,
                    );

                    if (response.status !== 204 && !response.ok) {
                        throw new Error(
                            getErrorMessage(
                                payload,
                                `Failed to remove team access (${response.status}).`,
                            ),
                        );
                    }
                }),
            );

            await Promise.all(
                skillIdsToAdd.map(async (entry) => {
                    const { response, payload } = await requestJson(
                        `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs/${encodeURIComponent(nextSkillHubId)}/skills`,
                        {
                            method: "POST",
                            body: JSON.stringify({ skillId: entry }),
                        },
                        12000,
                    );

                    if (!response.ok) {
                        throw new Error(
                            getErrorMessage(
                                payload,
                                `Failed to add a skill (${response.status}).`,
                            ),
                        );
                    }
                }),
            );

            await Promise.all(
                skillIdsToRemove.map(async (entry) => {
                    const { response, payload } = await requestJson(
                        `/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs/${encodeURIComponent(nextSkillHubId)}/skills/${encodeURIComponent(entry)}`,
                        { method: "DELETE" },
                        12000,
                    );

                    if (response.status !== 204 && !response.ok) {
                        throw new Error(
                            getErrorMessage(
                                payload,
                                `Failed to remove a skill (${response.status}).`,
                            ),
                        );
                    }
                }),
            );

            await reloadLibrary();
            router.push(
                skillHubId
                    ? getSkillHubRoute(orgSlug, nextSkillHubId)
                    : getSkillHubsRoute(orgSlug),
            );
            router.refresh();
        } catch (nextError) {
            setSaveError(
                nextError instanceof Error
                    ? nextError.message
                    : "Could not save the hub.",
            );
        } finally {
            setSaving(false);
        }
    }

    if (busy && skillHubId && !skillHub) {
        return (
            <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
                <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
                    Loading hub details...
                </div>
            </div>
        );
    }

    if (skillHubId && !skillHub) {
        return (
            <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
                <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
                    {error ?? "That hub could not be found."}
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
            <div className="mb-8 flex flex-col gap-3">
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                    {skillHubId ? "Skill hub editor" : "Create a hub"}
                </p>
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                        <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">
                            {skillHubId
                                ? (skillHub?.name ?? "Hub details")
                                : "Create a new skill hub"}
                        </h1>
                        <p className="mt-3 max-w-[700px] text-[16px] leading-8 text-gray-500">
                            Shape who can access this collection, then pick the
                            exact skills each team should inherit.
                        </p>
                    </div>
                </div>
            </div>

            <div className="mb-8 flex items-center justify-between gap-4">
                <Link
                    href={
                        skillHubId
                            ? getSkillHubRoute(orgSlug, skillHubId)
                            : getSkillHubsRoute(orgSlug)
                    }
                    className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
                >
                    <ArrowLeft className="h-5 w-5" />
                    Back
                </Link>

                {canManage ? (
                    <DenButton loading={saving} onClick={() => void saveHub()}>
                        {skillHubId ? "Save Hub" : "Create Hub"}
                    </DenButton>
                ) : (
                    <span className="rounded-full border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-gray-500">
                        Read only
                    </span>
                )}
            </div>

            {saveError ? (
                <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
                    {saveError}
                </div>
            ) : null}

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <h2 className="mb-8 text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                    Hub Details
                </h2>
                <div className="grid gap-6">
                    <label className="grid gap-3">
                        <span className="text-[14px] font-medium text-gray-700">
                            Hub Name
                        </span>
                        <DenInput
                            type="text"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            disabled={!canManage}
                        />
                    </label>
                    <label className="grid gap-3">
                        <span className="text-[14px] font-medium text-gray-700">
                            Description
                        </span>
                        <DenTextarea
                            value={description}
                            onChange={(event) =>
                                setDescription(event.target.value)
                            }
                            disabled={!canManage}
                            rows={4}
                        />
                    </label>
                </div>
            </section>

            <section className="mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                    Assigned Teams
                </h2>
                <p className="mt-2 text-[15px] text-gray-500">
                    Select which teams have access to this hub.
                </p>
                {skillHub?.access.members.length ? (
                    <p className="mt-3 text-[13px] text-gray-400">
                        {skillHub.access.members.length} direct member grant
                        {skillHub.access.members.length === 1 ? "" : "s"}{" "}
                        already exist and will stay in place.
                    </p>
                ) : null}

                {orgContext?.teams.length ? (
                    <div className="mt-8 grid gap-4 md:grid-cols-2">
                        {orgContext.teams.map((team) => {
                            const selected = selectedTeamIds.includes(team.id);
                            return (
                                <button
                                    key={team.id}
                                    type="button"
                                    disabled={!canManage}
                                    onClick={() => {
                                        if (!canManage) {
                                            return;
                                        }
                                        setSelectedTeamIds((current) =>
                                            current.includes(team.id)
                                                ? current.filter(
                                                      (entry) =>
                                                          entry !== team.id,
                                                  )
                                                : [...current, team.id],
                                        );
                                    }}
                                    className={`flex min-h-[84px] items-center gap-4 rounded-[24px] border px-5 py-4 text-left transition ${
                                        selected
                                            ? "border-[#0f172a] bg-[#0f172a] text-white"
                                            : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                                    } ${!canManage ? "cursor-default" : "cursor-pointer"}`}
                                >
                                    {selected ? (
                                        <CheckCircle2 className="h-7 w-7 shrink-0" />
                                    ) : (
                                        <Circle className="h-7 w-7 shrink-0 text-gray-300" />
                                    )}
                                    <div>
                                        <p className="text-[17px] font-medium tracking-[-0.03em]">
                                            {team.name}
                                        </p>
                                        <p
                                            className={`mt-1 text-[13px] ${selected ? "text-white/70" : "text-gray-400"}`}
                                        >
                                            {team.memberIds.length}{" "}
                                            {team.memberIds.length === 1
                                                ? "member"
                                                : "members"}
                                        </p>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="mt-8 rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                        Create teams from the Members page before assigning hub
                        access.
                    </div>
                )}
            </section>

            <section className="rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
                <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">
                            Hub Skills
                        </h2>
                        <p className="mt-2 text-[15px] text-gray-500">
                            Select the skills to include in this hub.
                        </p>
                    </div>

                    <div>
                        <DenInput
                            type="search"
                            icon={Search}
                            value={skillQuery}
                            onChange={(event) =>
                                setSkillQuery(event.target.value)
                            }
                            placeholder="Search skills..."
                        />
                    </div>
                </div>

                <div className="max-h-[560px] overflow-y-auto border-t border-gray-100 pt-6">
                    {filteredSkills.length === 0 ? (
                        <div className="rounded-[24px] border border-dashed border-gray-200 bg-gray-50 px-5 py-6 text-[15px] text-gray-500">
                            No skills match that search.
                        </div>
                    ) : (
                        <div className="grid gap-4">
                            {filteredSkills.map((skill) => {
                                const selected = selectedSkillIds.includes(
                                    skill.id,
                                );
                                const isPrivateRestricted =
                                    skill.shared === null &&
                                    !skill.canManage &&
                                    !access.isAdmin;
                                return (
                                    <button
                                        key={skill.id}
                                        type="button"
                                        disabled={
                                            !canManage || isPrivateRestricted
                                        }
                                        onClick={() => {
                                            if (
                                                !canManage ||
                                                isPrivateRestricted
                                            ) {
                                                return;
                                            }
                                            setSelectedSkillIds((current) =>
                                                current.includes(skill.id)
                                                    ? current.filter(
                                                          (entry) =>
                                                              entry !==
                                                              skill.id,
                                                      )
                                                    : [...current, skill.id],
                                            );
                                        }}
                                        className={`flex items-start gap-4 rounded-[24px] border px-5 py-5 text-left transition ${
                                            selected
                                                ? "border-[#0f172a] bg-[#f8fafc]"
                                                : "border-gray-200 bg-white hover:border-gray-300"
                                        } ${isPrivateRestricted ? "cursor-not-allowed opacity-60" : !canManage ? "cursor-default" : "cursor-pointer"}`}
                                    >
                                        {selected ? (
                                            <CheckCircle2 className="mt-0.5 h-7 w-7 shrink-0 text-[#0f172a]" />
                                        ) : (
                                            <Circle className="mt-0.5 h-7 w-7 shrink-0 text-gray-300" />
                                        )}
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-3">
                                                <span className="text-[18px] font-semibold tracking-[-0.03em] text-gray-950">
                                                    {skill.title}
                                                </span>
                                                <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                                                    {parseSkillCategory(
                                                        skill.skillText,
                                                    ) ??
                                                        getSkillVisibilityLabel(
                                                            skill.shared,
                                                        )}
                                                </span>
                                                <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                                                    {getSkillVisibilityLabel(
                                                        skill.shared,
                                                    )}
                                                </span>
                                            </div>
                                            <p className="mt-2 text-[15px] leading-7 text-gray-500">
                                                {skill.description ||
                                                    "No description yet."}
                                            </p>
                                            {isPrivateRestricted ? (
                                                <p className="mt-3 text-[13px] text-amber-600">
                                                    Private skills can only be
                                                    added by their creator or an
                                                    org admin.
                                                </p>
                                            ) : null}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
