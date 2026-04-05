import { notFound } from "next/navigation";

import { LandingTrustTopicPage } from "../../../components/landing-trust-topic-page";
import { getTrustTopic, trustTopics } from "../../../components/trust-content";
import { getGithubData } from "../../../lib/github";

export async function generateStaticParams() {
  return trustTopics.map((topic) => ({ slug: topic.slug }));
}

export async function generateMetadata({
  params
}: {
  params: { slug: string };
}) {
  const topic = getTrustTopic(params.slug);

  if (!topic) {
    return {
      title: "OpenWork — Trust"
    };
  }

  return {
    title: `OpenWork — ${topic.label}`,
    description: topic.summary
  };
}

export default async function TrustTopicRoute({
  params
}: {
  params: { slug: string };
}) {
  const topic = getTrustTopic(params.slug);

  if (!topic) {
    notFound();
  }

  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <LandingTrustTopicPage
      topic={topic}
      stars={github.stars}
      downloadHref={github.downloads.macos}
      calUrl={cal}
    />
  );
}
