import { LandingDen } from "../../components/landing-den";
import { resolveDownloadHref } from "../../lib/download-target";
import { getGithubData } from "../../lib/github";
import { headers } from "next/headers";

export const metadata = {
  title: "OpenWork — Den",
  description:
    "Always-on AI workers that handle repetitive work for your team and report back in Slack, Telegram, or the desktop app.",
};

export default async function Den() {
  const github = await getGithubData();
  const downloadHref = resolveDownloadHref(github, headers());

  return (
    <LandingDen
      stars={github.stars}
      downloadHref={downloadHref}
      getStartedHref="https://app.openwork.software"
    />
  );
}
