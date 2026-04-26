import CompareSection from "@/components/home/compare-section";
import HomeFaqsSection from "@/components/home/home-faqs-section";
import HomeHeroSection from "@/components/home/hero-section/home-hero-section";
import HowItWorksSection from "@/components/home/how-it-works-section/how-it-works-section";
import ProvidersSection from "@/components/home/providers-section";
import QuickstartSection from "@/components/home/quickstart-section";
import TheWorkspaceSection from "@/components/home/the-workspace-section";
import TrustRow from "@/components/home/trust-row";
import WhyUsSection from "@/components/home/why-us-section";
import CtaSection from "@/components/ui/cta-section";
import { StructuredData } from "@/components/structured-data";
import { baseOpenGraph } from "@/lib/seo";

export const metadata = {
  alternates: { canonical: "/" },
  openGraph: { ...baseOpenGraph, url: "https://openworklabs.com" }
};

const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenWork",
  description:
    "Open source alternative to Claude Cowork. Desktop app for shipping agentic workflows your team will actually use.",
  url: "https://openworklabs.com",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Linux, Windows",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD", url: "https://openworklabs.com/pricing" },
  publisher: { "@type": "Organization", name: "OpenWork", url: "https://openworklabs.com" }
};

export default function Home() {
  return (
    <>
      <StructuredData data={softwareApplicationSchema} />
      <main className="home-page mx-auto flex max-w-(--max-container) flex-col gap-[8rem] md:gap-[12rem]">
        <HomeHeroSection />
        <TrustRow />
        <WhyUsSection />
        <TheWorkspaceSection />
        <HowItWorksSection />
        <ProvidersSection />
        <QuickstartSection />
        <CompareSection />
        <HomeFaqsSection />
        <CtaSection />
      </main>
    </>
  );
}
