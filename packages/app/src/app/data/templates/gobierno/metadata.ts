import type { AikaTemplate } from "../index";

import redaccionOficial from "./skills/redaccion-oficial.md?raw";
import transparenciaDatos from "./skills/transparencia-datos.md?raw";
import redactarOficio from "./commands/redactar-oficio.md?raw";
import generarInforme from "./commands/generar-informe.md?raw";
import respuestaCiudadana from "./commands/respuesta-ciudadana.md?raw";

const template: AikaTemplate = {
  id: "gobierno",
  name: "Gobierno / Sector Público",
  description:
    "Oficios, informes de transparencia y respuestas ciudadanas en lenguaje oficial.",
  icon: "Landmark",
  locale: "es",
  category: "industry",
  audience: "Municipios, dependencias gubernamentales",
  skills: [
    { slug: "redaccion-oficial", content: redaccionOficial },
    { slug: "transparencia-datos", content: transparenciaDatos },
  ],
  commands: [
    { slug: "redactar-oficio", content: redactarOficio },
    { slug: "generar-informe", content: generarInforme },
    { slug: "respuesta-ciudadana", content: respuestaCiudadana },
  ],
  suggestedMcps: [
    {
      name: "Google Drive",
      package: "@anthropic/gdrive-mcp",
      reason: "Acceder a documentos oficiales y compartir informes institucionales.",
    },
  ],
};

export default template;
