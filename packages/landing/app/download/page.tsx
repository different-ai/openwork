import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "AikaOS — Descargar",
  description:
    "Descarga AikaOS para macOS, Windows y Linux. Incluye instrucciones de instalación para AUR y paquetes directos.",
};

export default async function Download() {
  const github = await getGithubData();
  const releaseLabel = github.releaseTag || "última versión";
  const releaseUrl = github.releaseUrl;

  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} active="download" />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              AikaOS Desktop
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Descargar AikaOS
            </h1>
            <p className="mb-4 max-w-3xl text-[17px] leading-relaxed text-gray-700">
              Instala AikaOS en macOS, Windows o Linux. Elige el paquete que
              corresponda a tu sistema operativo y arquitectura.
            </p>
            <p className="mb-10 text-[14px] text-gray-600">
              Última versión estable:{" "}
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
              <h2 className="mb-2 text-[16px] font-semibold text-gray-900">
                macOS
              </h2>
              <p className="text-[14px] text-gray-700">
                Apple Silicon e Intel
              </p>
            </a>
            <a
              href="#windows"
              className="feature-card border-violet-100 bg-violet-50/50 transition hover:border-violet-200"
            >
              <h2 className="mb-2 text-[16px] font-semibold text-gray-900">
                Windows
              </h2>
              <p className="text-[14px] text-gray-700">Instalador MSI x64</p>
            </a>
            <a
              href="#linux"
              className="feature-card border-emerald-100 bg-emerald-50/60 transition hover:border-emerald-200"
            >
              <h2 className="mb-2 text-[16px] font-semibold text-gray-900">
                Linux
              </h2>
              <p className="text-[14px] text-gray-700">
                AUR, .deb y .rpm
              </p>
            </a>
          </div>

          <section id="macos" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">macOS</h2>
            <p className="mb-8 text-[15px] text-gray-700">
              Descarga el DMG que corresponda a tu Mac.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="feature-card bg-white/90">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">
                  Apple Silicon (serie M)
                </h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Recomendado para chips M1, M2, M3 y M4.
                </p>
                <a
                  href={github.installers.macos.appleSilicon}
                  className="doc-button"
                  rel="noreferrer"
                  target="_blank"
                >
                  Descargar .dmg
                </a>
              </div>

              <div className="feature-card bg-white/90">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">
                  Intel (x64)
                </h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Para Macs con procesador Intel.
                </p>
                <a
                  href={github.installers.macos.intel}
                  className="doc-button"
                  rel="noreferrer"
                  target="_blank"
                >
                  Descargar .dmg
                </a>
              </div>
            </div>
          </section>

          <hr />

          <section id="windows" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">Windows</h2>
            <p className="mb-6 text-[15px] text-gray-700">
              AikaOS para Windows está disponible como instalador MSI x64.
            </p>
            <a
              href={github.installers.windows.x64}
              className="doc-button"
              rel="noreferrer"
              target="_blank"
            >
              Descargar Windows x64 (.msi)
            </a>
          </section>

          <hr />

          <section id="linux" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">Linux</h2>
            <p className="mb-8 text-[15px] text-gray-700">
              Instala desde AUR en distribuciones basadas en Arch, o descarga
              paquetes directamente para Ubuntu/Debian y Fedora/RHEL/openSUSE.
            </p>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="feature-card border-emerald-100 bg-white/90 ring-1 ring-emerald-100/60">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">
                  Arch Linux (AUR)
                </h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Instala y mantén AikaOS actualizado vía el Arch User
                  Repository.
                </p>
                <pre className="mono overflow-x-auto rounded-lg bg-gray-950 px-4 py-3 text-[13px] text-gray-100">
                  <code>yay -S aikaos</code>
                </pre>
                <p className="mt-3 text-[13px] text-gray-600">
                  ¿Prefieres paru?{" "}
                  <span className="mono">paru -S aikaos</span>
                </p>
                <a
                  href={github.installers.linux.aur}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex text-[13px] font-semibold text-gray-700 underline decoration-gray-300 underline-offset-4 transition hover:text-black"
                >
                  Ver paquete en AUR
                </a>
              </div>

              <div className="feature-card border-amber-100 bg-white/90 ring-1 ring-amber-100/60">
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">
                  Ubuntu / Debian (.deb)
                </h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Descarga el paquete para tu arquitectura.
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
                <h3 className="mb-2 text-[16px] font-semibold text-gray-900">
                  Fedora / RHEL / openSUSE (.rpm)
                </h3>
                <p className="mb-4 text-[14px] text-gray-600">
                  Descarga un paquete RPM para sistemas x64 o arm64.
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
              ¿Necesitas otro formato?{" "}
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-gray-900 underline decoration-gray-300 underline-offset-4 transition hover:decoration-gray-700"
              >
                Ver todos los assets del release
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
