import { Boxes, LayoutDashboard, Network, Plug, Route, SlidersHorizontal, Users } from "lucide-react";
import {
  getAiGatewayProvidersRoute,
  getAiGatewayRoute,
  getInferenceRoute,
  getNewAiGatewayLimitRoute,
  getNewAiGatewayProviderRoute,
  getNewAiGatewaySmartRouterRoute,
  permissionLockReason,
} from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { AiGatewayExample } from "./examples/ai-gateway/gateway-example";
import { LimitsExample } from "./examples/ai-gateway/limits-example";
import { OpenWorkModelsExample } from "./examples/ai-gateway/openwork-models-example";
import { OverviewExample } from "./examples/ai-gateway/overview-example";
import { ProvidersExample } from "./examples/ai-gateway/providers-example";
import { SmartRouterExample } from "./examples/ai-gateway/smart-router-example";
import { UsersTeamsExample } from "./examples/ai-gateway/users-teams-example";

/**
 * Facts the AI Gateway pages report from data they already load. A missing
 * fact means "not loaded yet": a section never takes over the page on a guess.
 */
export type AiGatewayFacts = {
  /** Gateway providers (`GET /v1/inference-providers?scope=manageable`). */
  providers?: number;
  /** OpenWork Models turned on (`GET /v1/inference`). */
  openworkModels?: boolean;
  /** Who added the first provider, when it was someone else (only returned to provider managers). */
  setUpBy?: string | null;
  /** Smart Routers (`GET /v1/org/auto-routers`); only reported where the feature is on. */
  smartRouters?: number;
  /** Spend limit policies, not archived (`GET /v1/gateway/usage-limit-policies`). */
  policies?: number;
  /** Provider access grants to anyone (everyone, a team or a person). */
  accessGrants?: number;
};

type Ctx = FeatureIntroContext<AiGatewayFacts>;

const PATH = getAiGatewayRoute();
const MANAGE_PROVIDERS_LOCK = permissionLockReason("gateway_providers.manage");

function gatewaySetUp(ctx: Ctx): boolean {
  return (ctx.facts.providers ?? 0) > 0 || ctx.facts.openworkModels === true;
}

function setUpByNote(ctx: Ctx): string | null {
  return ctx.facts.setUpBy ? `Set up by ${ctx.facts.setUpBy}` : null;
}

export const aiGatewayIntros = [
  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway",
    version: 1,
    match: { path: PATH },
    icon: Network,
    title: "AI Gateway",
    summary: "Give your whole team AI models without sharing API keys.",
    highlights: [
      { title: "Your own providers.", text: "OpenAI, Anthropic, Google, Azure, Amazon Bedrock, OpenRouter and more, with keys kept on the server." },
      { title: "OpenWork Models.", text: "Hand-picked models in one subscription, with no keys to manage." },
      { title: "Access and limits.", text: "Choose who can use which models and how much they can spend." },
      { title: "Usage by person.", text: "See spend by person, team and model." },
    ],
    example: {
      Component: AiGatewayExample,
      alt: "Example: Anthropic, OpenAI and OpenWork Models shared with Engineering, Design and everyone else, each with their spend for the last 31 days.",
    },
    docsUrl: docsPage("ai-gateway/overview"),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayProviders") && !gatewaySetUp(ctx), label: "Add your first AI provider", href: getNewAiGatewayProviderRoute() },
      {
        when: (ctx) => (ctx.facts.providers ?? 0) > 0 && ctx.can("canViewGatewayProviders"),
        label: "See your providers",
        href: getAiGatewayProvidersRoute(),
        note: setUpByNote,
      },
      { when: (ctx) => ctx.facts.openworkModels === true && ctx.can("canViewModelsSettings"), label: "See OpenWork Models", href: getInferenceRoute() },
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Add your first AI provider", href: getNewAiGatewayProviderRoute() },
      { when: () => true, label: "Add your first AI provider", href: getNewAiGatewayProviderRoute(), locked: { reason: MANAGE_PROVIDERS_LOCK } },
    ],
    // Full screen only once both facts are known and neither is set up.
    setupState: (ctx) => {
      if (ctx.facts.providers === undefined || ctx.facts.openworkModels === undefined) return "done";
      return gatewaySetUp(ctx) ? "done" : "none";
    },
  }),

  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway.overview",
    parent: "ai-gateway",
    version: 1,
    match: { path: PATH, tab: "overview" },
    icon: LayoutDashboard,
    title: "Overview",
    summary: "See what your team spends on AI, by person, team and model.",
    highlights: [
      { title: "Spend over time.", text: "Daily usage and estimated cost for the last 31 days." },
      { title: "Who uses what.", text: "The people, teams and models with the most spend." },
      { title: "Every provider.", text: "Your own providers and OpenWork Models, in one place." },
    ],
    example: { Component: OverviewExample, alt: "Example: $391 of spend over the last 14 days, with the three people who used the most." },
    docsUrl: docsPage("ai-gateway/usage-dashboard"),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Add an AI provider", href: getNewAiGatewayProviderRoute() },
      { when: () => true, label: "Add an AI provider", href: getNewAiGatewayProviderRoute(), locked: { reason: MANAGE_PROVIDERS_LOCK } },
    ],
    // Usage comes from your own providers, so the overview has nothing to show without one.
    setupState: (ctx) => ((ctx.facts.providers ?? 0) > 0 ? "done" : "none"),
  }),

  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway.ai-providers",
    parent: "ai-gateway",
    version: 1,
    match: { path: PATH, tab: "ai-providers" },
    icon: Plug,
    title: "AI providers",
    summary: "Share the AI accounts your company already pays for, without sharing keys.",
    highlights: [
      { title: "Keys stay on the server.", text: "Members never see or paste an API key." },
      { title: "Choose who can use it.", text: "Everyone, some teams or a few people, with all models or only some." },
      { title: "Many providers.", text: "OpenAI, Anthropic, Google, Azure, Amazon Bedrock, OpenRouter, LiteLLM and more." },
    ],
    example: { Component: ProvidersExample, alt: "Example: Anthropic for everyone and OpenAI for Engineering, both ready, and Google waiting for a key." },
    docsUrl: docsPage("ai-gateway/provider-support"),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayProviders") && (ctx.facts.providers ?? 0) === 0, label: "Add your first AI provider", href: getNewAiGatewayProviderRoute() },
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Add a provider", href: getNewAiGatewayProviderRoute() },
      { when: () => true, label: "Add a provider", href: getNewAiGatewayProviderRoute(), locked: { reason: MANAGE_PROVIDERS_LOCK } },
    ],
    setupState: (ctx) => ((ctx.facts.providers ?? 0) > 0 ? "done" : "none"),
  }),

  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway.smart-routers",
    parent: "ai-gateway",
    version: 1,
    // Smart Routers live on AI Providers; old `?tab=auto-router` links still land there.
    match: { path: PATH, tab: "auto-router" },
    icon: Route,
    title: "Smart Routers",
    summary: "One model your team picks that sends each prompt to the best of your models for it.",
    bannerText: "A Smart Router sends each prompt to the best of your models, so quick questions don't use your most expensive one.",
    highlights: [
      { title: "Lower cost.", text: "Quick questions go to a fast, cheaper model." },
      { title: "Better answers on hard work.", text: "Difficult prompts go to the model you tagged for that work." },
      { title: "Per team.", text: "Engineering and Support can each route to their own models." },
    ],
    example: {
      Component: SmartRouterExample,
      alt: "Example: Smart: Engineering with Claude Opus for debugging, Claude Haiku for quick questions and Gemini Pro for long documents, and which one answered three sample prompts.",
    },
    docsUrl: docsPage("ai-gateway/auto-model-routing"),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Set up a Smart Router", href: getNewAiGatewaySmartRouterRoute() },
      { when: () => true, label: "Set up a Smart Router", href: getNewAiGatewaySmartRouterRoute(), locked: { reason: MANAGE_PROVIDERS_LOCK } },
    ],
    // Banner only: providers exist but no router yet. Unknown (or feature off) shows nothing.
    setupState: (ctx) => {
      if ((ctx.facts.providers ?? 0) === 0 || ctx.facts.smartRouters === undefined) return "done";
      return ctx.facts.smartRouters === 0 ? "partial" : "done";
    },
  }),

  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway.limits",
    parent: "ai-gateway",
    version: 1,
    match: { path: PATH, tab: "limits" },
    icon: SlidersHorizontal,
    title: "Limits",
    summary: "Keep AI spend predictable with limits for everyone, a team or one person.",
    highlights: [
      { title: "Daily, weekly or monthly.", text: "An amount in US dollars for each period you need." },
      { title: "Pause or warn.", text: "Stop someone's models at the limit, or only flag it." },
      { title: "Ask for more.", text: "Let people request 25% more for an admin to approve." },
    ],
    example: {
      Component: LimitsExample,
      alt: "Example: Engineering has used 40% of $200 a month, Design 85% of $100 a month, and Sam Lee reached $20 a day and is paused.",
    },
    docsUrl: docsPage("ai-gateway/limits"),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayLimits"), label: "Add a limit", href: getNewAiGatewayLimitRoute() },
      { when: () => true, label: "Add a limit", href: getNewAiGatewayLimitRoute(), locked: { reason: permissionLockReason("gateway_limits.manage") } },
    ],
    setupState: (ctx) => ((ctx.facts.policies ?? 0) > 0 ? "done" : "none"),
  }),

  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway.users-and-teams",
    parent: "ai-gateway",
    version: 1,
    match: { path: PATH, tab: "users-and-teams" },
    icon: Users,
    title: "Users and teams",
    summary: "See who can use which models, their limit and what they spent.",
    bannerText: "No one can use your providers yet. Choose who gets each provider's models.",
    highlights: [
      { title: "Everyone at a glance.", text: "Each person's models, limit and spend in one row." },
      { title: "Teams.", text: "Give a whole team models and a shared limit in one step." },
    ],
    example: {
      Component: UsersTeamsExample,
      alt: "Example: everyone, Engineering and two people, each with the providers they can use, their limit and their spend.",
    },
    docsUrl: docsPage("ai-gateway/users-and-teams"),
    ctas: [
      { when: (ctx) => ctx.can("canManageGatewayProviders"), label: "Choose who can use your providers", href: getAiGatewayProvidersRoute() },
      { when: () => true, label: "Choose who can use your providers", href: getAiGatewayProvidersRoute(), locked: { reason: MANAGE_PROVIDERS_LOCK } },
    ],
    // OpenWork Models reach everyone, so only an org on its own providers alone can have nobody with access.
    setupState: (ctx) => {
      if (ctx.facts.accessGrants === undefined) return "none";
      if (ctx.facts.openworkModels === undefined) return "done";
      return ctx.facts.accessGrants === 0 && !ctx.facts.openworkModels ? "partial" : "done";
    },
  }),

  defineFeatureIntro<AiGatewayFacts>({
    key: "ai-gateway.openwork-models",
    parent: "ai-gateway",
    version: 1,
    match: { path: PATH, tab: "openwork-models" },
    icon: Boxes,
    title: "OpenWork Models",
    summary: "Hand-picked models for everyone in your workspace, with no API keys to manage.",
    highlights: [
      { title: "Made for knowledge work.", text: "A lineup chosen for research, writing, documents and spreadsheets." },
      { title: "One subscription.", text: "Covers every active member, billed through OpenWork." },
      { title: "Usage included.", text: "Shared usage limits come with the plan; see what's left on this tab." },
    ],
    example: {
      Component: OpenWorkModelsExample,
      alt: "Example: OpenWork Models on for everyone, four models with what each is best for, and 68% of this week's included usage left.",
    },
    docsUrl: docsPage("ai-gateway/openwork-models"),
    ctas: [
      { when: (ctx) => ctx.facts.openworkModels === true, label: "See OpenWork Models", href: getInferenceRoute() },
      { when: (ctx) => ctx.can("canManageBilling") || ctx.can("canManageModelsSettings"), label: "Turn on OpenWork Models", href: getInferenceRoute() },
      { when: () => true, label: "Turn on OpenWork Models", href: getInferenceRoute(), locked: { reason: permissionLockReason("billing.manage") } },
    ],
    setupState: (ctx) => (ctx.facts.openworkModels === true ? "done" : "none"),
  }),
];
