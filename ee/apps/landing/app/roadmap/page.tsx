import { RoadmapPageShell } from "../../components/roadmap-page-shell";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork Roadmap | A workspace for everyone, on any platform",
  description:
    "What is ready, being built, and coming soon for the OpenWork desktop app, Admin, MCP Gateway, Web, Automations, Workflows, Dashboards, and new apps.",
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

export default async function RoadmapPage() {
  const github = await getGithubData();

  return <RoadmapPageShell stars={github.stars} />;
}
