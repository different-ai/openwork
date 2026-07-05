import { DownloadOpenWorkCard } from "@openwork/ui/react";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

const downloadSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenWork",
  description:
    "Open source Claude Cowork alternative. Download the OpenWork desktop app for macOS, Windows, or Linux. No account required.",
  url: "https://openworklabs.com/download",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Windows, Linux",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD"
  },
  publisher: {
    "@type": "Organization",
    name: "OpenWork",
    url: "https://openworklabs.com"
  }
};

export const metadata = {
  title: "Download OpenWork — macOS, Windows, Linux",
  description:
    "Download the OpenWork desktop app for macOS, Windows, or Linux. Free, open source, no account required.",
  alternates: {
    canonical: "/download"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/download"
  }
};

export default async function Download() {
  const github = await getGithubData();
  const releaseTag = github.releaseTag || undefined;

  return (
    <div className="min-h-screen">
      <StructuredData data={downloadSchema} />
      <SiteNav
        stars={github.stars}
        downloadHref={github.downloads.macos}
        mobilePrimaryHref="/download"
        mobilePrimaryLabel="Download now"
        active="download"
      />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up max-w-2xl">
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Download now
            </h1>
            <p className="mb-6 text-[17px] leading-relaxed text-gray-700">
              Free and open source. No account required.
            </p>
          </div>

          <section className="my-8">
            <DownloadOpenWorkCard installers={github.installers} releaseTag={releaseTag} />
          </section>

          <p className="max-w-md text-[13px] text-gray-500">
            Joining a team?{" "}
            <a
              href="https://app.openworklabs.com"
              className="text-gray-700 underline underline-offset-2"
            >
              Sign in
            </a>{" "}
            after install to sync shared skills.
          </p>

          <div className="mt-16">
            <SiteFooter />
          </div>
        </div>
      </main>
    </div>
  );
}
