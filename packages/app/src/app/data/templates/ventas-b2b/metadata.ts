import type { AikaTemplate } from "../index";

import prospeccionVentas from "./skills/prospeccion-ventas.md?raw";
import propuestasComerciales from "./skills/propuestas-comerciales.md?raw";
import crearPropuesta from "./commands/crear-propuesta.md?raw";
import seguimientoLead from "./commands/seguimiento-lead.md?raw";
import reportePipeline from "./commands/reporte-pipeline.md?raw";

const template: AikaTemplate = {
  id: "ventas-b2b",
  name: "Ventas B2B",
  description:
    "Propuestas comerciales, seguimiento de leads y reportes de pipeline.",
  icon: "Handshake",
  locale: "es",
  category: "function",
  audience: "Equipos comerciales, ejecutivos de ventas",
  skills: [
    { slug: "prospeccion-ventas", content: prospeccionVentas },
    { slug: "propuestas-comerciales", content: propuestasComerciales },
  ],
  commands: [
    { slug: "crear-propuesta", content: crearPropuesta },
    { slug: "seguimiento-lead", content: seguimientoLead },
    { slug: "reporte-pipeline", content: reportePipeline },
  ],
  suggestedMcps: [
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar pipeline de ventas y base de datos de prospectos.",
    },
    {
      name: "Slack",
      package: "@anthropic/slack-mcp",
      reason: "Coordinar con el equipo comercial y compartir actualizaciones de deals.",
    },
  ],
};

export default template;
