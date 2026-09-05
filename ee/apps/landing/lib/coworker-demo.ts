import type { AvatarColor, AvatarGlasses } from "../components/coworker-brand";
import type { Personality } from "../../../../apps/coworker/src/lib/personalities";

export type StockCoworkerId = "scout" | "editor" | "ops";
export type CoworkerId = StockCoworkerId | `custom-${number}`;
export type DemoView = "chat" | "documents" | "assignments" | "connections" | "group" | "create";

/** Fictional, deterministic examples of the app's conversations, documents,
 * assignments, and OpenWork Connect. No providers or customer data are used. */
export const TEAM: Array<{ id: StockCoworkerId; name: string; role: string; color: AvatarColor; glasses: AvatarGlasses }> = [
  { id: "scout", name: "Scout", role: "Research", color: "blue", glasses: "round" },
  { id: "editor", name: "Editor", role: "Writing", color: "rose", glasses: "square" },
  { id: "ops", name: "Ops", role: "Operations", color: "mint", glasses: "none" },
];

export type DemoQuestion = { prompt: string; options: Array<{ label: string; description: string; reply: string }> };
export type DemoCoworker = { name: string; role: string; mission: string; responsibilities: string[]; color: AvatarColor; glasses: AvatarGlasses; personality: Personality };
export const COWORKER_STARTERS: Array<{ id: string; label: string; coworker: DemoCoworker }> = [
  { id: "research", label: "Research", coworker: { name: "Milo", role: "Research partner", mission: "Turn scattered information into a clear next step.", responsibilities: ["Compare options and recommend one", "Turn research into a short brief", "Prepare a weekly research roundup"], color: "violet", glasses: "round", personality: "warm" } },
  { id: "growth", label: "Growth", coworker: { name: "Nova", role: "Growth partner", mission: "Help turn product ideas into campaigns people care about.", responsibilities: ["Draft campaign ideas and launch copy", "Review feedback for the next experiment", "Prepare a weekly campaign review"], color: "rose", glasses: "square", personality: "curious" } },
  { id: "support", label: "Support", coworker: { name: "Ellis", role: "Customer support partner", mission: "Help customers get clear answers and make their feedback useful.", responsibilities: ["Draft helpful replies for review", "Spot recurring customer questions", "Prepare a weekly feedback digest"], color: "mint", glasses: "none", personality: "thoughtful" } },
];
export const DEFAULT_DEMO_COWORKER = COWORKER_STARTERS[0]!.coworker;

export type Example = {
  question: string;
  answer: string;
  followUp: string;
  reply: string;
  document: { title: string; eyebrow: string; intro: string; points: string[]; next: string };
  assignment: { title: string; description: string; result: string };
  routine: string;
  responsibilities: string[];
  clarification: DemoQuestion;
};

export const EXAMPLES: Record<StockCoworkerId, Example> = {
  scout: {
    question: "How’s the launch brief coming along?",
    answer: "First draft’s ready. I pulled the key points into a short brief. Take a look when you have a moment.",
    followUp: "What should we focus on first?",
    reply: "Start with one useful moment: someone checking in on a draft and finding it ready to review. We can build the launch story around that.",
    document: {
      title: "Launch brief", eyebrow: "Research · Draft for review",
      intro: "Make the first minute feel useful. Show a coworker helping with something familiar, then let people try it themselves.",
      points: ["Lead with a real task, such as a first draft or a short research brief.", "Let visitors explore the conversation and open the work it produced.", "Make the next step clear: choose a coworker and give it a starting point."],
      next: "Choose one example for launch day and ask a few early users to try it.",
    },
    assignment: { title: "Compare three launch examples", description: "Recommend the clearest example for a first-time visitor.", result: "The draft-review example is the easiest to understand. It shows a request, a useful result, and a natural next step." },
    routine: "Weekly research roundup",
    responsibilities: ["Compare options", "Write research briefs", "Share a weekly roundup"],
    clarification: { prompt: "Who should this brief help first?", options: [
      { label: "Founders", description: "A useful first step for a small team.", reply: "I’ll focus the brief on a founder’s first useful task: compare three launch ideas, choose one, and get a draft ready to review." },
      { label: "Marketing teams", description: "From research to a campaign draft.", reply: "I’ll focus the brief on the campaign handoff: research the angle, write an opening, and agree on the next experiment." },
    ] },
  },
  editor: {
    question: "Could you help with the announcement?",
    answer: "I’ve put together a short first draft. It keeps the focus on the people doing the work, with a simple invitation to try it.",
    followUp: "Make the opening a little warmer.",
    reply: "How about: ‘Good work starts with a little company. Meet your new coworkers.’ I’ve added that as an alternative opening in the draft.",
    document: {
      title: "Announcement draft", eyebrow: "Writing · Draft for review",
      intro: "Your work. Better together. Meet your AI coworkers: a little help with the research, the first draft, and whatever comes next.",
      points: ["Give a coworker a role and something to work on.", "Drop into the conversation when you want to shape the next step.", "Review the result and make it your own."],
      next: "Meet your next coworker. Start with one task you would love a little help with.",
    },
    assignment: { title: "Write three announcement openings", description: "Keep them short, warm, and easy to understand.", result: "Three directions: ‘Your work. Better together.’, ‘A little company for your next big idea.’, and ‘Meet the newest member of your team.’" },
    routine: "Monday editorial check-in",
    responsibilities: ["Draft announcements", "Refine tone and wording", "Prepare an editorial check-in"],
    clarification: { prompt: "Where will we use this opening?", options: [
      { label: "On the website", description: "A short headline and an invitation.", reply: "For the website: ‘Good work starts with a little company.’ Follow it with one useful example and an invitation to meet your coworker." },
      { label: "In a launch email", description: "A personal introduction to your coworkers.", reply: "For the email: ‘Meet the newest member of your team.’ I’ll keep the introduction short, show a first draft, and finish with an invitation to try it." },
    ] },
  },
  ops: {
    question: "Where are we with the launch checklist?",
    answer: "The sample checklist is ready. I’ve separated what’s done from what needs a decision, so you can see the next step at a glance.",
    followUp: "What still needs a decision?",
    reply: "Two things: pick the launch example and confirm the first release date. I’ve kept both at the top of the checklist.",
    document: {
      title: "Launch checklist", eyebrow: "Operations · Working checklist",
      intro: "A small checklist to keep launch day moving. One owner for each task, and a clear place for decisions.",
      points: ["Ready: first announcement draft and product walkthrough.", "Needs a decision: the launch example and release date.", "Next: invite early users and collect feedback on their first task."],
      next: "Review the two open decisions together, then share the final checklist.",
    },
    assignment: { title: "Prepare the launch handoff", description: "Summarize the open decisions and the next three actions.", result: "Confirm the example, choose the release date, then invite early users. Keep the announcement and checklist in the same handoff." },
    routine: "Friday progress digest",
    responsibilities: ["Keep a launch checklist", "Clarify owners and next steps", "Prepare a progress digest"],
    clarification: { prompt: "Which decision should we work through first?", options: [
      { label: "The launch example", description: "Choose the story we want to show.", reply: "Let’s start with the draft-review example. I’ll put the brief, announcement, and walkthrough into one handoff for you to review." },
      { label: "The release plan", description: "Make the remaining work clear.", reply: "I’ll start with the release plan: list the remaining checks, agree who owns each one, and leave the release date for your decision." },
    ] },
  },
};

/** Custom examples use the visitor's chosen responsibilities throughout;
 * they never inherit Scout's launch assignments or claim a live action. */
export function customExample(coworker: DemoCoworker, answer: number | null): Example {
  const firstTask = coworker.responsibilities[answer ?? 0]!;
  return {
    question: "Let’s plan our first task.",
    answer: "Hi, I’m " + coworker.name + ". Here’s what I’ll help you take care of. We can start with one small task and shape it together.",
    followUp: "Help me choose a first task.",
    reply: "Your mission is: “" + coworker.mission + "” Let’s pick one responsibility to start with.",
    responsibilities: coworker.responsibilities,
    clarification: { prompt: "What should we start with?", options: coworker.responsibilities.map((label) => ({ label, description: "Start with a draft you can review together.", reply: "Let’s start with: “" + label + "”. Share a few example notes, and we’ll turn them into a first draft for your review." })) },
    document: { title: coworker.name + "’s working plan", eyebrow: coworker.role + " · Sample plan", intro: coworker.mission, points: coworker.responsibilities, next: "Choose a responsibility in the chat, then give your coworker a starting point." },
    assignment: { title: firstTask, description: coworker.mission, result: "Sample handoff: collect the relevant notes, prepare a first draft for “" + firstTask + "”, and ask you to review the next step." },
    routine: coworker.responsibilities[2]!,
  };
}

export const DEMO_VIEWS: Array<{ id: DemoView; label: string }> = [
  { id: "chat", label: "Chat" }, { id: "documents", label: "Documents" },
  { id: "assignments", label: "Assignments" }, { id: "connections", label: "Connections" },
];
