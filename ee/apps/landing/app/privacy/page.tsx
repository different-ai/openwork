import { LegalPage } from "../../components/legal-page";

export const metadata = {
  title: "Micx — Privacy Policy",
  description: "Privacy policy for Different AI, doing business as Micx.",
  alternates: {
    canonical: "/privacy"
  }
};

export default function PrivacyPage() {
  return <LegalPage file="privacy/privacy-policy.md" />;
}
