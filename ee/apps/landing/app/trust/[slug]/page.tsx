import { notFound } from "next/navigation";

import {
  LandingTrustDetail,
  getTrustSection
} from "../../../components/landing-trust";
import { trustSections } from "../../../components/trust-content";
import { getGithubData } from "../../../lib/github";

export function generateStaticParams() {
  return trustSections.map((section) => ({ slug: section.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const section = getTrustSection(params.slug);

  if (!section) {
    return {
      title: "OpenWork — Trust"
    };
  }

  return {
    title: `OpenWork — ${section.title}`,
    description: section.intro
  };
}

export default async function TrustDetailPage({
  params
}: {
  params: { slug: string };
}) {
  const section = getTrustSection(params.slug);

  if (!section) {
    notFound();
  }

  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <LandingTrustDetail
      section={section}
      stars={github.stars}
      downloadHref={github.downloads.macos}
      calUrl={cal}
    />
  );
}
