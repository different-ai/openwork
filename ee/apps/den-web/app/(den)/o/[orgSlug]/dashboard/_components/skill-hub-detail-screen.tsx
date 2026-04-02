"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, BookOpen, Pencil } from "lucide-react";
import { buttonVariants } from "../../../../_components/ui/button";
import {
  getEditSkillHubRoute,
  getSkillDetailRoute,
  getSkillHubsRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatSkillTimestamp,
  getHubAccent,
  getSkillVisibilityLabel,
  parseSkillCategory,
  useOrgSkillLibrary,
} from "./skill-hub-data";

export function SkillHubDetailScreen({ skillHubId }: { skillHubId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { skillHubs, busy, error } = useOrgSkillLibrary(orgId);
  const skillHub = useMemo(() => skillHubs.find((entry) => entry.id === skillHubId) ?? null, [skillHubId, skillHubs]);

  if (busy && !skillHub) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading hub details...
        </div>
      </div>
    );
  }

  if (!skillHub) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
          {error ?? "That hub could not be found."}
        </div>
      </div>
    );
  }

  const accent = getHubAccent(skillHub.name);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
      <div className="mb-8 flex items-center justify-between gap-4">
        <Link
          href={getSkillHubsRoute(orgSlug)}
          className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
        >
          <ArrowLeft className="h-5 w-5" />
          Back
        </Link>

        {skillHub.canManage ? (
          <Link href={getEditSkillHubRoute(orgSlug, skillHub.id)} className={buttonVariants({ variant: "secondary" })}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit Hub
          </Link>
        ) : null}
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="overflow-hidden rounded-[36px] border border-gray-200 bg-white shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
          <div className="relative h-56 border-b border-gray-100" style={{ backgroundImage: `${accent.grain}, ${accent.gradient}` }}>
            <div className="absolute bottom-[-32px] left-8 flex h-24 w-24 items-center justify-center rounded-[28px] border border-white/70 bg-white shadow-[0_20px_35px_-24px_rgba(15,23,42,0.45)]">
              <BookOpen className="h-9 w-9 text-gray-800" />
            </div>
          </div>

          <div className="px-8 pb-8 pt-14">
            <div className="mb-8 flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-gray-100 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                {skillHub.skills.length} {skillHub.skills.length === 1 ? "Skill" : "Skills"}
              </span>
              <span className="rounded-full bg-gray-100 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                {skillHub.access.teams.length} {skillHub.access.teams.length === 1 ? "Team" : "Teams"}
              </span>
              <span className="rounded-full bg-gray-100 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                {skillHub.access.members.length} direct member{skillHub.access.members.length === 1 ? "" : "s"}
              </span>
            </div>

            <h1 className="text-[48px] font-semibold tracking-[-0.08em] text-gray-950">{skillHub.name}</h1>
            <p className="mt-5 max-w-[20ch] text-[28px] leading-[1.35] tracking-[-0.05em] text-gray-500">
              {skillHub.description || "A curated library of reusable skills for your team."}
            </p>

            <div className="mt-8 border-t border-gray-100 pt-8">
              <p className="mb-5 text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Included Skills</p>
              <div className="grid gap-4">
                {skillHub.skills.length === 0 ? (
                  <div className="rounded-[28px] border border-dashed border-gray-200 bg-[#f8fafc] px-6 py-8 text-[15px] text-gray-500">
                    This hub does not include any skills yet.
                  </div>
                ) : (
                  skillHub.skills.map((skill) => (
                    <Link
                      key={skill.id}
                      href={getSkillDetailRoute(orgSlug, skill.id)}
                      className="rounded-[28px] border border-gray-200 bg-[#f8fafc] px-6 py-5 transition hover:border-gray-300 hover:bg-white"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-[19px] font-semibold tracking-[-0.04em] text-gray-950">{skill.title}</span>
                        <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                          {parseSkillCategory(skill.skillText) ?? getSkillVisibilityLabel(skill.shared)}
                        </span>
                        <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                          {getSkillVisibilityLabel(skill.shared)}
                        </span>
                      </div>
                      <p className="mt-3 text-[15px] leading-8 text-gray-500">
                        {skill.description || "Open this skill to inspect the full instructions."}
                      </p>
                    </Link>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="grid gap-4 self-start">
          <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Assigned Teams</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {skillHub.access.teams.length === 0 ? (
                <span className="text-[15px] leading-7 text-gray-500">No teams assigned yet.</span>
              ) : (
                skillHub.access.teams.map((team) => (
                  <span key={team.teamId} className="rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
                    {team.name}
                  </span>
                ))
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Direct Access</p>
            <div className="mt-4 grid gap-3">
              {skillHub.access.members.length === 0 ? (
                <span className="text-[15px] leading-7 text-gray-500">No direct member grants.</span>
              ) : (
                skillHub.access.members.map((member) => (
                  <div key={member.id} className="rounded-[20px] bg-[#f8fafc] px-4 py-3">
                    <p className="text-[15px] font-medium tracking-[-0.03em] text-gray-950">{member.user.name}</p>
                    <p className="mt-1 text-[13px] text-gray-400">{member.user.email}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Last Updated</p>
            <p className="mt-3 text-[22px] font-semibold tracking-[-0.05em] text-gray-950">{formatSkillTimestamp(skillHub.updatedAt)}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
