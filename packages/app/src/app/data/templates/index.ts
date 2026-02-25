/**
 * AikaOS Industry Templates
 *
 * Each template bundles skills (SKILL.md content), commands (frontmatter+prompt),
 * and suggested MCP servers so a worker is productive out of the box for a
 * specific industry or role.
 *
 * Templates are pure data — they don't modify upstream code. A future UI
 * integration will let users pick a template when creating a worker and copy
 * these files into `.opencode/skills/` and `.opencode/commands/`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A skill that will be written to `.opencode/skills/<slug>/SKILL.md`. */
export interface TemplateSkill {
  /** Folder name under `.opencode/skills/`. */
  slug: string;
  /** Raw markdown content (including YAML frontmatter). */
  content: string;
}

/** A command that will be written to `.opencode/commands/<slug>.md`. */
export interface TemplateCommand {
  /** File name (without `.md`) under `.opencode/commands/`. */
  slug: string;
  /** Raw markdown content (including YAML frontmatter). */
  content: string;
}

/** An MCP server suggestion shown to the user after template installation. */
export interface SuggestedMcp {
  /** Human-readable name (e.g. "Browser Automation"). */
  name: string;
  /** NPM package or URL to install. */
  package: string;
  /** One-line explanation of why this template needs it. */
  reason: string;
}

/** Full template definition. */
export interface AikaTemplate {
  /** Unique identifier (kebab-case). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description shown in the template picker. */
  description: string;
  /** Lucide icon name for the UI. */
  icon: string;
  /** ISO 639-1 language the template content is written in. */
  locale: "en" | "es";
  /** Industry or function category. */
  category: "industry" | "function";
  /** Target audience. */
  audience: string;
  /** Skills bundled with this template. */
  skills: TemplateSkill[];
  /** Commands bundled with this template. */
  commands: TemplateCommand[];
  /** MCP servers the user should consider connecting. */
  suggestedMcps: SuggestedMcp[];
}

// ---------------------------------------------------------------------------
// Lazy loaders — each template's metadata.ts default-exports an AikaTemplate
// ---------------------------------------------------------------------------

export async function loadTemplate(id: string): Promise<AikaTemplate> {
  switch (id) {
    case "web-dev":
      return (await import("./web-dev/metadata")).default;
    case "legal-latam":
      return (await import("./legal-latam/metadata")).default;
    case "contabilidad-latam":
      return (await import("./contabilidad-latam/metadata")).default;
    case "retail":
      return (await import("./retail/metadata")).default;
    case "marketing-digital":
      return (await import("./marketing-digital/metadata")).default;
    case "educacion":
      return (await import("./educacion/metadata")).default;
    case "gobierno":
      return (await import("./gobierno/metadata")).default;
    case "soporte-tecnico":
      return (await import("./soporte-tecnico/metadata")).default;
    case "ventas-b2b":
      return (await import("./ventas-b2b/metadata")).default;
    case "recursos-humanos":
      return (await import("./recursos-humanos/metadata")).default;
    // Tier 1 — Personal ($20/mes)
    case "investigador-web":
      return (await import("./investigador-web/metadata")).default;
    case "gestor-email":
      return (await import("./gestor-email/metadata")).default;
    case "creador-contenido":
      return (await import("./creador-contenido/metadata")).default;
    case "asistente-obsidian":
      return (await import("./asistente-obsidian/metadata")).default;
    case "planificador-proyectos":
      return (await import("./planificador-proyectos/metadata")).default;
    // Tier 2 — Profesional ($50/mes)
    case "asistente-fiscal":
      return (await import("./asistente-fiscal/metadata")).default;
    case "redactor-bilingue":
      return (await import("./redactor-bilingue/metadata")).default;
    case "analista-competencia":
      return (await import("./analista-competencia/metadata")).default;
    case "gestor-whatsapp":
      return (await import("./gestor-whatsapp/metadata")).default;
    case "asistente-inmobiliario":
      return (await import("./asistente-inmobiliario/metadata")).default;
    // Tier 3 — Business ($150/mes)
    case "medico-clinica":
      return (await import("./medico-clinica/metadata")).default;
    case "abogado-migratorio":
      return (await import("./abogado-migratorio/metadata")).default;
    case "profesor-universitario":
      return (await import("./profesor-universitario/metadata")).default;
    case "freelancer-admin":
      return (await import("./freelancer-admin/metadata")).default;
    case "agente-aduanas":
      return (await import("./agente-aduanas/metadata")).default;
    default:
      throw new Error(`Unknown template: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Catalog — lightweight list for the template picker (no content loaded)
// ---------------------------------------------------------------------------

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  locale: "en" | "es";
  category: "industry" | "function";
  audience: string;
}

export const templateCatalog: TemplateSummary[] = [
  {
    id: "web-dev",
    name: "Web Development",
    description: "Full-stack web development with Next.js, Tailwind, and modern tooling.",
    icon: "Code2",
    locale: "en",
    category: "function",
    audience: "Developers, agencies, freelancers",
  },
  {
    id: "legal-latam",
    name: "Legal LATAM",
    description: "Redacción jurídica, contratos y revisión de documentos legales para México, Colombia y Argentina.",
    icon: "Scale",
    locale: "es",
    category: "industry",
    audience: "Despachos de abogados, asesores legales",
  },
  {
    id: "contabilidad-latam",
    name: "Contabilidad LATAM",
    description: "Reportes fiscales, conciliación de cuentas y cumplimiento tributario para LATAM.",
    icon: "Calculator",
    locale: "es",
    category: "industry",
    audience: "Contadores, PyMEs, firmas contables",
  },
  {
    id: "retail",
    name: "Retail / E-commerce",
    description: "Gestión de catálogo, inventario y atención al cliente para tiendas en línea.",
    icon: "ShoppingCart",
    locale: "es",
    category: "industry",
    audience: "Tiendas online, marketplaces, comercio minorista",
  },
  {
    id: "marketing-digital",
    name: "Marketing Digital",
    description: "Campañas, copywriting y reportes de métricas para el mercado hispanohablante.",
    icon: "Megaphone",
    locale: "es",
    category: "function",
    audience: "Agencias de marketing, equipos de growth",
  },
  {
    id: "educacion",
    name: "Educación",
    description: "Planes de clase, evaluaciones y material didáctico para instituciones educativas.",
    icon: "GraduationCap",
    locale: "es",
    category: "industry",
    audience: "Escuelas, universidades, tutores",
  },
  {
    id: "gobierno",
    name: "Gobierno / Sector Público",
    description: "Oficios, informes de transparencia y respuestas ciudadanas en lenguaje oficial.",
    icon: "Landmark",
    locale: "es",
    category: "industry",
    audience: "Municipios, dependencias gubernamentales",
  },
  {
    id: "soporte-tecnico",
    name: "Soporte Técnico",
    description: "Diagnóstico de tickets, base de conocimiento y escalamiento para help desks.",
    icon: "Headphones",
    locale: "es",
    category: "function",
    audience: "Help desks, equipos de soporte SaaS",
  },
  {
    id: "ventas-b2b",
    name: "Ventas B2B",
    description: "Propuestas comerciales, seguimiento de leads y reportes de pipeline.",
    icon: "Handshake",
    locale: "es",
    category: "function",
    audience: "Equipos comerciales, ejecutivos de ventas",
  },
  {
    id: "recursos-humanos",
    name: "Recursos Humanos",
    description: "Reclutamiento, evaluaciones de desempeño y políticas internas.",
    icon: "Users",
    locale: "es",
    category: "function",
    audience: "Departamentos de RRHH, reclutadores",
  },
  // Tier 1 — Personal ($20/mes)
  {
    id: "investigador-web",
    name: "Investigador Web",
    description: "Investigación profunda, comparación de opciones y resúmenes ejecutivos con fuentes verificadas.",
    icon: "Search",
    locale: "es",
    category: "function",
    audience: "Profesionales, estudiantes, analistas, emprendedores",
  },
  {
    id: "gestor-email",
    name: "Gestor de Email",
    description: "Redacción profesional, clasificación inteligente y seguimiento de correos electrónicos.",
    icon: "Mail",
    locale: "es",
    category: "function",
    audience: "Profesionales, ejecutivos, equipos de ventas",
  },
  {
    id: "creador-contenido",
    name: "Creador de Contenido",
    description: "Posts para redes sociales, calendarios editoriales y adaptación de contenido multiplataforma.",
    icon: "PenTool",
    locale: "es",
    category: "function",
    audience: "Community managers, creadores de contenido, marcas",
  },
  {
    id: "asistente-obsidian",
    name: "Asistente Obsidian",
    description: "Lee tu vault, conecta notas, genera resúmenes semanales y mantiene tu segundo cerebro organizado.",
    icon: "Brain",
    locale: "es",
    category: "function",
    audience: "Usuarios de Obsidian, investigadores, profesionales del conocimiento",
  },
  {
    id: "planificador-proyectos",
    name: "Planificador de Proyectos",
    description: "Roadmaps, desglose de tareas, estimaciones y reportes de avance para equipos y freelancers.",
    icon: "GanttChart",
    locale: "es",
    category: "function",
    audience: "Project managers, startups, freelancers, equipos de desarrollo",
  },
  // Tier 2 — Profesional ($50/mes)
  {
    id: "asistente-fiscal",
    name: "Asistente Fiscal LATAM",
    description: "Cálculos de impuestos, calendario de obligaciones y revisión de facturas para México, Colombia, Argentina, Chile y Perú.",
    icon: "Receipt",
    locale: "es",
    category: "industry",
    audience: "Contadores independientes, PyMEs, emprendedores",
  },
  {
    id: "redactor-bilingue",
    name: "Redactor Bilingüe EN↔ES",
    description: "Traducción profesional, redacción bilingüe y localización para mercados US y LATAM.",
    icon: "Languages",
    locale: "es",
    category: "function",
    audience: "Empresas internacionales, exportadores, freelancers bilingües",
  },
  {
    id: "analista-competencia",
    name: "Analista de Competencia",
    description: "Análisis de competidores, comparación de precios y monitoreo de tendencias de mercado.",
    icon: "TrendingUp",
    locale: "es",
    category: "function",
    audience: "Startups, e-commerce, agencias, equipos de estrategia",
  },
  {
    id: "gestor-whatsapp",
    name: "Gestor de WhatsApp Business",
    description: "Respuestas rápidas, catálogos de productos y flujos de venta por WhatsApp.",
    icon: "MessageCircle",
    locale: "es",
    category: "function",
    audience: "PyMEs, tiendas online, negocios locales, vendedores independientes",
  },
  {
    id: "asistente-inmobiliario",
    name: "Asistente Inmobiliario",
    description: "Fichas de propiedades, análisis de inversión, contratos de arrendamiento y comparación de precios por zona.",
    icon: "Building2",
    locale: "es",
    category: "industry",
    audience: "Agentes inmobiliarios, inversionistas, administradores de propiedades",
  },
  // Tier 3 — Business ($150/mes)
  {
    id: "medico-clinica",
    name: "Médico / Clínica",
    description: "Notas clínicas SOAP, referimientos a especialistas e indicaciones para pacientes en lenguaje claro.",
    icon: "Stethoscope",
    locale: "es",
    category: "industry",
    audience: "Médicos generales, especialistas, clínicas privadas",
  },
  {
    id: "abogado-migratorio",
    name: "Abogado Migratorio",
    description: "Orientación sobre visas, checklists de documentos y borradores de cartas para trámites migratorios.",
    icon: "Plane",
    locale: "es",
    category: "industry",
    audience: "Migrantes, abogados migratorios, empresas con empleados internacionales",
  },
  {
    id: "profesor-universitario",
    name: "Profesor Universitario",
    description: "Syllabus, exámenes, rúbricas y retroalimentación académica con taxonomía de Bloom.",
    icon: "GraduationCap",
    locale: "es",
    category: "industry",
    audience: "Profesores universitarios, coordinadores académicos, tutores",
  },
  {
    id: "freelancer-admin",
    name: "Freelancer Admin",
    description: "Cotizaciones, contratos, control financiero y gestión de clientes para independientes.",
    icon: "Briefcase",
    locale: "es",
    category: "function",
    audience: "Freelancers, consultores independientes, profesionales autónomos",
  },
  {
    id: "agente-aduanas",
    name: "Agente de Aduanas",
    description: "Cálculo de aranceles, clasificación arancelaria, documentos de exportación y logística internacional.",
    icon: "Ship",
    locale: "es",
    category: "industry",
    audience: "Importadores, exportadores, agentes aduanales, PyMEs de comercio exterior",
  },
];
