import { LegalPage } from "../../components/legal-page";

export const metadata = {
  title: "OpenWork — Privacy Policy",
  description: "Privacy policy for Different AI, doing business as OpenWork."
};

export default function PrivacyPage() {
  return <LegalPage file="privacy/privacy-policy.md" />;
}
