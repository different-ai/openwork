import type { Metadata } from "next";

import { MigrationGuidePage } from "../../../../components/migration-guide-page";
import { getGithubData } from "../../../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../../../lib/seo";

export const metadata: Metadata = withSocialMetadata({
  title: "Migrate from Claude Cowork to OpenWork",
  description:
    "Move your Claude Cowork plugins and skills to OpenWork with one prompt to your agent, or by hand with the openwork-bootstrap command.",
  alternates: {
    canonical: "/docs/start-here/migrate-from-claude-cowork"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "Migrate from Claude Cowork to OpenWork",
    description:
      "Paste one prompt into Claude Code and your agent moves your Cowork plugins and skills to OpenWork.",
    url: "https://openworklabs.com/docs/start-here/migrate-from-claude-cowork"
  }
});

export default async function MigrateFromClaudeCoworkPage() {
  const github = await getGithubData();

  return (
    <MigrationGuidePage
      stars={github.stars}
      downloadHref={github.downloads.macos}
    />
  );
}
