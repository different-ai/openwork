import { LegalPage } from "../../components/legal-page";

export const metadata = {
  title: "OpenWork — Terms of Use",
  description: "Terms of use for Different AI, doing business as OpenWork."
};

export default function TermsPage() {
  return <LegalPage file="terms/terms-of-use.md" />;
}
