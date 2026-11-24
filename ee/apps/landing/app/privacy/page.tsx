import { LegalPage } from "../../components/legal-page";
import { withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork — Privacy Policy",
  description: "Privacy policy for Different AI, doing business as OpenWork.",
  alternates: {
    canonical: "/privacy"
  }
});

export default async function PrivacyPage() {
  return await LegalPage({ file: "privacy/privacy-policy.md" });
}
