import { LandingTrustOverview } from "../../components/landing-trust";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Security & Data Privacy",
  description:
    "How OpenWork handles data, subprocessors, incident response, and compliance for self-hosted enterprise deployments."
};

export default async function TrustPage() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <LandingTrustOverview
      stars={github.stars}
      downloadHref={github.downloads.macos}
      calUrl={cal}
    />
  );
}
