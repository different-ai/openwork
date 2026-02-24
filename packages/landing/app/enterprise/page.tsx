import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "AikaOS — Precios",
  description:
    "Planes de AikaOS para empresas en Latinoamérica. Desde $20 USD/mes hasta implementación enterprise con desarrollo MCP a medida.",
};

const PLANES = [
  {
    nombre: "Personal",
    precio: "$20",
    periodo: "USD/mes",
    desc: "1 instalación. La app base sin expertos preconfigurados. Ideal para explorar y configurar tus propios skills.",
    destacado: false,
    features: [
      "App de escritorio (macOS)",
      "Trae tu propio modelo (BYOM)",
      "Actualizaciones incluidas",
      "Soporte por documentación",
    ],
    cta: "Empezar",
    ctaHref: "#contacto",
    ctaClass: "doc-button-dark",
  },
  {
    nombre: "Profesional",
    precio: "$50",
    periodo: "USD/mes",
    desc: "1 instalación. Todos los expertos y skills preconfigurados. Sistema listo para trabajar con puesta en marcha asistida.",
    destacado: true,
    features: [
      "Todo lo de Personal",
      "10 expertos preconfigurados para LATAM",
      "Todos los skills y comandos",
      "Servidores MCP incluidos",
      "Soporte por email",
      "Puesta en marcha asistida",
    ],
    cta: "Empezar",
    ctaHref: "#contacto",
    ctaClass: "doc-button",
  },
  {
    nombre: "Business",
    precio: "$150",
    periodo: "USD/mes",
    desc: "Hasta 5 instalaciones. Interconexión entre agentes y asistencia para integrar tu modelo preferido en toda tu infraestructura.",
    destacado: false,
    features: [
      "Todo lo de Profesional",
      "Hasta 5 instalaciones",
      "Interconexión entre agentes vía MCP",
      "Asistencia de integración de modelo",
      "Soporte prioritario (email + chat)",
      "Actualizaciones con prioridad",
    ],
    cta: "Contactar ventas",
    ctaHref: "#contacto",
    ctaClass: "doc-button-dark",
  },
  {
    nombre: "Enterprise",
    precio: "$500",
    periodo: "USD/mes",
    desc: "10+ instalaciones. Desarrollo de servidores MCP a medida, integración completa de modelo y arquitectura personalizada de agentes.",
    destacado: false,
    features: [
      "Todo lo de Business",
      "10+ instalaciones (ilimitadas)",
      "Desarrollo de servidores MCP custom",
      "Integración completa de modelo en tu infra",
      "Acceso anticipado a nuevas funciones",
      "Soporte dedicado + videollamada",
      "Arquitectura de agentes personalizada",
    ],
    cta: "Hablar con ventas",
    ctaHref: "#contacto",
    ctaClass: "doc-button-dark",
  },
];

export default function Enterprise() {
  return (
    <div className="min-h-screen">
      <SiteNav active="enterprise" />

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
              Todos los planes incluyen actualizaciones con nuevos modelos,
              integraciones y mejoras. Precios en USD para toda Latinoamérica.
              Trae tu propio modelo de IA (BYOM) o te ayudamos a elegir uno.
            </p>
          </div>

          {/* ── Pricing cards ── */}
          <div className="mb-16 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
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
                      Personal
                    </th>
                    <th className="pb-3 px-4 text-center font-semibold text-aika-teal">
                      Profesional
                    </th>
                    <th className="pb-3 px-4 text-center font-semibold text-gray-900">
                      Business
                    </th>
                    <th className="pb-3 pl-4 text-center font-semibold text-gray-900">
                      Enterprise
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(
                    [
                      ["Instalaciones", "1", "1", "Hasta 5", "10+"],
                      ["App de escritorio", true, true, true, true],
                      ["Trae tu propio modelo (BYOM)", true, true, true, true],
                      ["Actualizaciones incluidas", true, true, true, true],
                      ["Expertos preconfigurados", false, true, true, true],
                      ["Skills y comandos completos", false, true, true, true],
                      ["Servidores MCP", false, true, true, true],
                      ["Puesta en marcha asistida", false, true, true, true],
                      ["Interconexión entre agentes", false, false, true, true],
                      ["Asistencia integración de modelo", false, false, true, true],
                      ["Soporte prioritario", false, false, true, true],
                      ["Desarrollo MCP a medida", false, false, false, true],
                      ["Integración completa en tu infra", false, false, false, true],
                      ["Acceso anticipado", false, false, false, true],
                      ["Soporte dedicado + videollamada", false, false, false, true],
                    ] as [string, boolean | string, boolean | string, boolean | string, boolean | string][]
                  ).map(([feature, pe, pr, bu, en]) => (
                    <tr key={feature as string}>
                      <td className="py-3 pr-4 text-gray-700">
                        {feature as string}
                      </td>
                      {[pe, pr, bu, en].map((val, i) => (
                        <td key={i} className="py-3 px-4 text-center">
                          {typeof val === "string" ? (
                            <span className="text-[13px] font-semibold text-gray-900">
                              {val}
                            </span>
                          ) : val ? (
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

          {/* ── BYOM ── */}
          <section className="py-12">
            <h2 className="mb-4 text-2xl font-bold md:text-3xl">
              Trae tu propio modelo (BYOM)
            </h2>
            <p className="mb-8 max-w-3xl text-base leading-relaxed text-gray-700">
              AikaOS no te obliga a usar un modelo específico. Tú decides qué
              inteligencia artificial potencia tu sistema. Estas son tus
              opciones:
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="feature-card bg-white/90">
                <h4 className="mb-2 text-[15px] font-bold">
                  API key propia
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-700">
                  Conecta tu clave de Anthropic (Claude), OpenAI (GPT-4),
                  DeepSeek, Google Gemini o cualquier proveedor compatible.
                  Pagas directamente al proveedor por tu consumo.
                </p>
              </div>
              <div className="feature-card bg-white/90">
                <h4 className="mb-2 text-[15px] font-bold">
                  Modelos locales (Ollama)
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-700">
                  Corre Llama, Mistral, Phi u otros modelos 100% en tu máquina.
                  Sin internet, sin costo adicional, con privacidad total.
                </p>
              </div>
              <div className="feature-card bg-white/90">
                <h4 className="mb-2 text-[15px] font-bold">
                  Suscripción de OpenCode
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-700">
                  Si ya tienes una suscripción de OpenCode, puedes conectarla
                  directamente a AikaOS sin configuración adicional.
                </p>
              </div>
              <div className="feature-card border-teal-100 bg-teal-50/30 ring-1 ring-teal-100/60">
                <h4 className="mb-2 text-[15px] font-bold">
                  Asistencia de integración
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-700">
                  En planes Business y Enterprise, nuestro equipo integra el
                  modelo que prefieras en toda tu infraestructura. Te ayudamos
                  a elegir, configurar y optimizar.
                </p>
              </div>
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
            </div>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
