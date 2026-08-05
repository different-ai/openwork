import { RoadmapPageShell } from "../../../components/roadmap-page-shell";
import { getGithubData } from "../../../lib/github";
import { baseOpenGraph } from "../../../lib/seo";

export const metadata = {
  title: "Micx Roadmap",
  description:
    "What Micx supports today and what is coming next across desktop, hosted workspaces, external agents, and new surfaces.",
  alternates: {
    canonical: "/roadmap"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "Micx Roadmap | Your workspace, on every surface",
    description:
      "The roadmap for the Micx desktop app, portable agent capabilities, hosted workspaces, and every surface where work happens.",
    url: "https://micxlabs.com/roadmap"
  }
};

export default async function DocsRoadmapPage() {
  const github = await getGithubData();

  return <RoadmapPageShell stars={github.stars} />;
}
