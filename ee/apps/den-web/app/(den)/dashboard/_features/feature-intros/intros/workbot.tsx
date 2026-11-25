import { MessageCircle } from "lucide-react";
import { getNewAiGatewayProviderRoute, getWorkbotSettingsRoute, permissionLockReason } from "../../../../_lib/den-org";
import { WORKBOT_ENTRY_COPY, WORKBOT_ENTRY_HREF } from "../../../_lib/workbot-entry";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { WorkbotExample } from "./examples/workbot/workbot-example";

export type WorkbotFacts = {
  modelChosen?: boolean;
  needsProvider?: boolean;
  workbotOff?: boolean;
};

type Ctx = FeatureIntroContext<WorkbotFacts>;

const PATH = getWorkbotSettingsRoute();
export const WORKBOT_DEFAULT_MODEL_ANCHOR = "#workbot-default-model";

function workbotUnusable(ctx: Ctx): boolean {
  return ctx.facts.needsProvider === true && ctx.facts.modelChosen === false;
}

export const workbotIntros = [
  defineFeatureIntro<WorkbotFacts>({
    key: "workbot",
    version: 1,
    match: { path: PATH },
    icon: MessageCircle,
    title: "Workbot",
    summary: "Give your team an assistant in the browser that works in the apps they already use.",
    highlights: [
      { title: "Nothing to install.", text: "People open Workbot in their browser and sign in with their OpenWork account." },
      { title: "Works in your apps.", text: "Gmail, Google Calendar, Slack and the other apps your team connected, with each person's own account." },
      { title: "Takes on longer jobs.", text: "Workbot keeps working on its own cloud computer while people keep chatting." },
      { title: "One model for your cloud agents.", text: "The model you choose here is also the default for OpenWork in Slack and cloud Automations." },
    ],
    example: {
      Component: WorkbotExample,
      alt: "Example: someone asks Workbot what's on their plate today. It reads their Google Calendar, searches Linear and reads #launch in Slack, then answers. Below, the team's setup: GPT-6 Luna as the default model, and Google Workspace, Linear and Slack for everyone.",
    },
    docsUrl: docsPage("workbot/overview"),
    ctas: [
      { when: (ctx) => workbotUnusable(ctx) && ctx.can("canManageGatewayProviders"), label: "Add an AI provider", href: getNewAiGatewayProviderRoute() },
      {
        when: workbotUnusable,
        label: "Add an AI provider",
        href: getNewAiGatewayProviderRoute(),
        locked: { reason: `Workbot needs an AI provider first. ${permissionLockReason("gateway_providers.manage")}` },
      },
      { when: (ctx) => ctx.can("canManageModelsSettings"), label: "Choose the default model", href: WORKBOT_DEFAULT_MODEL_ANCHOR },
      {
        when: (ctx) => ctx.orgContext.capabilities.workbot === true && ctx.facts.needsProvider !== true && ctx.facts.workbotOff === true,
        label: "Open Workbot",
        href: WORKBOT_ENTRY_HREF,
        locked: { reason: WORKBOT_ENTRY_COPY.offTitle },
      },
      {
        when: (ctx) => ctx.orgContext.capabilities.workbot === true && ctx.facts.needsProvider !== true,
        label: "Open Workbot",
        href: WORKBOT_ENTRY_HREF,
      },
      { when: () => true, label: "Choose the default model", href: WORKBOT_DEFAULT_MODEL_ANCHOR, locked: { reason: permissionLockReason("inference.manage") } },
    ],
    setupState: (ctx) => {
      if (ctx.facts.needsProvider === undefined || ctx.facts.modelChosen === undefined) return "done";
      return workbotUnusable(ctx) ? "none" : "done";
    },
  }),
];
