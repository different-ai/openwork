import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "AikaOS — Descargar",
  description:
    "Solicita AikaOS para macOS con Apple Silicon. Windows y Linux próximamente.",
};

export default function Download() {
  return (
    <div className="min-h-screen">
      <SiteNav active="download" />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              AikaOS Desktop
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Obtener AikaOS
            </h1>
            <p className="mb-4 max-w-3xl text-[17px] leading-relaxed text-gray-700">
              AikaOS está disponible para macOS con procesadores Apple Silicon.
              Las versiones para Windows y Linux están en desarrollo.
            </p>
            <p className="mb-10 text-[14px] text-gray-600">
              La descarga se gestiona a través de nuestro equipo para garantizar
              una instalación correcta y soporte desde el primer día.
            </p>
          </div>

          {/* ── macOS ── */}
          <section id="macos" className="py-6">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">macOS</h2>
            <p className="mb-8 text-[15px] text-gray-700">
              Disponible para Apple Silicon (M1, M2, M3, M4) e Intel.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="feature-card border-teal-100 bg-teal-50/30 ring-1 ring-teal-100/60">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-[16px] font-semibold text-gray-900">
                    Apple Silicon (serie M)
                  </h3>
                  <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-semibold text-teal-700">
                    Recomendado
                  </span>
                </div>
                <p className="mb-4 text-[14px] text-gray-600">
                  Para chips M1, M2, M3 y M4.
                </p>
                <a
                  href="/enterprise#contacto"
                  className="doc-button"
                >
                  Solicitar instalación
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
                  href="/enterprise#contacto"
                  className="doc-button"
                >
                  Solicitar instalación
                </a>
              </div>
            </div>

            {/* Cómo funciona */}
            <div className="mt-8 rounded-2xl border border-gray-100 bg-gray-50/60 p-6">
              <h3 className="mb-4 text-[15px] font-bold">
                ¿Cómo obtengo AikaOS?
              </h3>
              <ol className="list-inside list-decimal space-y-3 text-[14px] text-gray-700">
                <li>
                  Elige tu plan en la{" "}
                  <a
                    href="/enterprise"
                    className="font-semibold text-teal-700 underline decoration-teal-300 underline-offset-4 transition hover:decoration-teal-600"
                  >
                    página de precios
                  </a>{" "}
                  (desde $20 USD/mes).
                </li>
                <li>
                  Contáctanos y nuestro equipo coordinará la instalación.
                </li>
                <li>
                  Recibes AikaOS configurado y listo para trabajar en tu Mac.
                </li>
                <li>
                  Configura tu modelo de IA (API key propia, Ollama local, o
                  suscripción de OpenCode).
                </li>
                <li>
                  Empieza a automatizar. Soporte incluido en tu plan.
                </li>
              </ol>
            </div>
          </section>

          <hr />

          {/* ── Windows ── */}
          <section id="windows" className="py-6">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold md:text-3xl">Windows</h2>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-[12px] font-semibold text-amber-600 ring-1 ring-amber-200">
                Próximamente
              </span>
            </div>
            <p className="mt-3 text-[15px] text-gray-500">
              La versión para Windows está en desarrollo activo. Se anunciará
              cuando esté lista.
            </p>
          </section>

          <hr />

          {/* ── Linux ── */}
          <section id="linux" className="py-6">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold md:text-3xl">Linux</h2>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-[12px] font-semibold text-amber-600 ring-1 ring-amber-200">
                Próximamente
              </span>
            </div>
            <p className="mt-3 text-[15px] text-gray-500">
              La versión para Linux (Arch, Ubuntu/Debian, Fedora) está en
              desarrollo activo. Se anunciará cuando esté lista.
            </p>
          </section>

          <hr />

          <div className="mt-8 rounded-2xl border border-teal-200 bg-teal-50/50 p-6 text-center">
            <p className="text-[15px] text-gray-700">
              ¿Tienes dudas sobre la instalación o compatibilidad?{" "}
              <a
                href="mailto:contacto@aikalabs.com"
                className="font-semibold text-teal-700 underline decoration-teal-300 underline-offset-4 transition hover:decoration-teal-600"
              >
                Escríbenos a contacto@aikalabs.com
              </a>
            </p>
          </div>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
