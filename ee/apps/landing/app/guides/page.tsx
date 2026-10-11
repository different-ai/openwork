import { GuidesIndexPage } from "../../components/guide-page";
import { StructuredData } from "../../components/structured-data";
import { getGithubData } from "../../lib/github";
import { GUIDES_PATH, SITE_URL, guidePath, guides } from "../../lib/guides";
import { baseOpenGraph, withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork guides — AI tools, costs, and controls",
  description:
    "OpenWork with OpenCode, MCP clients, and local models; AI costs, current organization controls, paused policies, and planned desktop agent permissions.",
  alternates: { canonical: GUIDES_PATH },
  openGraph: { ...baseOpenGraph, url: `${SITE_URL}${GUIDES_PATH}` }
});

const itemListSchema = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  itemListElement: guides.map((guide, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: guide.heading,
    url: `${SITE_URL}${guidePath(guide)}`
  }))
};

export default async function Guides() {
  const github = await getGithubData();
  return (
    <>
      <StructuredData data={itemListSchema} />
      <GuidesIndexPage stars={github.stars} />
    </>
  );
}
