import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

const CLOUD_SIGNUP_URL = "https://app.openworklabs.com?mode=sign-up";

const downloadSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenWork",
  description:
    "Open source Claude Cowork alternative. Sign up for OpenWork Cloud to get access to the desktop app for macOS, Windows, and Linux.",
  url: "https://openworklabs.com/download",
  downloadUrl: CLOUD_SIGNUP_URL,
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
  title: "Get Started with OpenWork — macOS, Windows, Linux",
  description:
    "Create a free OpenWork Cloud account to get access to the OpenWork desktop app for macOS, Windows, and Linux.",
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

  return (
    <div className="min-h-screen">
      <StructuredData data={downloadSchema} />
      <SiteNav
        stars={github.stars}
        downloadHref={github.downloads.macos}
        active="download"
      />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up max-w-3xl">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              OpenWork desktop
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Get Started with OpenWork
            </h1>
            <p className="mb-6 text-[17px] leading-relaxed text-gray-700">
              Create a free OpenWork Cloud account first. After signup, we guide
              you to the desktop app and connect it to your cloud workspace.
            </p>
            <a
              href={CLOUD_SIGNUP_URL}
              target="_blank"
              rel="noreferrer"
              className="doc-button inline-flex"
            >
              Get Started for free
            </a>
          </div>

          <section className="my-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="feature-card border-sky-100 bg-sky-50/60">
              <span className="mb-2 block text-[16px] font-semibold text-gray-900">1. Sign up</span>
              <p className="text-[14px] text-gray-700">Create your free OpenWork Cloud account.</p>
            </div>
            <div className="feature-card border-violet-100 bg-violet-50/50">
              <span className="mb-2 block text-[16px] font-semibold text-gray-900">2. Create a workspace</span>
              <p className="text-[14px] text-gray-700">Set up your personal or team workspace before installing.</p>
            </div>
            <div className="feature-card border-emerald-100 bg-emerald-50/60">
              <span className="mb-2 block text-[16px] font-semibold text-gray-900">3. Open the app</span>
              <p className="text-[14px] text-gray-700">Use the guided desktop app access flow from Cloud.</p>
            </div>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
