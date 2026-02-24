import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";
import { getGithubData } from "../lib/github";

const EXPERTOS = [
  {
    id: "legal-latam",
    nombre: "Legal LATAM",
    desc: "Redacción jurídica, contratos y revisión de documentos legales para México, Colombia y Argentina.",
    audiencia: "Despachos de abogados, asesores legales",
    color: "border-violet-100 bg-violet-50/40 ring-1 ring-violet-100/50",
    badge: "bg-violet-50 text-violet-700",
  },
  {
    id: "contabilidad-latam",
    nombre: "Contabilidad LATAM",
    desc: "Reportes fiscales, conciliación de cuentas y cumplimiento tributario.",
    audiencia: "Contadores, PyMEs, firmas contables",
    color: "border-emerald-100 bg-emerald-50/40 ring-1 ring-emerald-100/50",
    badge: "bg-emerald-50 text-emerald-700",
  },
  {
    id: "retail",
    nombre: "Retail / E-commerce",
    desc: "Gestión de catálogo, inventario y atención al cliente para tiendas en línea.",
    audiencia: "Tiendas online, marketplaces",
    color: "border-sky-100 bg-sky-50/40 ring-1 ring-sky-100/50",
    badge: "bg-sky-50 text-sky-700",
  },
  {
    id: "marketing-digital",
    nombre: "Marketing Digital",
    desc: "Campañas, copywriting y reportes de métricas para el mercado hispanohablante.",
    audiencia: "Agencias de marketing, equipos de growth",
    color: "border-pink-100 bg-pink-50/40 ring-1 ring-pink-100/50",
    badge: "bg-pink-50 text-pink-700",
  },
  {
    id: "educacion",
    nombre: "Educación",
    desc: "Planes de clase, evaluaciones y material didáctico para instituciones educativas.",
    audiencia: "Escuelas, universidades, tutores",
    color: "border-amber-100 bg-amber-50/40 ring-1 ring-amber-100/50",
    badge: "bg-amber-50 text-amber-700",
  },
  {
    id: "gobierno",
    nombre: "Gobierno / Sector Público",
    desc: "Oficios, informes de transparencia y respuestas ciudadanas en lenguaje oficial.",
    audiencia: "Municipios, dependencias gubernamentales",
    color: "border-blue-100 bg-blue-50/40 ring-1 ring-blue-100/50",
    badge: "bg-blue-50 text-blue-700",
  },
  {
    id: "soporte-tecnico",
    nombre: "Soporte Técnico",
    desc: "Diagnóstico de tickets, base de conocimiento y escalamiento para help desks.",
    audiencia: "Help desks, equipos de soporte SaaS",
    color: "border-orange-100 bg-orange-50/40 ring-1 ring-orange-100/50",
    badge: "bg-orange-50 text-orange-700",
  },
  {
    id: "ventas-b2b",
    nombre: "Ventas B2B",
    desc: "Propuestas comerciales, seguimiento de leads y reportes de pipeline.",
    audiencia: "Equipos comerciales, ejecutivos de ventas",
    color: "border-teal-100 bg-teal-50/40 ring-1 ring-teal-100/50",
    badge: "bg-teal-50 text-teal-700",
  },
  {
    id: "recursos-humanos",
    nombre: "Recursos Humanos",
    desc: "Reclutamiento, evaluaciones de desempeño y políticas internas.",
    audiencia: "Departamentos de RRHH, reclutadores",
    color: "border-indigo-100 bg-indigo-50/40 ring-1 ring-indigo-100/50",
    badge: "bg-indigo-50 text-indigo-700",
  },
  {
    id: "web-dev",
    nombre: "Desarrollo Web",
    desc: "Full-stack con Next.js, Tailwind y herramientas modernas de desarrollo.",
    audiencia: "Desarrolladores, agencias, freelancers",
    color: "border-gray-200 bg-gray-50/40 ring-1 ring-gray-100/50",
    badge: "bg-gray-100 text-gray-700",
  },
];

const CLIENTES = [
  {
    sector: "Despachos legales",
    desc: "Automatiza contratos, poderes notariales y revisión de documentos en minutos.",
    icono: "⚖️",
  },
  {
    sector: "Firmas contables",
    desc: "Genera reportes fiscales, concilia cuentas y cumple con normativas locales.",
    icono: "📊",
  },
  {
    sector: "Comercio minorista",
    desc: "Gestiona catálogos, responde clientes y analiza inventario automáticamente.",
    icono: "🛒",
  },
  {
    sector: "Agencias de marketing",
    desc: "Crea campañas, genera copy persuasivo y reporta métricas semanales.",
    icono: "📣",
  },
  {
    sector: "Instituciones educativas",
    desc: "Diseña planes de clase, rúbricas y exámenes alineados a estándares.",
    icono: "🎓",
  },
  {
    sector: "Gobierno municipal",
    desc: "Redacta oficios, informes de transparencia y respuestas ciudadanas.",
    icono: "🏛️",
  },
];

export default async function Home() {
  const github = await getGithubData();
  return (
    <div className="relative min-h-screen">
      <div className="relative z-10">
        <SiteNav stars={github.stars} />

        <main className="pb-24 pt-20">
          <div className="content-max-width px-6">
            {/* ── Hero ── */}
            <div className="animate-fade-up">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-[12px] font-semibold uppercase tracking-wider text-teal-700">
                <span className="mono">{">_"}</span> por AikaLabs
              </div>
              <h1 className="mb-4 max-w-4xl text-5xl font-bold tracking-tight md:text-6xl">
                Agentes IA preconfigurados para tu empresa.
              </h1>
              <p className="mb-10 max-w-4xl text-xl font-medium leading-relaxed text-gray-900/80">
                AikaOS convierte la inteligencia artificial en empleados
                digitales listos para trabajar. Elige un experto, instálalo en
                tu escritorio y automatiza tareas reales — contratos, reportes
                fiscales, campañas, soporte y más.
              </p>
            </div>

            {/* ── CTA ── */}
            <div className="mb-10 flex flex-wrap items-center gap-3">
              <a
                href={github.downloads.macos}
                className="doc-button"
                rel="noreferrer"
                target="_blank"
              >
                Descargar para macOS
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
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
              </a>
              <div className="ml-2 flex gap-4">
                <a
                  href="/download#windows"
                  className="text-[15px] font-medium text-gray-900/60 transition hover:text-gray-900"
                >
                  Windows{" "}
                  <span className="alpha-tag ml-1 border-gray-900/10 text-gray-900/60">
                    Alpha
                  </span>
                </a>
                <a
                  href="/download#linux"
                  className="text-[15px] font-medium text-gray-900/60 transition hover:text-gray-900"
                >
                  Linux{" "}
                  <span className="alpha-tag ml-1 border-gray-900/10 text-gray-900/60">
                    Alpha
                  </span>
                </a>
              </div>
            </div>

            {/* ── Video demo ── */}
            <div className="group relative mb-2 mt-8">
              <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl transition-transform duration-500 group-hover:scale-[1.01] ring-1 ring-black/5">
                <video
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="w-full block"
                >
                  <source src="/app-demo.mp4" type="video/mp4" />
                </video>
              </div>
            </div>

            <p className="mb-16 text-center text-[13px] text-gray-500">
              Interfaz real de AikaOS — crea tareas, ejecuta skills y automatiza
              flujos desde tu escritorio.
            </p>

            <hr />

            {/* ── Expertos preconfigurados ── */}
            <section id="expertos" className="py-12">
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                10 expertos preconfigurados
              </h2>
              <p className="mb-10 max-w-3xl text-base leading-relaxed text-gray-700">
                Cada experto incluye skills especializados, comandos listos para
                usar y servidores MCP sugeridos. Instálalos con un clic desde la
                pestaña Skills.
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                {EXPERTOS.map((exp) => (
                  <div
                    key={exp.id}
                    className={`feature-card ${exp.color}`}
                  >
                    <span
                      className={`mb-3 inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${exp.badge}`}
                    >
                      {exp.audiencia.split(",")[0]}
                    </span>
                    <h4 className="mb-2 text-[15px] font-bold">
                      {exp.nombre}
                    </h4>
                    <p className="text-[14px] leading-relaxed text-gray-700">
                      {exp.desc}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <hr />

            {/* ── Funciones ── */}
            <section id="funciones" className="py-12">
              <h2 className="mb-10 text-2xl font-bold md:text-3xl">
                Lo que puedes hacer con AikaOS
              </h2>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
                <div className="feature-card border-teal-100 bg-white/90 ring-1 ring-teal-100/60">
                  <span className="mb-3 inline-flex rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-teal-700">
                    Productividad
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Multitarea entre proyectos
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Ejecuta múltiples hilos en paralelo y cambia de contexto
                    entre tareas de navegador y archivos locales al instante.
                  </p>
                </div>
                <div className="feature-card border-violet-100 bg-white/90 ring-1 ring-violet-100/60">
                  <span className="mb-3 inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                    Automatización
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Tareas programadas
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Ejecuta cualquier prompt en un horario o actívalo
                    automáticamente. Configúralo una vez y deja que se encargue
                    solo.
                  </p>
                </div>
                <div className="feature-card border-emerald-100 bg-white/90 ring-1 ring-emerald-100/60">
                  <span className="mb-3 inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                    Reutilización
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Skills compartibles
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Convierte cualquier flujo complejo en un skill reutilizable.
                    Compártelo con tu equipo para que lo ejecuten con un clic.
                  </p>
                </div>
                <div className="feature-card border-amber-100 bg-white/90 ring-1 ring-amber-100/60">
                  <span className="mb-3 inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                    Extensible
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Servidores MCP
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Conecta herramientas externas — navegador, bases de datos,
                    APIs — mediante el protocolo MCP. Sin código adicional.
                  </p>
                </div>
                <div className="feature-card border-sky-100 bg-white/90 ring-1 ring-sky-100/60">
                  <span className="mb-3 inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                    Local-first
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Privacidad total
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Todo corre en tu máquina. Tus datos nunca salen de tu
                    escritorio a menos que tú lo decidas.
                  </p>
                </div>
                <div className="feature-card border-pink-100 bg-white/90 ring-1 ring-pink-100/60">
                  <span className="mb-3 inline-flex rounded-full bg-pink-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-pink-700">
                    LATAM
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Hecho para Latinoamérica
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Interfaz en español, expertos que entienden normativas
                    locales (SAT, DIAN, AFIP) y flujos adaptados a la región.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ── Clientes objetivo ── */}
            <section id="clientes" className="py-12">
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                Diseñado para estos sectores
              </h2>
              <p className="mb-10 max-w-3xl text-base leading-relaxed text-gray-700">
                AikaOS se adapta a las necesidades específicas de cada industria
                en Latinoamérica. Estos son algunos de los sectores que ya
                pueden beneficiarse.
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                {CLIENTES.map((c) => (
                  <div key={c.sector} className="feature-card bg-white/90">
                    <div className="mb-3 text-2xl">{c.icono}</div>
                    <h4 className="mb-2 text-[15px] font-bold">{c.sector}</h4>
                    <p className="text-[14px] leading-relaxed text-gray-700">
                      {c.desc}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <hr />

            {/* ── Cómo empezar ── */}
            <section id="empezar" className="py-12">
              <h2 className="mb-6 text-2xl font-bold md:text-3xl">
                Empieza en 3 pasos
              </h2>

              <div className="space-y-12">
                <div className="flex gap-6">
                  <div className="step-circle shrink-0">1</div>
                  <div className="space-y-4">
                    <h3 className="text-base font-bold">
                      Descarga e instala AikaOS
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      Disponible para macOS (estable), Windows y Linux (alpha).
                      No requiere registro.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <a
                        href={github.downloads.macos}
                        className="doc-button"
                        rel="noreferrer"
                        target="_blank"
                      >
                        Descargar para macOS
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
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                          />
                        </svg>
                      </a>
                      <div className="ml-2 flex gap-4">
                        <a
                          href="/download#windows"
                          className="text-[15px] text-gray-700 transition hover:text-black"
                        >
                          Windows{" "}
                          <span className="alpha-tag ml-1">Alpha</span>
                        </a>
                        <a
                          href="/download#linux"
                          className="text-[15px] text-gray-700 transition hover:text-black"
                        >
                          Linux{" "}
                          <span className="alpha-tag ml-1">Alpha</span>
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex gap-6">
                  <div className="step-circle shrink-0">2</div>
                  <div className="space-y-4">
                    <h3 className="text-base font-bold">
                      Elige un experto preconfigurado
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      Ve a la pestaña Skills, haz clic en{" "}
                      <strong>Aplicar Plantilla</strong> y selecciona el experto
                      que necesitas. Se instalan skills y comandos
                      automáticamente.
                    </p>
                  </div>
                </div>

                <div className="flex gap-6">
                  <div className="step-circle shrink-0">3</div>
                  <div className="space-y-4">
                    <h3 className="text-base font-bold">
                      Envía tu primera tarea
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      Escribe lo que necesitas en lenguaje natural. El agente
                      ejecuta la tarea, te muestra un plan antes de actuar y tú
                      apruebas cada paso.
                    </p>
                    <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3">
                      <div className="flex flex-col gap-3 rounded-xl border border-violet-100 bg-white/90 p-4 shadow-sm ring-1 ring-violet-100/50">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                          Legal
                        </span>
                        <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                          &ldquo;Redacta un contrato de arrendamiento para un
                          local comercial en CDMX.&rdquo;
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 rounded-xl border border-emerald-100 bg-white/90 p-4 shadow-sm ring-1 ring-emerald-100/50">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                          Contabilidad
                        </span>
                        <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                          &ldquo;Genera el reporte fiscal mensual con desglose
                          de IVA e ISR.&rdquo;
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 rounded-xl border border-pink-100 bg-white/90 p-4 shadow-sm ring-1 ring-pink-100/50">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-pink-700">
                          Marketing
                        </span>
                        <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                          &ldquo;Crea una campaña de email para el Buen Fin con
                          3 variantes de copy.&rdquo;
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <hr />

            {/* ── FAQ ── */}
            <section id="faq" className="py-12">
              <h2 className="mb-10 text-2xl font-bold md:text-3xl">
                Preguntas frecuentes
              </h2>
              <div className="space-y-12">
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Qué diferencia hay entre AikaOS y un chatbot normal?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Un chatbot te da respuestas de texto. AikaOS puede ejecutar
                    acciones reales: crear archivos, editar documentos, navegar
                    la web y correr comandos en tu máquina — siempre con tu
                    aprobación.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Es gratis?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Sí. AikaOS es open source y puedes usarlo gratis con modelos
                    locales. Solo pagas por uso de API si decides conectar
                    modelos en la nube como Claude o GPT-4.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Mis datos están seguros?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    AikaOS corre localmente en tu computadora. No puede acceder
                    a archivos ni ejecutar comandos sin tu permiso. Ves un plan
                    claro antes de cada acción.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Funciona con normativas de mi país?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Los expertos preconfigurados incluyen conocimiento de
                    normativas locales (SAT en México, DIAN en Colombia, AFIP en
                    Argentina). Puedes personalizar los skills para tu
                    jurisdicción específica.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Puedo compartir automatizaciones con mi equipo?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Sí. Empaqueta cualquier flujo como un skill y compártelo.
                    Tus compañeros lo instalan y lo ejecutan en sus propias
                    máquinas al instante.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ── CTA final ── */}
            <section className="py-12 text-center">
              <h2 className="mb-4 text-2xl font-bold md:text-3xl">
                Empieza a automatizar hoy
              </h2>
              <p className="mx-auto mb-8 max-w-2xl text-[15px] leading-relaxed text-gray-700">
                Descarga AikaOS, elige un experto y envía tu primera tarea. Sin
                registro, sin tarjeta de crédito, sin complicaciones.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <a
                  href={github.downloads.macos}
                  className="doc-button"
                  rel="noreferrer"
                  target="_blank"
                >
                  Descargar para macOS
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
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                </a>
                <a
                  href="/enterprise"
                  className="doc-button-dark"
                >
                  Ver precios para empresas
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
    </div>
  );
}
