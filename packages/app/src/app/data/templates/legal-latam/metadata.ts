import type { AikaTemplate } from "../index";

import redaccionJuridica from "./skills/redaccion-juridica.md?raw";
import revisionDocumentos from "./skills/revision-documentos.md?raw";
import redactarContrato from "./commands/redactar-contrato.md?raw";
import revisarDocumento from "./commands/revisar-documento.md?raw";
import generarPoder from "./commands/generar-poder.md?raw";

const template: AikaTemplate = {
  id: "legal-latam",
  name: "Legal LATAM",
  description:
    "Redacción jurídica, contratos y revisión de documentos legales para México, Colombia y Argentina.",
  icon: "Scale",
  locale: "es",
  category: "industry",
  audience: "Despachos de abogados, asesores legales",
  skills: [
    { slug: "redaccion-juridica", content: redaccionJuridica },
    { slug: "revision-documentos", content: revisionDocumentos },
  ],
  commands: [
    { slug: "redactar-contrato", content: redactarContrato },
    { slug: "revisar-documento", content: revisarDocumento },
    { slug: "generar-poder", content: generarPoder },
  ],
  suggestedMcps: [
    {
      name: "Google Drive",
      package: "@anthropic/gdrive-mcp",
      reason: "Acceder y editar documentos legales almacenados en Drive.",
    },
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar base de datos de contratos y clientes en Notion.",
    },
  ],
};

export default template;
