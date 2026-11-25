import { AppFeedbackForm, type AppFeedbackPrefill } from "../../components/app-feedback-form";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph, withSocialMetadata } from "../../lib/seo";

export const metadata = withSocialMetadata({
  title: "OpenWork — Contact",
  description: "Contact the OpenWork team for product, support, security, and sales questions.",
  alternates: {
    canonical: "/contact",
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/contact",
  },
});

const prefill: AppFeedbackPrefill = {
  source: "openwork-contact-page",
  entrypoint: "/contact",
  deployment: "landing",
  appVersion: "",
  openworkServerVersion: "",
  opencodeVersion: "",
  osName: "",
  osVersion: "",
  platform: "web",
};

export default async function ContactPage() {
  const github = await getGithubData();

  return (
    <div className="min-h-screen overflow-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={github.stars} />
      <main className="mx-auto w-full max-w-6xl px-6 md:px-8">
        <AppFeedbackForm prefill={prefill} mode="contact" />
        <SiteFooter />
      </main>
    </div>
  );
}
