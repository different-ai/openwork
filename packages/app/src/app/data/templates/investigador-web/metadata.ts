import type { AikaTemplate } from "../index";

import investigacionWeb from "./skills/investigacion-web.md?raw";
import sintesisReportes from "./skills/sintesis-reportes.md?raw";
import investigarTema from "./commands/investigar-tema.md?raw";
import compararOpciones from "./commands/comparar-opciones.md?raw";
import resumenArticulo from "./commands/resumen-articulo.md?raw";

const template: AikaTemplate = {
  id: "investigador-web",
  name: "Investigador Web",
  description:
    "Búsqueda profunda en internet, verificación de fuentes y generación de reportes estructurados.",
  icon: "Search",
  locale: "es",
  category: "function",
  audience: "Analistas, consultores, periodistas, estudiantes de posgrado",
  skills: [
    { slug: "investigacion-web", content: investigacionWeb },
    { slug: "sintesis-reportes", content: sintesisReportes },
  ],
  commands: [
    { slug: "investigar-tema", content: investigarTema },
    { slug: "comparar-opciones", content: compararOpciones },
    { slug: "resumen-articulo", content: resumenArticulo },
  ],
  suggestedMcps: [
    {
      name: "Firecrawl",
      package: "firecrawl-mcp",
      reason: "Scraping y búsqueda web para investigación profunda.",
    },
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Búsquedas web rápidas con resultados actualizados.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar reportes e investigaciones en archivos locales.",
    },
  ],
};

export default template;
