import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { DenOrgAccessFlags, DenOrgContext } from "../../../_lib/den-org";

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
  | "computers"
  | "my-computers"
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
  | "audit-logs"
  | "admin.support-triage";

export type FeatureIntroSetupState = "none" | "partial" | "done";

export type FeatureIntroFactValue = string | number | boolean | null;
export type FeatureIntroFacts = { readonly [fact: string]: FeatureIntroFactValue | undefined };

export type FeatureIntroPermission = {
  [K in keyof DenOrgAccessFlags]: DenOrgAccessFlags[K] extends boolean ? K : never;
}[keyof DenOrgAccessFlags];

export type FeatureIntroContext<F extends FeatureIntroFacts = FeatureIntroFacts> = {
  orgId: string;
  orgSlug: string | null;
  orgContext: DenOrgContext;
  access: DenOrgAccessFlags;
  isAdmin: boolean;
  can: (permission: FeatureIntroPermission) => boolean;
  memberName: (memberId: string | null | undefined) => string | null;
  facts: Partial<F>;
};

export type FeatureIntroCta<F extends FeatureIntroFacts = FeatureIntroFacts> = {
  when(ctx: FeatureIntroContext<F>): boolean;
  label: string;
  href: string;
  locked?: { reason: string };
  note?(ctx: FeatureIntroContext<F>): string | null;
};

export type FeatureIntroHighlight = { title: string; text: string };

export type FeatureIntroExampleSpec = {
  Component: ComponentType;
  alt: string;
};

export type FeatureIntroMatch = {
  path: string;
  tab?: string;
  tabParam?: "tab" | "view" | "show";
};

export type FeatureIntro<F extends FeatureIntroFacts = FeatureIntroFacts> = {
  key: FeatureIntroKey;
  version: number;
  match: FeatureIntroMatch;
  icon: LucideIcon;
  title: string;
  summary: string;
  bannerText?: string;
  body?: string;
  highlights?: readonly FeatureIntroHighlight[];
  example?: FeatureIntroExampleSpec;
  docsUrl: string;
  ctas: readonly FeatureIntroCta<F>[];
  setupState(ctx: FeatureIntroContext<F>): FeatureIntroSetupState;
  parent?: FeatureIntroKey;
  helpOnly?: boolean;
};

export function defineFeatureIntro<F extends FeatureIntroFacts>(intro: FeatureIntro<F>): FeatureIntro {
  return intro;
}
