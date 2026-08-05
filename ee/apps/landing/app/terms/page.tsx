import { LegalPage } from "../../components/legal-page";

export const metadata = {
  title: "Micx — Terms of Use",
  description: "Terms of use for Different AI, doing business as Micx.",
  alternates: {
    canonical: "/terms"
  }
};

export default function TermsPage() {
  return <LegalPage file="terms/terms-of-use.md" />;
}
