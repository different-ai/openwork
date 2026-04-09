import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork - Download",
  description:
    "Download OpenWork desktop for macOS and Linux, or purchase Windows support for binary access and updates.",
};

export default async function Download() {
  const github = await getGithubData();
  const releaseLabel = github.releaseTag || "latest";
  const releaseUrl = github.releaseUrl;
  const windowsCheckoutUrl =
    process.env.NEXT_PUBLIC_WINDOWS_CHECKOUT_URL || "/pricing#windows-support";
  const windowsCheckoutExternal = /^https?:\/\//.test(windowsCheckoutUrl);

  return (
    <div className="min-h-screen">
      <SiteNav
        stars={github.stars}
        downloadHref={github.downloads.macos}
        active="download"
      />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              OpenWork desktop
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Download OpenWork
            </h1>
            <p className="mb-4 max-w-3xl text-[17px] leading-relaxed text-gray-700">
              Install OpenWork on macOS, Windows, or Linux. Pick the package that
              matches your distro and architecture.
            </p>
            <p className="mb-10 text-[14px] text-gray-600">
              Latest stable release: 
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-gray-900 underline decoration-gray-300 underline-offset-4 transition hover:decoration-gray-700"
              >
                {releaseLabel}
              </a>
            </p>
          </div>

          <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <a
              href="#macos"
              className="feature-card border-sky-100 bg-sky-50/60 transition hover:border-sky-200"
            >
              <h2 className="mb-2 text-[16px] font-semibold text-gray-900">macOS</h2>
              <p className="text-[14px] text-gray-700">Apple Silicon and Intel builds</p>
            </a>
            <a
              href="#windows"
              className="feature-card border-violet-100 bg-violet-50/50 transition hover:border-violet-200"
            >
              <h2 className="mb-2 text-[16px] font-semibold text-gray-900">Windows</h2>
              <p className="text-[14px] text-gray-700">$99/year support plan with manual build delivery</p>
            </a>
            <a
              href="#linux"
              className="feature-card border-emerald-100 bg-emerald-50/60 transition hover:border-emerald-200"
            >
              <h2 className="mb-2 text-[16px] font-semibold text-gray-900">Linux</h2>
              <p className="text-[14px] text-gray-700">AUR, .deb, and .rpm options</p>
            </a>
          </div>

          <section id="macos" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">macOS</h2>
            <p className="mb-8 text-[15px] text-gray-700">
              Download the DMG that matches your Mac.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="feature-card bg-white/90">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">Apple Silicon (M-series)</h3>
                <p className="mb-4 text-[14px] text-gray-600">Recommended for M1, M2, M3, and M4 chips.</p>
                <a
                  href={github.installers.macos.appleSilicon}
                  className="doc-button"
                  rel="noreferrer"
                  target="_blank"
                >
                  Download .dmg
                </a>
              </div>

              <div className="feature-card bg-white/90">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">Intel (x64)</h3>
                <p className="mb-4 text-[14px] text-gray-600">For Intel-based Macs.</p>
                <a
                  href={github.installers.macos.intel}
                  className="doc-button"
                  rel="noreferrer"
                  target="_blank"
                >
                  Download .dmg
                </a>
              </div>
            </div>
          </section>

          <hr />

          <section id="windows" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">Windows</h2>
            <p className="mb-6 text-[15px] text-gray-700">
              Windows access is sold as an annual support plan. It includes one seat,
              Windows binary access, and one year of updates.
            </p>

            <div className="feature-card max-w-2xl border-violet-100 bg-white/90 ring-1 ring-violet-100/70">
              <h3 className="mb-2 text-[18px] font-semibold text-gray-900">
                Windows support — $99/year
              </h3>
              <p className="mb-5 text-[14px] leading-7 text-gray-600">
                Purchase through Polar and we will send your Windows build link after checkout.
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  href={windowsCheckoutUrl}
                  className="doc-button"
                  rel={windowsCheckoutExternal ? "noreferrer" : undefined}
                  target={windowsCheckoutExternal ? "_blank" : undefined}
                >
                  Purchase Windows support
                </a>
                <a href="/pricing#windows-support" className="secondary-button">
                  See pricing details
                </a>
              </div>
            </div>
          </section>

          <hr />

          <section id="linux" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">Linux</h2>
            <p className="mb-8 text-[15px] text-gray-700">
              Install from AUR on Arch-based distributions, or download packages
              directly for Ubuntu/Debian and Fedora/RHEL/openSUSE.
            </p>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="feature-card border-emerald-100 bg-white/90 ring-1 ring-emerald-100/60">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">Arch Linux (AUR)</h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Install and keep OpenWork updated via the Arch User Repository.
                </p>
                <pre className="mono overflow-x-auto rounded-lg bg-gray-950 px-4 py-3 text-[13px] text-gray-100">
                  <code>yay -S openwork</code>
                </pre>
                <p className="mt-3 text-[13px] text-gray-600">
                  Prefer paru? <span className="mono">paru -S openwork</span>
                </p>
                <a
                  href={github.installers.linux.aur}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex text-[13px] font-semibold text-gray-700 underline decoration-gray-300 underline-offset-4 transition hover:text-black"
                >
                  View package on AUR
                </a>
              </div>

              <div className="feature-card border-amber-100 bg-white/90 ring-1 ring-amber-100/60">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">Ubuntu / Debian (.deb)</h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Download the package for your architecture.
                </p>
                <div className="flex flex-wrap gap-3">
                  <a
                    href={github.installers.linux.debX64}
                    target="_blank"
                    rel="noreferrer"
                    className="doc-button"
                  >
                    x64 .deb
                  </a>
                  <a
                    href={github.installers.linux.debArm64}
                    target="_blank"
                    rel="noreferrer"
                    className="doc-button"
                  >
                    arm64 .deb
                  </a>
                </div>
              </div>

              <div className="feature-card border-sky-100 bg-white/90 ring-1 ring-sky-100/60">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">Fedora / RHEL / openSUSE (.rpm)</h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Download an RPM package for x64 or arm64 systems.
                </p>
                <div className="flex flex-wrap gap-3">
                  <a
                    href={github.installers.linux.rpmX64}
                    target="_blank"
                    rel="noreferrer"
                    className="doc-button"
                  >
                    x64 .rpm
                  </a>
                  <a
                    href={github.installers.linux.rpmArm64}
                    target="_blank"
                    rel="noreferrer"
                    className="doc-button"
                  >
                    arm64 .rpm
                  </a>
                </div>
              </div>
            </div>

            <p className="mt-8 text-[14px] text-gray-600">
              Need another format? 
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-gray-900 underline decoration-gray-300 underline-offset-4 transition hover:decoration-gray-700"
              >
                Browse all release assets
              </a>
              .
            </p>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
