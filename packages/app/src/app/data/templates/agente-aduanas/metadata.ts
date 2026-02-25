import type { AikaTemplate } from "../index";

import comercioExterior from "./skills/comercio-exterior.md?raw";
import logisticaInternacional from "./skills/logistica-internacional.md?raw";
import calcularImportacion from "./commands/calcular-importacion.md?raw";
import documentosExportacion from "./commands/documentos-exportacion.md?raw";
import clasificarProducto from "./commands/clasificar-producto.md?raw";

const template: AikaTemplate = {
  id: "agente-aduanas",
  name: "Agente de Aduanas",
  description:
    "Cálculo de aranceles, clasificación arancelaria, documentos de exportación y logística internacional.",
  icon: "Ship",
  locale: "es",
  category: "industry",
  audience: "Importadores, exportadores, agentes aduanales, PyMEs de comercio exterior",
  skills: [
    { slug: "comercio-exterior", content: comercioExterior },
    { slug: "logistica-internacional", content: logisticaInternacional },
  ],
  commands: [
    { slug: "calcular-importacion", content: calcularImportacion },
    { slug: "documentos-exportacion", content: documentosExportacion },
    { slug: "clasificar-producto", content: clasificarProducto },
  ],
  suggestedMcps: [
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Consultar aranceles vigentes, regulaciones y requisitos por país.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar cálculos de importación y checklists de documentos.",
    },
  ],
};

export default template;
