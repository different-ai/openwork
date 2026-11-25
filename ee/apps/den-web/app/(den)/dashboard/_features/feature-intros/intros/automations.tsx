import { CalendarClock } from "lucide-react";
import { getAutomationsRoute } from "../../../../_lib/den-org";
import { defineFeatureIntro } from "../types";
import { OPENWORK_INSTALL_ROUTE } from "./analytics";
import { docsPage } from "./docs";
import { AutomationsExample } from "./examples/automations/automations-example";

export type AutomationsFacts = {
  automations?: number;
};

export const automationsIntros = [
  defineFeatureIntro<AutomationsFacts>({
    key: "automations",
    version: 1,
    match: { path: getAutomationsRoute() },
    icon: CalendarClock,
    title: "My Automations",
    summary: "Have OpenWork do a task for you on a schedule, and see how each run went.",
    highlights: [
      { title: "On a schedule.", text: "Every morning, every Monday, or once at a set time." },
      { title: "On your computer or in the cloud.", text: "Desktop Automations run in the OpenWork app. Cloud Automations run in OpenWork Web." },
      { title: "Every run in one place.", text: "What ran, whether it worked and its result, and stop a run that's still going." },
      { title: "Set up where you work.", text: "Create and change them in the OpenWork app or in OpenWork Web." },
    ],
    example: {
      Component: AutomationsExample,
      alt: "Example: Invoice follow-up running now in the cloud; Weekly sales digest every Monday at 9:00 AM in the cloud, last run succeeded; and Morning inbox triage every day at 8:30 AM on the desktop.",
    },
    docsUrl: docsPage("start-here/do-work-with-it/automations"),
    ctas: [
      {
        when: (ctx) => ctx.orgContext.capabilities.openworkWeb,
        label: "Download OpenWork",
        href: OPENWORK_INSTALL_ROUTE,
        note: () => "Or create a Cloud Automation in OpenWork Web.",
      },
      { when: () => true, label: "Download OpenWork", href: OPENWORK_INSTALL_ROUTE },
    ],
    setupState: (ctx) => {
      if (ctx.facts.automations === undefined) return "done";
      return ctx.facts.automations > 0 ? "done" : "none";
    },
  }),
];
