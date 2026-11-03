import { LegalPage } from "../../../components/legal-page";
import { withSocialMetadata } from "../../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork — Subscription Terms",
  description:
    "Subscription terms governing production use of OpenWork Enterprise Edition software by Different AI, doing business as OpenWork.",
  alternates: {
    canonical: "/terms/subscription"
  }
});

export default async function SubscriptionTermsPage() {
  return await LegalPage({ file: "terms/subscription/subscription-terms.md" });
}
