import { RoadmapPageShell } from "../../components/roadmap-page-shell";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

export const metadata = {
  title: "OpenWork Roadmap | Your workspace, on every surface",
  description:
    "See what OpenWork supports today and what is coming next for the desktop app, OpenWork Connect, hosted workspaces, Slack, mobile, and reliable agent workflows.",
  alternates: {
    canonical: "/roadmap"
  },
  openGraph: {
    ...baseOpenGraph,
    title: "OpenWork Roadmap | Your workspace, on every surface",
    description:
      "The roadmap for the OpenWork desktop app, portable agent capabilities, hosted workspaces, and every surface where work happens.",
    url: "https://openworklabs.com/roadmap"
  }
};

export default async function RoadmapPage() {
  const github = await getGithubData();

  return <RoadmapPageShell stars={github.stars} />;
}
