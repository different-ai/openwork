import { LegalPage } from "../../../components/legal-page";

export const metadata = {
  title: "OpenWork — Subscription Terms",
  description:
    "Subscription terms governing production use of OpenWork Enterprise Edition software by Different AI, doing business as OpenWork.",
  alternates: {
    canonical: "/terms/subscription"
  }
};

export default function SubscriptionTermsPage() {
  return <LegalPage file="terms/subscription/subscription-terms.md" />;
}
