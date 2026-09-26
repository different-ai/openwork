import { ClaudeCowork3pPage } from "../../../components/claude-cowork-3p-page";
import { StructuredData } from "../../../components/structured-data";
import { CLAUDE_COWORK_3P_URL, claudeCowork3pFaq } from "../../../lib/claude-cowork-3p";
import { CLAUDE_COWORK_ALTERNATIVE_URL } from "../../../lib/claude-cowork-alternative";
import { getGithubData } from "../../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork vs Claude Cowork on 3P (Bedrock, Vertex, Foundry)",
  description:
    "Running Claude Cowork on Bedrock, Vertex, or Foundry? Compare OpenWork: keep your gateway and cloud spend, use any model, share skills and MCPs.",
  alternates: {
    canonical: "/alternatives/claude-cowork-3p"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/alternatives/claude-cowork-3p"
  }
});

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: claudeCowork3pFaq.map((entry) => ({
    "@type": "Question",
    name: entry.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: entry.answer
    }
  }))
};

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "OpenWork", item: "https://openworklabs.com" },
    { "@type": "ListItem", position: 2, name: "Claude Cowork alternative", item: CLAUDE_COWORK_ALTERNATIVE_URL },
    { "@type": "ListItem", position: 3, name: "Claude Cowork on 3P", item: CLAUDE_COWORK_3P_URL }
  ]
};

export default async function ClaudeCowork3p() {
  const github = await getGithubData();

  return (
    <>
      <StructuredData data={faqSchema} />
      <StructuredData data={breadcrumbSchema} />
      <ClaudeCowork3pPage stars={github.stars} />
    </>
  );
}
