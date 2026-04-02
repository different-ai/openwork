"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BookOpen, FileText, Plus, Search } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
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
  getSkillVisibilityLabel,
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

    return skills.filter((skill) =>
      skill.title.toLowerCase().includes(normalizedQuery) ||
      (skill.description ?? "").toLowerCase().includes(normalizedQuery),
    );
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
          <div>
            <DenInput
              type="search"
              icon={Search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeView === "hubs" ? "Search hubs..." : "Search skills..."}
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
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {filteredHubs.map((skillHub) => (
              <Link
                key={skillHub.id}
                href={getSkillHubRoute(orgSlug, skillHub.id)}
                className="block overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-8px_rgba(15,23,42,0.1)]"
              >
                {/* Gradient header */}
                <div className="relative h-36 overflow-hidden border-b border-gray-100">
                  <div className="absolute inset-0">
                    <PaperMeshGradient seed={skillHub.id} speed={0} />
                  </div>
                  <div className="absolute bottom-[-20px] left-6 flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/60 bg-white shadow-[0_12px_24px_-12px_rgba(15,23,42,0.3)]">
                    <BookOpen className="h-6 w-6 text-gray-700" />
                  </div>
                </div>

                {/* Body */}
                <div className="px-6 pb-5 pt-9">
                  <h2 className="mb-1.5 text-[15px] font-semibold text-gray-900">
                    {skillHub.name}
                  </h2>
                  <p className="line-clamp-2 text-[13px] leading-[1.6] text-gray-400">
                    {skillHub.description || "A curated library of reusable skills for this organization."}
                  </p>

                  <div className="mt-5 flex items-center gap-2 border-t border-gray-100 pt-4">
                    <span className="inline-flex rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-500">
                      {skillHub.skills.length} {skillHub.skills.length === 1 ? "Skill" : "Skills"}
                    </span>
                    <span className="ml-auto text-[13px] font-medium text-gray-500">
                      View Hub
                    </span>
                  </div>
                </div>
              </Link>
            ))}
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
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filteredSkills.map((skill) => (
            <Link
              key={skill.id}
              href={getSkillDetailRoute(orgSlug, skill.id)}
              className="block overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-8px_rgba(15,23,42,0.1)]"
            >
              {/* Gradient header — seeded by skill id */}
              <div className="relative h-36 overflow-hidden border-b border-gray-100">
                <div className="absolute inset-0">
                  <PaperMeshGradient seed={skill.id} speed={0} />
                </div>
                <div className="absolute bottom-[-20px] left-6 flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/60 bg-white shadow-[0_12px_24px_-12px_rgba(15,23,42,0.3)]">
                  <FileText className="h-6 w-6 text-gray-700" />
                </div>
              </div>

              {/* Body */}
              <div className="px-6 pb-5 pt-9">
                <h2 className="mb-1.5 text-[15px] font-semibold text-gray-900">
                  {skill.title}
                </h2>
                <p className="line-clamp-2 text-[13px] leading-[1.6] text-gray-400">
                  {skill.description || "Open this skill to view its instructions."}
                </p>

                <div className="mt-5 flex items-center gap-2 border-t border-gray-100 pt-4">
                  <span className="inline-flex rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-500">
                    {getSkillVisibilityLabel(skill.shared)}
                  </span>
                  <span className="ml-auto text-[12px] text-gray-400">
                    {formatSkillTimestamp(skill.updatedAt)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
