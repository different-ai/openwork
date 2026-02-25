import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";
import { HeroBeam } from "../components/hero-beam";
import { SectionTitle } from "../components/section-title";

/* ── 25 expertos incluidos en plan Profesional+ ── */
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

/* ── 5 expertos premium (Business+) — skills avanzados, más comandos ── */
const EXPERTOS_PREMIUM = [
  {
    id: "investigador-web",
    nombre: "Investigador Web",
    desc: "Investigación profunda con fact-checking (SIFT), verificación de fuentes y reportes profesionales. 3 skills + 5 comandos.",
    audiencia: "Periodistas, analistas, consultores",
    color: "border-cyan-200 bg-cyan-50/40 ring-2 ring-cyan-200/60",
    badge: "bg-cyan-50 text-cyan-800",
  },
  {
    id: "creador-contenido",
    nombre: "Creador de Contenido",
    desc: "Posts nativos, calendarios editoriales, hilos virales y copywriting persuasivo (AIDA/PAS/BAB). 3 skills + 5 comandos.",
    audiencia: "Community managers, freelancers",
    color: "border-fuchsia-200 bg-fuchsia-50/40 ring-2 ring-fuchsia-200/60",
    badge: "bg-fuchsia-50 text-fuchsia-800",
  },
  {
    id: "asistente-obsidian",
    nombre: "Asistente Obsidian",
    desc: "Gestión de vault, Zettelkasten, MOCs, weekly reviews y procesamiento de inbox. 3 skills + 5 comandos.",
    audiencia: "PKM, investigadores, escritores",
    color: "border-purple-200 bg-purple-50/40 ring-2 ring-purple-200/60",
    badge: "bg-purple-50 text-purple-800",
  },
  {
    id: "ventas-b2b-premium",
    nombre: "Ventas B2B Pro",
    desc: "Pipeline completo: prospección BANT+MEDDIC, propuestas con 3 opciones de precio, 7 objeciones con scripts. 3 skills + 5 comandos.",
    audiencia: "Equipos comerciales, SDRs",
    color: "border-teal-200 bg-teal-50/40 ring-2 ring-teal-200/60",
    badge: "bg-teal-50 text-teal-800",
  },
  {
    id: "asistente-inmobiliario",
    nombre: "Asistente Inmobiliario",
    desc: "Fichas, análisis de inversión (Cap Rate, GRM), contratos por país, marketing para portales y redes. 3 skills + 5 comandos.",
    audiencia: "Agentes inmobiliarios, inversionistas",
    color: "border-rose-200 bg-rose-50/40 ring-2 ring-rose-200/60",
    badge: "bg-rose-50 text-rose-800",
  },
];

const SECTORES = [
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
  {
    sector: "Salud y clínicas",
    desc: "Agenda citas, automatiza facturación médica, genera resúmenes clínicos y apoya el triaje inicial. Solo el 65% de la atención primaria en LATAM usa expedientes electrónicos — AikaOS cierra esa brecha.",
    icono: "🏥",
  },
  {
    sector: "Inmobiliaria / PropTech",
    desc: "Publica propiedades, genera contratos de arrendamiento, da seguimiento a clientes y automatiza valuaciones comparativas de mercado.",
    icono: "🏠",
  },
  {
    sector: "Logística y cadena de suministro",
    desc: "Predice demanda de inventario, rastrea envíos, coordina proveedores y genera reportes de aduanas. El comercio intrarregional en LATAM es solo el 14% — la eficiencia logística es clave.",
    icono: "🚛",
  },
  {
    sector: "Agricultura / Agtech",
    desc: "Planifica cultivos, genera documentos de cumplimiento fitosanitario, automatiza trámites de exportación y analiza datos climáticos para toma de decisiones.",
    icono: "🌾",
  },
  {
    sector: "Fintech y servicios financieros",
    desc: "Procesa documentos de crédito, automatiza onboarding de clientes, genera reportes de cumplimiento regulatorio y analiza riesgo crediticio.",
    icono: "💳",
  },
  {
    sector: "Construcción",
    desc: "Prepara licitaciones, documenta avance de obra, genera reportes de seguridad laboral y automatiza presupuestos de materiales.",
    icono: "🏗️",
  },
];

/* ── Datos de la tabla comparativa ── */
const COMPARATIVA = [
  {
    criterio: "Precio",
    aikaos: "Desde $20 USD/mes. Incluye la app, actualizaciones y soporte. Sin costos ocultos.",
    openclaw: "El software es gratuito, pero requiere suscripción a un modelo (Claude Max recomendado: $100-200/mes). Configuración técnica por tu cuenta.",
    cowork: "$20/mes (Pro) a $200/mes (Max 20x). Pago obligatorio para acceder a funciones agenticas.",
  },
  {
    criterio: "Privacidad de datos",
    aikaos: "Total. Todo corre en tu máquina. Tus archivos, conversaciones y datos nunca salen de tu computadora.",
    openclaw: "Parcial. Corre localmente pero envía todo a APIs externas. Sin GUI, difícil auditar qué se envía.",
    cowork: "Limitada. El procesamiento ocurre en servidores de Anthropic. Tu información pasa por sus sistemas.",
  },
  {
    criterio: "Interfaz",
    aikaos: "App de escritorio con GUI completa. Cualquier persona puede usarla sin conocimientos técnicos.",
    openclaw: "Sin GUI nativa. Se opera por línea de comandos o mensajes de WhatsApp/Telegram/Discord.",
    cowork: "App de escritorio (macOS y Windows). Interfaz pulida pero requiere conexión constante a internet.",
  },
  {
    criterio: "Modelos de IA",
    aikaos: "Trae tu propio modelo (BYOM): Claude, GPT-4, DeepSeek, Ollama (local). También ofrecemos asistencia para integrar el modelo que prefieras.",
    openclaw: "Cualquiera, pero recomienda fuertemente Claude Max ($100-200/mes) para mejor rendimiento.",
    cowork: "Solo Claude (Anthropic). No puedes usar otros modelos.",
  },
  {
    criterio: "Funciona offline",
    aikaos: "Sí, con modelos locales (Ollama). Sin internet, sin problema.",
    openclaw: "Parcial. El gateway corre local pero necesita API externa para el modelo.",
    cowork: "No. Requiere conexión activa a internet durante toda la sesión.",
  },
  {
    criterio: "Límites de uso",
    aikaos: "Sin límites. Usa todo lo que necesites, cuando lo necesites.",
    openclaw: "Sin límites propios, pero heredas los límites del modelo que uses.",
    cowork: "Límites estrictos por ventanas de 5 horas. Cowork consume tokens mucho más rápido que el chat normal.",
  },
  {
    criterio: "Aprobación de acciones",
    aikaos: "Sí. Ves un plan claro antes de cada acción. Nada se ejecuta sin tu permiso.",
    openclaw: "Limitada. El agente puede actuar sin dirección explícita (caso documentado: creó un perfil de citas sin permiso del usuario).",
    cowork: "Parcial. Pide permiso para eliminar archivos, pero puede ejecutar otras acciones sin confirmación.",
  },
  {
    criterio: "Seguridad",
    aikaos: "Sistema cerrado y controlado por AikaLabs. Sin skills de terceros no verificados. Cada actualización es revisada por nuestro equipo.",
    openclaw: "Riesgos documentados: Cisco encontró exfiltración de datos en skills de terceros. El repositorio de skills carece de verificación adecuada.",
    cowork: "Anthropic advierte explícitamente: no usar para cargas de trabajo reguladas. Sin logs de auditoría para actividad de Cowork.",
  },
  {
    criterio: "Idioma",
    aikaos: "Interfaz nativa en español. Expertos preconfigurados para LATAM con normativas locales (SAT, DIAN, AFIP).",
    openclaw: "Solo en inglés. Sin soporte nativo para español ni normativas latinoamericanas.",
    cowork: "Multiidioma en chat, pero la interfaz y documentación están en inglés.",
  },
  {
    criterio: "Puesta en marcha",
    aikaos: "Nosotros lo instalamos y configuramos. Recibes el sistema listo para trabajar con soporte incluido.",
    openclaw: "Requiere Node 22+, CLI wizard, configuración de gateway, canales de mensajería. Nivel técnico medio-avanzado.",
    cowork: "Descarga la app, inicia sesión con tu cuenta de pago. Sencillo pero requiere suscripción.",
  },
  {
    criterio: "Cumplimiento regulatorio",
    aikaos: "GDPR/LGPD automático: ningún dato sale de tu máquina. Ideal para datos sensibles (médicos, legales, financieros).",
    openclaw: "Depende de tu configuración. Si usas APIs en la nube, los datos salen de tu máquina.",
    cowork: "Anthropic no ofrece cumplimiento HIPAA para Cowork. Ellos mismos advierten no usarlo para cargas reguladas.",
  },
  {
    criterio: "Actualizaciones",
    aikaos: "Incluidas en tu plan. Nuevos modelos, integraciones y mejoras se entregan automáticamente.",
    openclaw: "Actualizaciones comunitarias. Sin garantía de estabilidad ni soporte.",
    cowork: "Actualizaciones de Anthropic. No tienes control sobre qué cambia ni cuándo.",
  },
  {
    criterio: "Servidores MCP",
    aikaos: "Incluidos en planes Profesional+. En Enterprise, desarrollamos servidores MCP a medida para tu empresa.",
    openclaw: "3,000+ skills de la comunidad, pero sin verificación de seguridad.",
    cowork: "Conectores limitados (Google Drive, Gmail, DocuSign). No puedes crear los tuyos.",
  },
];

export default function Home() {
  return (
    <div className="relative min-h-screen">
      <div className="relative z-10">
        <SiteNav />

        <main className="pb-24 pt-20">
          <div className="content-max-width px-6">
            {/* ── Hero ── */}
            <div className="animate-fade-up">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-[12px] font-semibold uppercase tracking-wider text-teal-700">
                <span className="mono">{">_"}</span> por AikaLabs
              </div>
              <h1 className="mb-4 max-w-4xl text-5xl font-bold tracking-tight md:text-6xl">
                Tu equipo de IA privado, listo para trabajar.
              </h1>
              <p className="mb-6 max-w-4xl text-xl font-medium leading-relaxed text-gray-900/80">
                AikaOS es un sistema de agentes inteligentes que corre
                directamente en tu computadora. Automatiza contratos, reportes
                fiscales, campañas, soporte y más — sin que tus datos salgan
                de tu empresa. Nosotros lo instalamos, configuramos y
                mantenemos actualizado.
              </p>
              <p className="mb-10 max-w-3xl text-[15px] leading-relaxed text-gray-500">
                Disponible para macOS con Apple Silicon (M1/M2/M3/M4).
                Windows y Linux en desarrollo.
              </p>
            </div>

            {/* ── CTA principal ── */}
            <div className="mb-10 flex flex-wrap items-center gap-4">
              <a
                href="/enterprise#contacto"
                className="doc-button"
              >
                Solicitar demo
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
                href="/enterprise"
                className="doc-button-dark"
              >
                Ver planes desde $20/mes
              </a>
            </div>

            {/* ── Video demo ── */}
            <div className="group relative mb-2 mt-8">
              <div className="relative overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl transition-transform duration-500 group-hover:scale-[1.01] ring-1 ring-black/5">
                {/* Overlay: tapa "OpenWork" en la esquina superior del video y muestra "AikaOS" */}
                <div className="absolute left-0 top-0 z-10 flex items-center gap-2 bg-[#1e1e2e] px-6 py-2 min-w-[260px]">
                  <span className="font-mono text-sm font-bold text-aika-teal">{">_"}</span>
                  <span className="text-sm font-semibold text-white">AikaOS</span>
                </div>
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

            {/* ══════════════════════════════════════════════════════════
                ── CÓMO FUNCIONA ──
                ══════════════════════════════════════════════════════════ */}
            <section id="como-funciona" className="py-12">
              <SectionTitle>Cómo funciona</SectionTitle>
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                Cómo funciona
              </h2>
              <p className="mb-10 max-w-3xl text-base leading-relaxed text-gray-700">
                AikaOS se instala en tu computadora y se conecta al modelo de
                inteligencia artificial que tú elijas. Nosotros nos encargamos
                de la puesta en marcha.
              </p>

              <div className="space-y-8">
                <div className="flex gap-6">
                  <div className="step-circle shrink-0">1</div>
                  <div className="space-y-3">
                    <h3 className="text-base font-bold">
                      Elige tu plan y contáctanos
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      Selecciona el plan que se adapte a tu empresa (desde $20
                      USD/mes). Nuestro equipo te contactará para coordinar la
                      instalación.
                    </p>
                  </div>
                </div>

                <div className="flex gap-6">
                  <div className="step-circle shrink-0">2</div>
                  <div className="space-y-3">
                    <h3 className="text-base font-bold">
                      Conecta tu modelo de IA (BYOM)
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      AikaOS funciona con el modelo que tú prefieras. Puedes
                      usar tu propia API key de Anthropic (Claude), OpenAI
                      (GPT-4), DeepSeek, o modelos locales con Ollama. También
                      puedes usar una suscripción de OpenCode. Si necesitas
                      ayuda para elegir o integrar un modelo, nuestro equipo te
                      asiste sin costo adicional en planes Business y
                      Enterprise.
                    </p>
                  </div>
                </div>

                <div className="flex gap-6">
                  <div className="step-circle shrink-0">3</div>
                  <div className="space-y-3">
                    <h3 className="text-base font-bold">
                      Recibe tu sistema listo para trabajar
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      Te entregamos AikaOS instalado y configurado con los
                      expertos y skills que necesitas para tu industria. Solo
                      abre la app y empieza a trabajar.
                    </p>
                  </div>
                </div>

                <div className="flex gap-6">
                  <div className="step-circle shrink-0">4</div>
                  <div className="space-y-3">
                    <h3 className="text-base font-bold">
                      Actualizaciones y soporte continuo
                    </h3>
                    <p className="text-[15px] text-gray-700">
                      Tu plan incluye actualizaciones con nuevos modelos, nuevas
                      integraciones y mejoras constantes. Nuestro equipo está
                      disponible para soporte técnico y para desarrollar
                      funcionalidades a medida.
                    </p>
                  </div>
                </div>
              </div>

              {/* BYOM callout */}
              <div className="mt-12 rounded-2xl border border-teal-200 bg-teal-50/50 p-6">
                <h3 className="mb-3 text-[15px] font-bold text-teal-800">
                  Trae tu propio modelo (BYOM)
                </h3>
                <p className="mb-4 text-[14px] leading-relaxed text-gray-700">
                  AikaOS no te obliga a usar un modelo específico. Tú decides
                  qué inteligencia artificial potencia tu sistema:
                </p>
                <ul className="space-y-2 text-[14px] text-gray-700">
                  <li>
                    <strong>API key propia:</strong> Anthropic (Claude), OpenAI
                    (GPT-4), DeepSeek, Google Gemini, o cualquier proveedor
                    compatible.
                  </li>
                  <li>
                    <strong>Modelos locales:</strong> Ollama con Llama, Mistral,
                    Phi u otros modelos que corren 100% en tu máquina sin
                    internet.
                  </li>
                  <li>
                    <strong>OpenCode:</strong> Si ya tienes una suscripción de
                    OpenCode, puedes conectarla directamente.
                  </li>
                  <li>
                    <strong>Asistencia de integración:</strong> En planes
                    Business y Enterprise, nuestro equipo integra el modelo que
                    prefieras en toda tu infraestructura.
                  </li>
                </ul>
              </div>

              {/* Requisitos */}
              <div className="mt-8 rounded-2xl border border-gray-100 bg-gray-50/60 p-6">
                <h3 className="mb-3 text-[15px] font-bold">
                  Requisitos del sistema
                </h3>
                <ul className="space-y-2 text-[14px] text-gray-700">
                  <li>
                    <strong>macOS:</strong> 12.0 (Monterey) o superior
                  </li>
                  <li>
                    <strong>Procesador:</strong> Apple Silicon (M1, M2, M3, M4)
                  </li>
                  <li>
                    <strong>RAM:</strong> 8 GB mínimo (16 GB recomendado para
                    modelos locales)
                  </li>
                  <li>
                    <strong>Disco:</strong> 500 MB para la aplicación
                  </li>
                  <li>
                    <strong>Conexión a internet:</strong> Solo si usas modelos en
                    la nube (Claude, GPT-4)
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ══════════════════════════════════════════════════════════
                ── POR QUÉ LOCAL-FIRST ──
                ══════════════════════════════════════════════════════════ */}
            <section id="local-first" className="py-12">
              <SectionTitle>¿Por qué correr tu IA en local?</SectionTitle>
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                ¿Por qué correr tu IA en local?
              </h2>
              <p className="mb-10 max-w-3xl text-base leading-relaxed text-gray-700">
                La mayoría de las herramientas de IA procesan tus datos en
                servidores externos. Eso significa que tus conversaciones,
                archivos y estrategias de negocio pasan por manos de terceros.
                AikaOS funciona diferente: todo corre en tu propia computadora.
              </p>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-2xl border border-teal-100 bg-teal-50/30 p-6 ring-1 ring-teal-100/50">
                  <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-lg">
                    🔒
                  </div>
                  <h3 className="mb-2 text-[15px] font-bold">
                    Privacidad total de tus datos
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Tus conversaciones, archivos y datos de negocio nunca salen
                    de tu computadora. No hay servidores intermediarios, no hay
                    terceros con acceso a tu información. En abril de 2023,
                    empleados de Samsung filtraron código confidencial al usar
                    ChatGPT — con AikaOS eso es imposible porque nada se envía
                    a la nube.
                  </p>
                </div>

                <div className="rounded-2xl border border-emerald-100 bg-emerald-50/30 p-6 ring-1 ring-emerald-100/50">
                  <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-lg">
                    💰
                  </div>
                  <h3 className="mb-2 text-[15px] font-bold">
                    Costos predecibles
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Un precio fijo mensual que incluye la app, actualizaciones y
                    soporte. Con modelos locales como Ollama, tu costo de
                    infraestructura adicional es $0. Sin sorpresas de consumo,
                    sin facturas variables.
                  </p>
                </div>

                <div className="rounded-2xl border border-violet-100 bg-violet-50/30 p-6 ring-1 ring-violet-100/50">
                  <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-lg">
                    🔓
                  </div>
                  <h3 className="mb-2 text-[15px] font-bold">
                    Sin dependencia de un proveedor
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Elige el modelo que quieras: Claude, GPT-4, DeepSeek, Llama,
                    Mistral o cualquier modelo local. Si un proveedor sube
                    precios o cambia sus términos, simplemente cambias a otro.
                    Tu trabajo y tus automatizaciones siguen funcionando.
                  </p>
                </div>

                <div className="rounded-2xl border border-blue-100 bg-blue-50/30 p-6 ring-1 ring-blue-100/50">
                  <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-lg">
                    📋
                  </div>
                  <h3 className="mb-2 text-[15px] font-bold">
                    Cumplimiento regulatorio automático
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Si tus datos nunca salen de tu máquina, cumples
                    automáticamente con GDPR, LGPD (Brasil), Ley Federal de
                    Protección de Datos (México) y regulaciones similares. Ideal
                    para despachos legales, clínicas y firmas financieras.
                  </p>
                </div>

                <div className="rounded-2xl border border-amber-100 bg-amber-50/30 p-6 ring-1 ring-amber-100/50">
                  <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-lg">
                    ♾️
                  </div>
                  <h3 className="mb-2 text-[15px] font-bold">
                    Sin límites de uso
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Las herramientas cloud tienen límites por ventanas de tiempo
                    — Claude Cowork opera en ventanas de 5 horas y las tareas
                    agenticas consumen tokens mucho más rápido que el chat
                    normal. Con AikaOS y un modelo local, puedes trabajar todo
                    el día sin interrupciones.
                  </p>
                </div>

                <div className="rounded-2xl border border-pink-100 bg-pink-50/30 p-6 ring-1 ring-pink-100/50">
                  <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-pink-100 text-lg">
                    📡
                  </div>
                  <h3 className="mb-2 text-[15px] font-bold">
                    Funciona sin internet
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Con un modelo local instalado, AikaOS funciona completamente
                    offline. Especialmente valioso en Latinoamérica, donde más
                    de la mitad de los hogares rurales no tienen acceso
                    confiable a internet.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ── Visualización: AikaOS conecta tus herramientas con IA ── */}
            <section className="py-12">
              <SectionTitle>Conecta todo con inteligencia artificial</SectionTitle>
              <HeroBeam />
            </section>

            <hr />

            {/* ── Expertos preconfigurados ── */}
            <section id="expertos" className="py-12">
              <SectionTitle>25 expertos + 5 premium</SectionTitle>
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                25 expertos preconfigurados
              </h2>
              <p className="mb-4 max-w-3xl text-base leading-relaxed text-gray-700">
                Cada experto incluye skills especializados, comandos listos para
                usar y servidores MCP configurados. Disponibles a partir del
                plan Profesional ($50/mes).
              </p>
              <p className="mb-10 max-w-3xl text-[14px] text-gray-500">
                El plan Personal ($20/mes) incluye la app base sin expertos
                preconfigurados — ideal para quienes quieren configurar sus
                propios skills.
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

              {/* ── Expertos Premium (Business+) ── */}
              <div className="mt-12">
                <h3 className="mb-3 text-xl font-bold md:text-2xl">
                  + 5 expertos premium
                </h3>
                <p className="mb-4 max-w-3xl text-base leading-relaxed text-gray-700">
                  Expertos avanzados con 3 skills especializados y 5 comandos
                  cada uno. Incluidos a partir del plan Business ($150/mes).
                </p>
                <p className="mb-8 max-w-3xl text-[14px] text-gray-500">
                  Cada experto premium se instala como un worker independiente:
                  descarga la carpeta, selecciónala en AikaOS y empieza a
                  trabajar. Sin terminal, sin configuración.
                </p>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                  {EXPERTOS_PREMIUM.map((exp) => (
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
              </div>
            </section>

            <hr />

            {/* ── Funciones ── */}
            <section id="funciones" className="py-12">
              <SectionTitle>Lo que puedes hacer con AikaOS</SectionTitle>
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
                    Interconexión
                  </span>
                  <h4 className="mb-2 text-[15px] font-bold">
                    Servidores MCP
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Conecta herramientas externas — navegador, bases de datos,
                    APIs — mediante el protocolo MCP. En planes Enterprise,
                    desarrollamos servidores MCP a medida para tu empresa.
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

            {/* ══════════════════════════════════════════════════════════
                ── COMPARATIVA VS COMPETENCIA ──
                ══════════════════════════════════════════════════════════ */}
            <section id="comparativa" className="py-12">
              <SectionTitle>AikaOS vs la competencia</SectionTitle>
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                AikaOS vs la competencia
              </h2>
              <p className="mb-4 max-w-3xl text-base leading-relaxed text-gray-700">
                Existen otras herramientas de IA agentica en el mercado. Aquí
                comparamos AikaOS con las dos más populares para que puedas
                tomar una decisión informada.
              </p>

              {/* Resumen de competidores */}
              <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="rounded-2xl border border-orange-100 bg-orange-50/30 p-6">
                  <h3 className="mb-2 text-[15px] font-bold text-orange-800">
                    OpenClaw (225k estrellas en GitHub)
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Asistente personal creado por Peter Steinberger. Se opera
                    por mensajería (WhatsApp, Telegram, Discord). Siempre
                    encendido, con 3,000+ skills de la comunidad. Sin embargo,
                    tiene problemas de seguridad documentados: Cisco encontró
                    que skills de terceros realizaban exfiltración de datos sin
                    que el usuario lo supiera. Un caso documentado mostró que el
                    agente creó un perfil de citas sin permiso del usuario.
                    Requiere Node 22+ y configuración técnica avanzada.
                  </p>
                </div>
                <div className="rounded-2xl border border-purple-100 bg-purple-50/30 p-6">
                  <h3 className="mb-2 text-[15px] font-bold text-purple-800">
                    Claude Cowork (por Anthropic)
                  </h3>
                  <p className="text-[14px] leading-relaxed text-gray-700">
                    Herramienta agentica de escritorio de Anthropic. Interfaz
                    pulida, acceso directo a archivos locales, sub-agentes en
                    paralelo, conectores para Google Drive, Gmail, DocuSign.
                    Cuesta de $20 a $200/mes. Requiere conexión a internet
                    constante — todo el procesamiento ocurre en servidores de
                    Anthropic. Límites de uso por ventanas de 5 horas. Anthropic
                    advierte explícitamente: &quot;No usar para cargas de trabajo
                    reguladas&quot;. Sin logs de auditoría para actividad de
                    Cowork.
                  </p>
                </div>
              </div>

              {/* Tabla comparativa */}
              <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full min-w-[800px] text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/80">
                      <th className="px-4 py-3 font-bold text-gray-900">
                        Criterio
                      </th>
                      <th className="px-4 py-3 font-bold text-teal-700">
                        AikaOS
                      </th>
                      <th className="px-4 py-3 font-bold text-orange-700">
                        OpenClaw
                      </th>
                      <th className="px-4 py-3 font-bold text-purple-700">
                        Claude Cowork
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARATIVA.map((row, i) => (
                      <tr
                        key={row.criterio}
                        className={
                          i % 2 === 0 ? "bg-white" : "bg-gray-50/50"
                        }
                      >
                        <td className="border-t border-gray-100 px-4 py-3 font-semibold text-gray-900 align-top">
                          {row.criterio}
                        </td>
                        <td className="border-t border-gray-100 px-4 py-3 text-gray-700 align-top">
                          {row.aikaos}
                        </td>
                        <td className="border-t border-gray-100 px-4 py-3 text-gray-700 align-top">
                          {row.openclaw}
                        </td>
                        <td className="border-t border-gray-100 px-4 py-3 text-gray-700 align-top">
                          {row.cowork}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Resumen */}
              <div className="mt-8 rounded-2xl border border-teal-200 bg-teal-50/50 p-6">
                <h3 className="mb-3 text-[15px] font-bold text-teal-800">
                  En resumen: ¿por qué AikaOS?
                </h3>
                <ul className="space-y-2 text-[14px] leading-relaxed text-gray-700">
                  <li>
                    <strong>vs OpenClaw:</strong> AikaOS tiene interfaz gráfica
                    completa (no necesitas terminal ni WhatsApp), flujo de
                    aprobación antes de cada acción, sistema cerrado y
                    verificado (sin skills de terceros no auditados), y puesta
                    en marcha profesional incluida.
                  </li>
                  <li>
                    <strong>vs Claude Cowork:</strong> AikaOS funciona offline,
                    no tiene límites de uso, tus datos nunca salen de tu
                    máquina, puedes usar cualquier modelo de IA, y el precio
                    incluye actualizaciones y soporte — no solo acceso a la
                    herramienta.
                  </li>
                  <li>
                    <strong>Exclusivo de AikaOS:</strong> Interfaz nativa en
                    español, expertos preconfigurados para industrias
                    latinoamericanas, normativas locales integradas (SAT, DIAN,
                    AFIP), desarrollo de servidores MCP a medida, e
                    interconexión entre agentes para empresas.
                  </li>
                </ul>
              </div>
            </section>

            <hr />

            {/* ── Sectores objetivo ── */}
            <section id="sectores" className="py-12">
              <SectionTitle>Diseñado para estos sectores</SectionTitle>
              <h2 className="mb-3 text-2xl font-bold md:text-3xl">
                Diseñado para estos sectores
              </h2>
              <p className="mb-10 max-w-3xl text-base leading-relaxed text-gray-700">
                AikaOS se adapta a las necesidades específicas de cada industria
                en Latinoamérica. Desde despachos legales hasta clínicas
                médicas, desde logística hasta agricultura.
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                {SECTORES.map((c) => (
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

            {/* ── Planes resumen ── */}
            <section id="planes" className="py-12">
              <SectionTitle>Planes</SectionTitle>
              <h2 className="mb-3 text-center text-2xl font-bold md:text-3xl">
                Planes
              </h2>
              <p className="mx-auto mb-10 max-w-2xl text-center text-base leading-relaxed text-gray-700">
                Precios en USD para toda Latinoamérica. Todos los planes
                incluyen actualizaciones y soporte.
              </p>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                {/* Personal */}
                <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-1 text-lg font-bold">Personal</h3>
                  <div className="mb-3 flex items-baseline gap-1">
                    <span className="text-3xl font-bold tracking-tight">$20</span>
                    <span className="text-[14px] text-gray-500">USD/mes</span>
                  </div>
                  <p className="mb-6 text-[14px] text-gray-600">
                    1 instalación. La app base sin expertos preconfigurados.
                    Ideal para explorar y configurar tus propios skills.
                  </p>
                  <ul className="mb-8 flex-1 space-y-2 text-[13px] text-gray-700">
                    <li>App de escritorio (macOS)</li>
                    <li>Trae tu propio modelo (BYOM)</li>
                    <li>Actualizaciones incluidas</li>
                    <li>Soporte por documentación</li>
                  </ul>
                  <a href="/enterprise#contacto" className="doc-button-dark w-full justify-center text-[13px]">
                    Empezar
                  </a>
                </div>

                {/* Profesional */}
                <div className="relative flex flex-col rounded-2xl border-2 border-aika-teal bg-teal-50/30 p-6 shadow-lg">
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-aika-teal px-4 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
                    Más popular
                  </div>
                  <h3 className="mb-1 text-lg font-bold">Profesional</h3>
                  <div className="mb-3 flex items-baseline gap-1">
                    <span className="text-3xl font-bold tracking-tight">$50</span>
                    <span className="text-[14px] text-gray-500">USD/mes</span>
                  </div>
                  <p className="mb-6 text-[14px] text-gray-600">
                    1 instalación. Todos los expertos y skills preconfigurados.
                    Sistema listo para trabajar.
                  </p>
                  <ul className="mb-8 flex-1 space-y-2 text-[13px] text-gray-700">
                    <li>Todo lo de Personal</li>
                    <li>25 expertos preconfigurados para LATAM</li>
                    <li>Todos los skills y comandos</li>
                    <li>Servidores MCP incluidos</li>
                    <li>Soporte por email</li>
                    <li>Puesta en marcha asistida</li>
                  </ul>
                  <a href="/enterprise#contacto" className="doc-button w-full justify-center text-[13px]">
                    Empezar
                  </a>
                </div>

                {/* Business */}
                <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-1 text-lg font-bold">Business</h3>
                  <div className="mb-3 flex items-baseline gap-1">
                    <span className="text-3xl font-bold tracking-tight">$150</span>
                    <span className="text-[14px] text-gray-500">USD/mes</span>
                  </div>
                  <p className="mb-6 text-[14px] text-gray-600">
                    Hasta 5 instalaciones. Interconexión entre agentes y
                    asistencia para integrar tu modelo preferido.
                  </p>
                  <ul className="mb-8 flex-1 space-y-2 text-[13px] text-gray-700">
                    <li>Todo lo de Profesional</li>
                    <li>Hasta 5 instalaciones</li>
                    <li className="font-semibold text-teal-700">+ 5 expertos premium avanzados</li>
                    <li>Interconexión entre agentes vía MCP</li>
                    <li>Asistencia de integración de modelo</li>
                    <li>Soporte prioritario (email + chat)</li>
                    <li>Actualizaciones con prioridad</li>
                  </ul>
                  <a href="/enterprise#contacto" className="doc-button-dark w-full justify-center text-[13px]">
                    Contactar ventas
                  </a>
                </div>

                {/* Enterprise */}
                <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-1 text-lg font-bold">Enterprise</h3>
                  <div className="mb-3 flex items-baseline gap-1">
                    <span className="text-3xl font-bold tracking-tight">$500</span>
                    <span className="text-[14px] text-gray-500">USD/mes</span>
                  </div>
                  <p className="mb-6 text-[14px] text-gray-600">
                    10+ instalaciones. Desarrollo de servidores MCP a medida y
                    arquitectura personalizada.
                  </p>
                  <ul className="mb-8 flex-1 space-y-2 text-[13px] text-gray-700">
                    <li>Todo lo de Business</li>
                    <li>10+ instalaciones (ilimitadas)</li>
                    <li className="font-semibold text-teal-700">30 expertos (25 + 5 premium) + custom</li>
                    <li>Desarrollo de servidores MCP custom</li>
                    <li>Integración completa de modelo en tu infra</li>
                    <li>Acceso anticipado a nuevas funciones</li>
                    <li>Soporte dedicado + videollamada</li>
                    <li>Arquitectura de agentes personalizada</li>
                  </ul>
                  <a href="/enterprise#contacto" className="doc-button-dark w-full justify-center text-[13px]">
                    Hablar con ventas
                  </a>
                </div>
              </div>
            </section>

            <hr />

            {/* ── FAQ ── */}
            <section id="faq" className="py-12">
              <SectionTitle>Preguntas frecuentes</SectionTitle>
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
                    ¿Necesito comprar un modelo de IA aparte?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    AikaOS funciona con el modelo que tú elijas (BYOM: Bring
                    Your Own Model). Puedes usar tu API key de Anthropic,
                    OpenAI, DeepSeek u otro proveedor. También puedes usar
                    modelos locales gratuitos con Ollama, o conectar una
                    suscripción de OpenCode. En planes Business y Enterprise,
                    nuestro equipo te ayuda a integrar el modelo en toda tu
                    infraestructura.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Solo funciona en Mac?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Actualmente AikaOS está optimizado para macOS con
                    procesadores Apple Silicon (M1, M2, M3, M4). Las versiones
                    para Windows y Linux están en desarrollo activo y se
                    anunciarán próximamente.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Mis datos están seguros?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    AikaOS corre localmente en tu computadora. No puede acceder
                    a archivos ni ejecutar comandos sin tu permiso. Ves un plan
                    claro antes de cada acción. Tus datos nunca pasan por
                    servidores de terceros. El sistema es cerrado y cada
                    actualización es verificada por nuestro equipo.
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
                    ¿Qué incluyen las actualizaciones?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    Todos los planes incluyen actualizaciones con nuevos modelos
                    compatibles, nuevas integraciones, mejoras de rendimiento y
                    nuevos skills. En planes Enterprise, también desarrollamos
                    funcionalidades a medida para tu empresa.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿Qué son los servidores MCP?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    MCP (Model Context Protocol) permite que AikaOS se conecte
                    con herramientas externas: navegadores, bases de datos,
                    APIs, CRMs y más. En el plan Enterprise, desarrollamos
                    servidores MCP personalizados que conectan AikaOS con los
                    sistemas específicos de tu empresa, permitiendo
                    interconexión entre agentes y automatización de flujos
                    complejos.
                  </p>
                </div>
                <div>
                  <h4 className="mb-2 text-[15px] font-bold">
                    ¿En qué se diferencia de OpenClaw o Claude Cowork?
                  </h4>
                  <p className="text-[15px] leading-relaxed text-gray-700">
                    AikaOS es un sistema cerrado y verificado con interfaz
                    gráfica completa, a diferencia de OpenClaw que requiere
                    terminal y tiene problemas de seguridad documentados en sus
                    skills de terceros. A diferencia de Claude Cowork, AikaOS
                    funciona offline, no tiene límites de uso, tus datos nunca
                    salen de tu máquina, y puedes usar cualquier modelo de IA.
                    Además, es el único con interfaz nativa en español, expertos
                    para Latinoamérica, y servicio de puesta en marcha
                    profesional.
                  </p>
                </div>
              </div>
            </section>

            <hr />

            {/* ── CTA final ── */}
            <section className="py-12 text-center">
              <SectionTitle>Empieza a automatizar tu empresa</SectionTitle>
              <h2 className="mb-4 text-2xl font-bold md:text-3xl">
                Empieza a automatizar tu empresa
              </h2>
              <p className="mx-auto mb-8 max-w-2xl text-[15px] leading-relaxed text-gray-700">
                Contáctanos para una demo personalizada. Te mostramos cómo
                AikaOS puede automatizar los flujos de trabajo de tu industria.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-4">
                <a
                  href="/enterprise#contacto"
                  className="doc-button"
                >
                  Solicitar demo
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
                  href="/enterprise"
                  className="doc-button-dark"
                >
                  Ver planes desde $20/mes
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
