"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BookOpen, FileText, Pencil, Plus, Search } from "lucide-react";
import { UnderlineTabs } from "../../../../_components/ui/tabs";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import {
  getNewSkillHubRoute,
  getNewSkillRoute,
  getSkillDetailRoute,
  getSkillHubRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatSkillTimestamp,
  getSkillBodyPreview,
  getHubAccent,
  getSkillVisibilityLabel,
  parseSkillCategory,
  useOrgSkillLibrary,
} from "./skill-hub-data";

type SkillLibraryView = "hubs" | "skills";

const SKILL_LIBRARY_TABS = [
  { value: "hubs" as const, label: "Hubs", icon: BookOpen },
  { value: "skills" as const, label: "All Skills", icon: FileText },
];

export function SkillHubsScreen() {
  const { activeOrg, orgId, orgSlug, orgContext } = useOrgDashboard();
  const { skills, skillHubs, busy, error } = useOrgSkillLibrary(orgId);
  const [activeView, setActiveView] = useState<SkillLibraryView>("hubs");
  const [query, setQuery] = useState("");

  const filteredHubs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return skillHubs;
    }

    return skillHubs.filter((skillHub) => {
      return (
        skillHub.name.toLowerCase().includes(normalizedQuery) ||
        (skillHub.description ?? "").toLowerCase().includes(normalizedQuery) ||
        skillHub.access.teams.some((team) => team.name.toLowerCase().includes(normalizedQuery))
      );
    });
  }, [query, skillHubs]);

  const filteredSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return skills;
    }

    return skills.filter((skill) => {
      const category = parseSkillCategory(skill.skillText) ?? "";
      return (
        skill.title.toLowerCase().includes(normalizedQuery) ||
        (skill.description ?? "").toLowerCase().includes(normalizedQuery) ||
        category.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [query, skills]);

  return (
    <DashboardPageTemplate
      icon={BookOpen}
      badgeLabel="New"
      title="Skill Hubs"
      description="Curate shared skill libraries for each team, then publish reusable skills your whole organization can discover."
      colors={["#FFF0F3", "#881337", "#F43F5E", "#FDA4AF"]}
    >
      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-4">
          <UnderlineTabs tabs={SKILL_LIBRARY_TABS} activeTab={activeView} onChange={setActiveView} />
          <div className="max-w-[640px]">
            <DenInput
              type="search"
              icon={Search}
              iconSize={20}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeView === "hubs" ? "Search hubs..." : "Search skills..."}
              className="h-16 rounded-full pr-5 text-[15px]"
            />
          </div>
        </div>

        <Link
          href={activeView === "hubs" ? getNewSkillHubRoute(orgSlug) : getNewSkillRoute(orgSlug)}
          className={buttonVariants({ variant: "primary" })}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {activeView === "hubs" ? "Create Hub" : "Add Skill"}
        </Link>
      </div>

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error}
        </div>
      ) : null}

      {busy ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading your skill library...
        </div>
      ) : activeView === "hubs" ? (
        filteredHubs.length === 0 ? (
          <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
            <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
              {skillHubs.length === 0 ? "No skill hubs yet." : "No skill hubs match that search yet."}
            </p>
            <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-gray-500">
              {skillHubs.length === 0
                ? "Create your first hub to organize shared skills by team and control who can access each collection."
                : "Try a different search term, or switch to All Skills to browse the individual skills already available in this org."}
            </p>
            {skillHubs.length === 0 && skills.length > 0 ? (
              <DenButton
                variant="secondary"
                className="mt-6"
                onClick={() => setActiveView("skills")}
              >
                Browse all skills
              </DenButton>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
            {filteredHubs.map((skillHub) => {
              const accent = getHubAccent(skillHub.name);
              return (
                <Link
                  key={skillHub.id}
                  href={getSkillHubRoute(orgSlug, skillHub.id)}
                  className="block overflow-hidden rounded-[32px] border border-gray-200 bg-white shadow-[0_18px_48px_-34px_rgba(15,23,42,0.28)] transition hover:-translate-y-0.5 hover:border-gray-300"
                >
                  <div className="relative h-44 border-b border-gray-100" style={{ backgroundImage: `${accent.grain}, ${accent.gradient}` }}>
                    <div className="absolute bottom-[-28px] left-8 flex h-20 w-20 items-center justify-center rounded-[24px] border border-white/70 bg-white shadow-[0_20px_35px_-24px_rgba(15,23,42,0.45)]">
                      <BookOpen className="h-8 w-8 text-gray-800" />
                    </div>
                  </div>

                  <div className="px-8 pb-8 pt-12">
                    <div className="mb-8 min-h-[128px]">
                      <div className="mb-4 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                        <span className="rounded-full bg-white/75 px-3 py-1 text-gray-600 backdrop-blur">
                          {skillHub.access.members.length} direct
                        </span>
                        <span className="rounded-full bg-white/75 px-3 py-1 text-gray-600 backdrop-blur">
                          {skillHub.access.teams.length} team access
                        </span>
                      </div>
                      <h2 className="mb-3 text-[21px] font-semibold tracking-[-0.04em] text-gray-950">
                        {skillHub.name}
                      </h2>
                      <p className="max-w-[38ch] text-[15px] leading-8 text-gray-500">
                        {skillHub.description || "A curated library of reusable skills for this organization."}
                      </p>
                    </div>

                    <div className="flex items-center gap-3 border-t border-gray-100 pt-6">
                      <span className="inline-flex rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
                        {skillHub.skills.length} {skillHub.skills.length === 1 ? "Skill" : "Skills"}
                      </span>
                      <span className="inline-flex rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
                        {skillHub.access.teams.length} {skillHub.access.teams.length === 1 ? "Team" : "Teams"}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-2 text-[15px] font-medium text-gray-700">
                        {skillHub.canManage ? <Pencil className="h-4 w-4" /> : null}
                        {skillHub.canManage ? "View Hub" : "Open"}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )
      ) : filteredSkills.length === 0 ? (
        <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
            {skills.length === 0 ? "No skills have been added yet." : "No skills match that search yet."}
          </p>
          <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-gray-500">
            {skills.length === 0
              ? "Add your first skill to start building the hub library, then group it into team-specific hubs."
              : "Try a broader search or switch back to Hubs to manage curated collections."}
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {filteredSkills.map((skill) => {
            const category = parseSkillCategory(skill.skillText) ?? getSkillVisibilityLabel(skill.shared);
            return (
              <Link
                key={skill.id}
                href={getSkillDetailRoute(orgSlug, skill.id)}
                className="rounded-[28px] border border-gray-200 bg-white p-7 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)] transition hover:-translate-y-0.5 hover:border-gray-300"
              >
                <div className="mb-6 flex items-start gap-4">
                  <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[24px] border border-gray-100 bg-gray-50 text-gray-400">
                    <FileText className="h-8 w-8" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-[20px] font-semibold tracking-[-0.04em] text-gray-950">
                      {skill.title}
                    </h2>
                    <p className="mt-2 text-[13px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                      {category}
                    </p>
                  </div>
                </div>

                <p className="text-[15px] leading-8 text-gray-500">
                  {skill.description || getSkillBodyPreview(skill.skillText, { name: skill.title, description: skill.description }) || "Open the skill to view its instructions and usage details."}
                </p>

                <div className="mt-8 flex items-center justify-between gap-3 text-[13px] text-gray-400">
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-gray-100 px-3 py-1.5 text-gray-500">{getSkillVisibilityLabel(skill.shared)}</span>
                    {skill.canManage ? <span className="rounded-full bg-gray-100 px-3 py-1.5 text-gray-500">Manageable</span> : null}
                  </div>
                  <span>{formatSkillTimestamp(skill.updatedAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
