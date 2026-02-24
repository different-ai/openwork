import type { AikaTemplate } from "../index";

import copywritingLatam from "./skills/copywriting-latam.md?raw";
import metricasReportes from "./skills/metricas-reportes.md?raw";
import crearCampana from "./commands/crear-campana.md?raw";
import generarCopy from "./commands/generar-copy.md?raw";
import reporteSemanal from "./commands/reporte-semanal.md?raw";

const template: AikaTemplate = {
  id: "marketing-digital",
  name: "Marketing Digital",
  description:
    "Campañas, copywriting y reportes de métricas para el mercado hispanohablante.",
  icon: "Megaphone",
  locale: "es",
  category: "function",
  audience: "Agencias de marketing, equipos de growth",
  skills: [
    { slug: "copywriting-latam", content: copywritingLatam },
    { slug: "metricas-reportes", content: metricasReportes },
  ],
  commands: [
    { slug: "crear-campana", content: crearCampana },
    { slug: "generar-copy", content: generarCopy },
    { slug: "reporte-semanal", content: reporteSemanal },
  ],
  suggestedMcps: [
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar calendario editorial y base de datos de campañas.",
    },
    {
      name: "Slack",
      package: "@anthropic/slack-mcp",
      reason: "Compartir reportes y coordinar con el equipo de marketing.",
    },
    {
      name: "Browser Automation",
      package: "@anthropic/browser-mcp",
      reason: "Revisar landing pages y analizar competencia en vivo.",
    },
  ],
};

export default template;
