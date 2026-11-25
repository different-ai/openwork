import { Inbox } from "lucide-react";
import { TriageThreadExample } from "../../../../../../components/admin/support-triage/threads";
import { defineFeatureIntro } from "../types";

export const supportTriageIntro = defineFeatureIntro({
  key: "admin.support-triage",
  version: 1,
  match: { path: "/admin/support-triage" },
  icon: Inbox,
  title: "Triage new support threads",
  summary: "Surface product bugs and enterprise leads in Plain without sorting every thread by hand.",
  body: "Job requests and unsolicited pitches are marked Done. Unclear threads stay untouched for you to review. Only threads received after you turn on triage are included.",
  docsUrl: "https://github.com/different-ai/openwork/blob/dev/docs/support-triage.md",
  ctas: [{ when: () => true, label: "Set up triage", href: "#triage-settings" }],
  example: { Component: TriageThreadExample, alt: "Example support threads with enterprise lead and needs review categories" },
  setupState: ({ facts }) => facts.hasThreads ? "done" : facts.plainConfigured ? "partial" : "none",
});
