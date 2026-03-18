import { LandingDen } from "../../components/landing-den";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Den",
  description:
    "Always-on AI workers that handle repetitive work for your team and report back in Slack, Telegram, or the desktop app.",
};

export default async function Den() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  return (
    <LandingDen
      stars={github.stars}
      downloadHref={github.downloads.macos}
      getStartedHref="https://app.openworklabs.com"
      callHref={cal}
    />
  );
}
