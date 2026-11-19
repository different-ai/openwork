import { LandingEnterprise } from "../../components/landing-enterprise";
import { StructuredData } from "../../components/structured-data";
import { enterpriseFaq } from "../../lib/enterprise";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork Enterprise — AI governance, gateway and SSO",
  description:
    "Give teams an approved AI path with company SSO, SCIM, permissions, AWS Bedrock, and usage visibility. Local-first desktop, cloud management, and deployment options.",
  alternates: {
    canonical: "/enterprise"
  },
  openGraph: {
    url: "https://openworklabs.com/enterprise"
  }
});

export default async function Enterprise() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: enterpriseFaq.map(entry => ({
            "@type": "Question",
            name: entry.question,
            acceptedAnswer: { "@type": "Answer", text: entry.answer }
          }))
        }}
      />
      <LandingEnterprise stars={github.stars} calUrl={cal} />
    </>
  );
}
