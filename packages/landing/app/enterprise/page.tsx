import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "AikaOS — Precios",
  description:
    "Planes de AikaOS para empresas en Latinoamérica. Desde uso gratuito hasta implementación enterprise con soporte dedicado.",
};

const PLANES = [
  {
    nombre: "Starter",
    precio: "Gratis",
    periodo: "",
    desc: "Para profesionales independientes y equipos pequeños que quieren probar la automatización con IA.",
    destacado: false,
    features: [
      "App de escritorio (macOS, Windows, Linux)",
      "10 expertos preconfigurados",
      "Skills y comandos ilimitados",
      "Modelos locales gratuitos",
      "Comunidad en GitHub",
    ],
    cta: "Descargar gratis",
    ctaHref: "/download",
    ctaClass: "doc-button-dark",
  },
  {
    nombre: "Profesional",
    precio: "$49 USD",
    periodo: "/mes por worker",
    desc: "Para PyMEs y equipos que necesitan workers en la nube, automatizaciones programadas y soporte prioritario.",
    destacado: true,
    features: [
      "Todo lo de Starter",
      "Workers hospedados en la nube",
      "Automatizaciones programadas",
      "Acceso desde Slack y Telegram",
      "Soporte prioritario por email",
      "Onboarding personalizado",
    ],
    cta: "Contactar ventas",
    ctaHref: "#contacto",
    ctaClass: "doc-button",
  },
  {
    nombre: "Enterprise",
    precio: "Personalizado",
    periodo: "",
    desc: "Para organizaciones que requieren implementación a medida, seguridad avanzada y soporte dedicado.",
    destacado: false,
    features: [
      "Todo lo de Profesional",
      "Workers ilimitados",
      "SSO y control de acceso",
      "Auditoría y permisos granulares",
      "Skills personalizados por industria",
      "Gerente de cuenta dedicado",
      "SLA garantizado",
    ],
    cta: "Hablar con ventas",
    ctaHref: "#contacto",
    ctaClass: "doc-button-dark",
  },
];

export default async function Enterprise() {
  const github = await getGithubData();

  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} active="enterprise" />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up text-center">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              Precios
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              Un plan para cada etapa de tu empresa
            </h1>
            <p className="mx-auto mb-12 max-w-2xl text-[17px] leading-relaxed text-gray-700">
              Empieza gratis con modelos locales. Escala a la nube cuando tu
              equipo lo necesite. Precios en USD para toda Latinoamérica.
            </p>
          </div>

          {/* ── Pricing cards ── */}
          <div className="mb-16 grid grid-cols-1 gap-6 md:grid-cols-3">
            {PLANES.map((plan) => (
              <div
                key={plan.nombre}
                className={`relative flex flex-col rounded-2xl border p-8 transition-transform hover:-translate-y-1 ${
                  plan.destacado
                    ? "border-aika-teal bg-teal-50/30 shadow-lg ring-2 ring-aika-teal/20"
                    : "border-gray-200 bg-white shadow-sm"
                }`}
              >
                {plan.destacado && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-aika-teal px-4 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
                    Más popular
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="mb-2 text-lg font-bold">{plan.nombre}</h3>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold tracking-tight">
                      {plan.precio}
                    </span>
                    {plan.periodo && (
                      <span className="text-[14px] text-gray-500">
                        {plan.periodo}
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-[14px] leading-relaxed text-gray-600">
                    {plan.desc}
                  </p>
                </div>

                <ul className="mb-8 flex-1 space-y-3">
                  {plan.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-[14px] text-gray-700"
                    >
                      <svg
                        className="mt-0.5 h-4 w-4 shrink-0 text-aika-teal"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>

                <a
                  href={plan.ctaHref}
                  className={`${plan.ctaClass} w-full justify-center`}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>

          {/* ── Comparativa rápida ── */}
          <section className="py-12">
            <h2 className="mb-8 text-center text-2xl font-bold">
              Comparativa rápida
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[14px]">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="pb-3 pr-4 font-semibold text-gray-900">
                      Característica
                    </th>
                    <th className="pb-3 px-4 text-center font-semibold text-gray-900">
                      Starter
                    </th>
                    <th className="pb-3 px-4 text-center font-semibold text-aika-teal">
                      Profesional
                    </th>
                    <th className="pb-3 pl-4 text-center font-semibold text-gray-900">
                      Enterprise
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {[
                    ["App de escritorio", true, true, true],
                    ["Expertos preconfigurados", true, true, true],
                    ["Modelos locales", true, true, true],
                    ["Workers en la nube", false, true, true],
                    ["Automatizaciones programadas", false, true, true],
                    ["Slack / Telegram", false, true, true],
                    ["Soporte prioritario", false, true, true],
                    ["SSO / Control de acceso", false, false, true],
                    ["Auditoría granular", false, false, true],
                    ["SLA garantizado", false, false, true],
                  ].map(([feature, s, p, e]) => (
                    <tr key={feature as string}>
                      <td className="py-3 pr-4 text-gray-700">
                        {feature as string}
                      </td>
                      {[s, p, e].map((val, i) => (
                        <td key={i} className="py-3 px-4 text-center">
                          {val ? (
                            <svg
                              className="mx-auto h-4 w-4 text-aika-teal"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <hr />

          {/* ── Contacto ── */}
          <section id="contacto" className="py-12 text-center">
            <h2 className="mb-4 text-2xl font-bold md:text-3xl">
              ¿Listo para automatizar tu empresa?
            </h2>
            <p className="mx-auto mb-8 max-w-2xl text-[15px] leading-relaxed text-gray-700">
              Escríbenos para agendar una demo personalizada o resolver
              cualquier duda sobre implementación en tu organización.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <a
                href="mailto:contacto@aikalabs.com"
                className="doc-button"
              >
                contacto@aikalabs.com
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              </a>
              <a
                href="/download"
                className="doc-button-dark"
              >
                O descarga gratis
              </a>
            </div>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
