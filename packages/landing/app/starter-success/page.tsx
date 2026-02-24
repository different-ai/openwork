import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "AikaOS — Suscripción confirmada",
  description: "Gracias por suscribirte a AikaOS.",
};

export default function StarterSuccessPage() {
  return (
    <div className="min-h-screen">
      <SiteNav />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <section className="animate-fade-up">
            <div className="mb-4 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
              Suscripción confirmada
            </div>

            <h1 className="mb-4 text-4xl font-bold tracking-tight">
              Gracias. Ya estás dentro.
            </h1>

            <p className="max-w-2xl text-[16px] leading-relaxed text-gray-700">
              Nuestro equipo se pondrá en contacto contigo para coordinar la
              instalación y puesta en marcha de AikaOS.
            </p>
          </section>

          <section className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="feature-card">
              <h2 className="mb-2 text-[15px] font-bold">
                ¿Qué sigue?
              </h2>
              <ul className="space-y-2 text-[14px] leading-relaxed text-gray-600">
                <li>- Revisamos tu configuración de equipo y caso de uso.</li>
                <li>- Coordinamos la instalación y configuración en tu Mac.</li>
                <li>- Te entregamos el sistema listo para trabajar con soporte incluido.</li>
              </ul>
            </div>

            <div className="feature-card bg-gradient-to-br from-teal-50 to-emerald-50">
              <h2 className="mb-2 text-[15px] font-bold">
                ¿Quieres acelerar?
              </h2>
              <p className="mb-4 text-[14px] leading-relaxed text-gray-600">
                Escríbenos para agendar una llamada y compartir tu caso de
                uso. Te ayudamos con el onboarding personalizado.
              </p>
              <a href="mailto:contacto@aikalabs.com" className="doc-button">
                Contactar equipo
              </a>
            </div>
          </section>

          <div className="mt-10 rounded-xl border border-gray-100 bg-white p-5 text-[13px] text-gray-500">
            AikaOS corre localmente en tu máquina, funciona con cualquier
            modelo de IA y tus datos nunca salen de tu computadora.
          </div>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
