import { RoadmapPageShell } from "../../../components/roadmap-page-shell";
import { getGithubData } from "../../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork Roadmap",
  description:
    "What OpenWork supports today and what is coming next across desktop, hosted workspaces, external agents, and new surfaces.",
  alternates: {
    canonical: "/roadmap"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "OpenWork Roadmap | A workspace for everyone, on any platform",
    description:
      "What is ready, being built, and coming soon across every OpenWork product.",
    url: "https://openworklabs.com/roadmap"
  }
});

export default async function DocsRoadmapPage() {
  const github = await getGithubData();

  return <RoadmapPageShell stars={github.stars} />;
}
