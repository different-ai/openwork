import { LegalPage } from "../../components/legal-page";
import { withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork — Terms of Use",
  description: "Terms of use for Different AI, doing business as OpenWork.",
  alternates: {
    canonical: "/terms"
  }
});

export default function TermsPage() {
  return <LegalPage file="terms/terms-of-use.md" />;
}
