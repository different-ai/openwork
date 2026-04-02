"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BookOpen, FileText, Pencil, Plus, Search } from "lucide-react";
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

function ViewToggle({
  activeView,
  onChange,
}: {
  activeView: SkillLibraryView;
  onChange: (value: SkillLibraryView) => void;
}) {
  return (
    <div className="inline-flex rounded-[28px] border border-gray-200 bg-white p-1 shadow-[0_8px_20px_-16px_rgba(15,23,42,0.3)]">
      {([
        ["hubs", "Hubs", BookOpen],
        ["skills", "All Skills", FileText],
      ] as const).map(([value, label, Icon]) => {
        const selected = activeView === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            className={`inline-flex items-center gap-2 rounded-[22px] px-5 py-3 text-[15px] font-medium tracking-[-0.02em] transition-all ${
              selected
                ? "bg-white text-gray-950 shadow-[0_8px_20px_-18px_rgba(15,23,42,0.4)]"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

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
    <div className="mx-auto w-full max-w-[1380px] px-6 py-8 md:px-8">
      <div className="mb-8 flex flex-col gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
          {activeOrg?.name ?? "Organization library"}
        </p>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">Skill Hubs</h1>
            <p className="mt-3 max-w-[700px] text-[16px] leading-8 text-gray-500">
              Curate shared skill libraries for each team, then publish reusable skills your whole organization can discover.
            </p>
          </div>

          <div className="flex flex-wrap gap-3 text-[13px] font-medium text-gray-600">
            <span className="rounded-full border border-gray-200 bg-white px-4 py-2">
              {skillHubs.length} {skillHubs.length === 1 ? "hub" : "hubs"}
            </span>
            <span className="rounded-full border border-gray-200 bg-white px-4 py-2">
              {skills.length} {skills.length === 1 ? "skill" : "skills"}
            </span>
            <span className="rounded-full border border-gray-200 bg-white px-4 py-2">
              {orgContext?.teams.length ?? 0} {orgContext?.teams.length === 1 ? "team" : "teams"}
            </span>
          </div>
        </div>
      </div>

      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-4">
          <ViewToggle activeView={activeView} onChange={setActiveView} />
          <label className="relative block max-w-[640px]">
            <span className="pointer-events-none absolute inset-y-0 left-5 flex items-center text-gray-400">
              <Search className="h-5 w-5" />
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeView === "hubs" ? "Search hubs..." : "Search skills..."}
              className="h-16 w-full rounded-full border border-gray-200 bg-white pl-14 pr-5 text-[15px] text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-300 focus:ring-4 focus:ring-gray-900/5"
            />
          </label>
        </div>

        <Link
          href={activeView === "hubs" ? getNewSkillHubRoute(orgSlug) : getNewSkillRoute(orgSlug)}
          className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-[#0f172a] px-6 text-[15px] font-medium text-white transition hover:bg-[#111c33]"
        >
          <Plus className="h-4 w-4" />
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
              <button
                type="button"
                onClick={() => setActiveView("skills")}
                className="mt-6 inline-flex h-12 items-center justify-center rounded-full border border-gray-200 bg-white px-5 text-[14px] font-medium text-gray-800 transition hover:border-gray-300 hover:text-gray-950"
              >
                Browse all skills
              </button>
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
    </div>
  );
}
