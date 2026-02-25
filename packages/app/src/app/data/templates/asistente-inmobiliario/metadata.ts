import type { AikaTemplate } from "../index";

import gestionInmobiliaria from "./skills/gestion-inmobiliaria.md?raw";
import analisisInversion from "./skills/analisis-inversion.md?raw";
import crearFicha from "./commands/crear-ficha.md?raw";
import analizarInversion from "./commands/analizar-inversion.md?raw";
import contratoArrendamiento from "./commands/contrato-arrendamiento.md?raw";

const template: AikaTemplate = {
  id: "asistente-inmobiliario",
  name: "Asistente Inmobiliario",
  description:
    "Fichas de propiedades, análisis de inversión, contratos de arrendamiento y comparación de precios por zona.",
  icon: "Building2",
  locale: "es",
  category: "industry",
  audience: "Agentes inmobiliarios, inversionistas, administradores de propiedades",
  skills: [
    { slug: "gestion-inmobiliaria", content: gestionInmobiliaria },
    { slug: "analisis-inversion", content: analisisInversion },
  ],
  commands: [
    { slug: "crear-ficha", content: crearFicha },
    { slug: "analizar-inversion", content: analizarInversion },
    { slug: "contrato-arrendamiento", content: contratoArrendamiento },
  ],
  suggestedMcps: [
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Buscar precios de referencia y comparables en portales inmobiliarios.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar fichas, contratos y análisis de inversión.",
    },
  ],
};

export default template;
