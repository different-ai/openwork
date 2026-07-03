import { headers } from "next/headers";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import { detectOsFromUserAgent, osDownloadLabel } from "../../lib/detect-os";
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
  const userAgent = headers().get("user-agent")?.toLowerCase() || "";
  const detectedOs = detectOsFromUserAgent(userAgent);
  const primaryUrl =
    detectedOs === "windows"
      ? github.downloads.windows
      : detectedOs === "linux"
        ? github.downloads.linux
        : github.downloads.macos;
  const primaryLabel = osDownloadLabel(detectedOs);
  const releaseTag = github.releaseTag || undefined;

  const platformGroups = [
    {
      os: "macOS",
      options: [
        { label: "Apple Silicon", format: ".dmg", href: github.installers.macos.appleSilicon },
        { label: "Intel", format: ".dmg", href: github.installers.macos.intel }
      ]
    },
    {
      os: "Windows",
      options: [{ label: "x64", format: ".exe", href: github.installers.windows.x64 }]
    },
    {
      os: "Linux",
      options: [
        { label: "x64", format: ".AppImage", href: github.installers.linux.appImageX64 },
        { label: "arm64", format: ".AppImage", href: github.installers.linux.appImageArm64 },
        { label: "x64", format: ".tar.gz", href: github.installers.linux.tarX64 },
        { label: "arm64", format: ".tar.gz", href: github.installers.linux.tarArm64 }
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
        mobilePrimaryLabel={primaryLabel}
        osDownloadUrl={primaryUrl}
        active="download"
      />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up max-w-2xl">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              OpenWork desktop
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Download OpenWork
            </h1>
            <p className="mb-6 text-[17px] leading-relaxed text-gray-700">
              A local-first AI coworker for your desktop. Point it at a folder
              and start working.
            </p>

            <div className="flex flex-wrap items-center gap-4">
              <a href={primaryUrl} className="doc-button inline-flex">
                {primaryLabel}
              </a>
              {releaseTag ? (
                <span className="mono text-[13px] text-gray-500">{releaseTag}</span>
              ) : null}
            </div>
          </div>

          <section className="my-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {platformGroups.map((group) => (
              <div
                key={group.os}
                className="rounded-[2rem] border border-slate-200/40 bg-white/80 p-6 shadow-[0_20px_60px_-24px_rgba(15,23,42,0.18)]"
              >
                <span className="mb-3 block text-[16px] font-semibold text-gray-900">
                  {group.os}
                </span>
                <div className="flex flex-col gap-2">
                  {group.options.map((option) => (
                    <a
                      key={`${option.label}-${option.format}`}
                      href={option.href}
                      className="text-[14px] text-gray-600 transition-colors hover:text-[#011627]"
                    >
                      {option.label}{" "}
                      <span className="mono text-gray-400">{option.format}</span>
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
