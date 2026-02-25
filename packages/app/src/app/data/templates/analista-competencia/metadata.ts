import type { AikaTemplate } from "../index";

import analisisCompetitivo from "./skills/analisis-competitivo.md?raw";
import monitoreoMercado from "./skills/monitoreo-mercado.md?raw";
import analizarCompetidor from "./commands/analizar-competidor.md?raw";
import compararPrecios from "./commands/comparar-precios.md?raw";
import reporteMercado from "./commands/reporte-mercado.md?raw";

const template: AikaTemplate = {
  id: "analista-competencia",
  name: "Analista de Competencia",
  description:
    "Análisis de competidores, comparación de precios y monitoreo de tendencias de mercado.",
  icon: "TrendingUp",
  locale: "es",
  category: "function",
  audience: "Startups, e-commerce, agencias, equipos de estrategia",
  skills: [
    { slug: "analisis-competitivo", content: analisisCompetitivo },
    { slug: "monitoreo-mercado", content: monitoreoMercado },
  ],
  commands: [
    { slug: "analizar-competidor", content: analizarCompetidor },
    { slug: "comparar-precios", content: compararPrecios },
    { slug: "reporte-mercado", content: reporteMercado },
  ],
  suggestedMcps: [
    {
      name: "Firecrawl",
      package: "firecrawl-mcp",
      reason: "Scraping de sitios web de competidores para análisis de precios y features.",
    },
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Buscar noticias, reviews y menciones de competidores.",
    },
  ],
};

export default template;
