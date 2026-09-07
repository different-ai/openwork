import type { TeamDraft, TeamRole } from "./bridge.ts";

/** Small, editable starting teams. Roles describe responsibilities, never granted access or active schedules. */
type WorkPattern = { id: string; label: string; outcome: string; jobs: Array<{ roleId: string; mission: string }> };
export const WORK_PATTERNS: WorkPattern[] = [
  { id: "marketing", label: "Marketing & content", outcome: "Research → draft → review a weekly campaign.", jobs: [
    { roleId: "research", mission: "I compare audience questions and competing messages, then prepare a sourced campaign brief." },
    { roleId: "writing", mission: "I turn the campaign brief into consistent posts, emails, and a content calendar for your review." },
  ] },
  { id: "sales", label: "Sales & account management", outcome: "Prepare accounts → draft follow-ups → review next steps.", jobs: [
    { roleId: "sales", mission: "I prepare account briefs and draft personal follow-ups, keeping promises and next steps visible for your review." },
    { roleId: "operations", mission: "I organize deal checklists and flag overdue next steps so important conversations stay on track." },
  ] },
  { id: "founder", label: "Founder & small business", outcome: "Compare opportunities → choose priorities → plan the week.", jobs: [
    { roleId: "research", mission: "I compare market opportunities and customer signals, making assumptions and missing evidence clear." },
    { roleId: "operations", mission: "I turn your priorities into a practical weekly plan with owners, next steps, and open decisions." },
  ] },
  { id: "product", label: "Product & engineering", outcome: "Explore a problem → prepare a spec → review delivery.", jobs: [
    { roleId: "product", mission: "I turn a product problem into a scoped spec, implementation checklist, and release review." },
    { roleId: "research", mission: "I synthesize user feedback and technical options, separating evidence from assumptions before the team builds." },
  ] },
  { id: "consulting", label: "Consulting & research", outcome: "Gather evidence → synthesize findings → prepare a brief.", jobs: [
    { roleId: "research", mission: "I investigate a client question, compare reliable sources, and surface evidence, gaps, and tradeoffs." },
    { roleId: "writing", mission: "I turn research into a clear client brief with recommendations, sources, and decisions for review." },
  ] },
  { id: "support", label: "Customer success & support", outcome: "Triage feedback → draft replies → prepare a handoff.", jobs: [
    { roleId: "support", mission: "I sort customer questions, draft thoughtful replies, and flag sensitive cases for a person to review." },
    { roleId: "product", mission: "I group recurring customer feedback into actionable product issues with impact and reproduction details." },
  ] },
  { id: "people", label: "People & recruiting", outcome: "Prepare role briefs → organize interviews → support onboarding.", jobs: [
    { roleId: "writing", mission: "I draft clear role descriptions, interview guides, and onboarding materials for your review." },
    { roleId: "operations", mission: "I organize interview logistics and onboarding checklists, leaving hiring decisions to people." },
  ] },
  { id: "education", label: "Education & training", outcome: "Research a topic → draft a lesson → prepare practice.", jobs: [
    { roleId: "research", mission: "I find and check sources for a lesson, matching the material to the learners and learning goals." },
    { roleId: "writing", mission: "I turn learning goals into clear lessons, practice exercises, and feedback prompts for your review." },
  ] },
];

export function workPattern(id: string) { return WORK_PATTERNS.find((pattern) => pattern.id === id); }

export function patternDrafts(drafts: TeamDraft[], patternId: string): TeamDraft[] {
  const pattern = workPattern(patternId);
  return drafts.map((draft) => {
    const job = pattern?.jobs.find((item) => item.roleId === draft.roleId);
    return job ? { ...draft, mission: job.mission } : draft;
  });
}

export function rolesForPattern(catalog: TeamRole[], patternId: string): TeamRole[] {
  const jobs = workPattern(patternId)?.jobs ?? [];
  return [...catalog].sort((a, b) => {
    const rank = (role: TeamRole) => { const index = jobs.findIndex((job) => job.roleId === role.id); return index < 0 ? jobs.length : index; };
    return rank(a) - rank(b);
  }).map((role) => {
    const job = jobs.find((item) => item.roleId === role.id);
    return job ? { ...role, mission: job.mission, pitch: job.mission} : role;
  });
}

export function teamAdvicePrompt(description: string, patternId: string): string {
  const pattern = workPattern(patternId);
  return [
    "Help me shape my coworker team around my work.",
    ...(pattern ? [`My area: ${pattern.label}. A starting workflow: ${pattern.outcome}`] : []),
    `What I need: ${description.trim()}`,
    "Review who is already on my team. Recommend a small, practical workflow: who owns each step, what they hand over, and where I review the result. Prefer existing teammates. If a useful role is missing, use coworker_team_suggest to offer the single most helpful addition and explain why; I will decide whether to add them. If a suggestion cannot be offered yet, explain the recommendation in the reply. Do not create schedules, change settings, or send anything to other people.",
  ].join("\n\n");
}
