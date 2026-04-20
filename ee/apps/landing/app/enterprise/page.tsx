import { LandingEnterprise } from "../../components/landing-enterprise";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

export const metadata = {
  title: "OpenWork Enterprise — Self-hosted AI agents for teams",
  description:
    "Deploy shared skills, MCPs, and agent workflows across your org. Self-hosted or managed, 50+ LLM providers, HIPAA / SOC 2 / ISO 27001 / GDPR ready.",
  alternates: {
    canonical: "/enterprise"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/enterprise"
  }
};

export default async function Enterprise() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <LandingEnterprise
      stars={github.stars}
      downloadHref={github.downloads.macos}
      calUrl={cal}
    />
  );
}
