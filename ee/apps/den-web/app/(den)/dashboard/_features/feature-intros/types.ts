import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { DenOrgAccessFlags, DenOrgContext } from "../../../_lib/den-org";

/**
 * Every intro key, keyed by route + tab (DESIGN.md I10). Listing a key here
 * before it has content keeps "which pages still need an intro" visible.
 * Add the key here, then the intro in `intros/<section>.tsx`.
 */
export type FeatureIntroKey =
  | "ai-gateway"
  | "ai-gateway.overview"
  | "ai-gateway.ai-providers"
  | "ai-gateway.smart-routers"
  | "ai-gateway.limits"
  | "ai-gateway.users-and-teams"
  | "ai-gateway.api-keys"
  | "ai-gateway.openwork-models"
  | "members"
  | "members.teams"
  | "members.roles"
  | "members.roles.new"
  | "team-detail.role"
  | "team-detail.members"
  | "team-detail.access"
  | "team-detail.agents"
  | "team-detail.browser"
  | "team-detail.models"
  | "team-detail.workbot"
  | "team-detail.prompts"
  | "team-detail.desktop"
  | "connectors"
  | "connectors.add"
  | "connectors.access"
  | "plugins"
  | "plugins.agents"
  | "plugins.commands"
  | "plugins.hooks"
  | "plugins.mcps"
  | "plugins.sources"
  | "plugins.access"
  | "plugins.new"
  | "plugins.import"
  | "plugins.skill"
  | "library"
  | "library.connectors"
  | "library.skills"
  | "library.plugins"
  | "library.models"
  | "library.connectors.add"
  | "library.plugins.new"
  | "library.models.key"
  | "library.share"
  | "automations"
  | "home"
  | "web"
  | "desktop-policies"
  | "deployments"
  | "org-settings"
  | "diagnostics"
  | "billing"
  | "billing.invoices"
  | "api-keys"
  | "collections"
  | "collections.plugins"
  | "connectors.tool-tester"
  | "auth-security"
  | "auth-security.sso"
  | "auth-security.scim"
  | "workbot"
  | "my-bot"
  | "analytics"
  | "analytics.library"
  | "analytics.workflow-runs"
  | "audit-logs";

export type FeatureIntroSetupState = "none" | "partial" | "done";

/** One fact a page already knows, e.g. `{ providers: 2, smartRouters: 0 }`. */
export type FeatureIntroFactValue = string | number | boolean | null;
export type FeatureIntroFacts = { readonly [fact: string]: FeatureIntroFactValue | undefined };

/** Boolean permission flags from `getOrgAccessFlags`, e.g. "canManageTeams". */
export type FeatureIntroPermission = {
  [K in keyof DenOrgAccessFlags]: DenOrgAccessFlags[K] extends boolean ? K : never;
}[keyof DenOrgAccessFlags];

/**
 * What an intro can read to pick its setup state and action. `facts` are
 * supplied by the page (FeatureIntroGate / useFeatureIntro) from data it
 * already loads; a fact is missing until the page reports it.
 */
export type FeatureIntroContext<F extends FeatureIntroFacts = FeatureIntroFacts> = {
  orgId: string;
  orgSlug: string | null;
  orgContext: DenOrgContext;
  access: DenOrgAccessFlags;
  /** Owner, admin role or Admin team member. Prefer `can()` for a specific action. */
  isAdmin: boolean;
  can: (permission: FeatureIntroPermission) => boolean;
  /** Display name of an org member by member id, for "Set up by {name}". */
  memberName: (memberId: string | null | undefined) => string | null;
  facts: Partial<F>;
};

export type FeatureIntroCta<F extends FeatureIntroFacts = FeatureIntroFacts> = {
  /** First variant whose `when` matches is shown (DESIGN.md I6). */
  when(ctx: FeatureIntroContext<F>): boolean;
  /** Verb-first, sentence case, no arrow (C1, C7). */
  label: string;
  /** Goes straight to the create form or setup step (I5). Another site's URL opens in a new tab. */
  href: string;
  /** No permission: show a lock with why and who can change it instead of a button (P4, C5). */
  locked?: { reason: string };
  /** Optional quiet line under the action, e.g. "Set up by Ada". */
  note?(ctx: FeatureIntroContext<F>): string | null;
};

export type FeatureIntroHighlight = { title: string; text: string };

/** Live example rendered with sample data (I7). `alt` is read to screen readers instead. */
export type FeatureIntroExampleSpec = {
  Component: ComponentType;
  alt: string;
};

export type FeatureIntroMatch = {
  /** Full dashboard path, `:param` segments match anything, e.g. "/dashboard/members/teams/:teamId". */
  path: string;
  /** Tab value; when set the intro only matches with `?{tabParam}={tab}`. */
  tab?: string;
  /** Search param holding the tab. Defaults to "tab". */
  tabParam?: "tab" | "view" | "show";
};

export type FeatureIntro<F extends FeatureIntroFacts = FeatureIntroFacts> = {
  key: FeatureIntroKey;
  /** Bump to show the intro again to everyone. */
  version: number;
  match: FeatureIntroMatch;
  icon: LucideIcon;
  title: string;
  /** One line: what it does for the person and their team (I4). */
  summary: string;
  /** Banner line when partly set up: the missing piece. Defaults to `summary`. */
  bannerText?: string;
  /** Full screen only, ≤ 3 sentences. */
  body?: string;
  /** ≤ 4 on the full screen, the first 3 in a box. */
  highlights?: readonly FeatureIntroHighlight[];
  example?: FeatureIntroExampleSpec;
  docsUrl: string;
  ctas: readonly FeatureIntroCta<F>[];
  setupState(ctx: FeatureIntroContext<F>): FeatureIntroSetupState;
  /** Section intro for a tab or sub-page: decides full screen vs box (I2). */
  parent?: FeatureIntroKey;
  /**
   * Reference only: a settings form with nothing to set up. Never shown on the page,
   * never dotted; it answers `?` (I8) so every page has an intro.
   */
  helpOnly?: boolean;
};

/** Keeps each intro's facts typed while registering them in one list. */
export function defineFeatureIntro<F extends FeatureIntroFacts>(intro: FeatureIntro<F>): FeatureIntro {
  return intro;
}
