import { LandingDen } from "../../components/landing-den";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Den",
  description:
    "Hosted sandboxed workers for your team, available in desktop, Slack, and Telegram.",
};

export default async function Den() {
  const github = await getGithubData();

  return (
    <LandingDen
      stars={github.stars}
      downloadHref={github.downloads.macos}
      getStartedHref="https://app.openwork.software"
    />
  );
}
