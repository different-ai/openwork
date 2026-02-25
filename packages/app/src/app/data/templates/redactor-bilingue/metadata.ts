import type { AikaTemplate } from "../index";

import traduccionProfesional from "./skills/traduccion-profesional.md?raw";
import redaccionBilingue from "./skills/redaccion-bilingue.md?raw";
import traducirDocumento from "./commands/traducir-documento.md?raw";
import versionBilingue from "./commands/version-bilingue.md?raw";
import revisarTexto from "./commands/revisar-texto.md?raw";

const template: AikaTemplate = {
  id: "redactor-bilingue",
  name: "Redactor Bilingüe EN↔ES",
  description:
    "Traducción profesional, redacción bilingüe y localización para mercados US y LATAM.",
  icon: "Languages",
  locale: "es",
  category: "function",
  audience: "Empresas internacionales, exportadores, freelancers bilingües",
  skills: [
    { slug: "traduccion-profesional", content: traduccionProfesional },
    { slug: "redaccion-bilingue", content: redaccionBilingue },
  ],
  commands: [
    { slug: "traducir-documento", content: traducirDocumento },
    { slug: "version-bilingue", content: versionBilingue },
    { slug: "revisar-texto", content: revisarTexto },
  ],
  suggestedMcps: [
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Verificar terminología y uso correcto en contexto.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Leer y guardar documentos para traducción.",
    },
  ],
};

export default template;
