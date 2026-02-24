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
];
