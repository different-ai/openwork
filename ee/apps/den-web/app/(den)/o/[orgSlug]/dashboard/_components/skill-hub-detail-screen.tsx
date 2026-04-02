"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, BookOpen, Pencil } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { buttonVariants } from "../../../../_components/ui/button";
import {
  getEditSkillHubRoute,
  getSkillDetailRoute,
  getSkillHubsRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatSkillTimestamp,
  getSkillVisibilityLabel,
  parseSkillCategory,
  useOrgSkillLibrary,
} from "./skill-hub-data";

export function SkillHubDetailScreen({ skillHubId }: { skillHubId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { skillHubs, busy, error } = useOrgSkillLibrary(orgId);
  const skillHub = useMemo(
    () => skillHubs.find((entry) => entry.id === skillHubId) ?? null,
    [skillHubId, skillHubs],
  );

  if (busy && !skillHub) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-400">
          Loading hub details...
        </div>
      </div>
    );
  }

  if (!skillHub) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-[13px] text-red-600">
          {error ?? "That hub could not be found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">

      {/* Nav */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getSkillHubsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        {skillHub.canManage ? (
          <Link
            href={getEditSkillHubRoute(orgSlug, skillHub.id)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit Hub
          </Link>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_240px]">

        {/* ── Main card ── */}
        <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white">

          {/* Gradient header — seeded by hub id, matches list card */}
          <div className="relative h-40 overflow-hidden border-b border-gray-100">
            <div className="absolute inset-0">
              <PaperMeshGradient seed={skillHub.id} speed={0} />
            </div>
            <div className="absolute bottom-[-20px] left-6 flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/60 bg-white shadow-[0_12px_24px_-12px_rgba(15,23,42,0.3)]">
              <BookOpen className="h-6 w-6 text-gray-700" />
            </div>
          </div>

          <div className="px-6 pb-6 pt-10">
            {/* Title + description + last updated */}
            <h1 className="text-[18px] font-semibold text-gray-900">{skillHub.name}</h1>
            {skillHub.description ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-gray-400">
                {skillHub.description}
              </p>
            ) : null}
            <p className="mt-2 text-[12px] text-gray-300">
              Updated {formatSkillTimestamp(skillHub.updatedAt)}
            </p>

            {/* Included skills */}
            <div className="mt-6 border-t border-gray-100 pt-5">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                {skillHub.skills.length === 0
                  ? "No skills yet"
                  : `${skillHub.skills.length} ${skillHub.skills.length === 1 ? "Skill" : "Skills"}`}
              </p>

              {skillHub.skills.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-100 px-5 py-6 text-[13px] text-gray-400">
                  This hub does not include any skills yet.
                </div>
              ) : (
                <div className="grid gap-1.5">
                  {skillHub.skills.map((skill) => (
                    <Link
                      key={skill.id}
                      href={getSkillDetailRoute(orgSlug, skill.id)}
                      className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 px-4 py-3 transition hover:border-gray-200 hover:bg-gray-50/60"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-gray-900">
                          {skill.title}
                        </p>
                        {skill.description ? (
                          <p className="mt-0.5 truncate text-[12px] text-gray-400">
                            {skill.description}
                          </p>
                        ) : null}
                      </div>
                      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] text-gray-400">
                        {parseSkillCategory(skill.skillText) ?? getSkillVisibilityLabel(skill.shared)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Sidebar ── */}
        <aside className="grid gap-3 self-start">

          {/* Teams */}
          <div className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Teams
            </p>
            {skillHub.access.teams.length === 0 ? (
              <span className="text-[13px] text-gray-400">No teams assigned.</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {skillHub.access.teams.map((team) => (
                  <span
                    key={team.teamId}
                    className="rounded-full bg-gray-100 px-3 py-1 text-[12px] text-gray-500"
                  >
                    {team.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Direct access — only show when populated */}
          {skillHub.access.members.length > 0 ? (
            <div className="rounded-xl border border-gray-100 bg-white p-4">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Direct Access
              </p>
              <div className="divide-y divide-gray-100">
                {skillHub.access.members.map((member) => (
                  <div key={member.id} className="py-2.5 first:pt-0 last:pb-0">
                    <p className="text-[13px] font-medium text-gray-900">
                      {member.user.name}
                    </p>
                    <p className="text-[12px] text-gray-400">{member.user.email}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

        </aside>
      </div>
    </div>
  );
}
