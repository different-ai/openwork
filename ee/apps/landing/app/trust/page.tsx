import { LandingTrustOverview } from "../../components/landing-trust";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Trust",
  description:
    "How OpenWork approaches deployment control, local-first architecture, provider choice, and enterprise trust."
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
