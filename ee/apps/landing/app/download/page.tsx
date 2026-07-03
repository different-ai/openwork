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

  const platformGroups = [
    {
      os: "macOS",
      options: [
        { label: "Mac (Apple Silicon)", href: github.installers.macos.appleSilicon },
        { label: "Mac (Intel)", href: github.installers.macos.intel }
      ]
    },
    {
      os: "Windows",
      options: [
        { label: "Windows (x64)", href: github.installers.windows.x64 },
        { label: "Windows (ARM64)", href: github.installers.windows.arm64 }
      ]
    },
    {
      os: "Linux",
      options: [
        { label: "Linux AppImage (x64)", href: github.installers.linux.appImageX64 },
        { label: "Linux AppImage (ARM64)", href: github.installers.linux.appImageArm64 },
        { label: "Linux tar.gz (x64)", href: github.installers.linux.tarX64 },
        { label: "Linux tar.gz (ARM64)", href: github.installers.linux.tarArm64 }
      ]
    }
  ];

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
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              OpenWork desktop
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Download now
            </h1>
            <p className="mb-6 text-[17px] leading-relaxed text-gray-700">
              A local-first AI coworker for your desktop. Pick your platform
              below and start working.
              {releaseTag ? (
                <span className="mono ml-2 text-[13px] text-gray-500">{releaseTag}</span>
              ) : null}
            </p>
          </div>

          <section className="my-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {platformGroups.map((group) => (
              <div
                key={group.os}
                className="rounded-[2rem] border border-slate-200/40 bg-white/80 p-6 shadow-[0_20px_60px_-24px_rgba(15,23,42,0.18)]"
              >
                <span className="mb-2 block text-[16px] font-semibold text-gray-900">
                  {group.os}
                </span>
                <div className="flex flex-col">
                  {group.options.map((option, index) => (
                    <a
                      key={option.label}
                      href={option.href}
                      className={`py-3 text-[14px] text-gray-700 transition-colors hover:text-[#011627] ${
                        index < group.options.length - 1 ? "border-b border-gray-100" : ""
                      }`}
                    >
                      {option.label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
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
