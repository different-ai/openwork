import { notFound } from "next/navigation";
import { GuidePage } from "../../../components/guide-page";
import { StructuredData } from "../../../components/structured-data";
import { getGithubData } from "../../../lib/github";
import { GUIDES_PATH, SITE_URL, findGuide, guidePath, guides } from "../../../lib/guides";
import { baseOpenGraph, withSocialMetadata } from "../../../lib/seo";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return guides.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const guide = findGuide(slug);
  if (!guide) return {};
  const path = guidePath(guide);
  return withSocialMetadata({
    title: guide.title,
    description: guide.description,
    alternates: { canonical: path },
    openGraph: { ...baseOpenGraph, type: "article", url: `${SITE_URL}${path}` }
  });
}

export default async function Guide({ params }: Props) {
  const { slug } = await params;
  const guide = findGuide(slug);
  if (!guide) notFound();
  const github = await getGithubData();
  const url = `${SITE_URL}${guidePath(guide)}`;

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: guide.heading,
    description: guide.description,
    abstract: guide.answer,
    url,
    mainEntityOfPage: url,
    datePublished: guide.updated,
    dateModified: guide.updated,
    author: { "@type": "Organization", name: "OpenWork", url: SITE_URL },
    about: { "@type": "SoftwareApplication", name: "OpenWork", url: SITE_URL },
    publisher: { "@type": "Organization", name: "OpenWork", url: SITE_URL }
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: guide.faq.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer }
    }))
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "OpenWork", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Guides", item: `${SITE_URL}${GUIDES_PATH}` },
      { "@type": "ListItem", position: 3, name: guide.label, item: url }
    ]
  };

  return (
    <>
      <StructuredData data={articleSchema} />
      <StructuredData data={faqSchema} />
      <StructuredData data={breadcrumbSchema} />
      <GuidePage guide={guide} stars={github.stars} />
    </>
  );
}
