import type { Metadata } from "next";

import { MigrationGuidePage } from "../../../../components/migration-guide-page";
import { StructuredData } from "../../../../components/structured-data";
import {
  MIGRATION_GUIDE_URL,
  MIGRATION_PROMPT,
  migrationFaq,
  migrationSteps
} from "../../../../lib/claude-cowork-migration";
import { getGithubData } from "../../../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../../../lib/seo";

const title = "Migrate from Claude Cowork to OpenWork: move plugins and skills";
const description =
  "Switch from Claude Cowork to OpenWork, the free open-source Cowork alternative. One prompt moves your Cowork plugins, Claude skills, and MCP connectors.";

export const metadata: Metadata = withSocialMetadata({
  title,
  description,
  keywords: [
    "migrate from Claude Cowork",
    "Claude Cowork alternative",
    "switch from Claude Cowork",
    "Claude Cowork plugins",
    "Claude skills",
    "SKILL.md",
    "Claude Code plugins",
    "knowledge-work-plugins",
    "open source Claude Cowork",
    "OpenWork"
  ],
  alternates: {
    canonical: "/docs/start-here/migrate-from-claude-cowork"
  },
  openGraph: {
    ...baseOpenGraph,
    title,
    description,
    url: MIGRATION_GUIDE_URL
  }
});

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "How to migrate from Claude Cowork to OpenWork",
  description,
  totalTime: "PT10M",
  tool: [{ "@type": "HowToTool", name: "Claude Code or another coding agent" }],
  step: [
    {
      "@type": "HowToStep",
      name: "Paste the migration prompt",
      text: MIGRATION_PROMPT,
      url: `${MIGRATION_GUIDE_URL}#migration-heading`
    },
    ...migrationSteps.map((step) => ({
      "@type": "HowToStep",
      name: step.title,
      text: `${step.body} (${step.command})`
    }))
  ]
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: migrationFaq.map((entry) => ({
    "@type": "Question",
    name: entry.question,
    acceptedAnswer: { "@type": "Answer", text: entry.answer }
  }))
};

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "OpenWork", item: "https://openworklabs.com" },
    { "@type": "ListItem", position: 2, name: "Docs", item: "https://openworklabs.com/docs" },
    { "@type": "ListItem", position: 3, name: "Migrate from Claude Cowork", item: MIGRATION_GUIDE_URL }
  ]
};

export default async function MigrateFromClaudeCoworkPage() {
  const github = await getGithubData();

  return (
    <>
      <StructuredData data={howToSchema} />
      <StructuredData data={faqSchema} />
      <StructuredData data={breadcrumbSchema} />
      <MigrationGuidePage stars={github.stars} />
    </>
  );
}
